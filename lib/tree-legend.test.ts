import { describe, expect, it } from "vitest";

// `import type` matters here for the reason docs/testing.md gives: a plain
// import of `lib/family-graph.ts` drags `@/db` and postgres.js into a test
// that has no database and, in CI's `check` job, no `DATABASE_URL` either.
import type { FamilyGraph } from "@/lib/family-graph";
import { ENDED_UNION_DASH, NON_BIOLOGICAL_DASH } from "@/lib/tree-layout";
import { treeLegend, type TreeLegendEntryId } from "@/lib/tree-legend";

/**
 * The key to the canvas's lines (E10-T5).
 *
 * What is worth asserting is not the wording — that is copy, and it will be
 * edited — but the two properties the feature is: a family with nothing
 * qualified on it is not given a box explaining nothing, and a dash is never
 * offered without the unbroken line it is a variation on, when that line is
 * on screen to be compared against.
 */

function union(
  overrides: Partial<FamilyGraph["unions"][number]> & { id: string },
) {
  return {
    partnerAId: "rose",
    partnerBId: "walter",
    type: "marriage",
    endReason: "ongoing",
    sequence: 1,
    startDate: null,
    startDateQualifier: "exact",
    startDatePrecision: "day",
    startDateUpper: null,
    startDateUpperPrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    endDateUpper: null,
    endDateUpperPrecision: "day",
    notes: null,
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
}

/**
 * Only the two lists the legend reads are populated. `people` is deliberately
 * empty: which rows a family earns is a question about its unions and its
 * child links, and a fixture that carried nine people would suggest otherwise.
 */
function graph(
  unions: FamilyGraph["unions"],
  childLinks: FamilyGraph["childLinks"] = [],
): FamilyGraph {
  return { people: [], unions, childLinks };
}

function ids(entries: readonly { id: TreeLegendEntryId }[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("treeLegend", () => {
  it("explains nothing when nothing is qualified", () => {
    // The ordinary family: everyone still married, every child a birth child.
    // A permanent key in the corner of this canvas would be furniture.
    expect(
      treeLegend(
        graph(
          [union({ id: "u1" })],
          [{ unionId: "u1", childId: "dora", relation: "biological" }],
        ),
      ),
    ).toEqual([]);
  });

  it("explains nothing for a family with no unions at all", () => {
    expect(treeLegend(graph([]))).toEqual([]);
  });

  it("introduces a dash next to the unbroken line it varies", () => {
    const entries = treeLegend(
      graph([union({ id: "u1" }), union({ id: "u2", endReason: "divorce" })]),
    );

    expect(ids(entries)).toEqual(["union", "union-ended"]);
    expect(entries[0].dash).toBeNull();
    // Read back out of `lib/tree-layout.ts` rather than restated, which is the
    // property that keeps the key describing the canvas rather than a memory
    // of it.
    expect(entries[1].dash).toBe(ENDED_UNION_DASH);
  });

  it("leaves out an unbroken line the canvas is not drawing", () => {
    // Every union on this tree ended, so there is no solid partner line
    // anywhere for a row about one to point at.
    expect(
      ids(treeLegend(graph([union({ id: "u1", endReason: "death" })]))),
    ).toEqual(["union-ended"]);
  });

  it("does the same for a child who arrived some other way", () => {
    const links: FamilyGraph["childLinks"] = [
      { unionId: "u1", childId: "brian", relation: "biological" },
      { unionId: "u1", childId: "clara", relation: "adopted" },
    ];
    const entries = treeLegend(graph([union({ id: "u1" })], links));

    expect(ids(entries)).toEqual(["child", "child-other"]);
    expect(entries[1].dash).toBe(NON_BIOLOGICAL_DASH);
  });

  it("names one row for adoption, step and foster together", () => {
    // Three relations, one dash pattern, and so one row. A row per relation
    // would promise a distinction the canvas does not draw.
    const entries = treeLegend(
      graph(
        [union({ id: "u1" })],
        [
          { unionId: "u1", childId: "a", relation: "adopted" },
          { unionId: "u1", childId: "b", relation: "step" },
          { unionId: "u1", childId: "c", relation: "foster" },
        ],
      ),
    );

    expect(ids(entries)).toEqual(["child-other"]);
  });

  it("puts the union rows above the child rows", () => {
    // The order the canvas draws them in going down the page: partners, their
    // union, then the children below it.
    const entries = treeLegend(
      graph(
        [union({ id: "u1" }), union({ id: "u2", endReason: "divorce" })],
        [
          { unionId: "u1", childId: "brian", relation: "biological" },
          { unionId: "u1", childId: "clara", relation: "step" },
        ],
      ),
    );

    expect(ids(entries)).toEqual([
      "union",
      "union-ended",
      "child",
      "child-other",
    ]);
  });

  it("gives every row words as well as a line", () => {
    // The whole point of the key. A row that drew a dash and said nothing
    // would be the state this ticket found the canvas in.
    for (const entry of treeLegend(
      graph(
        [union({ id: "u1" }), union({ id: "u2", endReason: "divorce" })],
        [{ unionId: "u1", childId: "clara", relation: "adopted" }],
      ),
    )) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });
});
