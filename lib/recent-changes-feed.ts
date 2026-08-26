import {
  formatRevisionAuthor,
  formatRevisionTimestamp,
  revisionTimestampIso,
} from "@/lib/revision-format";

/**
 * What "recently changed" *is* (E8-T4, `YEO-58`) — the shape of a feed row,
 * the rule that orders one source against another, and how a row reads — as
 * plain functions over plain values.
 *
 * `lib/recent-changes.ts` is the half that queries; this is the half that
 * decides. The split is the one `lib/pages.ts`/`lib/entry-search.ts` and
 * `lib/people.ts`/`lib/people-search.ts` already make, and it is not a
 * stylistic preference: `npm test` — the suite CI's `check` job runs — has no
 * `DATABASE_URL` at all (docs/testing.md), so a module that imports `@/db`,
 * even only for a type, cannot be loaded there. Everything below is
 * arithmetic over `Date`s and strings, so all of it is checked by the suite
 * that gates a merge, rather than only by the database suite or by nothing.
 *
 * The other reason for the split is specific to this ticket. The merge is
 * where the interesting decision lives — three sources, one order — and the
 * merge is exactly the part that would have disappeared into SQL if the feed
 * had been one query. See `mergeRecentChanges` for why it is not.
 */

/**
 * One thing that happened, as the feed reports it.
 *
 * ## Why this is a discriminated union and not one flat row type
 *
 * Because the three things are genuinely different, and the flat version can
 * only be reached by throwing away what makes them so. A single
 * `{ what: string; who: string | null; when: Date }` would need one `who` to
 * carry an entry's `null` — "this row predates the column being written" —
 * and a person's, which since `YEO-104` is a different thing again: not a
 * missing value but a row whose author, where there is one, is *conditional*
 * on the source recorded beside it. Two different facts, one representation,
 * and nothing downstream able to tell them apart.
 *
 * The union keeps them apart *structurally*: `person-added` carries an
 * **optional** author rather than a nullable one, so the absence is a field
 * that is not there rather than a value a renderer could turn into "Unknown"
 * and imply that somebody's name went missing. It also lets each arm carry
 * the identity its own link needs — a slug, a person id, an import id —
 * instead of three nullable columns of which exactly one is ever set.
 *
 * That is the same "widen rather than collapse" answer `db/schema.ts` reaches
 * for date ranges and for the two portrait columns, applied to a read model
 * rather than to a table.
 *
 * Every arm carries `when`, because that is the one thing all three have in
 * common and the only field the ordering reads.
 */
