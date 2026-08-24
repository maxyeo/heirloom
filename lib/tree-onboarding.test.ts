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
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathPlace: null,
    notes: null,
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
    endDate: null,
    endDateQualifier: "exact",
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
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

  it("stops offering the invitation once a union exists", () => {
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
});
