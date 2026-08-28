import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema } from "@/db";
import { SEARCH_TEXT_CONFIG } from "@/db/schema";
import {
  DEFAULT_LIMIT,
  type EntryMatch,
  SNIPPET_OPTIONS,
  toEntryMatches,
} from "@/lib/entry-search";
import type { EntryLink } from "@/lib/entry-link";
import { LIVE_PAGES } from "@/lib/live-pages";
import { compareEntriesByTitle } from "@/lib/page-index";

/**
 * An entry's identity and its content — what a caller needs in order to
 * render the entry or to act on it, and nothing beyond that.
 *
 * Spelled out rather than inferred from the Drizzle table so the select below
 * has something to be checked against: widening the query and widening the
 * type are then the same edit, and a column nobody asked for cannot drift
 * into the payload unnoticed.
 *
 * `id` and `slug` are here despite the read route rendering neither, because
 * they are the row's identity rather than a column of content: `id` is what a
 * write path hangs off (`revisions.page_id`, E1-T3) and `slug` is what a
 * caller builds a link back to. A lookup that handed back content without
 * saying which row it came from would only make its callers query twice.
 *
 * `updatedAt`/`updatedBy` are the deliberate omission — those *are* content,
 * and the "last edited by" line belongs to the article chrome (E11-T2), which
 * is where the column and its formatting should arrive together.
 *
 * `hatnote` is here alongside `bodyHtml` because it is the other half of what
 * an entry says (E11-T9, `YEO-79`) — the line above the lead, stored in its
 * own column so that it is apparatus rather than prose. Both of this type's
 * consumers need it: the read route renders it, and the editor prefills a
 * field with it. It arrives **as stored**, which is not necessarily normalised
 * — `normaliseHatnote` runs on the way out, exactly as `sanitizeHtml` does for
 * the body, because a row written by `db:seed` or by hand has been through
 * neither.
 */
export type WikiEntry = {
  id: string;
  slug: string;
  title: string;
  bodyHtml: string;
  hatnote: string;
  /**
   * When this entry was retired, or null while it is live (E1-T10,
   * `YEO-122`).
   *
   * This is the one field on this type that is not content and not identity,
   * and it is here because `getPageBySlug` is the one reader that deliberately
   * does **not** filter retired rows out. Every route that loads an entry has
   * to decide what to do with a retired one, and a lookup that answered
   * `undefined` would make that decision for all of them — as a 404, which is
   * the answer this ticket argues against at length. Carrying the timestamp
   * turns "is this retired" into something the caller can see rather than
   * something it can only infer from an absence.
   */
  deletedAt: Date | null;
  /**
   * Who retired it, or null — both while it is live, and for a row retired by
   * a hand-run `UPDATE` with no session behind it.
   *
   * Carried alongside `deletedAt` rather than fetched by the one route that
   * renders it, because the tombstone states both in one sentence and a second
   * query for the second half of a sentence is not a saving. See
   * `app/wiki/[slug]/page.tsx`.
   */
  deletedBy: string | null;
};

