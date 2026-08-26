import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import {
  deleteCategory,
  getCategoryBySlug,
  listCategories,
  listEntriesInCategory,
  readEntryCategories,
  setEntryCategories,
} from "@/lib/categories";
import { raceWriters } from "@/test/db-concurrency";

/**
 * Database tests for categories (E11-T8, `YEO-78`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * Everything asserted here is a property of Postgres rather than of
 * TypeScript: the `on delete cascade` that makes retiring a category a
 * detachment, the unique index that decides who creates one, and the
 * join-row diff. What a *name* means is decided in `lib/category-name.ts` and
 * asserted against literals beside it, with no database at all.
 */

// Explicit ids, so teardown deletes precisely what this file created and
// assertions can ignore whatever else the database already holds.
const PAGE = "00000000-0000-4000-8000-0000000c0001";
const OTHER_PAGE = "00000000-0000-4000-8000-0000000c0002";
const SLUG = "categories-fixture-rose";
const OTHER_SLUG = "categories-fixture-thomas";

/**
 * Every category this file creates derives to a slug under one recognisable
 * prefix, so teardown can delete exactly those and leave a developer's own
 * categories alone. `slugFromTitle` lowercases and hyphenates, so the names
 * below all begin `categories-fixture-`.
 */
const PREFIX = "Categories Fixture";
const CATEGORY_SLUG_PREFIX = "categories-fixture";

function name(suffix: string): string {
  return `${PREFIX} ${suffix}`;
}

async function removeFixture() {
  // The join rows go with either end, so deleting both ends is enough.
  await db
    .delete(schema.pages)
    .where(inArray(schema.pages.id, [PAGE, OTHER_PAGE]));
  await db
    .delete(schema.categories)
    .where(like(schema.categories.slug, `${CATEGORY_SLUG_PREFIX}%`));
}

/** File an entry, in a transaction of its own, the way `savePage` does. */
async function file(pageId: string, names: readonly string[]) {
  return db.transaction((tx) => setEntryCategories(tx, pageId, names));
}

async function joinRowsFor(pageId: string) {
  return db
    .select()
    .from(schema.pageCategories)
    .where(eq(schema.pageCategories.pageId, pageId));
}

afterAll(removeFixture);

/**
 * Rebuilt before every test rather than once for the file, because these tests
 * write — a shared fixture would make each assertion depend on the order the
 * ones before it ran in. Cleaning up before inserting as well as after also
 * means an interrupted run, which skips `afterAll`, does not greet the next one
 * with a duplicate key on these fixed ids.
 */
beforeEach(async () => {
  await removeFixture();

  await db.insert(schema.pages).values([
    { id: PAGE, slug: SLUG, title: "Rose Fixture", bodyHtml: "" },
    { id: OTHER_PAGE, slug: OTHER_SLUG, title: "Thomas Fixture", bodyHtml: "" },
  ]);
});