export type RecentChange =
  /**
   * An entry was written or rewritten.
   *
   * Sourced from `pages.updated_at`/`pages.updated_by` rather than from a
   * join onto `revisions`, and that is worth being explicit about because
   * `revisions` is where this application's authorship story normally lives.
   * The two agree by construction: `lib/save-page.ts` writes the revision row
   * and these two columns in the same transaction, and
   * `lib/restore-revision.ts` and `lib/create-page.ts` do the same. So
   * `pages.updated_by` *is* the latest revision's author, already denormalised
   * onto the row whose `updated_at` the feed orders by.
   *
   * Reading it here rather than joining is what keeps the query a single
   * backward scan of `pages_updated_at_idx` — the acceptance criterion — with
   * no join and no per-entry subquery to find "the newest revision".
   *
   * **One row per entry, not one per revision.** An entry saved eleven times
   * this afternoon is one line in this feed, and the line says when it was
   * last touched. A feed of revisions would let one person editing one
   * article push everything else off a ten-row list, which is the opposite of
   * what a section headed "what has the family been writing" is for. The
   * entry's own history page is where every save is listed.
   */
  | {
      kind: "entry-changed";
      /** The entry's address, for the link back. */
      slug: string;
      title: string;
      when: Date;
      /**
       * Who saved it, or null.
       *
       * Null is not a defect: `pages.updated_by` is nullable, `db/seed.ts`
       * writes rows through it, and a row written by hand in a SQL console
       * has no signed-in author to record. `formatChangeAuthor` is what turns
       * that into something a reader can see.
       */
      editor: string | null;
    }
  /**
   * A person was added to the tree by hand.
   *
   * **This arm has an author only when one genuinely exists** (`YEO-104`).
   * Until that ticket it had no author field at all, because `individuals`
   * had no `created_by` column and never had — the arm's shape was the
   * honest report of a gap in the schema. The column exists now, and the arm
   * gains the author *and keeps the shape*: `addedBy` is optional rather than
   * nullable, so a row with nobody to name has no field to render instead of
   * a null to misrender.
   *
   * Absent covers exactly the rows `individualAuthorEmail` declines to
   * attribute (`lib/individual-author.ts`): a person added before the column
   * existed, and — unreachable through this application — a `member` row with
   * no email. Neither is a name that went missing, and neither may read as
   * one, which is why nothing here is ever handed to `formatChangeAuthor`.
   *
   * People that arrived in a GEDCOM file are deliberately **not** here — see
   * `people-imported`, which is also where their author is reported. That is
   * why no arm ever carries `created_by_source`: the one source whose author
   * lives elsewhere is the one source this arm never holds.
   */
  | {
      kind: "person-added";
      /** `individuals.id`, which is what `treeHref` deep-links to. */
      personId: string;
      /** Already joined by `formatPersonName`, so no renderer repeats that rule. */
      name: string;
      when: Date;
      /**
       * The member who added them, when the row records one.
       *
       * Optional — never `string | null` — and the distinction is the whole
       * of what this arm has always been for. See the docblock above.
       */
      addedBy?: string;
    }
  /**
   * A GEDCOM file was imported, reported as one line rather than as the
   * hundreds of people it wrote.
   *
   * ## Why an import is its own arm
   *
   * Because otherwise it is the whole feed. `lib/gedcom-import.ts` inserts
   * every individual in the file in one transaction, so a few hundred
   * `individuals` rows share a `created_at` to the millisecond. Ordered by
   * that column, they would fill a ten-row feed completely and go on filling
   * it until somebody had added a few hundred people by hand — a section
   * about what the family has been writing, showing nothing but one
   * afternoon's file upload, permanently.
   *
   * Collapsing them is also the more truthful report. Nobody added three
   * hundred people to this tree; somebody imported a file that contained
   * them, once, and the interesting facts are which file, how many, and who
   * ran it. `gedcom_imports` records exactly those, which is why this arm is
   * sourced from that table rather than aggregated out of `individuals`.
   *
   * And it is the arm that *does* have an author: `gedcom_imports.imported_by`
   * is written by the import endpoint from the signed-in session, the same
   * way `pages.updated_by` is. So the people who arrive in bulk are attributed
   * even though the people typed in one at a time are not.
   *
   * ## What is not filtered
   *
   * `gedcom_imports.released_at` is not consulted. Releasing a row retires its
   * claim on a file's digest so the same file can be imported again
   * (`YEO-95`); it does not remove the people that import wrote, and they are
   * still in the tree. A feed that hid released imports would be hiding an
   * event that actually happened.
   */
  | {
      kind: "people-imported";
      importId: string;
      /**
       * The uploaded filename, or null when the browser sent a `Blob` with no
       * `name` — nullable in the schema, so nullable here.
       */
      fileName: string | null;
      /** `gedcom_imports.individual_count`: how many people the file added. */
      personCount: number;
      when: Date;
      /** Who ran the import, or null on the same terms as `editor` above. */
      importedBy: string | null;
    };

/**
 * How many rows the section shows.
 *
 * Ten, and the number is doing two jobs. It is how long a home page section
 * can be before it stops being a glance and starts being a page — shorter
 * than `/search`'s twenty (`DEFAULT_LIMIT` in `lib/entry-search.ts`), which
 * is a destination a reader scrolls, where this sits under a two-item Browse
 * list.
 *
 * It is also the limit each of the three source queries takes, and they are
 * the same number on purpose rather than by coincidence: no source can
 * contribute more than every row of the merged feed, so ten from each is
 * exactly enough to be certain the merge is correct however the timestamps
 * interleave. Fetching fewer could drop a row that belonged; fetching more
 * could never change the answer.
 */
export const RECENT_CHANGES_LIMIT = 10;

/**
 * The tie-break key for two changes that happened at the same instant.
 *
 * Sorting on `when` alone is not a *total* order, and simultaneous rows are
 * not hypothetical here: an import writes its ledger row and its people in
 * one transaction, and `defaultNow()` inside a transaction is the
 * transaction's start time, so two arms can genuinely carry the same
 * millisecond. Without a tie-break the two orderings are both valid and the
 * feed can reshuffle between two requests that read identical rows — the
 * "make it total, not merely stable" rule `searchEntries` and `searchPeople`
 * each state for their own sorts.
 *
 * The key is the arm's own identity, which is unique within its table and
 * prefixed by the kind so that it is unique across all three.
 */
function tieBreakKey(change: RecentChange): string {
  switch (change.kind) {
    case "entry-changed":
      return `entry-changed:${change.slug}`;
    case "person-added":
      return `person-added:${change.personId}`;
    case "people-imported":
      return `people-imported:${change.importId}`;
  }
}

