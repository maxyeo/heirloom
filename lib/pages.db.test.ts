import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { findExistingSlugs, getPageBySlug, listPages } from "@/lib/pages";

/**
 * `getPageBySlug` is one `WHERE slug = $1`, so most of it is not worth a test.
 * What is worth a test is the part only Postgres can answer, and that is how
 * the comparison behaves on input taken straight from a URL:
 *
 *   - a miss comes back as `undefined`, which is what the read route turns
 *     into a 404;
 *   - the match is exact and case-sensitive, so `/wiki/Rose` is a different
 *     address from `/wiki/rose` rather than a second door onto one entry;
 *   - the slug is parameterised, not interpolated.
 *
 * Every one of those lives in SQL. Mocking the query would assert only that
 * the mock returned what the mock was told to return. See docs/testing.md.
 */

/**
 * `listPages` is the other half of this module, and what is worth proving
 * about it is narrower than it looks. The *ordering* is deliberately not in
 * SQL — see the function's own header, and `lib/page-index.test.ts`, which
 * checks the comparator under `npm test` where CI can see it. What only a real
 * Postgres can answer is what comes back out of the driver: that every row is
 * there, that `updated_at` arrives as a usable `Date` rather than a string,
 * and that the select stayed narrow.
 *
 * The last of those is checked here rather than by the compiler on purpose.
 * `WikiEntrySummary` constrains what a *caller* may read; it does nothing
 * about what the query actually asked Postgres for, and a `bodyHtml` added to
 * the select and not to the type would type-check perfectly while shipping
 * every article's HTML to a route that renders none of it.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made.
const ENTRY_ID = "00000000-0000-4000-8000-00000000e001";
const SLUG = "pages-fixture-rose-hale";
const BODY = "<p>Rose married Walter.</p>";

/**
 * The rest of the corpus this file inserts, to have something for `listPages`
 * to order. The titles are chosen to be the cases the database gets wrong on
 * its own: a lowercase initial and an accented one, which a `C`-collated
 * Postgres sorts after *every* capitalised title.
 */
const INDEX_FIXTURE = [
  { id: "00000000-0000-4000-8000-00000000e002", title: "Zoe Hale" },
  { id: "00000000-0000-4000-8000-00000000e003", title: "alice hale" },
  { id: "00000000-0000-4000-8000-00000000e004", title: "Émile Hale" },
  { id: "00000000-0000-4000-8000-00000000e005", title: "Ada Hale" },
].map((entry) => ({
  ...entry,
  slug: `pages-fixture-${entry.id.slice(-4)}`,
  bodyHtml: "",
}));

const FIXTURE_IDS = [ENTRY_ID, ...INDEX_FIXTURE.map((entry) => entry.id)];
const FIXTURE_SLUGS = new Set([SLUG, ...INDEX_FIXTURE.map((e) => e.slug)]);

async function removeFixture() {
  await db.delete(schema.pages).where(inArray(schema.pages.id, FIXTURE_IDS));
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and would
  // otherwise greet the next one with a duplicate key on a unique slug.
  await removeFixture();

  await db
    .insert(schema.pages)
    .values([
      { id: ENTRY_ID, slug: SLUG, title: "Rose Hale", bodyHtml: BODY },
      ...INDEX_FIXTURE,
    ]);
});

afterAll(removeFixture);

describe("getPageBySlug", () => {
  it("returns the entry stored under the slug", async () => {
    await expect(getPageBySlug(SLUG)).resolves.toEqual({
      id: ENTRY_ID,
      slug: SLUG,
      title: "Rose Hale",
      bodyHtml: BODY,
    });
  });

  it("returns undefined when no row holds the slug", async () => {
    await expect(getPageBySlug(`${SLUG}-nonexistent`)).resolves.toBeUndefined();
  });

  it("matches the slug exactly, case included", async () => {
    // Postgres `=` on `text` is case-sensitive. Worth pinning because the
    // alternative — a case-insensitive lookup — is a decision to make on
    // purpose (with a functional index), not one to discover from a bug.
    await expect(getPageBySlug(SLUG.toUpperCase())).resolves.toBeUndefined();
  });

  it("parameterises the slug instead of interpolating it", async () => {
    // The slug is a URL segment, so this is reachable by anyone who can sign
    // in, against a database with no RLS and one role for the whole app.
    // Interpolated, this would return the fixture row; parameterised, it is
    // just a slug that happens to contain punctuation, and matches nothing.
    await expect(getPageBySlug("' OR 1=1 --")).resolves.toBeUndefined();
  });
});