/**
 * Look up one entry by its slug.
 *
 * The slug arrives from the URL, so it is untrusted input. It is passed to
 * Drizzle's `eq`, which parameterises it — the value never reaches Postgres as
 * SQL text. This matters more here than it usually would: there is no RLS
 * under this database and the app connects as a single role, so a query built
 * by string concatenation would be reachable by anyone who can sign in.
 *
 * Returns `undefined` rather than throwing when nothing matches. "No such
 * entry" is an ordinary outcome of a wiki read — a link that has outrun its
 * page — and it is the caller's job to turn it into a 404, not this module's.
 *
 * ## Why this one does not apply `LIVE_PAGES` (E1-T10, `YEO-122`)
 *
 * It is the deliberate exception among the reads in this file, and the reason
 * `WikiEntry` carries `deletedAt` at all. Every other function here answers a
 * question about the *set* of entries — what is in the index, what a search
 * matches, which of these links lead somewhere — and a retired entry is not in
 * any of those sets. This one answers a question about one address, and there
 * are six routes standing behind it, each of which wants a different thing
 * from a retired row:
 *
 *   - `/wiki/[slug]` renders the tombstone — what happened, who did it, and
 *     the button that undoes it;
 *   - `/wiki/[slug]/edit` redirects to that tombstone rather than opening an
 *     editor `savePage` would refuse to save from;
 *   - `/wiki/[slug]/history` goes on listing every version, under a notice
 *     saying the entry itself is retired;
 *   - `/wiki/[slug]/history/[revisionId]` carries the same notice above one
 *     version, and stops calling the address beside it "the current version";
 *   - `/wiki/[slug]/history/compare` carries it above a diff of two;
 *   - `/wiki/[slug]/history/[revisionId]/restore` refuses, because there is
 *     nothing to restore *into* until the entry itself is back.
 *
 * Filtering here would make all six of them a 404, which is the outcome §3 of
 * the ticket argues against: on a wiki where everybody signed in is a full
 * editor (`lib/allowed-emails.ts`), hiding the history from the only people
 * who can reach it buys nothing, and an accidental retirement that answers 404
 * is indistinguishable from data loss. So the row comes back with the
 * timestamp on it, and the decision belongs to the route.
 *
 * That is also why the field is `deletedAt: Date | null` on the returned type
 * rather than something a caller has to ask a second question to discover: the
 * one thing that could go wrong here is a route forgetting to look, and a
 * column already in hand is the cheapest possible reminder.
 *
 * ## Why the list above is checked rather than trusted (`YEO-123`)
 *
 * Because it was wrong. It said five, and the two routes it left out were
 * exactly the two that had forgotten to look: the revision-detail page and the
 * comparison page both rendered a retired entry's prose as though it were
 * live, beside a link labelled "View the current version" that landed on a
 * tombstone. The miscount and the gap were one mistake — an enumeration in
 * prose is maintained by whoever remembers it is here, and the person adding
 * the sixth route is the person who does not.
 *
 * So the list is no longer the guard. `lib/pages.route-decisions.test.ts`
 * reads this docblock and the route tree together and fails when they
 * disagree: when a route calls this function without naming `deletedAt`, when
 * a caller is missing from the list above, and when the list names a route
 * that has stopped calling. It is the route-level counterpart of
 * `lib/pages.call-sites.test.ts`, which does the same job one layer down for
 * the queries, and it exists for the reason that file gives: every way of
 * getting this wrong is silent, and a route that never mentions `deletedAt`
 * looks right in review.
 */
export async function getPageBySlug(
  slug: string,
): Promise<WikiEntry | undefined> {
  // `slug` is unique in the schema, so `limit(1)` describes the table rather
  // than truncating a result: it lets Postgres stop at the index hit.
  const [entry] = await db
    .select({
      id: schema.pages.id,
      slug: schema.pages.slug,
      title: schema.pages.title,
      bodyHtml: schema.pages.bodyHtml,
      hatnote: schema.pages.hatnote,
      deletedAt: schema.pages.deletedAt,
      deletedBy: schema.pages.deletedBy,
    })
    .from(schema.pages)
    .where(eq(schema.pages.slug, slug))
    .limit(1);

  return entry;
}

/**
 * Which of these slugs exist — the whole of red-link resolution (E11-T6,
 * `YEO-76`), in one query.
 *
 * ## Why it takes a set and not a slug
 *
 * Because the acceptance criterion is "one query per page render, not one per
 * link", and a `slugExists(slug)` would make the wrong thing the easy thing:
 * every caller would sit in a loop, the page would still render correctly,
 * and nothing on screen would show that an entry with thirty links now costs
 * thirty round trips. There is no single-slug entry point here on purpose.
 * `resolveEntryLinks` collects a body's slugs in one pass and calls this once.
 *
 * ## Why the whole row set comes back rather than a count
 *
 * A count answers "do all of these exist", which is not the question — the
 * caller needs to know *which* ones do, and asking Postgres for the matching
 * slugs is the same index scan either way.
 *
 * An empty request issues no query at all. That is not a micro-optimisation:
 * `inArray` with an empty list generates SQL that Drizzle has to special-case,
 * and a body with no links — the common case in a young wiki — should not
 * reach the database to be told nothing is missing.
 *
 * The slugs come out of stored HTML, so they are untrusted input. They reach
 * Postgres through `inArray`, which parameterises them; nothing is
 * interpolated into SQL text. That matters here for the reason it matters in
 * `getPageBySlug`: there is no RLS under this database and one role for
 * everyone.
 *
 * ## A retired entry does not exist, for this question (E1-T10, `YEO-122`)
 *
 * `LIVE_PAGES` here is what makes "links to it render red" true, and it is
 * worth naming as a decision rather than reading as one filter among six.
 * A link to a retired entry is not a broken link that wants fixing; it is
 * precisely the invitation this feature exists to produce. The entry was
 * retired because somebody decided it should not have been written, so the
 * red link and its "write this entry" title are the correct thing to say to
 * the next reader who meets one — the same sentence a link to a page nobody
 * has written yet gets, arrived at from the other direction.
 *
 * The alternative — leaving such links blue — would have every one of them
 * lead to a tombstone, which is a worse page to be sent to than a red link is
 * to be shown. The tombstone is a place you arrive at *deliberately*, from the
 * address bar or from the history, not somewhere prose should point.
 *
 * @param slugs the slugs to check, in any order, duplicates allowed
 * @returns the subset that exists *and has not been retired*, as a set
 */
