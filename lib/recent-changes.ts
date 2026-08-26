import { asc, desc, gt, isNull } from "drizzle-orm";

import { db, schema } from "@/db";
import { individualAuthorEmail } from "@/lib/individual-author";
import { formatPersonName } from "@/lib/person-format";
import {
  mergeRecentChanges,
  type RecentChange,
  RECENT_CHANGES_LIMIT,
} from "@/lib/recent-changes-feed";

/**
 * The reads behind the home page's "Recently changed" section (E8-T4,
 * `YEO-58`) — three narrow selects, each against the table that owns its
 * source, handed to `lib/recent-changes-feed.ts` to be interleaved.
 *
 * The pairing is `lib/people.ts`/`lib/people-search.ts`'s: this module is the
 * one allowed to import `@/db`, and it contains no decisions — the shape of a
 * feed row, the ordering across sources, the limit and the formatting all
 * live in the pure module, where `npm test` can see them (docs/testing.md).
 *
 * ## Three queries rather than one
 *
 * Deliberately, and the reasoning is in `mergeRecentChanges`: a `UNION ALL`
 * would force the three unlike sources into one column list and rebuild in
 * SQL exactly the flat, mostly-null row the `RecentChange` union exists to
 * avoid. Three statements also let each one be the simplest query its own
 * table can serve — which is what keeps the first of them a plain backward
 * index scan.
 *
 * They are issued together rather than in sequence. None depends on another's
 * result, so awaiting them one at a time would cost the page three round
 * trips to the database where one round trip's latency will do.
 */

/**
 * Everything the section shows, newest first.
 *
 * @param limit how many rows the feed should hold, defaulting to
 *   `RECENT_CHANGES_LIMIT`. Passed on to each source query as well as to the
 *   merge — see that constant for why the two numbers are the same one.
 * @returns at most `limit` changes, newest first
 */
export async function listRecentChanges(
  limit: number = RECENT_CHANGES_LIMIT,
): Promise<RecentChange[]> {
  const [entries, people, imports] = await Promise.all([
    listRecentlyChangedEntries(limit),
    listRecentlyAddedPeople(limit),
    listRecentImports(limit),
  ]);

  return mergeRecentChanges([entries, people, imports], limit);
}

/**
 * The entries half, and the query the ticket's index criterion is about.
 *
 * ## Why this uses `pages_updated_at_idx`
 *
 * `updated_at` descending leads the `ORDER BY`, there is no `WHERE`, no join
 * and no aggregate, and the `LIMIT` is small. So a B-tree on `(updated_at)`
 * answers the ordering directly: Postgres walks the index from its high end
 * rather than reading the table and sorting it.
 *
 * The honest half, the same one `lib/people.ts` states for
 * `individuals_surname_idx`: on today's data — a family's few hundred entries
 * — the planner will very often choose a sequential scan anyway, because at
 * that size it is cheaper. That is not the index failing to be used; it is
 * the planner being right. What matters is that the query *remains*
 * index-eligible as the table grows, with no rewrite, and
 * `lib/recent-changes.db.test.ts` asserts that as a plan rather than as a
 * claim in this comment.
 *
 * Two things would quietly cost it. A `WHERE` on any other column, which
 * would make the index scan a filter over the whole table; and joining
 * `revisions` to find each entry's author, which is why the author is read
 * from `pages.updated_by` instead — see `RecentChange`'s `entry-changed` arm
 * for why the two cannot disagree.
 *
 * ## Why `id` is in the `ORDER BY`, even though it costs a sort node
 *
 * Because `updated_at` alone does not identify *which* ten rows this is. Ties
 * are not hypothetical — a bulk update, a restore, or two saves in one
 * transaction all give rows the same `now()` — and `ORDER BY` + `LIMIT` over
 * a tie that straddles the boundary returns whichever rows the plan happened
 * to produce. The feed would then drop a different entry on two requests that
 * read identical data. That is the "make it total, not merely stable" rule
 * `searchEntries` states for its own sort, applied one layer down; the
 * in-memory tie-break in `mergeRecentChanges` cannot rescue it, because by
 * then the dropped row is already gone.
 *
 * It is not free, and the trade is worth writing down. With `id` as a second
 * key the plan gains a sort node above the index scan — an `Incremental Sort`
 * on real data, which is only possible *because* the index already supplies
 * the leading key, and which orders within each group of equal `updated_at`
 * rather than sorting the table. The index still does the work; what it can
 * no longer do is emit the final order with no step above it.
 *
 * Correctness wins that trade. "The feed silently drops a different row each
 * time" is a defect a reader would eventually notice and never be able to
 * explain; an incremental sort over a handful of rows sharing a millisecond
 * is not measurable. The acceptance criterion is that the query uses
 * `pages_updated_at_idx`, and it does — the db test asserts the plan reaches
 * the rows through that index rather than through a sequential scan.
 *
 * The select is narrow for the reason `lib/pages.ts` gives for every one of
 * its own: `body_html` is the article, and a feed that renders four fields
 * has no business pulling every entry's prose across the wire to throw it
 * away.
 */
