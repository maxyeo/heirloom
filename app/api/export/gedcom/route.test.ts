import { beforeEach, describe, expect, it, vi } from "vitest";

import { GEDCOM_EXPORT_ENDPOINT } from "@/lib/export-endpoint";

/**
 * The wiring of the download endpoint (E7-T3, `YEO-53`).
 *
 * The *file* is tested in `lib/gedcom-export.test.ts` against the real
 * serialiser, and round-tripped in E7-T2 (`YEO-52`). The *name* and the
 * headers are `lib/export-endpoint.test.ts`. What is left for this file is
 * the part that only exists inside a route, and it is the same short list
 * `app/api/import/route.test.ts` argues is worth driving rather than reading:
 * that an anonymous caller is turned away before anything is read out of the
 * database, and that what comes back is a download rather than a page of text.
 *
 * ## The two mocks, and why there is no third
 *
 * `@/auth` calls `NextAuth()` at import time and does not load outside the
 * Next.js runtime — `app/auth-boundary.test.ts` gives that reason for stubbing
 * it and stubbing nothing else, and it is the same here.
 *
 * `@/lib/export-tree` is the second, and it is a module boundary this suite
 * genuinely cannot cross rather than behaviour worth driving: it is five lines
 * of `select` against a database that `npm test` runs without
 * (docs/testing.md), and `lib/export-tree.ts` exists as its own module
 * precisely so that the query has one home. Standing a fake Drizzle chain up
 * here would assert that a fake returns what the fake was told to.
 *
 * The stub does earn one assertion the real thing could not: it counts its
 * calls, which is how "the guard runs *before* the read" is checked rather
 * than assumed.
 */

const state = vi.hoisted(() => ({
  session: null as { user: { email: string } } | null,
  exports: 0,
}));

vi.mock("@/auth", () => ({ auth: async () => state.session }));

/** A minimal but real GEDCOM, so the body is something a reader could open. */
const TREE = ["0 HEAD", "1 CHAR UTF-8", "0 TRLR", ""].join("\n");

vi.mock("@/lib/export-tree", () => ({
  exportTreeAsGedcom: async () => {
    state.exports += 1;
    return TREE;
  },
}));

const { GET } = await import("@/app/api/export/gedcom/route");

beforeEach(() => {
  state.session = { user: { email: "rose@example.com" } };
  state.exports = 0;
});

describe("the guard", () => {
  it("answers 401 to a caller with no session", async () => {
    state.session = null;

    const response = await GET();

    expect(response.status).toBe(401);
  });

  it("does not read the tree for a caller it turned away", async () => {
    state.session = null;

    await GET();

    // The whole point of guarding first: a refusal that has already run the
    // query has already put the family in a variable it did not need to.
    expect(state.exports).toBe(0);
  });
});

describe("the download", () => {
  it("answers with the exported tree", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(TREE);
  });

  it("is saved rather than displayed, under a dated name", async () => {
    const response = await GET();

    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="family-tree-\d{4}-\d{2}-\d{2}\.ged"$/,
    );
  });

  it("declares GEDCOM in UTF-8", async () => {
    const response = await GET();

    expect(response.headers.get("content-type")).toBe(
      "text/vnd.familysearch.gedcom; charset=utf-8",
    );
  });

  it("is not left in a shared cache", async () => {
    const response = await GET();

    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reads the tree once per request", async () => {
    await GET();

    expect(state.exports).toBe(1);
  });
});

describe("the route", () => {
  it("is the path the settings page points at", () => {
    // A rename that moved the handler without moving the link would leave both
    // sides typechecking and the button 404ing.
    expect(GEDCOM_EXPORT_ENDPOINT).toBe("/api/export/gedcom");
  });
});
