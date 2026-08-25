import { getTableColumns } from "drizzle-orm";

import { db, schema } from "@/db";
import type { GedcomMapping } from "@/lib/gedcom-map";
import { batchesOf } from "@/lib/import-batches";
import { rowsFromMapping } from "@/lib/import-rows";

/**
 * Mapped rows in, three tables written or nothing written (E6-T4, `YEO-49`).
 *
 * ## All or nothing — but of the *write*
 *
 * The ticket's reason for existing is that "a half-imported tree is worse than
 * no import: it looks like data, so nobody re-runs it, and the gaps are
 * discovered one at a time over months." One transaction is the whole answer
 * to that: every row lands or none does, and a tree is never left in a state
 * nobody chose.
 *
 * `docs/gedcom.md` left this ticket a question it could not answer on its own
 * — whether a record `validateIndividual` refused should fail the entire file,
 * in which case E6-T2's per-record skipping was "cleverness that never runs".
 * **It should not, and the distinction is that all-or-nothing is a property of
 * the write rather than of the reading.** The transaction exists so that a
 * tree is never half-*written*. A tree that is fully written and honestly
 * described as missing one person whose death date preceded their birth is
 * not half-anything: it is the whole of what the file could be read as, with
 * a report saying what the rest was. Failing the file on one unreadable date
 * would make dirty files unimportable, and E6 exists precisely because real
 * GEDCOM files are dirty — a rule that refuses every real file is not a
 * safety property.
 *
 * So there is nothing here that decides anything. `mapGedcom` already ran the
 * three validators and already dropped what they refused; by the time a
 * `GedcomMapping` arrives, every remaining row is one this application has
 * agreed to store. This module's only job is to get them there together.
 *
 * ## Why a `GedcomMapping` and not a file
 *
 * Because the mapping *is* the rows. `lib/gedcom-map.ts` mints the ids in
 * memory and resolves every foreign key before returning — its own docblock
 * promises that "E6-T4 can then be one bulk insert inside one transaction,
 * with nothing left to resolve" — so taking anything earlier in the pipeline
 * would mean re-deciding something already decided. It also keeps the read
 * half testable with no database, which `lib/gedcom.purity.test.ts` enforces
 * and three tickets depend on.
 *
 * Counting what the file contained but this did not write is a question about
 * the *file*, not about the rows, and it is answered upstream where the file
 * still is (E6-T3, `YEO-48`) rather than re-derived here from a mapping that
 * no longer remembers.
 *
 * ## Faults propagate, and that is the design
 *
 * There is no `try` here and no result union with a `failed` member. Every
 * refusal this flow has was made before the transaction opened, so everything
 * that can go wrong inside it is a genuine fault — a dropped connection, a
 * statement timeout, a constraint added after this was written. Throwing is
 * what rolls the transaction back, and it is also the honest answer: the
 * caller gets an exception whose existence means, by construction, that
 * nothing was written. Catching it here to return a count of zero would turn
 * a guarantee into a value somebody has to remember to check.
 *
 * The route that calls this owns the sentence a reader sees, the same way it
 * already owns every other refusal in the import flow.
 *
 * ## The hazard, for whoever edits this next
 *
 * **postgres.js commits a transaction callback that returns normally.**
 * `db.transaction` is its `begin`, which issues `commit` when the callback
 * resolves and `rollback` only when it *throws*. So a future edit that adds a
 * refusal here — some check that can only be made against live rows — must
 * `throw`, not `return`. Returning `{ status: "refused" }` after a write
 * reports a refusal and commits it anyway.
 *
 * That is not hypothetical: it is the bug `lib/reorder-unions.ts` shipped and
 * then fixed, and `lib/reorder-unions.db.test.ts` pins the semantics against a
 * real database under "the transaction semantics reorderUnions relies on".
 * The idiom for doing it correctly is `refuse` in `lib/set-parents.ts` — a
 * private error carrying the typed result, thrown inside and unwrapped
 * outside. It is deliberately absent here rather than unused, because there is
 * nothing yet to refuse.
 */

/**
 * How many bind parameters one row of each table can produce.
 *
 * Taken from the table rather than from the row objects, because drizzle
 * builds an insert by walking every column of the table and can bind a
 * parameter for a key the row never had — see `batchSize` in
 * `lib/import-batches.ts` for the `$defaultFn` case that makes counting keys
 * unsafe. The table's column count is an upper bound under every path.
 *
 * Exported so `lib/gedcom-import.db.test.ts` can size its fixture from the
 * same numbers this uses, rather than hard-coding a row count that quietly
 * stops spanning more than one batch when the schema widens.
 */
export const INDIVIDUAL_COLUMNS = Object.keys(
  getTableColumns(schema.individuals),
).length;
export const UNION_COLUMNS = Object.keys(getTableColumns(schema.unions)).length;
export const UNION_CHILD_COLUMNS = Object.keys(
  getTableColumns(schema.unionChildren),
).length;

/** How many rows reached each table. */
export type ImportedCounts = {
  individuals: number;
  unions: number;
  unionChildren: number;
};

/**
 * Write a mapped GEDCOM file into the three tables, all of it or none of it.
 *
 * The three inserts run in table order — individuals, then unions, then the
 * child links — and that is required even though every foreign key was
 * resolved in memory before this was called. Postgres checks a foreign key at
 * the moment the row is inserted unless the constraint was declared
 * `DEFERRABLE`, and none of the ones in `db/schema.ts` were. Pre-resolved ids
 * remove the need to *read anything back* mid-write, which is what made one
 * bulk insert possible; they do not make a union insertable before its
 * partners exist.
 *
 * The counts come from the arrays rather than from `returning`. Nothing here
 * uses `onConflictDoNothing`, so a statement that did not throw inserted every
 * row it was given — which means the length is already the answer, and
 * `returning` would be a round trip's worth of data fetched to re-derive a
 * number this function had in hand before it opened the connection. The
 * absence of `onConflictDoNothing` is itself load-bearing: it is what makes
 * "the statement returned" mean "every row landed", and `mapGedcom` earns it
 * by making a duplicate key unreachable (it mints a fresh id per record and
 * de-duplicates repeated `CHIL` pointers within a family itself).
 *
 * @param mapping rows to write, with every id minted and every key resolved
 * @returns how many rows reached each table
 * @throws whatever the driver raises, having rolled the whole import back
 */
export async function importGedcom(
  mapping: GedcomMapping,
): Promise<ImportedCounts> {
  /**
   * The rows themselves come from `lib/import-rows.ts`, and deliberately not
   * from three `map` calls here. E7-T2 (`YEO-52`) round-trips an export
   * through *this* import and compares the bytes, which it can only do if the
   * part that decides what the rows are is reachable without a database. See
   * that module's docblock; `lib/gedcom-round-trip.test.ts` asserts this call
   * still exists, because a copy of it inlined here is how the tested
   * pipeline and the real one quietly stop being the same pipeline.
   */
  const { individuals, unions, unionChildren } = rowsFromMapping(mapping);

  await db.transaction(async (tx) => {
    for (const batch of batchesOf(individuals, INDIVIDUAL_COLUMNS)) {
      await tx.insert(schema.individuals).values(batch);
    }

    for (const batch of batchesOf(unions, UNION_COLUMNS)) {
      await tx.insert(schema.unions).values(batch);
    }

    for (const batch of batchesOf(unionChildren, UNION_CHILD_COLUMNS)) {
      await tx.insert(schema.unionChildren).values(batch);
    }
  });

  return {
    individuals: individuals.length,
    unions: unions.length,
    unionChildren: unionChildren.length,
  };
}