async function listRecentlyChangedEntries(
  limit: number,
): Promise<RecentChange[]> {
  const rows = await db
    .select({
      slug: schema.pages.slug,
      title: schema.pages.title,
      updatedAt: schema.pages.updatedAt,
      updatedBy: schema.pages.updatedBy,
    })
    .from(schema.pages)
    .orderBy(desc(schema.pages.updatedAt), asc(schema.pages.id))
    .limit(limit);

  return rows.map((row) => ({
    kind: "entry-changed",
    slug: row.slug,
    title: row.title,
    when: row.updatedAt,
    editor: row.updatedBy,
  }));
}

/**
 * The people half: everyone added to the tree by hand, newest first.
 *
 * ## Why `import_id is null`
 *
 * Because a GEDCOM import is reported as one line by `listRecentImports`
 * below, and a person counted there must not also appear here — the feed
 * would say the same arrival twice, and the second telling would be three
 * hundred rows long. `RecentChange`'s `people-imported` arm argues the case
 * in full. The predicate is the whole of the coordination between the two
 * queries: `individuals.import_id` is exactly "did a file write this row",
 * so there is no window in which a person belongs to both lists or to
 * neither.
 *
 * ## Why there is no index on `created_at`, and why that is fine
 *
 * There is not one, and this ticket does not add one. `db/schema.ts` puts a
 * single index on `individuals`, `(surname, given_name)`, so this ordering is
 * a sequential scan and a sort — over a table `getFamilyGraph` already reads
 * *whole* into the browser on every visit to `/tree`, at a few hundred rows.
 * Adding an index to save a sort on a table small enough to send to a browser
 * would be a migration and a write cost bought for nothing measurable, and
 * the same judgement `lib/people.ts` reaches about its own read. If the tree
 * ever holds tens of thousands of people, `individuals_created_at_idx` is an
 * additive migration and this query does not change shape to use it.
 *
 * ## Why `id` is in the `ORDER BY`, and why this query needs it most
 *
 * `created_at` is very far from unique here, and the proof is in this
 * repository rather than in theory: `db/seed.ts` inserts every seeded person
 * in a *single* statement, and `db/seed-family.ts` sets no `created_at` on
 * any of them, so on a freshly seeded database the whole family shares one
 * timestamp to the microsecond. There are more of them than
 * `RECENT_CHANGES_LIMIT`, so a `LIMIT` with no tie-break would cut through
 * the middle of that tie and return whichever rows the plan happened to
 * produce — a different two people dropped after an autovacuum reorders the
 * heap, with nothing on screen to suggest the list is arbitrary.
 *
 * `id` is unique, so `(created_at desc, id asc)` is total and the same
 * database always answers the same way — `lib/entry-person.ts` makes exactly
 * this argument for exactly this reason. It costs nothing here: there is no
 * index on `created_at`, so this query was sorting already and the second key
 * rides along in the sort that was happening anyway. That is the difference
 * from `listRecentlyChangedEntries`, where the same fix does cost a plan step
 * and its own docblock argues why it is still worth paying.
 *
 * The name is joined here rather than in the component because
 * `formatPersonName` is the one place that knows a surname can be missing —
 * the same reason every other surface goes through it.
 *
 * ## Why the author is decided here and not in the component (`YEO-104`)
 *
 * Two columns are selected and at most one string leaves this function.
 * `individualAuthorEmail` is the only sanctioned reading of the pair, and
 * running it here is what keeps `created_by_source` out of the feed's type
 * altogether: a component holding the raw pair would be a component able to
 * render `created_by` for a source that does not have an author, which is the
 * "Unknown" this ticket exists to keep off the screen. What crosses into
 * `RecentChange` is an address or nothing.
 *
 * The predicate above does the rest of the work: `import_id is null` already
 * excludes every row whose source is `import`, so the only sources reaching
 * `individualAuthorEmail` here are `member` and `legacy`.
 */