export async function findExistingSlugs(
  slugs: Iterable<string>,
): Promise<Set<string>> {
  // Distinct before asking: an entry linked nine times in one article is one
  // value in the `IN` list, not nine.
  const wanted = [...new Set(slugs)];
  if (wanted.length === 0) return new Set();

  const rows = await db
    .select({ slug: schema.pages.slug })
    .from(schema.pages)
    .where(and(inArray(schema.pages.slug, wanted), LIVE_PAGES));

  return new Set(rows.map((row) => row.slug));
}

/**
 * One row of the page index (E1-T9): enough to link to an entry and to say
 * when it last changed.
 *
 * `bodyHtml` is the deliberate omission here, for the same narrow-select
 * reason `WikiEntry` above gives for its own. The index renders no prose, and
 * a few hundred entries' worth of article HTML is a payload this route would
 * fetch across the wire, hold in memory and then throw away.
 *
 * `id` is absent too, and that is not an oversight: the index links and
 * nothing more, and `slug` is both the address it links to and a unique key
 * for the list. `WikiEntry` carries `id` because its callers write; this one's
 * do not.
 */
export type WikiEntrySummary = {
  slug: string;
  title: string;
  updatedAt: Date;
};

/**
 * Every entry, in the order a reader should meet them.
 *
 * ## Why the whole table
 *
 * There is no `limit`, no cursor and no count query, because the ticket says
 * there does not need to be: the corpus is a family's entries, a few hundred
 * at the outside. That is the same judgement `getFamilyGraph` makes about the
 * individuals table, and the index is the fallback navigation until search
 * (E8) exists — a paginated fallback would be a worse one.
 *
 * ## Why the ordering is not an `ORDER BY`
 *
 * docs/testing.md holds up `getFamilyGraph`'s ordering as the case for putting
 * an `ORDER BY` in SQL, and this is the deliberate exception to it.
 * "Alphabetical" is a question about language, and Postgres answers it out of
 * the database's collation — which is not this application's to choose. A
 * local `createdb` on macOS produces a `C`-collated database, where
 * `ORDER BY title` reads:
 *
 *     Ada Byron, Zoe, alice, de Vere, Émile Lefèvre
 *
 * — every capital ahead of every lowercase, and every accented letter behind
 * both. `lower(title)` corrects the first half and not the second. Supabase
 * creates its databases `en_US.UTF-8`, which gets both right, so the fault
 * would be invisible in production and permanent on the machine the entries
 * are written on.
 *
 * `Intl.Collator` is the same Unicode collation algorithm, pinned to one
 * locale by the application rather than inherited from whichever server the
 * rows happen to sit on. Using it costs reading the table before sorting it,
 * which the paragraph above already grants — and it buys an order that is
 * identical everywhere and testable under `npm test`, where CI can see it.
 * See `lib/page-index.ts`.
 *
 * ## Why the whole table is still not quite the whole table (`YEO-122`)
 *
 * `LIVE_PAGES`. The index is the wiki's list of what has been written, and a
 * retired entry is the one thing that has been written and is not on it — that
 * is most of what retiring means, and the first acceptance criterion of
 * E1-T10.
 *
 * @returns every live entry, alphabetically by title
 */
