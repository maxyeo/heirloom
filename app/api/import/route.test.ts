import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
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
 * ## The one mock, and why it is the only one
 *
 * `@/auth` calls `NextAuth()` at import time and does not load outside the
 * Next.js runtime — the same reason `app/auth-boundary.test.ts` gives for
 * stubbing it and stubbing nothing else. There is no second mock because
 * there is no second boundary: this route reaches no store and no database,
 * which is the property `lib/gedcom.purity.test.ts` asserts from the other
 * side.
 */

const state = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
}));
vi.mock("@/auth", () => ({ auth: async () => state.session }));

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

  it("accepts the digest it issued, and writes nothing yet", async () => {
    // E6-T4 (`YEO-49`) replaces this answer with the transaction. Until it
    // does, the endpoint says so plainly rather than looking finished — and
    // this test is what will notice the day the status stops being 501.
    const response = await POST(
      upload(TREE, { confirm: await digestOf(TREE) }),
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as ImportRefusal;
    expect(body.pendingTicket).toBe("E6-T4");
    expect(body.error).toContain("Nothing was written");
  });
});
