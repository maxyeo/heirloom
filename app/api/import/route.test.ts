import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
  type ImportDoneResponse,
  type ImportPreviewResponse,
  type ImportRefusal,
} from "@/lib/import-endpoint";
import {
  gedcomDigest,
  MAX_GEDCOM_BYTES,
  MAX_REQUEST_BYTES,
} from "@/lib/import-preview";

/**
 * The wiring of the import endpoint (E6-T3, `YEO-48`).
 *
 * The *decisions* are tested in `lib/import-preview.test.ts` against the real
 * implementation with nothing stubbed. What is left for this file is the part
 * that only exists inside a route, and `app/api/images/route.test.ts` — the
 * sibling this is modelled on — argues it is worth driving rather than
 * reading: that an anonymous caller gets a 401 before anything else happens,
 * that a multipart body is unpacked the way a browser sends one, and that the
 * status codes are the ones the screen is written against.
 *
 * The branch between the two stages is the reason this file matters more here
 * than it does there. `app/auth-boundary.test.ts` proves statically that the
 * guard is *called*; nothing but this proves that a request with no
 * confirmation on it cannot write, or that one carrying the wrong digest is
 * refused. Those are two of the ticket's four acceptance criteria, and they
 * are properties of this handler rather than of any value it computes.
 *
 * ## The two mocks, and why there are exactly two
 *
 * `@/auth` calls `NextAuth()` at import time and does not load outside the
 * Next.js runtime — the same reason `app/auth-boundary.test.ts` gives for
 * stubbing it.
 *
 * `@/lib/gedcom-import` is the second, and it arrived with E6-T5 (`YEO-50`)
 * closing the seam this route used to answer `501` at. It is the one thing on
 * this path that reaches Postgres, and `npm test` runs with no
 * `DATABASE_URL` by design (docs/testing.md). What it does when it gets
 * there is not this file's question either: `lib/gedcom-import.db.test.ts`
 * drives the real transaction against a real database, including the
 * rollback. What is left here — and is only visible here — is that a
 * confirmed request calls it exactly once with the mapping the same request
 * was read from, that an unconfirmed one never calls it at all, and that a
 * fault inside it becomes a sentence saying the tree is untouched.
 *
 * There is no third mock because there is no third boundary. Everything else
 * this route reaches is pure, which is the property
 * `lib/gedcom.purity.test.ts` asserts from the other side.
 */

const state = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
}));
vi.mock("@/auth", () => ({ auth: async () => state.session }));

const importGedcom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gedcom-import", () => ({ importGedcom }));

const { POST } = await import("@/app/api/import/route");

const TREE = [
  "0 HEAD",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME Ada /Reed/",
  "0 TRLR",
  "",
].join("\n");

/** A POST shaped exactly as the screen's `fetch` with a `FormData` body sends it. */
function upload(
  text: string,
  { field = IMPORT_FILE_FIELD, confirm = null as string | null } = {},
): Request {
  const form = new FormData();
  form.set(field, new File([text], "tree.ged", { type: "text/plain" }));
  if (confirm !== null) form.set(IMPORT_CONFIRM_FIELD, confirm);
  return new Request(`http://localhost${IMPORT_ENDPOINT}`, {
    method: "POST",
    body: form,
  });
}

/** The digest the screen would send back after previewing `text`. */
function digestOf(text: string): Promise<string> {
  return gedcomDigest(new TextEncoder().encode(text));
}

beforeEach(() => {
  state.session = { user: { email: "rose@example.com" } };
  importGedcom.mockReset();
  importGedcom.mockResolvedValue({
    individuals: 1,
    unions: 0,
    unionChildren: 0,
  });
});

describe("the guard", () => {
  it("answers 401 to a caller with no session", async () => {
    state.session = null;

    const response = await POST(upload(TREE));

    expect(response.status).toBe(401);
  });

  it("refuses a confirmed import from a caller with no session", async () => {
    // The request that would write, from the caller who must never reach it.
    // A route handler is a public POST endpoint whether or not a page renders
    // a button for it (`lib/session.ts`), so this is the boundary itself
    // rather than a repeat of the case above.
    state.session = null;

    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    expect(response.status).toBe(401);
  });
});

