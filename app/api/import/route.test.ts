import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
  IMPORT_RELEASE_FIELD,
  type ImportDoneResponse,
  type ImportPreviewResponse,
  type ImportRefusal,
  type PriorImport,
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
 * ## The three mocks, and why there are exactly three
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
 * rollback and the ledger's own refusal (`YEO-89`). What is left here — and
 * is only visible here — is that a confirmed request calls it exactly once
 * with the mapping the same request was read from, that an unconfirmed one
 * never calls it at all, that a fault inside it becomes a sentence saying
 * the tree is untouched, and that an `already-imported` outcome becomes a
 * `409` naming what the earlier import did.
 *
 * `@/lib/import-ledger` is the third, added with `YEO-89` alongside the
 * second: `findImportByDigest` is the preview branch's own reach into
 * Postgres, separate from the write, and mocking it is what keeps this file
 * — like every test in the `unit` project — off a real `DATABASE_URL`.
 *
 * There is no fourth mock because there is no fourth boundary. Everything
 * else this route reaches is pure, which is the property
 * `lib/gedcom.purity.test.ts` asserts from the other side.
 */

const state = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
}));
vi.mock("@/auth", () => ({ auth: async () => state.session }));

const importGedcom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/gedcom-import", () => ({ importGedcom }));

const findImportByDigest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/import-ledger", () => ({ findImportByDigest }));

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
  {
    field = IMPORT_FILE_FIELD,
    confirm = null as string | null,
    release = null as string | null,
  } = {},
): Request {
  const form = new FormData();
  form.set(field, new File([text], "tree.ged", { type: "text/plain" }));
  if (confirm !== null) form.set(IMPORT_CONFIRM_FIELD, confirm);
  if (release !== null) form.set(IMPORT_RELEASE_FIELD, release);
  return new Request(`http://localhost${IMPORT_ENDPOINT}`, {
    method: "POST",
    body: form,
  });
}

/** The digest the screen would send back after previewing `text`. */
function digestOf(text: string): Promise<string> {
  return gedcomDigest(new TextEncoder().encode(text));
}

/** A prior import, for the `already-imported` outcome and preview branch. */
const PRIOR_IMPORT: PriorImport = {
  id: "00000000-0000-4000-8000-0000000e0001",
  importedAt: "2026-03-03T00:00:00.000Z",
  fileName: "family.ged",
  counts: { people: 412, unions: 120, children: 300 },
};

