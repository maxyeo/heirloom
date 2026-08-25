import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getRevisionById, listRevisionsForPage } from "@/lib/revisions";

/**
 * What only Postgres can prove about `lib/revisions.ts`:
 *
 *   - `ORDER BY created_at DESC` actually orders newest first;
 *   - the `WHERE page_id = $1` scopes a page's history to that page, and
 *     nothing from another page's history leaks in;
 *   - a miss on `getRevisionById` comes back `undefined` rather than throwing;
 *   - the summary rows really do omit `bodyHtml`, not merely by type but at
 *     the row level, since `listRevisionsForPage` selects it in an explicit
 *     object rather than `select()`.
 *
 * Mocking Drizzle would prove none of this — see docs/testing.md and
 * `lib/pages.db.test.ts`, which this file mirrors.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made
// and nothing that already lives in whichever database `npm run test:db`
// points at.
const PAGE = "00000000-0000-4000-8000-00000000f001";
const OTHER_PAGE = "00000000-0000-4000-8000-00000000f002";
const REVISION_OLDEST = "00000000-0000-4000-8000-00000000f011";
const REVISION_MIDDLE = "00000000-0000-4000-8000-00000000f012";
const REVISION_NEWEST = "00000000-0000-4000-8000-00000000f013";
const OTHER_REVISION = "00000000-0000-4000-8000-00000000f021";
const UNKNOWN_REVISION = "00000000-0000-4000-8000-00000000f099";

const AUTHOR = "editor@fixture.test";

async function removeFixture() {
  // Revisions are `ON DELETE CASCADE` on `page_id` (db/schema.ts), so deleting
  // the pages is enough to take their revisions with them — the same pattern
  // `lib/save-page.db.test.ts` relies on.
  await db
    .delete(schema.pages)
    .where(inArray(schema.pages.id, [PAGE, OTHER_PAGE]));
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and
  // would otherwise greet the next run with a duplicate key on these ids.
  await removeFixture();

  await db.insert(schema.pages).values([
    {
      id: PAGE,
      slug: "revisions-fixture-rose-hale",
      title: "Rose Hale v3",
      bodyHtml: "<p>Rose married Walter.</p>",
    },
    {
      id: OTHER_PAGE,
      slug: "revisions-fixture-thomas-hale",
      title: "Thomas Hale",
      bodyHtml: "<p>Thomas.</p>",
    },
  ]);

  // Distinct, explicit timestamps rather than three inserts a millisecond
  // apart — the ordering assertion should not depend on how fast the test
  // machine happens to run.
  await db.insert(schema.revisions).values([
    {
      id: REVISION_OLDEST,
      pageId: PAGE,
      title: "Rose Hale v1",
      bodyHtml: "<p>v1.</p>",
      createdBy: AUTHOR,
      createdAt: new Date("2024-01-01T00:00:00Z"),
    },
    {
      id: REVISION_MIDDLE,
      pageId: PAGE,
      title: "Rose Hale v2",
      bodyHtml: "<p>v2.</p>",
      createdBy: AUTHOR,
      createdAt: new Date("2024-06-01T00:00:00Z"),
    },
    {
      id: REVISION_NEWEST,
      pageId: PAGE,
      title: "Rose Hale v3",
      bodyHtml: "<p>Rose married Walter.</p>",
      // Null on purpose — the case `formatRevisionAuthor` exists for.
      createdBy: null,
      createdAt: new Date("2024-09-01T00:00:00Z"),
    },
    {
      id: OTHER_REVISION,
      pageId: OTHER_PAGE,
      title: "Thomas Hale v1",
      bodyHtml: "<p>Thomas v1.</p>",
      createdBy: AUTHOR,
      createdAt: new Date("2024-05-01T00:00:00Z"),
    },
  ]);
});

afterAll(removeFixture);

describe("listRevisionsForPage", () => {
  it("returns a page's revisions newest first", async () => {
    const revisions = await listRevisionsForPage(PAGE);

    expect(revisions.map((r) => r.id)).toEqual([
      REVISION_NEWEST,
      REVISION_MIDDLE,
      REVISION_OLDEST,
    ]);
  });

  it("does not include another page's revisions", async () => {
    const revisions = await listRevisionsForPage(PAGE);

    expect(revisions.map((r) => r.id)).not.toContain(OTHER_REVISION);
  });

  it("scopes correctly for the other page too", async () => {
    const revisions = await listRevisionsForPage(OTHER_PAGE);

    expect(revisions.map((r) => r.id)).toEqual([OTHER_REVISION]);
  });

  it("returns an empty list for a page with no revisions", async () => {
    // A page can exist with no history at all — `db/seed.ts` inserts pages
    // but no revisions. Exercised properly with a real (fixture) row rather
    // than an unknown id, since an unknown id would pass for the wrong
    // reason.
    const bareId = "00000000-0000-4000-8000-00000000f003";
    await db.delete(schema.pages).where(inArray(schema.pages.id, [bareId]));
    await db.insert(schema.pages).values({
      id: bareId,
      slug: "revisions-fixture-bare",
      title: "No history yet",
      bodyHtml: "",
    });

    try {
      await expect(listRevisionsForPage(bareId)).resolves.toEqual([]);
    } finally {
      await db.delete(schema.pages).where(inArray(schema.pages.id, [bareId]));
    }
  });

  it("carries no bodyHtml key on the summary rows", async () => {
    const [revision] = await listRevisionsForPage(PAGE);

    expect(revision).not.toHaveProperty("bodyHtml");
    expect(Object.keys(revision).sort()).toEqual(
      ["createdAt", "createdBy", "id"].sort(),
    );
  });

  it("carries the author, including the null case", async () => {
    const revisions = await listRevisionsForPage(PAGE);

    expect(
      revisions.find((r) => r.id === REVISION_NEWEST)?.createdBy,
    ).toBeNull();
    expect(revisions.find((r) => r.id === REVISION_OLDEST)?.createdBy).toBe(
      AUTHOR,
    );
  });
});

describe("getRevisionById", () => {
  it("returns the full row, including the body and the owning page", async () => {
    await expect(getRevisionById(REVISION_MIDDLE)).resolves.toEqual({
      id: REVISION_MIDDLE,
      pageId: PAGE,
      title: "Rose Hale v2",
      bodyHtml: "<p>v2.</p>",
      hatnote: "",
      createdAt: new Date("2024-06-01T00:00:00Z"),
      createdBy: AUTHOR,
      // Null, because this fixture row is an ordinary save rather than a
      // restore (E1-T7). Asserted rather than left out of the object: this
      // `toEqual` is exact on purpose, so a column added to the select
      // without a decision about what it means to a reader fails here.
      restoredFromId: null,
    });
  });

  it("returns undefined for an id no row holds", async () => {
    await expect(getRevisionById(UNKNOWN_REVISION)).resolves.toBeUndefined();
  });
});