describe("what it refuses before reading a file", () => {
  it("answers 413 to a body that declares itself too large", async () => {
    // `Content-Length` is the client's own claim, so it may only ever be used
    // to say no early — asserted here on a request whose declared size is a
    // lie about a tiny body, which is exactly the shape that must still be
    // refused without buffering.
    const response = await POST(
      new Request(`http://localhost${IMPORT_ENDPOINT}`, {
        method: "POST",
        body: "x",
        headers: { "content-length": String(MAX_REQUEST_BYTES + 1) },
      }),
    );

    expect(response.status).toBe(413);
  });

  it("answers 400 to a body that is not a multipart form", async () => {
    const response = await POST(
      new Request(`http://localhost${IMPORT_ENDPOINT}`, {
        method: "POST",
        body: "0 HEAD",
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 400 when the file is under another name", async () => {
    const response = await POST(upload(TREE, { field: "gedcom" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as ImportRefusal;
    expect(body.error).toContain(IMPORT_FILE_FIELD);
  });

  it("answers 400 to an empty file", async () => {
    expect((await POST(upload(""))).status).toBe(400);
  });

  it("answers 413 to a file over the cap", async () => {
    const response = await POST(upload("0".repeat(MAX_GEDCOM_BYTES + 1)));

    expect(response.status).toBe(413);
  });
});

describe("previewing", () => {
  it("answers with counts and the digest of what it read", async () => {
    const response = await POST(upload(TREE));

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImportPreviewResponse;
    expect(body.stage).toBe("preview");
    expect(body.preview.counts).toEqual({ people: 1, unions: 0, children: 0 });
    expect(body.preview.sample).toEqual(["Ada Reed"]);
    // The digest is of the file, so the screen can hand it straight back.
    expect(body.digest).toBe(await digestOf(TREE));
  });

  it("previews a file that is not GEDCOM rather than refusing it", async () => {
    const response = await POST(upload("this is not gedcom\n"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImportPreviewResponse;
    expect(body.preview.counts.people).toBe(0);
    expect(body.preview.warnings.map((warning) => warning.kind)).toContain(
      "line",
    );
  });
});

describe("confirming", () => {
  it("refuses a confirmation for a different file", async () => {
    // The failure the whole ticket exists to prevent: a confirmation that
    // approves one tree and imports another.
    const response = await POST(
      upload(TREE, { confirm: await digestOf("0 HEAD\n0 TRLR\n") }),
    );

    expect(response.status).toBe(409);
  });

  it("refuses a confirmation that is not a digest at all", async () => {
    expect((await POST(upload(TREE, { confirm: "" }))).status).toBe(409);
  });

  it("accepts the digest it issued and writes the file", async () => {
    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImportDoneResponse;
    expect(body.stage).toBe("imported");
    // The report is the answer, and `lib/import-report.test.ts` is where its
    // contents are decided. What only this file can show is that `created`
    // comes from the *write* — the mock says one individual and no unions,
    // and the counts say so in the screen's three words rather than the
    // tables'.
    expect(body.report.created).toEqual({ people: 1, unions: 0, children: 0 });
  });

  it("counts what was written rather than what was predicted", async () => {
    // The one number in the report that is not a restatement of the preview.
    // A report that echoed the prediction could never tell anybody the
    // prediction was wrong, which is the only thing it is there for.
    importGedcom.mockResolvedValue({
      individuals: 0,
      unions: 0,
      unionChildren: 0,
    });

    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    const body = (await response.json()) as ImportDoneResponse;
    expect(body.report.created.people).toBe(0);
    // …while the file itself still had somebody in it.
    expect(body.report.found.people).toBe(1);
  });

  it("hands the write the mapping this very request was read from", async () => {
    // The property the two-request shape exists for, at the last step it can
    // still be lost: the bytes are parsed once and the rows that get written
    // are the rows that were summarised, rather than a second reading of the
    // same file.
    await POST(upload(TREE, { confirm: await digestOf(TREE) }));

    expect(importGedcom).toHaveBeenCalledTimes(1);
    const mapping = importGedcom.mock.calls[0][0] as {
      individuals: { values: { givenName: string } }[];
    };
    expect(mapping.individuals).toHaveLength(1);
    expect(mapping.individuals[0].values.givenName).toBe("Ada");
  });

  it("does not write for a request with no confirmation on it", async () => {
    // Two of the ticket's acceptance criteria in one assertion, and neither
    // is a property of any value this handler computes: previewing writes
    // nothing, and cancelling is the absence of this second request.
    await POST(upload(TREE));

    expect(importGedcom).not.toHaveBeenCalled();
  });

  it("does not write for a confirmation that names a different file", async () => {
    await POST(upload(TREE, { confirm: await digestOf("0 HEAD\n0 TRLR\n") }));

    expect(importGedcom).not.toHaveBeenCalled();
  });

  it("says the tree is untouched when the import throws", async () => {
    // `lib/gedcom-import.ts` is explicit that an exception *means* nothing
    // was written, because the throw is what rolled the transaction back. So
    // the sentence is not reassurance, it is the guarantee restated — and a
    // bare platform 500 with no JSON in it would reach the screen as "the
    // answer could not be read", which sends somebody looking at their
    // connection instead.
    importGedcom.mockRejectedValue(new Error("connection terminated"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as ImportRefusal;
    expect(body.error).toContain("nothing was written");
    // A fault rather than a fact about the request, so it leaves a trace.
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
