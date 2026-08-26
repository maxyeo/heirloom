import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { listRecentChanges } from "@/lib/recent-changes";

/**
 * The half of E8-T4 that only a real Postgres can answer.
 *
 * `lib/recent-changes-feed.test.ts` owns the merge, the tie-break, the limit
 * and every formatter — all of that is arithmetic over plain values and runs
 * in `npm test`, where CI's `check` job can see it. What is left for this file
 * is what lives in SQL and would otherwise be asserted only by a mock
 * returning what the mock was told to return (docs/testing.md):
 *
 *   - the two `WHERE` clauses, which are the whole of the coordination
 *     between the three sources — an imported person must appear once, as
 *     part of their import, and not twice;
 *   - that a *released* import is still reported, which is a deliberate
 *     difference from `findImportByDigest`'s filter and the single most
 *     likely thing for a future edit to "fix" by mistake;
 *   - that the columns come back as usable JavaScript values, `Date`s
 *     included, rather than as strings;
 *   - and the ticket's index criterion, checked as a query plan rather than
 *     as a claim in a comment.
 *
 * ## Why the fixtures carry explicit timestamps
 *
 * Rather than `test/db-timestamps.ts`'s `backdatePages`, which exists to stop
 * a *relative* assertion ("the save moved `updated_at` forward") flaking when
 * two transactions land inside one millisecond. This file asserts an absolute
 * interleaving across three tables instead, so every fixture states its own
 * instant on the way in: the expected order is then a property of the data
 * rather than of how fast the machine inserted it, and a failure reads as a
 * wrong query rather than as a race.
 *
 * The instants are minutes apart and years in the past, so they cannot
 * collide with each other or with anything another file leaves behind.
 */

/**
 * Explicit, recognisable ids, so teardown deletes exactly what this file made
 * and the assertions can pick their own rows out of a database that already
 * has data in it. `58` is the ticket.
 */
const ENTRY_RECENT = "00000000-0000-4000-8000-000000005801";
const ENTRY_OLDER = "00000000-0000-4000-8000-000000005802";
const PERSON_TYPED_RECENT = "00000000-0000-4000-8000-000000005803";
const PERSON_TYPED_OLDER = "00000000-0000-4000-8000-000000005804";
const PERSON_IMPORTED = "00000000-0000-4000-8000-000000005805";
const IMPORT_LIVE = "00000000-0000-4000-8000-000000005806";
const IMPORT_RELEASED = "00000000-0000-4000-8000-000000005807";
const IMPORT_EMPTY = "00000000-0000-4000-8000-000000005808";

const PAGE_IDS = [ENTRY_RECENT, ENTRY_OLDER];
const PERSON_IDS = [PERSON_TYPED_RECENT, PERSON_TYPED_OLDER, PERSON_IMPORTED];
const IMPORT_IDS = [IMPORT_LIVE, IMPORT_RELEASED, IMPORT_EMPTY];

const SLUG_RECENT = "recent-changes-fixture-rose";
const SLUG_OLDER = "recent-changes-fixture-walter";

/** One afternoon, laid out so that the three sources have to interleave. */
const at = (hhmm: string) => new Date(`2024-06-01T${hhmm}:00.000Z`);

/**
 * Every fixture instant, and what the feed should do with it. Reading down
 * this list is reading the assertion in the first test.
 *
 *   13:00  an import that added nobody      excluded (individual_count = 0)
 *   12:00  an entry saved                   shown
 *   11:00  a person typed in                shown
 *   10:30  an import of three people        shown, once
 *   10:30  one of those three people        excluded (import_id is not null)
 *   09:00  an entry saved, by nobody        shown, author Unknown
 *   08:00  a person typed in                shown
 *   07:00  an import, since released        shown — releasing retracts nothing
 */
