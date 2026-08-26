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
 * It is three queries and one call. That it is worth a file of its own is the
 * point: E7-T3 (`YEO-53`) puts a download button on the settings page and
 * E7-T4 (`YEO-54`) embeds the same text in a full backup, and both of them
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
 *
 * ## Why the three reads are named rather than inline
 *
 * Because the clause above is a claim about SQL that only SQL can settle, and
 * `lib/export-tree.db.test.ts` has to get hold of the statement to settle it.
 * A missing `ORDER BY` is unspecified rather than wrong: Postgres is entitled
 * to return a small table in any order, and what it in fact returns is very
 * often the order the deleted clause asked for, so the deletion passes a
 * row-level test. `YEO-94` learned that the hard way and moved its guard onto
 * the compiled statement, reaching the builders through a `Proxy` around `db`
 * that kept every select it saw.
 *
 * Naming them (`YEO-101`) does that job without the proxy, and keeps the one
 * thing that made the proxy worth its length: the test compiles the very
 * builders `exportTreeAsGedcom` runs. A test that declared its own copy of
 * these queries would prove something about the copy.
 */

/** Anything that can run a `select` — the pool, or a transaction. */
type TreeReader = Pick<typeof db, "select">;

/**
 * Every person, surname first and ending on the primary key.
 *
 * The name and the dates are what `orderIndividuals` re-sorts on anyway; the
 * id is the term that makes the order total, and the one worth guarding.
 */
export function individualsQuery(reader: TreeReader) {
  return reader
    .select()
    .from(schema.individuals)
    .orderBy(
      asc(schema.individuals.surname),
      asc(schema.individuals.givenName),
      asc(schema.individuals.id),
    );
}

/**
 * Every union, in the order a family remembers them.
 *
 * `sequence` is the column `db/schema.ts` keeps for "she remarried after he
 * died" — remembered long after the years are lost — and the id behind it
 * separates two unions that share one.
 */
export function unionsQuery(reader: TreeReader) {
  return reader
    .select()
    .from(schema.unions)
    .orderBy(asc(schema.unions.sequence), asc(schema.unions.id));
}

/**
 * Every parent-child link, ordered by the pair that is its primary key.
 *
 * This is the one clause no fixture can reach: `orderChildren` re-sorts these
 * links on family position and child position, which is already total, so
 * dropping a term here cannot change a byte of any export. It is guarded by
 * reading the SQL or it is not guarded at all.
 */
export function unionChildrenQuery(reader: TreeReader) {
  return reader
    .select()
    .from(schema.unionChildren)
    .orderBy(
      asc(schema.unionChildren.unionId),
      asc(schema.unionChildren.childId),
    );
}

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
    individualsQuery(reader),
    unionsQuery(reader),
    unionChildrenQuery(reader),
  ]);

  return writeGedcom({ individuals, unions, unionChildren });
}