describe("filing an entry", () => {
  it("creates the categories it has not seen before", async () => {
    const changed = await file(PAGE, [name("Emigrated"), name("Kilkenny")]);

    expect(changed).toBe(true);
    expect((await readEntryCategories(PAGE)).map((c) => c.name)).toEqual([
      name("Emigrated"),
      name("Kilkenny"),
    ]);
  });

  it("reuses a category another entry already created", async () => {
    await file(PAGE, [name("Emigrated")]);
    await file(OTHER_PAGE, [name("Emigrated")]);

    const rows = await db
      .select()
      .from(schema.categories)
      .where(like(schema.categories.slug, `${CATEGORY_SLUG_PREFIX}%`));

    // One row, two entries filed under it — which is the entire point of a
    // join table rather than a column of text on each entry.
    expect(rows).toHaveLength(1);
    expect(await listEntriesInCategory(rows[0].id)).toHaveLength(2);
  });

  it("reads two spellings of one heading as one category", async () => {
    await file(PAGE, [name("Emigrated")]);
    await file(OTHER_PAGE, [name("Emigrated").toUpperCase()]);

    const rows = await db
      .select()
      .from(schema.categories)
      .where(like(schema.categories.slug, `${CATEGORY_SLUG_PREFIX}%`));

    expect(rows).toHaveLength(1);
    // And the *first* author's spelling is the one on the bar: re-typing a
    // name with different capitalisation is not a rename. See
    // `setEntryCategories`.
    expect(rows[0].name).toBe(name("Emigrated"));
  });

  it("reports no change when the filing is already what was asked for", async () => {
    await file(PAGE, [name("Emigrated")]);

    // The no-op rule `savePage` depends on: an author who opens the editor and
    // presses Save without touching anything must not move `updated_at`.
    expect(await file(PAGE, [name("Emigrated")])).toBe(false);
    // Including through normalisation — this is the same request, differently
    // typed.
    expect(await file(PAGE, [`  ${name("Emigrated")}  `])).toBe(false);
  });

  it("detaches the ones that were taken away and keeps the rest", async () => {
    await file(PAGE, [name("Emigrated"), name("Kilkenny")]);

    expect(await file(PAGE, [name("Kilkenny"), name("Whitfield")])).toBe(true);
    expect((await readEntryCategories(PAGE)).map((c) => c.name)).toEqual([
      name("Kilkenny"),
      name("Whitfield"),
    ]);

    // The category itself survives being unfiled from its last entry: a
    // heading somebody named is not garbage to be collected the moment it is
    // empty. See `app/wiki/category/[slug]/page.tsx`.
    expect(
      await getCategoryBySlug(`${CATEGORY_SLUG_PREFIX}-emigrated`),
    ).toBeDefined();
  });

  it("un-files an entry completely when given no categories", async () => {
    await file(PAGE, [name("Emigrated")]);

    expect(await file(PAGE, [])).toBe(true);
    expect(await readEntryCategories(PAGE)).toEqual([]);
    expect(await joinRowsFor(PAGE)).toEqual([]);
  });

  it("leaves other entries' filings alone", async () => {
    await file(PAGE, [name("Emigrated")]);
    await file(OTHER_PAGE, [name("Emigrated")]);

    await file(PAGE, []);

    expect(await readEntryCategories(PAGE)).toEqual([]);
    expect((await readEntryCategories(OTHER_PAGE)).map((c) => c.name)).toEqual([
      name("Emigrated"),
    ]);
  });
});

describe("two authors creating the same category at once", () => {
  it("produces one category, and files both entries under it", async () => {
    /**
     * The race a check-then-insert would lose. Both writers look for the same
     * brand-new name, both find nothing, and both insert — so without
     * `on conflict do nothing` in `resolveCategories` one of them takes a
     * unique violation and rolls back a save that had nothing wrong with it.
     *
     * Per `test/db-concurrency.ts`: a green race test is evidence rather than
     * proof, and the way to check it is real is to remove the conflict clause
     * and watch this fail. It does — with
     * `duplicate key value violates unique constraint "categories_slug_unique"`.
     */
    const shared = name("Simultaneous");

    await raceWriters([
      () => file(PAGE, [shared]),
      () => file(OTHER_PAGE, [shared]),
    ]);

    const rows = await db
      .select()
      .from(schema.categories)
      .where(
        eq(schema.categories.slug, `${CATEGORY_SLUG_PREFIX}-simultaneous`),
      );

    expect(rows).toHaveLength(1);
    expect(await listEntriesInCategory(rows[0].id)).toHaveLength(2);
  });
});