beforeAll(async () => {
  await db.insert(schema.pages).values([
    {
      id: ENTRY_RECENT,
      slug: SLUG_RECENT,
      title: "Rose Whitfield",
      bodyHtml: "<p>Rose married Walter.</p>",
      updatedAt: at("12:00"),
      updatedBy: "rose@example.com",
    },
    {
      id: ENTRY_OLDER,
      slug: SLUG_OLDER,
      title: "Walter Whitfield",
      bodyHtml: "<p>Walter farmed.</p>",
      updatedAt: at("09:00"),
      // Null on purpose: `db/seed.ts` and any row written by hand in a SQL
      // console have no signed-in author, and the feed has to render that.
      updatedBy: null,
    },
  ]);

  await db.insert(schema.gedcomImports).values([
    {
      id: IMPORT_LIVE,
      digest: "58".repeat(32),
      fileName: "whitfield.ged",
      byteCount: 4096,
      individualCount: 3,
      unionCount: 1,
      unionChildCount: 1,
      importedAt: at("10:30"),
      importedBy: "walter@example.com",
    },
    {
      id: IMPORT_RELEASED,
      digest: "59".repeat(32),
      fileName: "old-attempt.ged",
      byteCount: 2048,
      individualCount: 5,
      unionCount: 0,
      unionChildCount: 0,
      importedAt: at("07:00"),
      importedBy: "walter@example.com",
      // Released, which gives up this digest's claim and removes nothing.
      releasedAt: at("07:30"),
      releasedBy: "walter@example.com",
    },
    {
      id: IMPORT_EMPTY,
      digest: "5a".repeat(32),
      fileName: "unions-only.ged",
      byteCount: 512,
      individualCount: 0,
      unionCount: 2,
      unionChildCount: 0,
      importedAt: at("13:00"),
      importedBy: "walter@example.com",
    },
  ]);

  await db.insert(schema.individuals).values([
    {
      id: PERSON_TYPED_RECENT,
      givenName: "Agnes",
      // Null on purpose: for the oldest generations a surname is routinely
      // unknown, and `formatPersonName` has to drop it rather than leave a
      // trailing space behind the given name.
      surname: null,
      createdAt: at("11:00"),
    },
    {
      id: PERSON_TYPED_OLDER,
      givenName: "Thomas",
      surname: "Whitfield",
      createdAt: at("08:00"),
    },
    {
      id: PERSON_IMPORTED,
      givenName: "Imported",
      surname: "Person",
      createdAt: at("10:30"),
      importId: IMPORT_LIVE,
    },
  ]);
});

afterAll(async () => {
  // People first: `individuals.import_id` is `on delete set null`, so the
  // order is not strictly required, but deleting a child before its parent is
  // the habit that keeps a future foreign key from turning teardown red.
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PERSON_IDS));
  await db
    .delete(schema.gedcomImports)
    .where(inArray(schema.gedcomImports.id, IMPORT_IDS));
  await db.delete(schema.pages).where(inArray(schema.pages.id, PAGE_IDS));
});

/**
 * The feed, narrowed to this file's own rows.
 *
 * The limit is generous rather than the default: these tests run against a
 * database that may hold other files' fixtures, and truncating to ten before
 * filtering would make the assertions depend on what else happens to be in
 * the table. The default limit is checked in
 * `lib/recent-changes-feed.test.ts`, over data nothing else can touch.
 */
async function fixtureFeed() {
  const changes = await listRecentChanges(500);

  return changes.filter((change) => {
    switch (change.kind) {
      case "entry-changed":
        return [SLUG_RECENT, SLUG_OLDER].includes(change.slug);
      case "person-added":
        return PERSON_IDS.includes(change.personId);
      case "people-imported":
        return IMPORT_IDS.includes(change.importId);
    }
  });
}