export async function listPages(): Promise<WikiEntrySummary[]> {
  const entries = await db
    .select({
      slug: schema.pages.slug,
      title: schema.pages.title,
      updatedAt: schema.pages.updatedAt,
    })
    .from(schema.pages)
    .where(LIVE_PAGES);

  // Sorting in place is safe: `entries` is an array Drizzle built for this
  // call, and nothing else holds a reference to it.
  return entries.sort(compareEntriesByTitle);
}

/**
 * Every entry, as something a person can be linked to (E2-T2).
 *
 * ## Why not `listPages`
 *
 * Because the two lists answer different questions and carry different
 * columns. The index renders titles and dates; this renders a link on a panel
 * and fills a picker, so it needs the `id` — which is what
 * `individuals.page_id` holds — and has no use for `updated_at`. Widening
 * `WikiEntrySummary` to serve both would put a date on a list nobody dates and
 * an id on a list that links by slug, which is the drift the narrow-select
 * note above exists to prevent.
 *
 * ## Why the whole table again
 *
 * The same judgement `listPages` makes, and `getFamilyGraph` before it: the
 * corpus is a family's entries, a few hundred at the outside. `/tree` reads
 * this once per load and hands it to the canvas, where `lib/entry-link.ts`
 * matches it against the people already in the browser — so opening one
 * person's panel after another costs no further request, which is the property
 * the whole canvas is built on.
 *
 * Ordered by the same comparator and for the same reason: "alphabetical" is a
 * question about language rather than about collation, and the answer has to
 * be the application's rather than the database's. See `lib/page-index.ts`.
 *
 * ## And retired entries are not linkable (`YEO-122`)
 *
 * `LIVE_PAGES`, for a sharper reason than the index's. This list is what the
 * canvas offers as *destinations*: the panel's "read the entry" link, and the
 * picker that hands `individuals.page_id` a target. Leaving a retired entry in
 * it would put a live-looking link to a tombstone on every relative's panel,
 * and would let somebody attach a person to an entry that has been retired —
 * a write, not merely a misleading read. `lib/link-person-entry.ts` refuses
 * that at the transaction as well, because a picker is a convenience and not a
 * boundary.
 *
 * @returns every live entry, alphabetically by title
 */
export async function listEntryLinks(): Promise<EntryLink[]> {
  const entries = await db
    .select({
      id: schema.pages.id,
      slug: schema.pages.slug,
      title: schema.pages.title,
    })
    .from(schema.pages)
    .where(LIVE_PAGES);

  // Sorting in place is safe: `entries` is an array Drizzle built for this
  // call, and nothing else holds a reference to it.
  return entries.sort(compareEntriesByTitle);
}