describe("retiring a category", () => {
  it("detaches it from entries rather than deleting them", async () => {
    /**
     * The ticket's last acceptance criterion, asserted rather than argued.
     *
     * It is a property of the schema: `page_categories` cascades from both of
     * its foreign keys, and no foreign key runs from `pages` to `categories`,
     * so there is no statement `deleteCategory` could issue that would reach an
     * entry. `db/schema.ts` has the reasoning; this is the proof.
     */
    await file(PAGE, [name("Emigrated"), name("Kilkenny")]);
    await file(OTHER_PAGE, [name("Emigrated")]);

    expect(await deleteCategory(`${CATEGORY_SLUG_PREFIX}-emigrated`)).toBe(
      true,
    );

    // Both entries are still there.
    const pages = await db
      .select({ id: schema.pages.id })
      .from(schema.pages)
      .where(inArray(schema.pages.id, [PAGE, OTHER_PAGE]));
    expect(pages).toHaveLength(2);

    // Detached from the retired category, and only from it.
    expect((await readEntryCategories(PAGE)).map((c) => c.name)).toEqual([
      name("Kilkenny"),
    ]);
    expect(await readEntryCategories(OTHER_PAGE)).toEqual([]);
  });

  it("reports whether there was one to retire", async () => {
    await file(PAGE, [name("Emigrated")]);

    expect(await deleteCategory(`${CATEGORY_SLUG_PREFIX}-emigrated`)).toBe(
      true,
    );
    // Twice is not an error — a second tab, or a back button onto a
    // confirmation for a category somebody has already retired.
    expect(await deleteCategory(`${CATEGORY_SLUG_PREFIX}-emigrated`)).toBe(
      false,
    );
  });
});

describe("deleting an entry", () => {
  it("takes its filings and leaves every category standing", async () => {
    // The other direction of the same cascade, and the one a category three
    // other entries are still using depends on.
    await file(PAGE, [name("Emigrated")]);
    await file(OTHER_PAGE, [name("Emigrated")]);

    await db.delete(schema.pages).where(eq(schema.pages.id, PAGE));

    const category = await getCategoryBySlug(
      `${CATEGORY_SLUG_PREFIX}-emigrated`,
    );
    expect(category).toBeDefined();
    if (!category) return;

    expect(
      (await listEntriesInCategory(category.id)).map((e) => e.slug),
    ).toEqual([OTHER_SLUG]);
  });
});

describe("reading", () => {
  it("orders an entry's categories the way a reader expects", async () => {
    // Alphabetically, and by `Intl.Collator` rather than by the database's
    // collation — which is `C` on a local `createdb` and `en_US.UTF-8` on
    // Supabase, and disagrees about every capital. See `lib/categories.ts`.
    await file(PAGE, [name("Whitfield"), name("emigrated"), name("Kilkenny")]);

    expect((await readEntryCategories(PAGE)).map((c) => c.name)).toEqual([
      name("emigrated"),
      name("Kilkenny"),
      name("Whitfield"),
    ]);
  });

  it("orders a category's entries alphabetically by title", async () => {
    await db
      .update(schema.pages)
      .set({ title: "zebra fixture" })
      .where(eq(schema.pages.id, PAGE));

    await file(PAGE, [name("Emigrated")]);
    await file(OTHER_PAGE, [name("Emigrated")]);

    const category = await getCategoryBySlug(
      `${CATEGORY_SLUG_PREFIX}-emigrated`,
    );
    expect(category).toBeDefined();
    if (!category) return;

    expect(
      (await listEntriesInCategory(category.id)).map((e) => e.title),
    ).toEqual(["Thomas Fixture", "zebra fixture"]);
  });

  it("includes a category nothing is filed under", async () => {
    // `listCategories` fills the picker, and a category whose last entry moved
    // is still one an author should be offered.
    await file(PAGE, [name("Emigrated")]);
    await file(PAGE, []);

    const ours = (await listCategories()).filter((category) =>
      category.slug.startsWith(CATEGORY_SLUG_PREFIX),
    );
    expect(ours.map((c) => c.name)).toEqual([name("Emigrated")]);
  });

  it("says nothing is there rather than throwing, for a slug no row holds", async () => {
    expect(
      await getCategoryBySlug(`${CATEGORY_SLUG_PREFIX}-nonexistent`),
    ).toBeUndefined();
  });
});
