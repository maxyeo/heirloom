import { describe, expect, it } from "vitest";

// `import type`, so that lib/family-graph.ts's own import of @/db — and with
// it postgres.js — is erased rather than loaded. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";
import { treeOnboarding } from "@/lib/tree-onboarding";

function person(
  overrides: Partial<FamilyGraph["people"][number]> & {
    id: string;
    givenName: string;
  },
) {
  return {
    surname: "Hale",
    sex: "female",
    birthDate: null,
    birthDateQualifier: "exact",
    birthDatePrecision: "day",
    birthDateUpper: null,
    birthDateUpperPrecision: "day",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
    deathDateUpper: null,
    deathDateUpperPrecision: "day",
    deathPlace: null,
    notes: null,
    portraitKey: null,
    portraitThumbKey: null,
    pageId: null,
    ...overrides,
  } satisfies FamilyGraph["people"][number];
}

function union(
  overrides: Partial<FamilyGraph["unions"][number]> & { id: string },
) {
  return {
    partnerAId: null,
    partnerBId: null,
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

function child(
  unionId: string,
  childId: string,
): FamilyGraph["childLinks"][number] {
  return { unionId, childId, relation: "biological" };
}

function graph(overrides: Partial<FamilyGraph> = {}): FamilyGraph {
  return { people: [], unions: [], childLinks: [], ...overrides };
}

describe("treeOnboarding", () => {
  it("reports an empty database as having nobody", () => {
    expect(treeOnboarding(graph())).toEqual({ stage: "no-people" });
  });

  it("names the one person on a one-person tree", () => {
    const one = graph({
      people: [person({ id: "rose", givenName: "Rose" })],
    });

    expect(treeOnboarding(one)).toEqual({
      stage: "unconnected",
      person: "Rose Hale",
    });
  });

  it("says nothing is connected when several people share no unions", () => {
    // Three people added one after another and never joined up: the same dead
    // end as the one-person tree, so it gets the same invitation — but with
    // nobody in particular to name.
    const several = graph({
      people: [
        person({ id: "rose", givenName: "Rose" }),
        person({ id: "walter", givenName: "Walter", sex: "male" }),
        person({ id: "dora", givenName: "Dora" }),
      ],
    });

    expect(treeOnboarding(several)).toEqual({
      stage: "unconnected",
      person: null,
    });
  });

  it("stops offering the invitation once a union joins two people", () => {
    const started = graph({
      people: [
        person({ id: "rose", givenName: "Rose" }),
        person({ id: "walter", givenName: "Walter", sex: "male" }),
      ],
      unions: [union({ id: "u1", partnerAId: "rose", partnerBId: "walter" })],
    });

    expect(treeOnboarding(started)).toEqual({ stage: "under-way" });
  });

  /**
   * Both partner columns are nullable (docs/architecture.md, "Unknown
   * parent"), so a union is not evidence that anybody is on the tree. A graph
   * in that state has nothing to draw and nothing to name, and the invitation
   * has to be the one that comes with a button.
   */
  it("treats a partnerless union as no tree at all", () => {
    const degenerate = graph({ unions: [union({ id: "u0" })] });

    expect(treeOnboarding(degenerate)).toEqual({ stage: "no-people" });
  });

  /**
   * `YEO-84`: the same partnerless union, but with people recorded beside it.
   * Counting rows rather than connections read this as a started tree and
   * took the hint away from an author who had connected nobody to anybody.
   */
  it("keeps the start hint when the only union joins nobody", () => {
    const stalled = graph({
      people: [
        person({ id: "rose", givenName: "Rose" }),
        person({ id: "walter", givenName: "Walter", sex: "male" }),
      ],
      unions: [union({ id: "u0" })],
    });

    expect(treeOnboarding(stalled)).toEqual({
      stage: "unconnected",
      person: null,
    });
  });

  /**
   * The shape the app's own write paths reach: detaching Walter from a
   * childless marriage clears his column and leaves the row, because E3-T8
   * deletes a union only at zero partners *and* zero children. What is left
   * on the canvas is Rose's card with a connector hanging off it, which is
   * the picture the hint answers rather than an answer to it.
   */
  it("keeps naming the lone person when a union holds only them", () => {
    const halfUnion = graph({
      people: [person({ id: "rose", givenName: "Rose" })],
      unions: [union({ id: "u1", partnerAId: "rose" })],
    });

    expect(treeOnboarding(halfUnion)).toEqual({
      stage: "unconnected",
      person: "Rose Hale",
    });
  });

  it("counts a child as one of the two a union joins", () => {
    // One known parent and one child is a family, and drawn as one — the
    // second partner simply being unrecorded.
    const singleParent = graph({
      people: [
        person({ id: "rose", givenName: "Rose" }),
        person({ id: "dora", givenName: "Dora" }),
      ],
      unions: [union({ id: "u1", partnerAId: "rose" })],
      childLinks: [child("u1", "dora")],
    });

    expect(treeOnboarding(singleParent)).toEqual({ stage: "under-way" });
  });

  it("keeps the hint for a lone child whose parents are both unknown", () => {
    // A union naming neither parent and one child joins that child to
    // nobody, so the tree has still not started.
    const unknownParents = graph({
      people: [person({ id: "dora", givenName: "Dora" })],
      unions: [union({ id: "u0" })],
      childLinks: [child("u0", "dora")],
    });

    expect(treeOnboarding(unknownParents)).toEqual({
      stage: "unconnected",
      person: "Dora Hale",
    });
  });

  it("counts two siblings under an unrecorded couple as under way", () => {
    const siblings = graph({
      people: [
        person({ id: "dora", givenName: "Dora" }),
        person({ id: "walter", givenName: "Walter", sex: "male" }),
      ],
      unions: [union({ id: "u0" })],
      childLinks: [child("u0", "dora"), child("u0", "walter")],
    });

    expect(treeOnboarding(siblings)).toEqual({ stage: "under-way" });
  });

  /**
   * The row that lists one person as both partners — the malformed shape
   * `previewPartnerDetachment` already restates both slots to cover. It fills
   * two columns and joins nobody to anybody, which is why the count is of
   * distinct people rather than of columns.
   */
  it("does not let one person listed twice count as a connection", () => {
    const selfPaired = graph({
      people: [person({ id: "rose", givenName: "Rose" })],
      unions: [union({ id: "u1", partnerAId: "rose", partnerBId: "rose" })],
    });

    expect(treeOnboarding(selfPaired)).toEqual({
      stage: "unconnected",
      person: "Rose Hale",
    });
  });
});
