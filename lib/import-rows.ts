import type { ChildRelation } from "./child-input";
import type { GedcomMapping } from "./gedcom-map";
import type { IndividualFields } from "./individual-input";
import type { UnionFields } from "./union-input";

/**
 * A `GedcomMapping` flattened into the rows the three tables take (E7-T2,
 * `YEO-52`).
 *
 * ## Why this is not three lines inside `lib/gedcom-import.ts`
 *
 * It was, and that is the problem this module exists to fix.
 *
 * E7-T2 round-trips export -> import -> export and compares the two texts
 * byte for byte. The import half of that trip has to be *the* import — the
 * one a family's file actually goes through — or the test proves a pipeline
 * nobody runs. But `importGedcom` opens a transaction, so a test cannot call
 * it without a database, and `npm test` must never need one
 * (`docs/testing.md`). The only way to have both is for the part of the
 * import that decides what the rows *are* to live on this side of the
 * database line, where a test can reach it.
 *
 * That is the same split `lib/import-batches.ts` made for the same reason,
 * and this module sits beside it: `lib/gedcom-import.ts` is now the
 * transaction and nothing else, and every value it writes is one of these.
 *
 * The drift this prevents is not hypothetical. `lib/gedcom-export.test.ts`
 * already carried a private `roundTrip` helper that spread `union.values`
 * without `sequence ?? 0` — harmless, because `mapGedcom` always supplies a
 * number, and harmless is exactly how this kind of copy starts. A second
 * caller re-deriving the rows is a second answer to "what does an import
 * write", and the round trip's whole claim is that there is only one.
 *
 * ## Pure, so the round trip can be
 *
 * No `@/db` and no drizzle: this takes a mapping and returns plain objects.
 * `lib/gedcom-round-trip.test.ts` asserts that `lib/gedcom-import.ts` builds
 * its values from here rather than inline, which is what keeps the tested
 * pipeline and the real one the same pipeline.
 */

/** An `individuals` row as it goes in: the validated fields, plus its id. */
export type ImportIndividualRow = IndividualFields & { id: string };

/**
 * A `unions` row as it goes in.
 *
 * `sequence` is narrowed to a plain `number` here, because `unions.sequence`
 * is `not null` — see `rowsFromMapping`.
 */
export type ImportUnionRow = UnionFields & { id: string; sequence: number };

/** A `union_children` row. `MappedChild` already is one. */
export type ImportChildRow = {
  unionId: string;
  childId: string;
  relation: ChildRelation;
};

/** Everything one mapped file writes, in table order. */
export type ImportRows = {
  individuals: ImportIndividualRow[];
  unions: ImportUnionRow[];
  unionChildren: ImportChildRow[];
};

/**
 * Flatten a mapping into rows.
 *
 * Pure and total: it renames nothing, decides nothing, and drops nothing.
 * Every refusal was already made by `mapGedcom`, whose three validators ran
 * before a `GedcomMapping` existed — so by the time a mapping arrives, every
 * row in it is one this application has agreed to store, and this only
 * changes its shape.
 *
 * The one value it supplies is `sequence`. `UnionFields.sequence` is
 * `number | null` — null means "place this after the ones already recorded",
 * which is a question for a form and not for an import — while
 * `unions.sequence` is `not null`. `mapGedcom` always supplies a number
 * (`deriveSequences` falls back to 0), so the null is unreachable from this
 * caller; it is spelled out anyway because under all-or-nothing an
 * unreachable null is not a null row, it is the whole file failing at the
 * last statement.
 *
 * @param mapping rows with every id minted and every key resolved
 * @returns the same rows, shaped for `insert` — and for `writeGedcom`
 */
export function rowsFromMapping(mapping: GedcomMapping): ImportRows {
  return {
    individuals: mapping.individuals.map((individual) => ({
      id: individual.id,
      ...individual.values,
    })),

    unions: mapping.unions.map((union) => ({
      id: union.id,
      ...union.values,
      sequence: union.values.sequence ?? 0,
    })),

    // Already exactly a `union_children` row — `MappedChild` was built to be
    // one — so there is nothing to rename.
    unionChildren: mapping.unionChildren.map((child) => ({ ...child })),
  };
}
