import { describe, expect, it } from "vitest";

import { MAX_UNION_SEQUENCE } from "@/lib/union-input";
import {
  applyMove,
  formatMove,
  MOVE_FIELD,
  ORDER_FIELD,
  readMove,
  readOrder,
  reorderInputFromFormData,
  resequenceUnions,
} from "@/lib/union-order";

/**
 * The arithmetic behind the union sequence editor (E3-T7, `YEO-35`), checked
 * with no database and no document.
 *
 * This is where the ticket's real risk lives. Moving a row up a list is
 * obvious; choosing *which numbers to write* is not, because `sequence` is one
 * column shared by both partners of a union and `lib/save-union.ts` numbers
 * new unions one past the highest either partner holds. A naive "renumber from
 * zero" passes every test anyone would think to write about the person doing
 * the reordering, and silently drags their partner's other marriages around.
 * So the assertions below are mostly about what does *not* change.
 */

/** Ids have to be shaped like primary keys, so fixtures need real UUIDs. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const A = id(1);
const B = id(2);
const C = id(3);

describe("applyMove", () => {
  it("swaps a union with the one above it", () => {
    expect(applyMove([A, B, C], { direction: "up", unionId: B })).toEqual([
      B,
      A,
      C,
    ]);
  });

  it("swaps a union with the one below it", () => {
    expect(applyMove([A, B, C], { direction: "down", unionId: B })).toEqual([
      A,
      C,
      B,
    ]);
  });

  it("does not move the first union up", () => {
    expect(applyMove([A, B], { direction: "up", unionId: A })).toBeNull();
  });

  it("does not move the last union down", () => {
    expect(applyMove([A, B], { direction: "down", unionId: B })).toBeNull();
  });

  it("does nothing for a union that is not in the list", () => {
    expect(applyMove([A, B], { direction: "up", unionId: C })).toBeNull();
  });

  it("leaves the list it was given alone", () => {
    const order = [A, B];
    applyMove(order, { direction: "down", unionId: A });
    expect(order).toEqual([A, B]);
  });
});

describe("resequenceUnions", () => {
  it("hands back the numbers it was given when they already differ", () => {
    // The whole point: a person whose unions sit at 3 and 7 keeps 3 and 7, so
    // a partner's other marriage recorded at 5 stays where it was put.
    expect(resequenceUnions([7, 3])).toEqual([3, 7]);
  });

  it("breaks a tie upward, because equal numbers cannot express an order", () => {
    // The state every tree starts in: `sequence` is `not null default 0`, so
    // until somebody reorders, every union in the table is 0.
    expect(resequenceUnions([0, 0, 0])).toEqual([0, 1, 2]);
  });

  it("only lifts the duplicates, not the whole run", () => {
    expect(resequenceUnions([4, 4, 9])).toEqual([4, 5, 9]);
  });

  it("is strictly increasing, so no pair is left to the date tie-break", () => {
    const assigned = resequenceUnions([2, 2, 2, 3, 3]);
    expect(assigned).toEqual([2, 3, 4, 5, 6]);
  });

  it("keeps the run inside the bound an explicit sequence is held to", () => {
    // Two unions both at the ceiling still have to end up in an order, and
    // `validateUnion` refuses anything above `MAX_UNION_SEQUENCE` — so the
    // pair has to make room downward rather than climb past it.
    expect(resequenceUnions([MAX_UNION_SEQUENCE, MAX_UNION_SEQUENCE])).toEqual([
      MAX_UNION_SEQUENCE - 1,
      MAX_UNION_SEQUENCE,
    ]);
  });

  it("never goes below zero", () => {
    expect(resequenceUnions([0])).toEqual([0]);
    expect(Math.min(...resequenceUnions([0, 0, 0, 0]))).toBe(0);
  });

  it("has nothing to say about no unions", () => {
    expect(resequenceUnions([])).toEqual([]);
  });

  it("leaves the values it was given alone", () => {
    const current = [5, 1];
    resequenceUnions(current);
    expect(current).toEqual([5, 1]);
  });
});

describe("formatMove and readMove", () => {
  it("round-trips a move through a button value", () => {
    expect(readMove(formatMove("up", A))).toEqual({
      direction: "up",
      unionId: A,
    });
    expect(readMove(formatMove("down", A))).toEqual({
      direction: "down",
      unionId: A,
    });
  });

  it("refuses a direction it does not offer", () => {
    expect(readMove(`sideways:${A}`)).toBeNull();
  });

  it("refuses a union id that is not shaped like one", () => {
    // Without this the id reaches `eq(unions.id, value)` and Postgres raises
    // `invalid input syntax for type uuid` — a 500 rather than a refusal.
    expect(readMove("up:not-a-uuid")).toBeNull();
  });

  it("refuses a value with no direction in it", () => {
    expect(readMove(A)).toBeNull();
  });

  it("refuses anything that is not text", () => {
    expect(readMove(null)).toBeNull();
    expect(readMove(new File([], "move.txt"))).toBeNull();
  });
});

describe("readOrder", () => {
  it("reads a list of distinct row ids", () => {
    expect(readOrder([A, B])).toEqual([A, B]);
  });

  it("reads an empty list as an empty list", () => {
    expect(readOrder([])).toEqual([]);
  });

  it("refuses a repeated union", () => {
    // A list naming the same union twice is not an order of anything, and
    // `resequenceUnions` would hand out two numbers for one row.
    expect(readOrder([A, A])).toBeNull();
  });

  it("refuses an entry that is not shaped like a row id", () => {
    expect(readOrder([A, "rose"])).toBeNull();
    expect(readOrder([A, new File([], "union.txt")])).toBeNull();
  });
});

describe("reorderInputFromFormData", () => {
  it("reads the person, the whole order, and the button that was pressed", () => {
    const form = new FormData();
    form.set("personId", A);
    form.append(ORDER_FIELD, B);
    form.append(ORDER_FIELD, C);
    form.set(MOVE_FIELD, formatMove("up", C));

    expect(reorderInputFromFormData(form)).toEqual({
      personId: A,
      order: [B, C],
      move: formatMove("up", C),
    });
  });

  it("reads an untouched form as an empty order and no move", () => {
    expect(reorderInputFromFormData(new FormData())).toEqual({
      personId: null,
      order: [],
      move: null,
    });
  });
});
