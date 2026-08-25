import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import {
  findExistingSlugs,
  getPageBySlug,
  listPages,
  searchEntries,
} from "@/lib/pages";

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
      // Empty, because this fixture never set one — which is what the column's
      // `default ''` means for every row that predates it (E11-T9, `YEO-79`).
      hatnote: "",
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

/**
 * Full-text search over entries (E8-T1, `YEO-55`), which is almost entirely a
 * property of Postgres and therefore almost entirely untestable in the suite
 * CI runs. `lib/entry-search.test.ts` owns the reading of a `ts_headline`
 * string; every acceptance criterion below it — the generated column, the GIN
 * index, tags not being indexed, a title outranking a body, a snippet showing
 * the term in context — is expressed in SQL, so this is where they are
 * checked.
 *
 * The fixture uses invented words ("quernstone", "carbuncle") rather than
 * ordinary ones, for the same reason the ids are explicit: these tests run
 * against a database that already has entries in it, and an assertion about
 * *ranking* cannot simply filter down to its own rows if a real entry can
 * outrank them out of the result set entirely.
 */
describe("searchEntries", () => {
  const TITLE_MATCH_ID = "00000000-0000-4000-8000-00000000e101";
  const BODY_MATCH_ID = "00000000-0000-4000-8000-00000000e102";
  const PROSE_ID = "00000000-0000-4000-8000-00000000e103";
  const MARKUP_ID = "00000000-0000-4000-8000-00000000e104";
  const REWRITTEN_ID = "00000000-0000-4000-8000-00000000e105";

  const SEARCH_FIXTURE = [
    {
      id: TITLE_MATCH_ID,
      title: "Quernstone Mill",
      // Says it once, in the title, and never in the body.
      bodyHtml: "<p>A watermill on the river, in the family since 1840.</p>",
    },
    {
      id: BODY_MATCH_ID,
      title: "The River Farm",
      // Says it eight times, in the body, and never in the title. This is the
      // entry that must not win.
      bodyHtml: `<p>${"quernstone ".repeat(8).trim()}</p>`,
    },
    {
      id: PROSE_ID,
      title: "Marriage Records",
      bodyHtml:
        "<p>Rose and Walter were <em>married</em> at the quernstone chapel" +
        " in 1902, and the parish record of it survives to this day.</p>",
    },
    {
      id: MARKUP_ID,
      title: "Sources",
      // Every searchable-looking string here is markup rather than prose: a
      // tag name, an attribute name, and a URL inside an attribute value.
      bodyHtml:
        '<p>A <em>note</em> with <a href="https://carbuncle.example/deeds">a' +
        " source</a>.</p>",
    },
    {
      id: REWRITTEN_ID,
      title: "Notebook",
      bodyHtml: "<p>Nothing much yet.</p>",
    },
  ].map((entry) => ({
    ...entry,
    slug: `search-fixture-${entry.id.slice(-4)}`,
  }));

  const SEARCH_IDS = SEARCH_FIXTURE.map((entry) => entry.id);
  const SEARCH_ID_SET = new Set(SEARCH_IDS);

  async function removeSearchFixture() {
    await db.delete(schema.pages).where(inArray(schema.pages.id, SEARCH_IDS));
  }

  /** This file's own matches, in the order `searchEntries` ranked them. */
  async function fixtureMatches(query: string, limit?: number) {
    const matches = await searchEntries(
      query,
      limit === undefined ? {} : { limit },
    );
    return matches.filter((match) => SEARCH_ID_SET.has(match.id));
  }

  beforeAll(async () => {
    await removeSearchFixture();
    await db.insert(schema.pages).values(SEARCH_FIXTURE);
  });

  afterAll(removeSearchFixture);

  describe("the column and the index", () => {
    it("keeps the vector as a generated column, not a trigger", async () => {
      const rows = await db.execute<{
        is_generated: string;
        generation_expression: string | null;
      }>(sql`
        select is_generated, generation_expression
        from information_schema.columns
        where table_name = 'pages' and column_name = 'search_vector'
      `);

      // "ALWAYS" is what makes every write path correct by construction: no
      // save action, seed script or hand-typed UPDATE can produce a row whose
      // vector disagrees with its text.
      expect(rows[0]?.is_generated).toBe("ALWAYS");

      // And it is the expression `db/schema.ts` describes: both columns, at
      // the two weights the ranking depends on.
      const expression = rows[0]?.generation_expression ?? "";
      expect(expression).toContain("title");
      expect(expression).toContain("body_html");
      expect(expression).toContain("'A'");
      expect(expression).toContain("'B'");
    });

    it("indexes the vector with GIN", async () => {
      const rows = await db.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes
        where tablename = 'pages' and indexname = 'pages_search_vector_idx'
      `);

      expect(rows[0]?.indexdef).toContain("USING gin");
      expect(rows[0]?.indexdef).toContain("search_vector");
    });
  });

  describe("what is searched", () => {
    it("finds an entry by a word written in its body", async () => {
      const ids = (await fixtureMatches("quernstone")).map((m) => m.id);

      // The title-only entry, the body-only entry, and the one that says it
      // in prose — all three, because the vector covers both columns.
      expect(new Set(ids)).toEqual(
        new Set([TITLE_MATCH_ID, BODY_MATCH_ID, PROSE_ID]),
      );
    });

    it("matches a word by its stem rather than its spelling", async () => {
      // The entry says "married"; nobody types that into a search box.
      const ids = (await fixtureMatches("marriages")).map((m) => m.id);
      expect(ids).toContain(PROSE_ID);
    });

    it("indexes the text content, not the HTML tags", async () => {
      // A tag name, an attribute name, and a host out of an `href`. Every one
      // of them is in `MARKUP_ID`'s stored HTML and none of them is text a
      // reader ever sees, so none of them is a way to find the entry.
      for (const query of ["carbuncle", "href", "https"]) {
        expect(await fixtureMatches(query)).toEqual([]);
      }

      // The prose in the same entry is found, which is what makes the four
      // assertions above about markup rather than about an unsearchable row.
      expect((await fixtureMatches("deeds")).map((m) => m.id)).toEqual([]);
      expect((await fixtureMatches("note source")).map((m) => m.id)).toEqual([
        MARKUP_ID,
      ]);
    });
  });

  describe("ranking", () => {
    it("ranks a title match above a body match, however often the body says it", async () => {
      const ids = (await fixtureMatches("quernstone")).map((m) => m.id);

      // One mention in a title beats eight in a body. This is arithmetic
      // rather than a tie-break: `ts_rank` caps a `B` lexeme at 0.4 and a
      // single `A` occurrence already scores about 0.61. See `db/schema.ts`.
      expect(ids.indexOf(TITLE_MATCH_ID)).toBeLessThan(
        ids.indexOf(BODY_MATCH_ID),
      );
    });

    it("returns at most the limit it was given", async () => {
      expect(await fixtureMatches("quernstone", 2)).toHaveLength(2);
    });
  });

  describe("snippets", () => {
    it("shows the matched term in context", async () => {
      const [match] = await fixtureMatches("married");
      expect(match.id).toBe(PROSE_ID);

      const marked = match.snippet.filter((segment) => segment.matched);
      expect(marked.map((segment) => segment.text)).toEqual(["married"]);

      // In context, not on its own: the sentence around it comes back too.
      const text = match.snippet.map((segment) => segment.text).join("");
      expect(text).toContain("Rose and Walter were married at the");
    });

    it("leaves no markup in the snippet", async () => {
      const [match] = await fixtureMatches("married");
      const text = match.snippet.map((segment) => segment.text).join("");

      // The `<em>` around "married" and the `<p>` around the sentence are
      // both gone, and the words either side of the `<em>` did not run
      // together where it used to be.
      expect(text).not.toContain("<");
      expect(text).not.toContain("em>");
      expect(text).toContain("were married at");
    });

    it("gives an entry matched only by its title a snippet of its opening", async () => {
      const [match] = await fixtureMatches("quernstone");
      expect(match.id).toBe(TITLE_MATCH_ID);

      // Nothing in the body matched, so nothing in the snippet is marked —
      // but the reader still gets to see what the entry is about.
      expect(match.snippet.every((segment) => !segment.matched)).toBe(true);
      expect(match.snippet.map((segment) => segment.text).join("")).toContain(
        "A watermill on the river",
      );
    });
  });

  describe("keeping up with the writes", () => {
    it("re-indexes an entry when its body is rewritten", async () => {
      // Nothing in the application does this. `lib/save-page.ts` writes
      // `body_html` and knows nothing about `search_vector`; Postgres
      // recomputes it as part of the same UPDATE, which is the whole argument
      // for a generated column over a trigger.
      expect(
        (await fixtureMatches("quernstone")).map((m) => m.id),
      ).not.toContain(REWRITTEN_ID);

      await db
        .update(schema.pages)
        .set({ bodyHtml: "<p>The quernstone is in the barn.</p>" })
        .where(eq(schema.pages.id, REWRITTEN_ID));

      expect((await fixtureMatches("quernstone")).map((m) => m.id)).toContain(
        REWRITTEN_ID,
      );

      await db
        .update(schema.pages)
        .set({ bodyHtml: "<p>Nothing much yet.</p>" })
        .where(eq(schema.pages.id, REWRITTEN_ID));

      expect(
        (await fixtureMatches("quernstone")).map((m) => m.id),
      ).not.toContain(REWRITTEN_ID);
    });
  });

  describe("what a search box gets typed into it", () => {
    it("returns nothing for a blank query", async () => {
      expect(await searchEntries("   ")).toEqual([]);
    });

    it("returns nothing for a query with no lexemes in it", async () => {
      // A stop word and punctuation both parse to an empty tsquery, which
      // matches no row — rather than raising the syntax error `to_tsquery`
      // would, which would turn a typo into a 500.
      expect(await fixtureMatches("the")).toEqual([]);
      expect(await fixtureMatches("!!! ???")).toEqual([]);
    });

    it("honours the search-box syntax people already type", async () => {
      // `websearch_to_tsquery`, not `plainto_tsquery`: a quoted phrase is a
      // phrase, and a leading `-` excludes.
      expect(
        (await fixtureMatches('"quernstone chapel"')).map((m) => m.id),
      ).toEqual([PROSE_ID]);

      const excluded = (await fixtureMatches("quernstone -chapel")).map(
        (m) => m.id,
      );
      expect(excluded).not.toContain(PROSE_ID);
      expect(excluded).toContain(TITLE_MATCH_ID);
    });

    it("parameterises the query instead of interpolating it", async () => {
      // This is whatever a signed-in reader typed, against a database with no
      // RLS and one role for the whole application.
      expect(await searchEntries("' OR 1=1 --")).toEqual([]);
      expect(await searchEntries("'); drop table pages; --")).toEqual([]);

      // And the table is still there.
      expect(await getPageBySlug(SLUG)).toBeDefined();
    });
  });
});
