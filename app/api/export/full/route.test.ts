import { beforeEach, describe, expect, it, vi } from "vitest";

import { MANIFEST_MEMBER, RESTORE_MEMBER } from "@/lib/export-archive";
import { FULL_EXPORT_ENDPOINT } from "@/lib/export-endpoint";
import { readZip, zipText } from "@/test/read-zip";

/**
 * The wiring of the full export endpoint (E7-T4, `YEO-54`).
 *
 * What the archive *contains* is `lib/export-archive.test.ts`, and the ZIP
 * itself is `lib/zip-stream.test.ts`. What is left for this file is the part
 * that only exists inside a route, and it is the same short list
 * `app/api/export/gedcom/route.test.ts` argues is worth driving: that an
 * anonymous caller is turned away before anything is read, that what comes
 * back is a download rather than a page, and — the one that is new here —
 * that the body arrives as a **stream** rather than as a response assembled
 * before the headers went out.
 *
 * ## The two mocks, and why there is no third
 *
 * `@/auth` calls `NextAuth()` at import time and does not load outside the
 * Next.js runtime; `app/auth-boundary.test.ts` gives that reason for stubbing
 * it and stubbing nothing else.
 *
 * `@/lib/export-full` is the second, and it is the module boundary this suite
 * cannot cross rather than behaviour worth driving: it is `select`s against a
 * database `npm test` runs without (docs/testing.md) and `fetch`es against an
 * image store. It exists as its own module precisely so that the reading has
 * one home — and the stub returns a **real archive from the real writer**, so
 * what this file asserts about the response body is still a ZIP that a reader
 * opens rather than a string somebody agreed to call one.
 *
 * The stub earns one assertion the real thing could not: it counts its calls,
 * which is how "the guard runs *before* the read" is checked rather than
 * assumed.
 */

const state = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
  exports: 0,
  /** How many chunks the route's stream has been asked to produce. */
  pulls: 0,
}));

vi.mock("@/auth", () => ({ auth: async () => state.session }));

vi.mock("@/lib/export-full", async () => {
  const { archiveMembers } = await import("@/lib/export-archive");
  const { zipChunks } = await import("@/lib/zip-stream");

  return {
    fullExportStream(generatedAt: Date) {
      state.exports += 1;

      const chunks = zipChunks(
        archiveMembers({
          generatedAt,
          gedcom: "0 HEAD\n1 CHAR UTF-8\n0 TRLR\n",
          tables: [{ table: "pages", rows: [{ id: "p1" }] }],
          images: [],
          schema: {
            migrationsApplied: 6,
            latestMigrationAt: "2026-05-22T09:15:00.000Z",
          },
          openImage: async () => ({ found: false, reason: "no store" }),
        }),
        generatedAt,
      );

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          state.pulls += 1;
          const { value, done } = await chunks.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        },
      });
    },
  };
});

const { GET } = await import("@/app/api/export/full/route");

beforeEach(() => {
  state.session = { user: { email: "rose@example.com" } };
  state.exports = 0;
  state.pulls = 0;
});

async function archiveFrom(response: Response) {
  return readZip(new Uint8Array(await response.arrayBuffer()));
}

describe("the guard", () => {
  it("answers 401 to a caller with no session", async () => {
    state.session = null;

    expect((await GET()).status).toBe(401);
  });

  it("does not read the wiki for a caller it turned away", async () => {
    state.session = null;

    await GET();

    // A refusal that has already run the queries has already put the family
    // in a variable it did not need to.
    expect(state.exports).toBe(0);
  });
});

describe("the download", () => {
  it("answers with an archive a reader can open", async () => {
    const archive = await archiveFrom(await GET());

    expect([...archive.byName.keys()]).toContain(MANIFEST_MEMBER);
    expect(zipText(archive, RESTORE_MEMBER)).toContain("Restoring this export");
  });

  it("is saved rather than displayed, under a dated name", async () => {
    const response = await GET();

    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="family-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
  });

  it("declares a ZIP", async () => {
    expect((await GET()).headers.get("content-type")).toBe("application/zip");
  });

  it("is not left in a shared cache", async () => {
    // The family's names, and a copy of them in a shared laptop's disk cache
    // is a copy outside the one boundary there is.
    expect((await GET()).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("reads the wiki once per request", async () => {
    await GET();

    expect(state.exports).toBe(1);
  });
});

describe("the streaming", () => {
  it("answers before the archive has been produced", async () => {
    /**
     * The acceptance criterion, at the only layer that can show it. When the
     * response object exists — status line, headers and all — the archive
     * underneath has barely started: a `ReadableStream` fills its queue as
     * soon as it is constructed, so *one* chunk may have been produced, and
     * that is the whole of it. A handler that assembled the archive and then
     * wrapped the result would have produced every chunk before this
     * assertion could run.
     */
    const response = await GET();

    expect(response.status).toBe(200);
    expect(state.pulls).toBeLessThanOrEqual(1);

    await response.arrayBuffer();
    // The archive has six members and a table of contents, so a finished one
    // is many chunks. The gap between the two numbers is the criterion.
    expect(state.pulls).toBeGreaterThan(5);
  });

  it("declares no length, because it does not know one yet", async () => {
    /**
     * A `Content-Length` guessed before the archive exists and disagreed with
     * by the body is a truncated download that looks complete — the one
     * failure a backup must not have. Its absence is what makes the response
     * chunked.
     */
    expect((await GET()).headers.get("content-length")).toBeNull();
  });

  it("stops the export when the reader gives up", async () => {
    // A closed tab. Cancelling has to reach the generator, or an abandoned
    // download leaves an image response open behind it.
    const response = await GET();

    await expect(response.body!.cancel()).resolves.toBeUndefined();
  });
});

describe("the route", () => {
  it("is the path the settings page points at", () => {
    // A rename that moved the handler without moving the link would leave
    // both sides typechecking and the button 404ing.
    expect(FULL_EXPORT_ENDPOINT).toBe("/api/export/full");
  });
});
