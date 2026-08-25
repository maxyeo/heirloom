import { asc } from "drizzle-orm";

import { db, schema } from "@/db";

import { writeGedcom } from "./gedcom-export";

/**
 * The whole tree, read out of the database and written as GEDCOM (E7-T1,
 * `YEO-51`).
 *
 * ## Why this is its own module
 *
 * `lib/gedcom-export.ts` is pure, and `lib/gedcom.purity.test.ts` asserts it —
 * the same rule the parser and the mapper are under, for the same reason:
 * E7-T2 (`YEO-52`) round-trips export through import with no database in
 * sight. So the reading half lives here, on the other side of that line, and
 * is the only part of the export that knows `@/db` exists.
 *
 * It is five lines of query and one call. That it is worth a file of its own
 * is the point: E7-T3 (`YEO-53`) puts a download button on the settings page
 * and E7-T4 (`YEO-54`) embeds the same text in a full backup, and both of them
 * should be calling one function rather than each writing this query and
 * discovering later that they disagreed about the ordering.
 *
 * ## The `orderBy` is not decoration
 *
 * Postgres gives no order without one, so two exports of an unchanged database
 * could come back in different orders and produce different files. The
 * serialiser sorts what it is given — on values that survive a round trip,
 * which a row id does not — so its output would in fact be stable either way.
 * These clauses make the *input* stable as well, which is what keeps the
 * serialiser's final tie-break, the caller's own order, from being a coin
 * toss for two people with the same name and the same dates.
 */

/** Anything that can run a `select` — the pool, or a transaction. */
type TreeReader = Pick<typeof db, "select">;

/**
 * Read the tree and serialise it.
 *
 * @param reader the pool by default; a transaction when the caller has one,
 *   which is what E7-T4 needs to export a backup consistent with itself
 */
export async function exportTreeAsGedcom(
  reader: TreeReader = db,
): Promise<string> {
  const [individuals, unions, unionChildren] = await Promise.all([
    reader
      .select()
      .from(schema.individuals)
      .orderBy(
        asc(schema.individuals.surname),
        asc(schema.individuals.givenName),
        asc(schema.individuals.id),
      ),
    reader
      .select()
      .from(schema.unions)
      .orderBy(asc(schema.unions.sequence), asc(schema.unions.id)),
    reader
      .select()
      .from(schema.unionChildren)
      .orderBy(
        asc(schema.unionChildren.unionId),
        asc(schema.unionChildren.childId),
      ),
  ]);

  return writeGedcom({ individuals, unions, unionChildren });
}
