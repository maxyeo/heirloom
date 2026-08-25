import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fetching one photograph for the archive (E7-T4, `YEO-54`).
 *
 * `lib/export-full.ts` is the database-aware half of the export and most of
 * it is checked in `lib/export-full.db.test.ts`, against a real Postgres.
 * `openImage` is the part that has nothing to do with Postgres and cannot be
 * reached from there at all: every branch it has is a way for the *image
 * store* to fail, and a test with a working store exercises none of them.
 *
 * They are worth driving because the rule they implement is not obvious and
 * is easy to quietly reverse: **a store that misbehaves costs the family the
 * pictures, never the backup.** An export that threw here would abort the
 * response mid-archive and leave a person with a broken download instead of
 * a complete wiki with a note saying which images were missing and why.
 *
 * ## What is mocked, and why it is only this
 *
 * `@/lib/storage` is a module boundary this suite cannot cross — it needs
 * `STORAGE_TOKEN` and a real Vercel Blob store (docs/testing.md) — and
 * `fetch` is the network. `@/db` is deliberately *not* mocked: importing it
 * is free, because `db/index.ts` connects lazily behind a Proxy, and nothing
 * on this path touches it.
 */

const storage = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<{ url: string } | null>>(),
}));

vi.mock("@/lib/storage", () => storage);

const { openImage } = await import("@/lib/export-full");

const KEY = "images/ab/0e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";

beforeEach(() => {
  storage.get.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A response whose body reports whether anybody released it. */
function respond(status: number, body: string) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: new Response(stream, { status }),
    wasCancelled: () => cancelled,
  };
}

describe("an image that is there", () => {
  it("comes back as bytes to put in the archive", async () => {
    storage.get.mockResolvedValue({ url: "https://store.test/signed" });
    vi.stubGlobal("fetch", async () => new Response("the photograph"));

    const opened = await openImage(KEY);

    expect(opened.found).toBe(true);
    await expect(
      new Response(opened.found ? opened.body : null).text(),
    ).resolves.toBe("the photograph");
  });
});

describe("an image that is not", () => {
  it("is reported as deleted when the store says it has no such object", async () => {
    // The ordinary case, not a failure: revisions are append-only and E5-T5
    // sweeps orphans, so a body outliving its photograph is expected.
    storage.get.mockResolvedValue(null);

    const opened = await openImage(KEY);

    expect(opened).toEqual({
      found: false,
      reason: "The image store no longer has this file.",
    });
  });

  it("is reported as unreachable when the store throws", async () => {
    /**
     * Told apart from the case above on purpose. Both leave the same gap in
     * the archive and call for opposite responses: one means the archive is
     * complete, the other means take it again.
     */
    storage.get.mockRejectedValue(new Error("STORAGE_TOKEN is not set."));

    const opened = await openImage(KEY);

    expect(opened.found).toBe(false);
    expect(opened.found === false && opened.reason).toContain(
      "could not be reached",
    );
    expect(opened.found === false && opened.reason).toContain("STORAGE_TOKEN");
  });

  it("is reported with the status when the store refuses the URL", async () => {
    storage.get.mockResolvedValue({ url: "https://store.test/expired" });
    const { response } = respond(403, "<Error>AccessDenied</Error>");
    vi.stubGlobal("fetch", async () => response);

    const opened = await openImage(KEY);

    expect(opened).toEqual({
      found: false,
      reason: "The image store answered 403 for this file.",
    });
  });

  it("hangs up on a refused response rather than dropping it", async () => {
    /**
     * A `403` from a blob store carries a paragraph of XML, and on Node a
     * response body nobody reads holds its socket out of the connection pool
     * until a finaliser gets to it. One is nothing; one per referenced
     * photograph, on an export that has run into an expired credential, is a
     * leak that scales with the size of the family album.
     */
    storage.get.mockResolvedValue({ url: "https://store.test/expired" });
    const { response, wasCancelled } = respond(500, "<Error>Oops</Error>");
    vi.stubGlobal("fetch", async () => response);

    await openImage(KEY);

    expect(wasCancelled()).toBe(true);
  });

  it("never throws, whatever the store does", async () => {
    // The property the whole archive rests on: one bad photograph must not
    // become a failed backup.
    storage.get.mockRejectedValue(new Error("network down"));

    await expect(openImage(KEY)).resolves.toMatchObject({ found: false });
  });
});
