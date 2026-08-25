import { describe, expect, it } from "vitest";

// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";
import {
  couplePartnerIds,
  describeUnionFacts,
  duplicateUnionGroups,
  findUnionsBetween,
  joinNotes,
  previewUnionMerge,
  sameCouple,
  unionFacts,
} from "@/lib/union-merge";

/**
 * Duplicate families and what merging them costs (E3-T10, `YEO-82`), asserted
 * with no database and no DOM.
 *
 * These are the tests that matter most in this ticket, for the reason
 * `lib/removal-preview.test.ts` gives about its own: a merge deletes a row,
 * the tree keeps no revision history, and the confirmation copy is the whole
 * safety mechanism — so a preview that under-reports is how somebody loses a
 * marriage date they typed.
 *
 * The trap the ticket names out loud is here too, twice over. Two unions
 * between the same pair is *not* automatically an error, so nothing in this
 * module may treat it as one; and two unions that each record one known
 * partner are not two records of one couple at all, so nothing here may offer
 * to merge them.
 *
 * The fixture is the seed tree from docs/architecture.md with the duplicate
 * this ticket exists for laid over it:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │             │  ╲
 *           Alice      Brian, Clara      Dora  (u3b, the duplicate)
 *                                                 │
 *                                                Edith
 */
function seedGraph(): FamilyGraph {
  return {
    people: [
      person({ id: "mary", givenName: "Mary", surname: "Ellis" }),
      person({ id: "thomas", givenName: "Thomas", sex: "male" }),
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({ id: "walter", givenName: "Walter", surname: "Doyle" }),
      person({ id: "alice", givenName: "Alice" }),
      person({ id: "brian", givenName: "Brian" }),
      person({ id: "clara", givenName: "Clara" }),
      person({ id: "dora", givenName: "Dora", surname: "Doyle" }),
      person({ id: "edith", givenName: "Edith", surname: "Doyle" }),
    ],
    unions: [
      union({
        id: "u1",
        partnerAId: "mary",
        partnerBId: "thomas",
        sequence: 1,
        startDate: "1920-06-01",
        endDate: "1931-08-02",
        endReason: "death",
      }),
      union({
        id: "u2",
        partnerAId: "thomas",
        partnerBId: "rose",
        sequence: 2,
        startDate: "1933-04-11",
      }),
      union({
        id: "u3",
        partnerAId: "rose",
        partnerBId: "walter",
        sequence: 3,
        startDate: "1946-09-30",
      }),
      /**
       * The duplicate this ticket is about, written exactly the way
       * `lib/set-parents.ts` writes one: type `unknown`, no dates, and a
       * sequence one past everything, because `nextSequence` put it there
       * today. Its only child is the one the author was actually recording.
       */
      union({
        id: "u3b",
        partnerAId: "walter",
        partnerBId: "rose",
        type: "unknown",
        sequence: 4,
      }),
    ],
    childLinks: [
      { unionId: "u1", childId: "alice", relation: "biological" },
      { unionId: "u2", childId: "brian", relation: "biological" },
      { unionId: "u2", childId: "clara", relation: "adopted" },
      { unionId: "u3", childId: "dora", relation: "biological" },
      { unionId: "u3b", childId: "edith", relation: "biological" },
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
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
}

function unionById(graph: FamilyGraph, id: string) {
  const found = graph.unions.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no union "${id}" in the fixture`);
  return found;
}

function mergeOf(keepId: string, mergeId: string, graph = seedGraph()) {
  const preview = previewUnionMerge(graph, keepId, mergeId);
  if (!preview) throw new Error(`no merge preview for ${keepId} + ${mergeId}`);
  return preview;
}

const names = (people: readonly { name: string }[]) =>
  people.map((entry) => entry.name);

describe("what counts as the same couple", () => {
  it("reads the two people out of a union that names two", () => {
    expect(couplePartnerIds(unionById(seedGraph(), "u3"))).toEqual([
      "rose",
      "walter",
    ]);
  });

  it("does not call a union with an unrecorded partner a couple", () => {
    /**
     * The trap, and the reason this is a function rather than a comparison
     * written twice. Both partner columns are nullable so that "we know the
     * mother, the father is unknown" needs no placeholder person — so two rows
     * that each record Rose and nobody else may be Rose's children by two men
     * nobody can name. Treating them as one couple would assert that those men
     * were the same man.
     */
    expect(couplePartnerIds(union({ id: "lone", partnerAId: "rose" }))).toBe(
      null,
    );
  });

  it("does not call a malformed row naming one person twice a couple", () => {
    expect(
      couplePartnerIds(
        union({ id: "odd", partnerAId: "rose", partnerBId: "rose" }),
      ),
    ).toBe(null);
  });

  it("matches the same two people whichever slots they are in", () => {
    const graph = seedGraph();
    // u3 records Rose then Walter; u3b records Walter then Rose. The columns
    // carry no meaning of their own, so the order must not decide this.
    expect(sameCouple(unionById(graph, "u3"), unionById(graph, "u3b"))).toBe(
      true,
    );
  });

  it("does not match two unions that merely share one partner", () => {
    const graph = seedGraph();
    expect(sameCouple(unionById(graph, "u2"), unionById(graph, "u3"))).toBe(
      false,
    );
  });

  it("does not match two unions that each leave a partner unrecorded", () => {
    expect(
      sameCouple(
        union({ id: "a", partnerAId: "rose" }),
        union({ id: "b", partnerAId: "rose" }),
      ),
    ).toBe(false);
  });
});

describe("finding the families two people already have", () => {
  it("returns every union recording exactly that pair", () => {
    const graph = seedGraph();
    expect(
      findUnionsBetween(graph.unions, "rose", "walter").map((u) => u.id),
    ).toEqual(["u3", "u3b"]);
  });

  it("returns nothing for two people with no family between them", () => {
    const graph = seedGraph();
    expect(findUnionsBetween(graph.unions, "mary", "walter")).toEqual([]);
  });

  it("returns nothing when the same person is named twice", () => {
    const graph = seedGraph();
    expect(findUnionsBetween(graph.unions, "rose", "rose")).toEqual([]);
  });
});

describe("grouping one person's duplicate families", () => {
  it("groups them by the partner they are shared with", () => {
    const groups = duplicateUnionGroups(seedGraph(), "rose");

    expect(groups).toHaveLength(1);
    expect(groups[0].partner.name).toBe("Walter Doyle");
    expect(groups[0].unions.map((u) => u.id)).toEqual(["u3", "u3b"]);
  });

  it("says nothing about a person whose families are all with different people", () => {
    // Rose is in u2 and u3 as well, but with two different partners — which is
    // a remarriage, not a duplicate, and asking about it would be noise.
    expect(duplicateUnionGroups(seedGraph(), "thomas")).toEqual([]);
  });

  it("says nothing about somebody with one family or none", () => {
    expect(duplicateUnionGroups(seedGraph(), "alice")).toEqual([]);
  });

  it("is silent about two unions that each record an unknown partner", () => {
    const graph = seedGraph();
    graph.unions.push(
      union({ id: "x1", partnerAId: "alice" }),
      union({ id: "x2", partnerAId: "alice" }),
    );

    // The ticket's real case, and the one a naive "same partner columns" check
    // would get wrong: Alice's two children by two unrecorded fathers.
    expect(duplicateUnionGroups(graph, "alice")).toEqual([]);
  });
});

describe("previewing a merge", () => {
  it("refuses to describe a merge of a union into itself", () => {
    expect(previewUnionMerge(seedGraph(), "u3", "u3")).toBe(null);
  });

  it("refuses to describe a merge of a union that is not in the graph", () => {
    expect(previewUnionMerge(seedGraph(), "u3", "gone")).toBe(null);
  });

  it("refuses to describe a merge of two different couples", () => {
    /**
     * The guard that keeps this from being a way to move somebody's children
     * under a couple they were never recorded with. u2 is Thomas and Rose; u3
     * is Rose and Walter.
     */
    expect(previewUnionMerge(seedGraph(), "u2", "u3")).toBe(null);
  });

  it("names the couple both records are about", () => {
    expect(names(mergeOf("u3", "u3b").partners)).toEqual([
      "Rose Hale",
      "Walter Doyle",
    ]);
  });

  it("moves the children of the record being merged away", () => {
    const preview = mergeOf("u3", "u3b");

    expect(names(preview.moving.map((entry) => entry.child))).toEqual([
      "Edith Doyle",
    ]);
    expect(preview.moving[0].relation).toBe("biological");
    // Dora was already in the record being kept, so nothing about her moves.
    expect(preview.shared).toEqual([]);
  });

  it("keeps one link for a child recorded in both, and says which relation stands", () => {
    const graph = seedGraph();
    graph.childLinks.push({
      unionId: "u3b",
      childId: "dora",
      relation: "adopted",
    });

    const preview = mergeOf("u3", "u3b", graph);

    // Edith still moves; Dora is the one recorded in both.
    expect(names(preview.moving.map((entry) => entry.child))).toEqual([
      "Edith Doyle",
    ]);
    expect(preview.shared).toHaveLength(1);
    expect(preview.shared[0].child.name).toBe("Dora Doyle");
    // The record being kept says biological; the one going says adopted. The
    // dialogue has to be able to say that out loud rather than pick silently.
    expect(preview.shared[0].keptRelation).toBe("biological");
    expect(preview.shared[0].mergedRelation).toBe("adopted");
  });

  it("names nothing as lost when the record going recorded nothing", () => {
    // The commonest merge by far: a bare `unknown` union created inline by the
    // set-parents flow, merged into the marriage it duplicated.
    expect(mergeOf("u3", "u3b").losses).toEqual([]);
  });

  it("names every value the record going holds and the survivor does not", () => {
    /**
     * The direction that loses something, which is the whole reason the
     * dialogue lists losses: keeping the bare inline row would drop the
     * marriage, its date and its end reason.
     */
    const graph = seedGraph();
    graph.unions = graph.unions.map((u) =>
      u.id === "u3" ? { ...u, endDate: "1970-01-02", endReason: "divorce" } : u,
    );

    const preview = mergeOf("u3b", "u3", graph);

    expect(preview.losses).toEqual([
      { field: "type", losing: "marriage", keeping: null },
      { field: "start", losing: "30 September 1946", keeping: null },
      { field: "end", losing: "2 January 1970", keeping: null },
      { field: "endReason", losing: "divorce", keeping: null },
    ]);
  });

  it("does not call an unsaid value a loss", () => {
    /**
     * The two enums put "nothing was said" in different places, and getting
     * `end_reason` the wrong way round would make every ordinary merge report
     * a loss nobody suffered. `ongoing` is the *default* — what the inline
     * family carries, never having been asked — so dropping it drops nothing
     * even when the record being kept says the marriage ended in divorce.
     */
    const graph = seedGraph();
    graph.unions = graph.unions.map((u) =>
      u.id === "u3" ? { ...u, endReason: "divorce" } : u,
    );

    expect(mergeOf("u3", "u3b", graph).losses).toEqual([]);
  });

  it("does treat an unrecorded *ending* as something to lose", () => {
    // `unknown` is the opposite of `ongoing`: it says the union did end and
    // nobody recorded why, which is a claim somebody chose from a list.
    const graph = seedGraph();
    graph.unions = graph.unions.map((u) =>
      u.id === "u3b" ? { ...u, endReason: "unknown" } : u,
    );

    expect(mergeOf("u3", "u3b", graph).losses).toEqual([
      { field: "endReason", losing: "unknown", keeping: null },
    ]);
  });

  it("gives the surviving record the earlier of the two places in the order", () => {
    /**
     * The acceptance criterion's "`sequence` stays coherent". The duplicate was
     * written today and numbered one past everything; the marriage it
     * duplicates is third. Keeping the *later* number would sort a 1946
     * marriage below whatever came after it.
     */
    const preview = mergeOf("u3b", "u3");

    expect(preview.sequence).toBe(3);
    expect(preview.resequences).toBe(true);
  });

  it("leaves the order alone when the surviving record already sits earlier", () => {
    const preview = mergeOf("u3", "u3b");

    expect(preview.sequence).toBe(3);
    expect(preview.resequences).toBe(false);
  });
});

describe("describing a family in a list", () => {
  it("reads as a type and a span when both are recorded", () => {
    expect(describeUnionFacts(unionFacts(unionById(seedGraph(), "u1")))).toBe(
      "Marriage, 1 June 1920 – 2 August 1931",
    );
  });

  it("reads as a type alone rather than a template with gaps in it", () => {
    expect(describeUnionFacts(unionFacts(unionById(seedGraph(), "u3b")))).toBe(
      "Union",
    );
  });

  it("says which end of the span it knows when it knows only one", () => {
    expect(describeUnionFacts(unionFacts(unionById(seedGraph(), "u3")))).toBe(
      "Marriage, from 30 September 1946",
    );
  });
});

describe("what happens to notes", () => {
  it("keeps both, so nothing anybody typed is dropped", () => {
    expect(
      joinNotes("From the parish register.", "Second cousin marriage."),
    ).toBe("From the parish register.\n\nSecond cousin marriage.");
  });

  it("keeps whichever one exists", () => {
    expect(joinNotes(null, "Only note.")).toBe("Only note.");
    expect(joinNotes("Only note.", null)).toBe("Only note.");
  });

  it("stays null when neither record had any, rather than writing a blank", () => {
    // `""` in a nullable column is a third state meaning the same as null and
    // comparing like neither — the rule `readText` states.
    expect(joinNotes(null, null)).toBe(null);
    expect(joinNotes("   ", "")).toBe(null);
  });
});
