import { describe, expect, it } from "vitest";

// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";
import {
  isUnionOrphaned,
  previewChildDetachment,
  previewPartnerDetachment,
  previewPersonRemoval,
} from "@/lib/removal-preview";

/**
 * The cascade preview (E3-T8, `YEO-36`), asserted hard and without a database.
 *
 * These are the tests that matter most in this ticket. A delete against this
 * schema is irreversible — `db/schema.ts` cascades and the tree keeps no
 * revision history — so the confirmation dialogue is the whole safety
 * mechanism, and a dialogue is only as honest as the facts underneath it. A
 * preview that under-reports is how somebody loses a family.
 *
 * The fixture is the seed tree from docs/architecture.md, which is worth
 * reusing precisely because it contains every case a `parent_id` column
 * cannot express:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │             │
 *           Alice      Brian, Clara      Dora
 *
 * Thomas and Rose are each a partner in two unions, so deleting either takes
 * two unions and strands two different sets of children. Alice and Dora are
 * connected only through that chain of remarriages. Clara is adopted, which
 * is a property of the *link* rather than of the person. And u0 records one
 * partner and leaves the other unknown, which is the nullable-partner case the
 * data model exists to support.
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

function removalOf(personId: string, graph: FamilyGraph = seedGraph()) {
  const preview = previewPersonRemoval(graph, personId);
  if (!preview) throw new Error(`no removal preview for "${personId}"`);
  return preview;
}

const names = (people: readonly { name: string }[]) =>
  people.map((entry) => entry.name);

describe("deleting a person", () => {
  it("takes every union they are a partner in, not just their place in it", () => {
    // The single most important assertion in this file. `unions.partner_a_id`
    // is ON DELETE CASCADE, so deleting Thomas does not leave two unions with
    // an empty slot — it deletes both union rows outright.
    const thomas = removalOf("thomas");

    expect(thomas.unions.map((entry) => entry.unionId)).toEqual(["u1", "u2"]);
  });

  it("names the partner who survives each union and the children stranded with them", () => {
    const thomas = removalOf("thomas");

    const [withMary, withRose] = thomas.unions;
    expect(withMary.partner?.name).toBe("Mary Ellis");
    expect(names(withMary.children)).toEqual(["Alice Hale"]);
    expect(withRose.partner?.name).toBe("Rose Hale");
    // Brian and Clara are Rose's children too, and the link saying so is
    // carried by the union that is about to be deleted.
    expect(names(withRose.children)).toEqual(["Brian Hale", "Clara Hale"]);
  });

  it("takes the link recording whose child they were", () => {
    const alice = removalOf("alice");

    expect(alice.unions).toEqual([]);
    expect(alice.parentLinks).toHaveLength(1);
    expect(alice.parentLinks[0].unionId).toBe("u1");
    expect(names(alice.parentLinks[0].parents)).toEqual([
      "Mary Ellis",
      "Thomas Hale",
    ]);
  });

  it("reads both ends of the graph for somebody who is a child and a spouse", () => {
    // Rose is a partner in u2 and u3 and nobody's recorded child; Dora is
    // only a child. A person who is both should report both, and Brian is
    // the case that proves the walk is not one-directional.
    const graph = seedGraph();
    graph.childLinks.push({
      unionId: "u1",
      childId: "rose",
      relation: "biological",
    });

    const rose = removalOf("rose", graph);

    expect(rose.unions.map((entry) => entry.unionId)).toEqual(["u2", "u3"]);
    expect(rose.parentLinks.map((link) => link.unionId)).toEqual(["u1"]);
  });

  it("lists everybody who loses a relationship, each of them once", () => {
    const thomas = removalOf("thomas");

    // Mary and Rose from the two unions, the three children hanging off them.
    // Nobody appears twice and Thomas never appears at all.
    expect(names(thomas.survivors)).toEqual([
      "Mary Ellis",
      "Alice Hale",
      "Rose Hale",
      "Brian Hale",
      "Clara Hale",
    ]);
  });

  it("does not name the same survivor twice when they share two unions", () => {
    // Two unions between the same pair — a remarriage after a divorce, which
    // the `sequence` column exists to order. Mary must be mentioned once.
    const graph = seedGraph();
    graph.unions.push(
      union({
        id: "u4",
        partnerAId: "thomas",
        partnerBId: "mary",
        sequence: 4,
      }),
    );

    expect(names(removalOf("thomas", graph).survivors)).toContain("Mary Ellis");
    expect(
      names(removalOf("thomas", graph).survivors).filter(
        (name) => name === "Mary Ellis",
      ),
    ).toHaveLength(1);
  });

  it("says a union has no other partner rather than dropping it", () => {
    // The nullable-partner case: "we know the mother, the father is unknown".
    // The union still disappears, and the children still lose their link.
    const graph: FamilyGraph = {
      people: [
        person({ id: "mother", givenName: "Ada" }),
        person({ id: "child", givenName: "Ivy" }),
      ],
      unions: [union({ id: "u0", partnerAId: "mother" })],
      childLinks: [{ unionId: "u0", childId: "child", relation: "biological" }],
    };

    const [only] = removalOf("mother", graph).unions;
    expect(only.partner).toBeNull();
    expect(names(only.children)).toEqual(["Ivy Hale"]);
  });

  it("reports nothing to lose for somebody with no relationships", () => {
    const graph: FamilyGraph = {
      people: [person({ id: "solo", givenName: "Solo" })],
      unions: [],
      childLinks: [],
    };

    const solo = removalOf("solo", graph);
    expect(solo.unions).toEqual([]);
    expect(solo.parentLinks).toEqual([]);
    expect(solo.survivors).toEqual([]);
  });

  it("flags a linked wiki entry, which the delete keeps", () => {
    // `individuals.page_id` points *at* `pages`, so there is no cascade in
    // this direction and the entry survives. The flag only decides whether
    // the dialogue bothers to say so.
    const graph = seedGraph();
    graph.people[1] = person({
      id: "thomas",
      givenName: "Thomas",
      pageId: "page-thomas",
    });

    expect(removalOf("thomas", graph).keepsEntry).toBe(true);
    expect(removalOf("rose").keepsEntry).toBe(false);
  });

  it("carries the dates and type of each union it is about to delete", () => {
    const [withMary] = removalOf("thomas").unions;

    expect(withMary.type).toBe("marriage");
    expect(withMary.start).toBe("1 June 1920");
    expect(withMary.end).toBe("2 August 1931");
  });

  it("cleans up a union their departure would leave with nobody in it", () => {
    // The one orphan a delete can create, and the cascade cannot reach it: a
    // union with no partners recorded, whose only child is the person going.
    // Their partner-unions are deleted outright by the foreign key, but this
    // one survives with only their *link* removed — leaving a row that no
    // panel can reach and nobody can ever remove.
    const graph: FamilyGraph = {
      people: [person({ id: "only", givenName: "Ivy" })],
      unions: [union({ id: "u0" })],
      childLinks: [{ unionId: "u0", childId: "only", relation: "biological" }],
    };

    expect(removalOf("only", graph).orphanedUnionIds).toEqual(["u0"]);
  });

  it("leaves a union that still holds another child", () => {
    const graph: FamilyGraph = {
      people: [
        person({ id: "one", givenName: "Ivy" }),
        person({ id: "two", givenName: "Joan" }),
      ],
      unions: [union({ id: "u0" })],
      childLinks: [
        { unionId: "u0", childId: "one", relation: "biological" },
        { unionId: "u0", childId: "two", relation: "biological" },
      ],
    };

    expect(removalOf("one", graph).orphanedUnionIds).toEqual([]);
  });

  it("leaves the union that recorded their parents, which still records them", () => {
    // Alice's parents are still a pair, so u1 goes on being a fact about
    // Mary and Thomas after Alice is gone.
    expect(removalOf("alice").orphanedUnionIds).toEqual([]);
  });

  it("does not list a union the cascade is already taking", () => {
    // Degenerate but reachable: somebody recorded as both a partner in a
    // union and a child of it. The foreign key deletes the whole row, so
    // there is nothing left for the cleanup to find.
    const graph = seedGraph();
    graph.childLinks.push({
      unionId: "u1",
      childId: "thomas",
      relation: "biological",
    });

    expect(removalOf("thomas", graph).orphanedUnionIds).toEqual([]);
  });

  it("returns null for somebody the graph does not hold", () => {
    // Not defensive: the panel may have been open while another tab deleted
    // the same person.
    expect(previewPersonRemoval(seedGraph(), "nobody")).toBeNull();
  });
});

describe("detaching a partner", () => {
  it("names the partner who stays and the children who keep them", () => {
    const preview = previewPartnerDetachment(seedGraph(), "u2", "thomas");

    expect(preview?.person.name).toBe("Thomas Hale");
    expect(preview?.partner?.name).toBe("Rose Hale");
    expect(names(preview?.children ?? [])).toEqual([
      "Brian Hale",
      "Clara Hale",
    ]);
  });

  it("keeps the union, because the children still need the other parent", () => {
    // The whole reason detaching is gentler than deleting: Rose stays
    // attached to Brian and Clara, where deleting Thomas would take the
    // union — and her link to them — with him.
    const preview = previewPartnerDetachment(seedGraph(), "u2", "thomas");

    expect(preview?.removesUnion).toBe(false);
  });

  it("removes the union when nothing would be left in it", () => {
    const graph: FamilyGraph = {
      people: [person({ id: "a", givenName: "Ada" })],
      unions: [union({ id: "u9", partnerAId: "a" })],
      childLinks: [],
    };

    expect(previewPartnerDetachment(graph, "u9", "a")?.removesUnion).toBe(true);
  });

  it("removes the union when a childless pair is reduced to one partner", () => {
    // One partner and no children records nothing — not that they were
    // together, and not that anybody was born. Keeping the row would leave
    // the surviving partner's panel claiming an "Unknown partner" that was
    // never unknown, only deleted.
    const graph: FamilyGraph = {
      people: [
        person({ id: "a", givenName: "Ada" }),
        person({ id: "b", givenName: "Ben" }),
      ],
      unions: [union({ id: "u9", partnerAId: "a", partnerBId: "b" })],
      childLinks: [],
    };

    expect(previewPartnerDetachment(graph, "u9", "a")?.removesUnion).toBe(true);
  });

  it("keeps a childless union nobody has been detached from", () => {
    // The same union, asked about a person who is not in it — the preview
    // refuses rather than answering about somebody else's marriage.
    const graph: FamilyGraph = {
      people: [
        person({ id: "a", givenName: "Ada" }),
        person({ id: "b", givenName: "Ben" }),
        person({ id: "c", givenName: "Cal" }),
      ],
      unions: [union({ id: "u9", partnerAId: "a", partnerBId: "b" })],
      childLinks: [],
    };

    expect(previewPartnerDetachment(graph, "u9", "c")).toBeNull();
  });

  it("returns null for a union that is not there", () => {
    expect(previewPartnerDetachment(seedGraph(), "u9", "thomas")).toBeNull();
  });
});

describe("detaching a child", () => {
  it("names both parents the link runs to", () => {
    const preview = previewChildDetachment(seedGraph(), "u2", "clara");

    expect(preview?.child.name).toBe("Clara Hale");
    expect(names(preview?.parents ?? [])).toEqual([
      "Thomas Hale",
      "Rose Hale",
    ]);
    // Adoption is recorded on the link, so it is a property of what is being
    // removed rather than of the person.
    expect(preview?.relation).toBe("adopted");
  });

  it("keeps a union that still has a pair of partners", () => {
    // Dora is u3's only child, but Rose and Walter are still married.
    expect(previewChildDetachment(seedGraph(), "u3", "dora")?.removesUnion).toBe(
      false,
    );
  });

  it("removes a union whose last child leaves it with nothing", () => {
    // The orphan the acceptance criterion is about: no partners recorded and,
    // once this link goes, no children either. Nothing in the application
    // could ever reach that row again.
    const graph: FamilyGraph = {
      people: [person({ id: "child", givenName: "Ivy" })],
      unions: [union({ id: "u0" })],
      childLinks: [{ unionId: "u0", childId: "child", relation: "biological" }],
    };

    expect(previewChildDetachment(graph, "u0", "child")?.removesUnion).toBe(
      true,
    );
  });

  it("keeps a union that has another child left", () => {
    const graph: FamilyGraph = {
      people: [
        person({ id: "one", givenName: "Ivy" }),
        person({ id: "two", givenName: "Joan" }),
      ],
      unions: [union({ id: "u0" })],
      childLinks: [
        { unionId: "u0", childId: "one", relation: "biological" },
        { unionId: "u0", childId: "two", relation: "biological" },
      ],
    };

    expect(previewChildDetachment(graph, "u0", "one")?.removesUnion).toBe(
      false,
    );
  });

  it("returns null when the two are not related", () => {
    expect(previewChildDetachment(seedGraph(), "u3", "brian")).toBeNull();
    expect(previewChildDetachment(seedGraph(), "u9", "dora")).toBeNull();
    expect(previewChildDetachment(seedGraph(), "u3", "nobody")).toBeNull();
  });
});

describe("when a union has stopped recording anything", () => {
  it("keeps any union that still holds a child", () => {
    expect(isUnionOrphaned([null, null], 1)).toBe(false);
    expect(isUnionOrphaned(["a", null], 1)).toBe(false);
    expect(isUnionOrphaned(["a", "b"], 2)).toBe(false);
  });

  it("keeps a childless union that still records a pair", () => {
    // A marriage with no children is a fact about a family. It stays.
    expect(isUnionOrphaned(["a", "b"], 0)).toBe(false);
  });

  it("removes a childless union with fewer than two partners", () => {
    // Covers the acceptance criterion's case (both partners gone, no
    // children) and the one-partner case, which states nothing either.
    expect(isUnionOrphaned([null, null], 0)).toBe(true);
    expect(isUnionOrphaned(["a", null], 0)).toBe(true);
    expect(isUnionOrphaned([null, "b"], 0)).toBe(true);
  });
});