async function listRecentlyAddedPeople(limit: number): Promise<RecentChange[]> {
  const rows = await db
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      createdAt: schema.individuals.createdAt,
      createdBySource: schema.individuals.createdBySource,
      createdBy: schema.individuals.createdBy,
    })
    .from(schema.individuals)
    .where(isNull(schema.individuals.importId))
    .orderBy(desc(schema.individuals.createdAt), asc(schema.individuals.id))
    .limit(limit);

  return rows.map((row) => ({
    kind: "person-added",
    personId: row.id,
    name: formatPersonName(row.givenName, row.surname),
    when: row.createdAt,
    // `undefined` when there is nobody to name, which is the property that
    // makes the field absent rather than empty — see the `person-added` arm.
    addedBy: individualAuthorEmail(row),
  }));
}

/**
 * The imports half: one line per GEDCOM file, not one per person it wrote.
 *
 * `individual_count > 0` is the only filter. An import that added no people —
 * a file of unions for individuals already present, or one whose every person
 * was a duplicate — did not add anybody to the tree, and a feed line reading
 * "0 people imported" answers a question nobody asked. It is a cheap
 * predicate on a table with one row per uploaded file, so it costs nothing to
 * be right about.
 *
 * Notably *not* filtered on `released_at`, which is the tempting second
 * predicate and would be wrong. It is tempting because `lib/import-ledger.ts`
 * does filter on it, and because a released row can look like a retracted
 * one. It is wrong because `db/schema.ts` is explicit about what releasing
 * means: "Releasing is deliberately *only* about the claim. It removes
 * nothing the earlier import wrote." The people are still in the tree, and
 * the same docblock says a file imported, released and imported again is
 * "legible as two rows, which is what actually happened" — which is precisely
 * the reading a feed of what happened should take.
 *
 * The two filters answer different questions, which is why they differ.
 * `findImportByDigest` asks "will pressing Import be refused?", and only a
 * live claim refuses anything. This asks "what happened?", and a released
 * import happened.
 *
 * `id` breaks ties on `imported_at` for the same reason it does in the two
 * queries above — a release and the re-import it was for commit together, so
 * two ledger rows genuinely can share an instant — and at the same price,
 * which is none: `gedcom_imports` has one row per uploaded file and no index
 * on `imported_at`, so this sorts either way.
 */
async function listRecentImports(limit: number): Promise<RecentChange[]> {
  const rows = await db
    .select({
      id: schema.gedcomImports.id,
      fileName: schema.gedcomImports.fileName,
      individualCount: schema.gedcomImports.individualCount,
      importedAt: schema.gedcomImports.importedAt,
      importedBy: schema.gedcomImports.importedBy,
    })
    .from(schema.gedcomImports)
    .where(gt(schema.gedcomImports.individualCount, 0))
    .orderBy(
      desc(schema.gedcomImports.importedAt),
      asc(schema.gedcomImports.id),
    )
    .limit(limit);

  return rows.map((row) => ({
    kind: "people-imported",
    importId: row.id,
    fileName: row.fileName,
    personCount: row.individualCount,
    when: row.importedAt,
    importedBy: row.importedBy,
  }));
}
