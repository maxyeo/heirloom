import { eq } from "drizzle-orm";

import { db, schema } from "@/db";

/**
 * What the read route needs off a `pages` row, and nothing else.
 *
 * Spelled out rather than inferred from the Drizzle table so the select below
 * has something to be checked against: widening the query and widening the
 * type are then the same edit, and a column nobody renders cannot drift into
 * the payload unnoticed. `updatedAt`/`updatedBy` are deliberately absent —
 * the "last edited by" line belongs to the article chrome (E11-T2), which is
 * where the column and its formatting should arrive together.
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
