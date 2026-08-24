import { describe, expect, it } from "vitest";

import {
  ancestryCycle,
  descendantsOrSelf,
  unionsWithoutCycle,
} from "@/lib/ancestry";
// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";

/**
 * The cycle guard (E3-T6, `YEO-34`), asserted without a database.
 *
 * These are the tests that matter most in this ticket, for the reason the
 * header of `lib/ancestry.ts` gives: a child link that makes somebody their
 * own ancestor is not a wrong-looking panel, it is `lib/tree-layout.ts`
 * walking a graph it assumes is acyclic. The check therefore has to be right
 * about four separate things, and each of them gets a section below —
 * including the one that is *not* a cycle, which is the one an over-eager
 * implementation breaks.
 *
 * The fixture is four generations with a marriage between cousins in it,
 * because that is the shape that separates "reached twice" from "reached in a
 * loop":
 *
 *   [Gran]══(uA)══[Grandpa]
 *          ┌────┴────┐
 *       [Parent]  [Aunt]══(uD)══[Uncle]
 *          ║                       │
 *         (uB)══[Spouse]        [Cousin]
 *          │                       ║
 *       [Child]══════════(uE)══════╝
 *                         │
 *                     [Grandchild]
 *
 * Child and Cousin are second cousins who married, so Grandchild descends
 * from Gran down two different paths. That is an ordinary family and not a
 * cycle, and the walk has to say so.
 */
function pedigree(): FamilyGraph {
  return {
    people: [
      person({ id: "gran", givenName: "Gran" }),
      person({ id: "grandpa", givenName: "Grandpa", sex: "male" }),
      person({ id: "parent", givenName: "Parent" }),
      person({ id: "spouse", givenName: "Spouse", sex: "male" }),
      person({ id: "aunt", givenName: "Aunt" }),
      person({ id: "uncle", givenName: "Uncle", sex: "male" }),
      person({ id: "child", givenName: "Child" }),
      person({ id: "cousin", givenName: "Cousin", sex: "male" }),
      person({ id: "grandchild", givenName: "Grandchild" }),
      // Nobody's relative: the control for every "this attach is fine" case.
      person({ id: "stranger", givenName: "Stranger", surname: "Nolan" }),
    ],
    unions: [
      union({ id: "uA", partnerAId: "gran", partnerBId: "grandpa" }),
      union({ id: "uB", partnerAId: "parent", partnerBId: "spouse" }),
      union({ id: "uD", partnerAId: "aunt", partnerBId: "uncle" }),
      union({ id: "uE", partnerAId: "child", partnerBId: "cousin" }),
    ],
    childLinks: [
      { unionId: "uA", childId: "parent", relation: "biological" },
      { unionId: "uA", childId: "aunt", relation: "biological" },
      { unionId: "uB", childId: "child", relation: "biological" },
      { unionId: "uD", childId: "cousin", relation: "biological" },
      { unionId: "uE", childId: "grandchild", relation: "biological" },
    ],
  };
}

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
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
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
    startDatePrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
}

const sorted = (ids: Set<string>) => [...ids].sort();

describe("who stands below whom", () => {
  it("includes the person themselves, because being your own parent is the shortest cycle", () => {
    expect(descendantsOrSelf(pedigree(), "grandchild")).toEqual(
      new Set(["grandchild"]),
    );
  });

  it("walks partner → union → child, generation after generation", () => {
    // Gran's line, in full: two children, two grandchildren by different
    // branches, and the great-grandchild the two branches rejoin at. Spouse
    // and Uncle married in rather than descended, so neither is here — and
    // Stranger is nowhere near it.
    expect(sorted(descendantsOrSelf(pedigree(), "gran"))).toEqual([
      "aunt",
      "child",
      "cousin",
      "gran",
      "grandchild",
      "parent",
    ]);
  });

  it("counts a person reached down two different lines exactly once", () => {
    // Grandchild descends from Gran through Parent and through Aunt, because
    // their parents are second cousins. Reached twice, held once.
    const below = descendantsOrSelf(pedigree(), "gran");

    expect([...below].filter((id) => id === "grandchild")).toHaveLength(1);
  });

  it("counts an adopted child as a descendant", () => {
    // Adoption is a `relation` on the link rather than a different shape, and
    // this file is about what the layout can draw rather than about blood: a
    // loop through an adoptive line is the same unrenderable loop.
    const graph = pedigree();
    graph.childLinks.push({
      unionId: "uE",
      childId: "stranger",
      relation: "adopted",
    });

    expect(descendantsOrSelf(graph, "child").has("stranger")).toBe(true);
  });

  it("follows a union that records only one partner", () => {
    // Both partner columns are nullable so that an unrecorded parent never
    // has to be invented as a placeholder person (docs/architecture.md). The
    // walk has to step over the empty slot rather than through it.
    const graph = pedigree();
    graph.unions.push(union({ id: "uF", partnerAId: "grandchild" }));
    graph.childLinks.push({
      unionId: "uF",
      childId: "stranger",
      relation: "biological",
    });

    expect(descendantsOrSelf(graph, "grandchild")).toEqual(
      new Set(["grandchild", "stranger"]),
    );
  });

  it("terminates on a cycle that is already in the data", () => {
    // Not reachable through the application once this ticket lands, but a
    // hand-written INSERT or an import predates the check — and a validation
    // that hangs is worse than the row it was meant to refuse.
    const graph = pedigree();
    graph.childLinks.push({
      unionId: "uA",
      childId: "grandchild",
      relation: "biological",
    });

    expect(descendantsOrSelf(graph, "gran").has("grandchild")).toBe(true);
  });
});