describe("listPages", () => {
  /** This file's own rows, in the order `listPages` put them. */
  async function fixtureRows() {
    const entries = await listPages();
    return entries.filter((entry) => FIXTURE_SLUGS.has(entry.slug));
  }

  it("returns every entry, not a page of them", async () => {
    // The ticket is explicit that there is no pagination, so the guarantee
    // worth pinning is that nothing was left behind: five rows in, five out.
    expect(await fixtureRows()).toHaveLength(FIXTURE_SLUGS.size);
  });

  it("orders titles the way a reader reads them, not the way the database does", async () => {
    // Under this database's collation `ORDER BY title` would answer "Ada Hale,
    // Rose Hale, Zoe Hale, alice hale, Émile Hale". That it does not is the
    // whole reason the sort is in TypeScript.
    const titles = (await fixtureRows()).map((entry) => entry.title);

    expect(titles).toEqual([
      "Ada Hale",
      "alice hale",
      "Émile Hale",
      "Rose Hale",
      "Zoe Hale",
    ]);
  });

  it("hands back updated_at as a Date the formatter can take", async () => {
    // postgres.js can return a timestamp as a string depending on how the
    // column is declared, and `formatUpdatedAt` takes a `Date`. TypeScript
    // believes Drizzle's mapping here; this is the assertion that checks it.
    const [entry] = await fixtureRows();

    expect(entry.updatedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(entry.updatedAt.getTime())).toBe(false);
  });

  it("selects no more of a row than the index renders", async () => {
    // Specifically: not `body_html`. A few hundred entries of article HTML
    // fetched for a list that shows none of it is the one way this query gets
    // expensive, and widening the select would not fail the type-check.
    const [entry] = await fixtureRows();

    expect(Object.keys(entry).sort()).toEqual(["slug", "title", "updatedAt"]);
  });
});

describe("findExistingSlugs", () => {
  /**
   * Red-link resolution (E11-T6). The part only Postgres can answer is how
   * `IN` behaves on values taken out of stored HTML: which of them come back,
   * that a miss is simply absent rather than an error, and that the list is
   * parameterised rather than interpolated.
   *
   * The *count* of queries is the other half of this function's contract, and
   * it is asserted where CI can see it — `lib/red-links.test.ts` drives
   * `resolveEntryLinks` against a recording lookup. There is nothing a real
   * database adds to that assertion.
   */

  it("returns the subset that exists", async () => {
    const wanted = [SLUG, `${SLUG}-nonexistent`, INDEX_FIXTURE[0].slug];

    await expect(findExistingSlugs(wanted)).resolves.toEqual(
      new Set([SLUG, INDEX_FIXTURE[0].slug]),
    );
  });

  it("answers an all-missing request without an error", async () => {
    // The common case for a young wiki: every link is red.
    await expect(
      findExistingSlugs([`${SLUG}-a`, `${SLUG}-b`]),
    ).resolves.toEqual(new Set());
  });

  it("answers an empty request without reaching the database", async () => {
    // `inArray` on an empty list is SQL Drizzle has to special-case, and a
    // body with no links should not ask at all.
    await expect(findExistingSlugs([])).resolves.toEqual(new Set());
  });

  it("collapses a slug asked for more than once", async () => {
    // An entry linked nine times is one value in the `IN` list, and one
    // member of the answer.
    await expect(findExistingSlugs([SLUG, SLUG, SLUG])).resolves.toEqual(
      new Set([SLUG]),
    );
  });

  it("matches slugs exactly, case included", async () => {
    // Same rule as `getPageBySlug`, and it has to stay the same rule: a link
    // resolving under a comparison the page route would 404 on would render
    // blue and lead nowhere.
    await expect(findExistingSlugs([SLUG.toUpperCase()])).resolves.toEqual(
      new Set(),
    );
  });

  it("parameterises the slugs instead of interpolating them", async () => {
    // These come out of stored HTML, which is authored content — reachable by
    // anyone who can sign in, against a database with no RLS.
    await expect(
      findExistingSlugs(["' OR 1=1 --", `'); drop table pages; --`]),
    ).resolves.toEqual(new Set());
  });
});