describe("listRecentChanges", () => {
  it("interleaves entries, people and imports into one order", async () => {
    const feed = await fixtureFeed();

    /*
      One assertion, because the interesting behaviour is the *whole* order —
      asserting each rule separately would let a query that got two of them
      right and dropped a row in between still pass. Reading it top to bottom
      is reading the table in this file's header: the two exclusions are the
      rows that are not here, and the released import is the row that is.
    */
    expect(feed).toEqual([
      {
        kind: "entry-changed",
        slug: SLUG_RECENT,
        title: "Rose Whitfield",
        when: at("12:00"),
        editor: "rose@example.com",
      },
      {
        kind: "person-added",
        personId: PERSON_TYPED_RECENT,
        // The surname was null, so the name is the given name and no more.
        name: "Agnes",
        when: at("11:00"),
      },
      {
        kind: "people-imported",
        importId: IMPORT_LIVE,
        fileName: "whitfield.ged",
        personCount: 3,
        when: at("10:30"),
        importedBy: "walter@example.com",
      },
      {
        kind: "entry-changed",
        slug: SLUG_OLDER,
        title: "Walter Whitfield",
        when: at("09:00"),
        editor: null,
      },
      {
        kind: "person-added",
        personId: PERSON_TYPED_OLDER,
        name: "Thomas Whitfield",
        when: at("08:00"),
      },
      {
        kind: "people-imported",
        importId: IMPORT_RELEASED,
        fileName: "old-attempt.ged",
        personCount: 5,
        when: at("07:00"),
        importedBy: "walter@example.com",
      },
    ]);
  });

  it("reports an imported person once, as their import", async () => {
    const feed = await fixtureFeed();

    // Stated on its own as well as inside the order above, because this is
    // the predicate whose absence would not fail loudly: the feed would still
    // render, and would simply be three hundred rows of one afternoon's file.
    const people = feed.filter((change) => change.kind === "person-added");
    expect(people.map((person) => person.personId)).not.toContain(
      PERSON_IMPORTED,
    );

    const imports = feed.filter((change) => change.kind === "people-imported");
    expect(imports.map((entry) => entry.importId)).toContain(IMPORT_LIVE);
  });

  it("still reports an import whose digest claim was released", async () => {
    const feed = await fixtureFeed();
    const imports = feed.filter((change) => change.kind === "people-imported");

    /*
      The difference from `findImportByDigest`, which filters released rows
      out. The two answer different questions: that one asks whether pressing
      Import will be refused, and only a live claim refuses anything; this one
      asks what happened, and a released import happened. `db/schema.ts` is
      explicit that releasing "removes nothing the earlier import wrote".
    */
    expect(imports.map((entry) => entry.importId)).toContain(IMPORT_RELEASED);
  });

  it("does not report an import that added nobody", async () => {
    const feed = await fixtureFeed();
    const imports = feed.filter((change) => change.kind === "people-imported");

    // A file of unions for people already present. "0 people imported from
    // unions-only.ged" is a sentence answering a question nobody asked — and
    // note this row is the *newest* fixture, so a missing predicate would put
    // it at the top of the feed.
    expect(imports.map((entry) => entry.importId)).not.toContain(IMPORT_EMPTY);
  });

  it("brings timestamps back as Dates rather than strings", async () => {
    const [newest] = await fixtureFeed();

    // What the driver hands back, which nothing in TypeScript can promise:
    // `mergeRecentChanges` calls `.getTime()` and the component calls
    // `.toISOString()`, and a string would satisfy neither while type-checking
    // perfectly at every layer in between.
    expect(newest?.when).toBeInstanceOf(Date);
    expect(newest?.when.toISOString()).toBe("2024-06-01T12:00:00.000Z");
  });

  it("selects no more of an entry than the feed renders", async () => {
    const [newest] = await fixtureFeed();

    /*
      Checked here rather than by the compiler, for the reason
      `lib/pages.db.test.ts` gives about its own narrow select: `RecentChange`
      constrains what a *caller* may read and says nothing about what the query
      asked Postgres for. A `bodyHtml` added to the select and not to the type
      would type-check perfectly while shipping every recently-edited article's
      full HTML into a home page that renders four fields of it.
    */
    expect(Object.keys(newest ?? {}).sort()).toEqual([
      "editor",
      "kind",
      "slug",
      "title",
      "when",
    ]);
  });
});

describe("the entries query and pages_updated_at_idx", () => {
  it("is served by a backward index scan with no sort step", async () => {
    /*
      The ticket's second acceptance criterion, checked as a plan rather than
      asserted in prose.

      `enable_seqscan = off` is what makes this a test of the *query* instead
      of a test of how many rows happen to be in the table. On a family's few
      hundred entries the planner will usually and correctly prefer a
      sequential scan and a sort, so asserting the plan it picks by default
      would assert the size of the fixture set. Turning the alternative off
      asks the question this criterion is actually about: given the choice,
      can this query be answered from `pages_updated_at_idx`? A query with a
      `WHERE` on another column, or a join onto `revisions` to find each
      entry's author, could not — and both are the natural next edits here,
      which is why this is worth pinning down.

      `set local` inside a transaction, because postgres.js pools connections:
      a bare `SET` could land on a different connection than the `EXPLAIN` and
      silently prove nothing. `local` also reverts on commit, so nothing else
      in the suite inherits it.
    */
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);

      const rows = await tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select slug, title, updated_at, updated_by
        from pages
        order by updated_at desc
        limit 10
      `);

      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("pages_updated_at_idx");
    // Backward, because the feed is newest-first — the index is ascending and
    // Postgres walks it from the high end rather than sorting the result.
    expect(plan).toContain("Index Scan Backward");
    // And no separate sort: the ordering comes out of the index itself, which
    // is the whole point of the index being usable here.
    expect(plan).not.toContain("Sort");
  });
});
