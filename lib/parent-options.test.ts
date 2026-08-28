import { describe, expect, it } from "vitest";

// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";
import { parentOptions } from "@/lib/parent-options";

/**
 * The set-parents form's two lists (E3-T6, `YEO-34`), asserted without a
 * document.
 *
 * The fixture is the seed tree from docs/architecture.md, because a flow about
 * *which family* somebody belongs to has to be tested against the tree that
 * has more than one answer:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │             │
 *           Alice      Brian, Clara      Dora
 *
 * u0 records Mary and leaves the other partner unknown, which is the nullable
 * column the ticket's "one known parent and one unknown" rests on.
 */
function seedGraph(): FamilyGraph {
  return {
    people: [
      person({ id: "mary", givenName: "Mary", surname: "Ellis" }),
      person({
        id: "thomas",
        givenName: "Thomas",
        sex: "male",
        birthDate: "1898-11-20",
        deathDate: "1974-02-01",
      }),
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({ id: "walter", givenName: "Walter", surname: "Doyle" }),
      person({ id: "alice", givenName: "Alice" }),
      person({ id: "brian", givenName: "Brian" }),
      person({ id: "clara", givenName: "Clara" }),
      person({ id: "dora", givenName: "Dora", surname: "Doyle" }),
      person({ id: "nora", givenName: "Nora", surname: "Nolan" }),
    ],
    unions: [
      union({ id: "u0", partnerAId: "mary" }),
      union({ id: "u1", partnerAId: "mary", partnerBId: "thomas" }),
      union({ id: "u2", partnerAId: "thomas", partnerBId: "rose" }),
      union({ id: "u3", partnerAId: "rose", partnerBId: "walter" }),
    ],
    childLinks: [
      { unionId: "u1", childId: "alice", relation: "biological" },
      { unionId: "u2", childId: "brian", relation: "biological" },
      { unionId: "u2", childId: "clara", relation: "adopted" },
      { unionId: "u3", childId: "dora", relation: "biological" },
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

const ids = (options: readonly { unionId: string }[]) =>
  options.map((option) => option.unionId);

describe("the families a person may be given", () => {
  it("offers every family that is not already theirs", () => {
    // Nora is nobody's relative, so every family on the tree is a possible
    // answer — including the one that records only Mary.
    const { available, current } = parentOptions(seedGraph(), "nora");

    expect(ids(available).sort()).toEqual(["u0", "u1", "u2", "u3"]);
    expect(current).toEqual([]);
  });

  it("leaves out the family already recording them, so the list holds no refusals", () => {
    // Choosing u1 for Alice could only ever come back as `already-recorded`.
    const { available, current } = parentOptions(seedGraph(), "alice");

    expect(ids(available)).not.toContain("u1");
    expect(ids(current)).toEqual(["u1"]);
  });

  it("lists both families of somebody recorded in two", () => {
    // Adopted into one, born into another: a real record, and the reason
    // `current` is a list rather than a single union.
    const graph = seedGraph();
    graph.childLinks.push({
      unionId: "u3",
      childId: "clara",
      relation: "step",
    });

    expect(ids(parentOptions(graph, "clara").current).sort()).toEqual([
      "u2",
      "u3",
    ]);
  });

  it("leaves out the families a person is a partner in", () => {
    // Rose in u2 or u3 would be her own parent. Her own line is out too: u1
    // holds Thomas, who is not her descendant, so it stays.
    const available = ids(parentOptions(seedGraph(), "rose").available);

    expect(available).not.toContain("u2");
    expect(available).not.toContain("u3");
    expect(available).toEqual(["u0", "u1"]);
  });

  it("leaves out every family standing below them", () => {
    // Thomas is a partner in u1 and u2, and Alice, Brian and Clara descend
    // from him — but none of them is a partner in anything, so what rules u1
    // and u2 out is Thomas himself. u0 and u3 hold nobody below him.
    expect(ids(parentOptions(seedGraph(), "thomas").available)).toEqual([
      "u0",
      "u3",
    ]);
  });

  it("refuses the family whose parent descends from them, generations down", () => {
    // The case nothing in the repository caught before this ticket: Dora
    // marries and has a child, and Mary must not be offered that family.
    const graph = seedGraph();
    graph.unions.push(union({ id: "u4", partnerAId: "dora" }));
    graph.childLinks.push({
      unionId: "u4",
      childId: "nora",
      relation: "biological",
    });

    // Mary is Alice's mother only; Dora descends from Rose, not from Mary, so
    // u4 stays available to Mary. It is Rose who must not be offered it.
    expect(ids(parentOptions(graph, "rose").available)).not.toContain("u4");
    expect(ids(parentOptions(graph, "mary").available)).toContain("u4");
  });
});

describe("how a family reads", () => {
  const labelOf = (childId: string, unionId: string) => {
    const { available, current } = parentOptions(seedGraph(), childId);
    const option = [...available, ...current].find(
      (entry) => entry.unionId === unionId,
    );
    if (!option) throw new Error(`no option for "${unionId}"`);
    return option.label;
  };

  it("names both parents, with their years", () => {
    expect(labelOf("nora", "u1")).toBe(
      "Mary Ellis and Thomas Hale (1898–1974)",
    );
  });

  it("carries a parent's date qualifier into their years", () => {
    // The label exists to tell two Thomas Hales apart, and "about 1898" is a
    // materially weaker claim than "1898" when that is the thing being told
    // apart. E4-T3 put the qualifier in `formatLifespan`; this is the surface
    // reading it back.
    const graph = seedGraph();
    const thomas = graph.people.find((entry) => entry.id === "thomas");
    if (!thomas) throw new Error("no thomas in the seed graph");
    thomas.birthDateQualifier = "about";
    thomas.birthDatePrecision = "year";
    thomas.birthDate = "1898-01-01";

    const option = [
      ...parentOptions(graph, "nora").available,
      ...parentOptions(graph, "nora").current,
    ].find((entry) => entry.unionId === "u1");

    expect(option?.label).toBe("Mary Ellis and Thomas Hale (about 1898–1974)");
    // Never the anchor day the year is stored on.
    expect(option?.label).not.toMatch(/January/);
  });

  it("says outright that the other parent is unrecorded", () => {
    // The ticket's "one known parent and one unknown". A label that hid the
    // empty column would make the case unenterable through the one flow that
    // exists to support it.
    expect(labelOf("nora", "u0")).toBe("Mary Ellis and an unrecorded partner");
  });

  it("has a sentence for a family recording nobody at all", () => {
    // E3-T8 clears partner columns, so such rows exist. "and" between two
    // blanks would not be a sentence.
    const graph = seedGraph();
    graph.unions.push(union({ id: "u5" }));

    const option = parentOptions(graph, "nora").available.find(
      (entry) => entry.unionId === "u5",
    );

    expect(option?.label).toBe("An unrecorded family");
  });

  it("sorts the list by the words on screen", () => {
    // Not by `sequence`, which orders one person's marriages and is exactly
    // the question this list is not asking.
    const labels = parentOptions(seedGraph(), "nora").available.map(
      (option) => option.label,
    );

    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels[0]).toBe("Mary Ellis and an unrecorded partner");
  });

  /**
   * `localeCompare` here is deliberate, not an oversight `YEO-116` missed
   * (ticket AC5; see `lib/compare-ids.ts`). These labels are the one thing
   * this picker puts on screen for somebody to read and choose between, so
   * an accented name has to sort where a reader expects it — the seed
   * fixture's plain-ASCII names above cannot show that, because code units
   * and collation agree on all of them; this fixture is chosen so they do
   * not.
   */
  it("puts an accented label where a reader expects it, not after every unaccented one", () => {
    const graph: FamilyGraph = {
      people: [
        person({ id: "elise", givenName: "Élise", surname: "Byrne" }),
        person({ id: "zoe", givenName: "Zoe", surname: "Byrne" }),
        person({ id: "kid", givenName: "Kid" }),
      ],
      unions: [
        union({ id: "u-elise", partnerAId: "elise", partnerBId: null }),
        union({ id: "u-zoe", partnerAId: "zoe", partnerBId: null }),
      ],
      childLinks: [],
    };

    const labels = parentOptions(graph, "kid").available.map(
      (option) => option.label,
    );

    // Collation reads `É` as a variant of `E` and puts Élise first, the
    // order a reader expects.
    expect(labels).toEqual([
      "Élise Byrne and an unrecorded partner",
      "Zoe Byrne and an unrecorded partner",
    ]);

    // The guard: code units alone would have reversed this — `Z` (0x5a) sorts
    // below `É` (0xc9) — which is exactly why this sort is `localeCompare`
    // and not `compareIds`.
    expect(labels[0] < labels[1]).toBe(false);
  });
});
