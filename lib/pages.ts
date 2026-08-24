import { eq, inArray } from "drizzle-orm";

import { db, schema } from "@/db";
import type { EntryLink } from "@/lib/entry-link";
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
 */
export type WikiEntry = {
  id: string;
  slug: string;
  title: string;
  bodyHtml: string;
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
 * @param slugs the slugs to check, in any order, duplicates allowed
 * @returns the subset that exists, as a set
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
    .where(inArray(schema.pages.slug, wanted));

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
 * @returns every entry, alphabetically by title
 */
export async function listPages(): Promise<WikiEntrySummary[]> {
  const entries = await db
    .select({
      slug: schema.pages.slug,
      title: schema.pages.title,
      updatedAt: schema.pages.updatedAt,
    })
    .from(schema.pages);

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
 * @returns every entry, alphabetically by title
 */
export async function listEntryLinks(): Promise<EntryLink[]> {
  const entries = await db
    .select({
      id: schema.pages.id,
      slug: schema.pages.slug,
      title: schema.pages.title,
    })
    .from(schema.pages);

  // Sorting in place is safe: `entries` is an array Drizzle built for this
  // call, and nothing else holds a reference to it.
  return entries.sort(compareEntriesByTitle);
}