/**
 * Full-text search over entries (E8-T1, `YEO-55`).
 *
 * ## The query, and why every part of it is in Postgres
 *
 * One statement does the matching, the ranking and the excerpting:
 *
 * - `@@` against `pages.search_vector`, the generated `tsvector` column
 *   `db/schema.ts` defines and `pages_search_vector_idx` covers. This is the
 *   only predicate, so it is the only thing the GIN index has to answer.
 * - `ts_rank` over the same column, which is where "title matches rank above
 *   body matches" comes from. Not as a tie-break bolted on afterwards, but as
 *   arithmetic: the column stores the title's lexemes at weight `A` and the
 *   body's at `B`, and `ts_rank`'s default weights cap a `B` lexeme at 0.4
 *   however many times the word occurs, while a single `A` occurrence already
 *   scores about 0.61. An entry that says "marriage" forty times in its body
 *   cannot climb past an entry that says it once in its title.
 * - `ts_headline` over `body_html`, which is the snippet. Same parser as
 *   `to_tsvector`, so it drops the tags and marks the term Postgres actually
 *   matched — stems and all, which is why this is not a substring search
 *   performed in TypeScript afterwards: a search for "marriages" highlights
 *   the word "married" it found, and nothing in the application knows how to
 *   agree with the `english` dictionary about that.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery` because the input is a
 * search box and people type search-box syntax into it: quoted phrases,
 * `or`, and a leading `-` to exclude. It is also the parser that cannot throw
 * on malformed input — `to_tsquery` raises a syntax error on a bare `&`,
 * which would turn a typo into a 500. A query with no lexemes in it at all
 * ("the", "!!!") parses to an empty tsquery, which matches nothing, which is
 * the honest answer.
 *
 * The configuration is `SEARCH_TEXT_CONFIG`, cast to `regconfig` explicitly
 * so the two-argument overload is the one resolved rather than left to
 * inference over an untyped parameter. It has to be the same configuration
 * the stored column was built with; `db/schema.ts` says what goes wrong if it
 * ever is not.
 *
 * ## The ordering, past rank
 *
 * `ts_rank` alone is not a total order — two entries can score identically,
 * and then the row order is whatever the plan happened to produce, so the
 * same query could return the same results in a different order on a later
 * request. `updated_at` descending breaks the tie the way a wiki should (the
 * entry somebody touched most recently is the likelier answer) and `id`
 * settles the rest, which is the same "make it total, not merely stable"
 * argument `searchPeople` makes for its own sort.
 *
 * Deliberately *not* `compareEntriesByTitle`, which `listPages` and
 * `listEntryLinks` both use: alphabetical is the right order for an index of
 * everything and the wrong one for an answer to a question. Relevance is the
 * order here, and the collation argument that comparator exists for does not
 * arise, because nothing in this `ORDER BY` compares text.
 *
 * ## What is not here
 *
 * No `count`. The page shows the results it has, and a second query to say
 * "23 entries" would cost as much as the first for a number that only ever
 * gets read as "more than fit". No offset pagination either: `DEFAULT_LIMIT`
 * results out of a corpus of a few hundred is the whole of the tail worth
 * showing, and page two of a family wiki search is a feature nobody asked
 * for.
 *
 * @param query what the author typed, unparsed
 * @param options `limit`, defaulting to `DEFAULT_LIMIT`
 * @returns the matching entries, most relevant first, at most `limit` of them
 */
export async function searchEntries(
  query: string,
  options: { limit?: number } = {},
): Promise<EntryMatch[]> {
  const { limit = DEFAULT_LIMIT } = options;

  const trimmed = query.trim();
  // No query issues no query. `@@` against an empty tsquery is false for
  // every row, so this is the same answer the database would give — bought
  // without the round trip, and without the notice Postgres logs when it is
  // handed a string with no lexemes in it.
  if (trimmed === "") return [];

  // Built once and interpolated three times. Every value here reaches
  // Postgres as a bound parameter — Drizzle's `sql` template parameterises
  // its interpolations — which matters more than usual for a search box:
  // this string is whatever a signed-in reader typed, and there is no RLS
  // under this database (see `getPageBySlug`).
  const tsquery = sql`websearch_to_tsquery(${SEARCH_TEXT_CONFIG}::regconfig, ${trimmed})`;

  const rows = await db
    .select({
      id: schema.pages.id,
      slug: schema.pages.slug,
      title: schema.pages.title,
      snippet: sql<string>`ts_headline(${SEARCH_TEXT_CONFIG}::regconfig, ${schema.pages.bodyHtml}, ${tsquery}, ${SNIPPET_OPTIONS})`,
    })
    .from(schema.pages)
    /**
     * Two predicates, and the second one is `LIVE_PAGES` (`YEO-122`).
     *
     * The `@@` is still the only thing `pages_search_vector_idx` has to
     * answer — Postgres applies the GIN index to the match and filters the
     * handful of rows it returns on `deleted_at`, rather than the other way
     * round — so the ranking argument above is untouched. What changes is that
     * a retired entry cannot be the answer to a search, which is the second
     * acceptance criterion of E1-T10 and the one most likely to be noticed:
     * search is how somebody finds an entry they cannot remember the address
     * of, and an entry that has been retired is one nobody should be handed
     * back with a snippet of its prose under it.
     */
    .where(and(sql`${schema.pages.searchVector} @@ ${tsquery}`, LIVE_PAGES))
    .orderBy(
      desc(sql`ts_rank(${schema.pages.searchVector}, ${tsquery})`),
      desc(schema.pages.updatedAt),
      asc(schema.pages.id),
    )
    .limit(limit);

  return toEntryMatches(rows);
}
