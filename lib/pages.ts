import { eq } from "drizzle-orm";

import { db, schema } from "@/db";
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