describe("refusing a link that would make somebody their own ancestor", () => {
  it("refuses the direct case: a partner of the union becoming its child", () => {
    // Parent is a partner in uB. Recording them as its child makes them their
    // own parent — one row, no walk needed, and the shortest loop there is.
    expect(ancestryCycle(pedigree(), "uB", "parent")).toBe("parent");
  });

  it("refuses one hop up: a parent becoming a child of their own child's union", () => {
    // Gran, recorded as a child of the union her daughter is a partner in.
    expect(ancestryCycle(pedigree(), "uB", "gran")).toBe("parent");
  });

  it("refuses across generations, which is the case nothing caught before", () => {
    // Gran as a child of her great-grandchild's parents' union. Neither
    // partner of uE is Gran, so `lib/save-child.ts`'s child-is-partner check
    // sees nothing wrong; the walk is what finds Child three ranks down.
    expect(ancestryCycle(pedigree(), "uE", "gran")).toBe("child");
  });

  it("names whichever partner is the one below them", () => {
    // Cousin descends from Gran through Aunt, and is partner B rather than
    // partner A. The second slot is checked as thoroughly as the first.
    const graph = pedigree();
    graph.unions = graph.unions.map((entry) =>
      entry.id === "uE" ? { ...entry, partnerAId: "stranger" } : entry,
    );

    expect(ancestryCycle(graph, "uE", "gran")).toBe("cousin");
  });

  it("allows the diamond: a legitimate second path to the same person", () => {
    // The whole point of the fixture. Grandchild is reachable from Gran twice
    // over, and adding Stranger to Gran's own union is nobody's ancestor
    // problem — an implementation that refused this would refuse every family
    // where two lines rejoin.
    expect(ancestryCycle(pedigree(), "uA", "stranger")).toBeNull();
  });

  it("allows a person to be a child of two different unions", () => {
    // Adopted into one family, born into another. Two rows, both true, and
    // neither of them a loop.
    const graph = pedigree();
    graph.childLinks.push({
      unionId: "uD",
      childId: "child",
      relation: "adopted",
    });

    expect(ancestryCycle(graph, "uD", "child")).toBeNull();
  });

  it("allows a descendant to be recorded under an ancestor's union", () => {
    // Downwards is the direction families run in. Grandchild under uA is a
    // strange record but not an impossible one, and it is emphatically not
    // the shape this check exists to refuse.
    expect(ancestryCycle(pedigree(), "uA", "grandchild")).toBeNull();
  });

  it("says nothing about a union the graph does not hold", () => {
    // Whether the union exists is the write's question, answered with
    // `union-not-found` rather than guessed at here.
    expect(ancestryCycle(pedigree(), "uZ", "gran")).toBeNull();
  });
});

describe("the families a person may be given", () => {
  it("leaves out every union standing below them, and their own", () => {
    // Nothing is offered for Gran, and that is the right answer rather than
    // an off-by-one: uB, uD and uE each hold somebody she is an ancestor of,
    // and uA holds Gran herself, which would make her her own parent. A
    // matriarch with no recorded parents has no family on this tree that
    // could hold her as a child — which is exactly what the form should say.
    expect(sorted(unionsWithoutCycle(pedigree(), "gran"))).toEqual([]);
  });

  it("leaves out the unions a person is a partner in", () => {
    const safe = unionsWithoutCycle(pedigree(), "child");

    expect(safe.has("uE")).toBe(false);
    expect(sorted(safe)).toEqual(["uA", "uB", "uD"]);
  });

  it("offers every union to somebody with no descendants at all", () => {
    expect(sorted(unionsWithoutCycle(pedigree(), "stranger"))).toEqual([
      "uA",
      "uB",
      "uD",
      "uE",
    ]);
  });

  it("agrees with the check the write enforces, union by union", () => {
    // The list the form filters by and the rule the transaction applies are
    // two readings of one walk; this is what pins them together, so that a
    // family offered by the picker is never refused by the server.
    const graph = pedigree();
    const safe = unionsWithoutCycle(graph, "gran");

    for (const entry of graph.unions) {
      expect(safe.has(entry.id)).toBe(
        ancestryCycle(graph, entry.id, "gran") === null,
      );
    }
  });
});
