import { describe, expect, it } from "vitest";

import { connectedFamilies } from "@/lib/family-components";
// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";

/**
 * Which people belong to the same family as which (`YEO-103`).
 *
 * The archive below is deliberately not one tree, because that is the whole
 * point of the file under test: two lineages nobody has joined yet, a pair
 * with a union and no children, and one person attached to nobody at all —
 * the shape a GEDCOM import of two branches leaves behind, and the shape
 * `lib/tree-onboarding.ts` calls `unconnected` while somebody is still typing.
 *
 * ## Why the ids read the way they do
 *
 * The order families come out in is the smallest person id in each, so the ids
 * here are chosen to make that assertable — and `abbott-alone` is chosen to
 * make it *fail loudly* if the rule about people joined to nobody were
 * dropped. It sorts before every other id in the fixture, so a version of this
 * that ordered every family by its smallest id and stopped there would put the
 * one person nobody is attached to first, ahead of both families. The tests
 * below say last.
 */
function unjoinedArchive(): FamilyGraph {
  return {
    people: [
      // Deliberately not in family order, and not in id order either: the
      // rows arrive from `getFamilyGraph` in whatever order Postgres feels
      // like, since there is no `ORDER BY` on `individuals`.
      person({ id: "birch-root", givenName: "Bertha" }),
      person({ id: "abbott-alone", givenName: "Ada", surname: "Abbott" }),
      person({ id: "ashby-child", givenName: "Alec", sex: "male" }),
      person({ id: "birch-spouse", givenName: "Basil", sex: "male" }),
      person({ id: "ashby-root", givenName: "Agnes" }),
      person({ id: "cole-widow", givenName: "Cora", surname: "Cole" }),
      person({ id: "ashby-grandchild", givenName: "Amy" }),
      person({ id: "birch-child", givenName: "Bram", sex: "male" }),
      person({ id: "ashby-spouse", givenName: "Arthur", sex: "male" }),
    ],
    unions: [
      union({
        id: "u-ashby-1",
        partnerAId: "ashby-root",
        partnerBId: "ashby-spouse",
      }),
      // One partner recorded and the other not, which is the case
      // docs/architecture.md calls "unknown parent". It still joins Alec to
      // his daughter, so the Ashbys are one family across three generations.
      union({ id: "u-ashby-2", partnerAId: "ashby-child", partnerBId: null }),
      union({
        id: "u-birch-1",
        partnerAId: "birch-root",
        partnerBId: "birch-spouse",
      }),
      // A union naming one person and nobody else. It joins Cora to no one,
      // so she is still somebody attached to nobody — the same threshold
      // `unionsConnectAnybody` applies in lib/tree-onboarding.ts.
      union({ id: "u-cole-1", partnerAId: "cole-widow", partnerBId: null }),
    ],
    childLinks: [
      { unionId: "u-ashby-1", childId: "ashby-child", relation: "biological" },
      {
        unionId: "u-ashby-2",
        childId: "ashby-grandchild",
        relation: "biological",
      },
      { unionId: "u-birch-1", childId: "birch-child", relation: "adopted" },
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
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
}

/** The grouping, with each family's own membership put in a fixed order. */
function grouped(graph: FamilyGraph): string[][] {
  return connectedFamilies(graph).map((members) => [...members].sort());
}

describe("connectedFamilies", () => {
  it("groups everybody a union names into one family", () => {
    expect(grouped(unjoinedArchive())).toEqual([
      // Three generations, joined through Alec: his parents' union above him
      // and his own below him.
      ["ashby-child", "ashby-grandchild", "ashby-root", "ashby-spouse"],
      ["birch-child", "birch-root", "birch-spouse"],
      // Then the two nobody is attached to.
      ["abbott-alone"],
      ["cole-widow"],
    ]);
  });

  it("puts the people joined to nobody after every family", () => {
    const families = connectedFamilies(unjoinedArchive());
    const alone = families.filter((members) => members.length === 1);

    // The decision the ticket asks to be made explicitly rather than left to
    // dagre: a loose end goes at the end. `abbott-alone` sorts before every
    // other id in the fixture, so this passing is not the id order in
    // disguise.
    expect(families.slice(-alone.length)).toEqual(alone);
    expect(alone).toEqual([["abbott-alone"], ["cole-widow"]]);
  });

  it("counts a union that names one person as joining nobody", () => {
    // Cora has a union row. What it draws is a connector dangling off a lone
    // card, which is not a family of two, and lib/tree-onboarding.ts already
    // draws that line in the same place.
    expect(connectedFamilies(unjoinedArchive())).toContainEqual(["cole-widow"]);
  });

  it("groups the same way whichever order the rows arrive in", () => {
    // `getFamilyGraph` puts no `ORDER BY` on `individuals`, so this is the
    // criterion that the order is a property of the family rather than of the
    // query plan.
    const forwards = unjoinedArchive();
    const backwards: FamilyGraph = {
      people: [...forwards.people].reverse(),
      unions: [...forwards.unions].reverse(),
      childLinks: [...forwards.childLinks].reverse(),
    };

    expect(grouped(backwards)).toEqual(grouped(forwards));
  });

  it("makes a family of one out of somebody no union mentions at all", () => {
    const graph = unjoinedArchive();
    graph.unions = [];
    graph.childLinks = [];

    expect(connectedFamilies(graph)).toEqual(
      [...graph.people]
        .map((p) => [p.id])
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  });

  it("ignores a child link naming somebody who is not in the archive", () => {
    const graph = unjoinedArchive();
    graph.childLinks = [
      ...graph.childLinks,
      { unionId: "u-birch-1", childId: "nobody-here", relation: "biological" },
    ];

    // The layout invents a dagre node for an unknown id but renders no person
    // node for it, so it is nobody's family and must not become one.
    expect(grouped(graph)).toEqual(grouped(unjoinedArchive()));
  });

  it("ignores a union partner who is not in the archive", () => {
    const graph = unjoinedArchive();
    graph.unions = [
      ...graph.unions,
      union({
        id: "u-birch-2",
        partnerAId: "birch-child",
        partnerBId: "nobody-here",
      }),
    ];

    // Same rule as the child link above, and today the same expression: both
    // ids reach one `id !== null && neighbours.has(id)` over the whole union.
    // Which is exactly why this is written down separately — the shared
    // filter is a fact about the current implementation, not a promise, and
    // splitting partners off from children is a natural enough refactor that
    // nothing should be resting on nobody having done it yet. A partner id is
    // also the one that can be `null`, so the partner half is where a rewrite
    // is most tempted to reduce the test to a null check.
    //
    // Bram's union names nobody real but Bram, so it joins him to no one and
    // the Birches stay the family they already were.
    expect(grouped(graph)).toEqual(grouped(unjoinedArchive()));
  });

  it("returns nothing for an empty archive", () => {
    expect(
      connectedFamilies({ people: [], unions: [], childLinks: [] }),
    ).toEqual([]);
  });
});