/**
 * Interleave the three sources into one feed, newest first.
 *
 * ## Why the merge is here and not a `UNION ALL`
 *
 * One SQL statement could return all three sources already ordered, and it
 * would cost this module its reason to exist. `UNION ALL` requires the arms
 * to share a column list, so the statement would have to pad an entry row
 * with a null person id and a person row with a null slug, a null title and a
 * null author — reassembling in the database precisely the flat, mostly-null
 * row that `RecentChange` is a union in order to avoid. Whatever came back
 * would then have to be discriminated in TypeScript anyway, from the nulls,
 * which is the lossy round trip rather than a saving.
 *
 * It would also move the interesting decision — how three unlike things order
 * against each other — into a place `npm test` cannot reach, for a merge over
 * at most thirty rows that are already in memory.
 *
 * What SQL keeps is the part only it can do: each source is ordered and
 * limited by Postgres, against its own table, so this function never sees
 * more than `RECENT_CHANGES_LIMIT` rows per source however large the tables
 * grow. See `lib/recent-changes.ts`.
 *
 * @param sources the three already-limited source lists, in any order
 * @param limit how many rows to keep, defaulting to `RECENT_CHANGES_LIMIT`
 * @returns at most `limit` changes, newest first, in a total order
 */
export function mergeRecentChanges(
  sources: readonly RecentChange[][],
  limit: number = RECENT_CHANGES_LIMIT,
): RecentChange[] {
  // A new array rather than sorting a caller's: `sources` is `readonly` at the
  // outer level but its members are not, and a merge has no business
  // reordering the lists it was handed.
  const all = sources.flat();

  all.sort((a, b) => {
    const byWhen = b.when.getTime() - a.when.getTime();
    if (byWhen !== 0) return byWhen;

    // Ascending on the key, which is arbitrary but *fixed* — the point is
    // that two equal instants always come back in the same order, not that
    // one of them deserves to be first.
    return tieBreakKey(a) < tieBreakKey(b) ? -1 : 1;
  });

  return all.slice(0, limit);
}

/**
 * When a change happened, as an unambiguous absolute moment.
 *
 * `formatRevisionTimestamp` rather than a fourth formatter of this
 * application's own, and rather than `formatUpdatedAt` from
 * `lib/page-index.ts`. The page index's is date-only, which is right for a
 * browsable list of everything and too coarse for a feed — "23 August 2026"
 * three times in a row says nothing about what happened first. The revision
 * formatter is the day *and* the time, pinned to UTC and to `en-GB` for
 * reasons that apply here unchanged: this renders on a server whose zone is
 * not the reader's, and an unpinned `Intl` would render differently on the
 * machine that builds this and the machine that serves it.
 *
 * Its module is named for where that decision was first needed rather than
 * for who is allowed to use it, and a page's `updated_at` is in any case the
 * instant of its newest revision. A third copy of "UTC, `en-GB`, long date,
 * short time" would only be a third place for those pins to drift apart.
 */
export function formatChangeWhen(when: Date): string {
  return formatRevisionTimestamp(when);
}

/**
 * The same instant for `<time dateTime>`, alongside the human-readable form
 * above because every surface that renders one renders both.
 */
export function changeWhenIso(when: Date): string {
  return revisionTimestampIso(when);
}

/**
 * Who to name for a change that records an author, for the rows where the
 * column is null.
 *
 * `formatRevisionAuthor` again, and for the same reason as the timestamp: the
 * question ("this column is nullable, what does a reader see?") and the answer
 * ("Unknown") are already settled for `revisions.created_by`, and
 * `pages.updated_by` and `gedcom_imports.imported_by` are nullable on
 * identical terms — their own docblocks say so.
 *
 * Deliberately still not offered for `person-added`, whose author is optional
 * rather than nullable (`YEO-104`). The distinction that arm exists to
 * preserve would be gone the moment a renderer could ask this function for a
 * person's author and be told "Unknown", which reads as a lost name rather
 * than as a row from before the column existed. There is no null to pass it:
 * `individualAuthorEmail` returns `undefined` or an address, and a row with
 * no author is rendered by saying nothing about one.
 */
export function formatChangeAuthor(email: string | null): string {
  return formatRevisionAuthor(email);
}

/**
 * How an import's file reads when the browser sent no filename.
 *
 * A fallback rather than an empty string, because the sentence it lands in
 * ("N people imported from …") has to say something. "a GEDCOM file" is what
 * is actually known about it.
 */
export function formatImportFileName(fileName: string | null): string {
  return fileName ?? "a GEDCOM file";
}

/**
 * "1 person" / "23 people", for an import's line.
 *
 * Here rather than in the component so that the singular is checked by
 * `npm test` — an import of exactly one person is both easy to get wrong and
 * easy never to see, since the fixtures anybody reaches for have several.
 */
export function formatPersonCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}