beforeEach(() => {
  state.session = { user: { email: "rose@example.com" } };
  importGedcom.mockReset();
  importGedcom.mockResolvedValue({
    status: "imported",
    importId: "00000000-0000-4000-8000-000000000001",
    counts: { individuals: 1, unions: 0, unionChildren: 0 },
  });
  findImportByDigest.mockReset();
  findImportByDigest.mockResolvedValue(null);
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

  it("reports null when this digest has never been imported", async () => {
    const response = await POST(upload(TREE));

    expect(findImportByDigest).toHaveBeenCalledWith(await digestOf(TREE));
    const body = (await response.json()) as ImportPreviewResponse;
    expect(body.alreadyImported).toBeNull();
  });

  it("reports the earlier import when this digest is already in the ledger (YEO-89)", async () => {
    // A read, not a refusal: the preview still answers 200 with what the
    // file contains, and adds what the ledger already knows about it — see
    // `components/GedcomImport.tsx` for where the reader is told.
    findImportByDigest.mockResolvedValue(PRIOR_IMPORT);

    const response = await POST(upload(TREE));

    expect(response.status).toBe(200);
    const body = (await response.json()) as ImportPreviewResponse;
    expect(body.alreadyImported).toEqual(PRIOR_IMPORT);
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
      status: "imported",
      importId: "00000000-0000-4000-8000-000000000002",
      counts: { individuals: 0, unions: 0, unionChildren: 0 },
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

  it("answers 409 naming the earlier import when the write finds this digest already in the ledger (YEO-89)", async () => {
    // The refusal `lib/gedcom-import.db.test.ts` proves the unique index
    // actually produces, seen from this route's side: the write can still
    // discover a conflict the preview's own read missed — a second tab that
    // previewed before the first tab's import committed — so this branch has
    // to be handled here rather than assumed unreachable.
    importGedcom.mockResolvedValue({
      status: "already-imported",
      previous: PRIOR_IMPORT,
    });

    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as ImportRefusal;
    // The date and what the earlier import added, not merely "already
    // imported" — see `alreadyImportedRefusal` in `app/api/import/route.ts`.
    expect(body.error).toContain("3 March 2026");
    expect(body.error).toContain("412 people");
    expect(body.error).toContain("nothing was written");
    // …and what to do about it, if the repeat was deliberate (`YEO-95`).
    // Acceptance criterion 4 of that ticket: a refusal that says only "no"
    // is how somebody ends up writing SQL against production by hand.
    expect(body.error).toContain("Import it again anyway");
  });

  it("writes nothing more when the write refuses as already-imported", async () => {
    importGedcom.mockResolvedValue({
      status: "already-imported",
      previous: PRIOR_IMPORT,
    });

    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    // The refusal is the whole answer — there is no report, because nothing
    // beyond the ledger's own read happened on this request.
    const body = (await response.json()) as ImportRefusal | ImportDoneResponse;
    expect("stage" in body).toBe(false);
  });
});

describe("releasing a prior import (YEO-95)", () => {
  it("passes the id through to the write, unexamined", async () => {
    // The route deliberately checks nothing about this value: whether the row
    // exists, still holds its claim, and belongs to these bytes are three
    // questions with one answer, and only the transaction that acts on it can
    // ask them without reopening the `select`-then-write race `YEO-89`
    // closed. So what is asserted here is precisely that it arrives.
    const prior = "00000000-0000-4000-8000-0000000e00ff";

    await POST(upload(TREE, { confirm: await digestOf(TREE), release: prior }));

    expect(importGedcom).toHaveBeenCalledTimes(1);
    expect(importGedcom.mock.calls[0][2]).toEqual({ release: prior });
  });

  it("leaves the guard standing for an ordinary confirmation", async () => {
    // The acceptance criterion that matters most: the accidental second
    // import — a second tab, a back button, a retried request — sends no
    // release field, and must reach the write with the override *off* rather
    // than with anything that could be read as consent.
    await POST(upload(TREE, { confirm: await digestOf(TREE) }));

    expect(importGedcom.mock.calls[0][2]).toEqual({ release: null });
  });

  it("refuses a release with no confirmation beside it", async () => {
    // A preview is not something an override can be spent on. Answering 200
    // and quietly previewing would leave a caller believing they had released
    // something, which is the one wrong answer available here.
    const response = await POST(upload(TREE, { release: "whatever" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as ImportRefusal;
    expect(body.error).toContain("part of importing it");
    expect(importGedcom).not.toHaveBeenCalled();
  });

  it("does not release for a confirmation that names a different file", async () => {
    // The digest check runs first and refuses whole. An override rides on a
    // confirmation; it cannot outlive one being rejected.
    const response = await POST(
      upload(TREE, {
        confirm: await digestOf("0 HEAD\n0 TRLR\n"),
        release: "00000000-0000-4000-8000-0000000e00ff",
      }),
    );

    expect(response.status).toBe(409);
    expect(importGedcom).not.toHaveBeenCalled();
  });

  it("still answers 409 when the write refuses a release it could not spend", async () => {
    // A stale release — one already spent, by this reader's own retry or by
    // another tab. `lib/gedcom-import.ts` releases nothing and the ordinary
    // index refuses the insert, so the answer is the ordinary refusal naming
    // whatever now holds the digest. Nothing about this path is special, and
    // that is the design: the override is single-use because the row it names
    // stops being live, not because anything counts its uses.
    importGedcom.mockResolvedValue({
      status: "already-imported",
      previous: PRIOR_IMPORT,
    });

    const response = await POST(
      upload(TREE, {
        confirm: await digestOf(TREE),
        release: "00000000-0000-4000-8000-0000000e00ff",
      }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as ImportRefusal;
    expect(body.error).toContain("already been imported");
  });
});
