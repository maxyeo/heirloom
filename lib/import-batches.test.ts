import { describe, expect, it } from "vitest";

import {
  MAX_BIND_PARAMETERS,
  MAX_ROWS_PER_STATEMENT,
  batchSize,
  batchesOf,
} from "@/lib/import-batches";

/**
 * The batching arithmetic behind the transactional import (E6-T4, `YEO-49`).
 *
 * No database, on purpose. The acceptance criterion these cover — "a file
 * with several hundred people should not be several hundred round trips" — is
 * a statement about a number, and a number is provable without one.
 *
 * That used to be the difference between a checked claim and an unchecked one,
 * because `npm run test:db` ran in no pipeline. `YEO-90` fixed that, and both
 * suites now gate a merge, so this file stays where it is on the ordinary
 * grounds: arithmetic belongs in the suite that needs no fixtures. See
 * docs/testing.md.
 *
 * What is deliberately *not* here: that `lib/gedcom-import.ts` actually uses
 * these batches, and that a failure in the last one unwinds the first. Both
 * are properties of a transaction rather than of arithmetic, and both live in
 * `lib/gedcom-import.db.test.ts`.
 */

/**
 * The width of the widest table this import writes.
 *
 * A literal rather than `getTableColumns(schema.individuals)`, because
 * importing the schema would drag `@/db` — and postgres.js — into a test that
 * CI runs with no `DATABASE_URL` (docs/testing.md names that trap). Nothing
 * here depends on the number being exactly right: every width up to the
 * crossover at 65 gives the same batch size, so this stands for "a row of
 * this schema's order of magnitude" rather than for a fact about a table.
 *
 * `lib/gedcom-import.db.test.ts` is where the real count is used, taken from
 * `getTableColumns` so that the production path cannot drift from the schema.
 */
const INDIVIDUAL_COLUMNS = 19;

function rows(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

describe("batchSize", () => {
  it("puts a file with several hundred people in one statement", () => {
    // The acceptance criterion, stated as the number it is. 500 people is one
    // round trip, not 500 — and the same holds for every count up to the row
    // cap.
    expect(batchSize(INDIVIDUAL_COLUMNS)).toBe(MAX_ROWS_PER_STATEMENT);
    expect(batchesOf(rows(500), INDIVIDUAL_COLUMNS)).toHaveLength(1);
  });

  it("is bounded by the row cap while the row is narrow", () => {
    // Every table this import writes is on this side of the crossover, so the
    // row cap is what governs in practice and the parameter ceiling is a
    // guard. Both of the other two tables are narrower still.
    expect(batchSize(17)).toBe(MAX_ROWS_PER_STATEMENT);
    expect(batchSize(3)).toBe(MAX_ROWS_PER_STATEMENT);
  });

  it("switches to the parameter ceiling exactly where the two cross", () => {
    /**
     * Asserted *at* the boundary rather than either side of it, because an
     * off-by-one in `MAX_BIND_PARAMETERS` is invisible anywhere else: a
     * constant of 65,535 rather than the driver's 65,533 gives identical
     * answers for every width this schema will ever have, and differs only
     * here. Two adjacent widths is the cheapest test that can tell them
     * apart.
     */
    expect(batchSize(65)).toBe(1000);
    expect(batchSize(66)).toBe(992);
    expect(batchSize(6553)).toBe(10);
    expect(batchSize(6554)).toBe(9);
  });

  it("never returns zero, however wide the row", () => {
    /**
     * The clamp matters more than it looks. Without it a table wider than the
     * ceiling floors to zero, and `batchesOf` then appends an empty batch
     * forever without consuming a row — a hang rather than an error. Pinned
     * at the last width that divides cleanly and at two that do not.
     */
    expect(batchSize(MAX_BIND_PARAMETERS)).toBe(1);
    expect(batchSize(MAX_BIND_PARAMETERS + 1)).toBe(1);
    expect(batchSize(70_000)).toBe(1);
  });
});

describe("batchesOf", () => {
  it("gives no statements at all for no rows", () => {
    /**
     * The landmine this disarms is in drizzle rather than here: `values()`
     * throws on an empty array, so a file with people but no families would
     * fail the whole import at the second statement if this returned a single
     * empty batch instead of none.
     */
    expect(batchesOf([], INDIVIDUAL_COLUMNS)).toEqual([]);
  });

  it("splits an exact multiple without a trailing empty statement", () => {
    const batches = batchesOf(rows(2000), INDIVIDUAL_COLUMNS);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000]);
  });

  it("carries the remainder in a last, shorter statement", () => {
    const batches = batchesOf(rows(1001), INDIVIDUAL_COLUMNS);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1]);
  });

  it("keeps every row, once, in the order it was given", () => {
    // The property `lib/gedcom-import.ts` relies on to treat the batches as
    // the list: foreign keys are already resolved, so nothing may be dropped
    // or reordered between the mapping and the wire.
    const original = rows(2501);
    expect(batchesOf(original, INDIVIDUAL_COLUMNS).flat()).toEqual(original);
  });

  it("keeps every statement under what the driver will accept", () => {
    /**
     * Asserted over the batches rather than restated as arithmetic, so that
     * this fails if `batchesOf` ever stops agreeing with `batchSize` — which
     * is the failure the two-function split makes possible.
     */
    for (const columns of [3, 17, 19, 66, 6554, 70_000]) {
      for (const batch of batchesOf(rows(5000), columns)) {
        expect(batch.length * columns).toBeLessThanOrEqual(
          // A single row wider than the ceiling cannot be made to fit, and the
          // clamp lets it through to fail at the driver by name; every other
          // width must land inside.
          Math.max(MAX_BIND_PARAMETERS, columns),
        );
      }
    }
  });
});
