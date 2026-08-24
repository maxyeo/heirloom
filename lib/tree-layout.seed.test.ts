import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import { seedFamily, seedPerson, seedUnion } from "@/db/seed-family";
import { PERSON_HEIGHT, layoutFamilyGraph } from "@/lib/tree-layout";

/**
 * The layout, against the family the data model was designed around
 * (E10-T3, `YEO-67`).
 *
 * `docs/architecture.md`: *"If the tree renders this correctly, the hard part
 * works."* This is the file that says whether it does, and it is worth having
 * because the failure it guards is one no reviewer catches by eye — a tree
 * that duplicates a twice-married person still looks like a family tree, and
 * looks like one for every family that has never remarried.
 *
 * The graph is imported from `db/seed-family.ts` rather than restated here,
 * which is the whole of the ticket's first acceptance criterion. A literal in
 * this file would be a copy that agrees with the seed today and drifts
 * silently afterwards — which is not a hypothetical, since the fixture in
 * `lib/tree-layout.test.ts` had already done exactly that under a docblock
 * claiming it was the seed.
 *
 * `db/seed-family.ts` reaches no database, so importing it costs this suite
 * nothing and `npm test` still runs with no `DATABASE_URL`.
 *
 * ## Why nothing below asserts a coordinate
 *
 * `getFamilyGraph` puts no `ORDER BY` on `individuals`, so the order people
 * arrive in is Postgres's business and not a promise. Dagre breaks ties
 * within a rank by insertion order, so an exact x is a fact about the last
 * `VACUUM` rather than about the layout. What is asserted instead is
 * everything that has to hold whichever order the rows come in: who exists,
 * how many times, which rank they land on relative to each other, and how
 * their edges are drawn. `lib/tree-layout.test.ts` owns the geometry, against
 * a small graph where the order is fixed because the literal fixes it.
 */

function nodeById(nodes: Node[], id: string): Node {
  const found = nodes.find((node) => node.id === id);
  if (!found) throw new Error(`no node laid out for "${id}"`);
  return found;
}

/** The unions a person is a partner in, read off the fixture. */
function unionsPartneredIn(personId: string) {
  return seedFamily.unions.filter(
    (union) => union.partnerAId === personId || union.partnerBId === personId,
  );
}

describe("layoutFamilyGraph, over the seeded family", () => {
  it("renders every person and every union exactly once", () => {
    const { nodes } = layoutFamilyGraph(seedFamily);

    const expected = [
      ...seedFamily.people.map((person) => person.id),
      ...seedFamily.unions.map((union) => union.id),
    ].sort();

    // Sorted ids rather than counts, because a count is satisfied by a node
    // laid out twice and another one missing.
    expect(nodes.map((node) => node.id).sort()).toEqual(expected);
    expect(nodes.filter((node) => node.type === "person")).toHaveLength(
      seedFamily.people.length,
    );
    // "Every union renders as its own node" — the decision the whole model
    // rests on. A union is not an edge between two people; it is the thing
    // both of them point at, which is what lets one person point at two.
    expect(nodes.filter((node) => node.type === "union")).toHaveLength(
      seedFamily.unions.length,
    );
  });

  it("draws a twice-married person once, not once per marriage", () => {
    const { nodes } = layoutFamilyGraph(seedFamily);

    for (const person of [seedPerson.thomas, seedPerson.rose]) {
      // The fixture has to still contain the hard case for the assertion
      // below to mean anything. A seed edited down to one marriage each would
      // leave this file green and testing nothing — the exact shape of green
      // that `docs/testing.md` is about.
      expect(unionsPartneredIn(person.id).length).toBeGreaterThan(1);

      expect(nodes.filter((node) => node.id === person.id)).toHaveLength(1);
    }
  });

  it("ranks every generation below the one above it", () => {
    const { nodes } = layoutFamilyGraph(seedFamily);
    const y = (id: string) => nodeById(nodes, id).position.y;

    // Enumerated from the fixture rather than listed, so a union added to the
    // seed is ranked by this test the moment it is added. Partners sit above
    // their union and the union above its children; reversing an edge or
    // flipping `rankdir` would scramble the tree while still producing a
    // perfectly valid-looking graph.
    for (const union of seedFamily.unions) {
      for (const partnerId of [union.partnerAId, union.partnerBId]) {
        if (!partnerId) continue;
        expect(y(partnerId) + PERSON_HEIGHT).toBeLessThanOrEqual(y(union.id));
      }
    }
    for (const link of seedFamily.childLinks) {
      expect(y(link.childId)).toBeGreaterThan(y(link.unionId));
    }
  });

  it("puts the four remarried generations on three ranks of people", () => {
    const { nodes } = layoutFamilyGraph(seedFamily);
    const y = (id: string) => nodeById(nodes, id).position.y;

    // Generation *is* dagre rank, and the seeded family is the case where
    // that has to be derived rather than counted: Rose's eight children by
    // Walter and Thomas's two by Rose are the same generation despite hanging
    // off different unions, and Edward — who shares no parent with any of
    // them — is that generation too.
    const generations = new Set(
      seedFamily.people.map((person) => y(person.id)),
    );
    expect(generations.size).toBe(3);

    expect(y(seedPerson.agnes.id)).toBeLessThan(y(seedPerson.thomas.id));
    for (const person of [
      seedPerson.mary,
      seedPerson.rose,
      seedPerson.walter,
    ]) {
      expect(y(person.id)).toBe(y(seedPerson.thomas.id));
    }
    for (const person of [
      seedPerson.edward,
      seedPerson.clara,
      seedPerson.arthur,
      seedPerson.stanley,
    ]) {
      expect(y(person.id)).toBeGreaterThan(y(seedPerson.thomas.id));
      expect(y(person.id)).toBe(y(seedPerson.edward.id));
    }
  });

  it("dashes an ended union and leaves an ongoing one solid", () => {
    const { edges } = layoutFamilyGraph(seedFamily);
    const dashed = { strokeDasharray: "4 4" };

    // Both polarities have to be present in the seed, or one of the two
    // branches below is never taken and this test half-passes by default.
    const ended = seedFamily.unions.filter((u) => u.endReason !== "ongoing");
    const ongoing = seedFamily.unions.filter((u) => u.endReason === "ongoing");
    expect(ended.length).toBeGreaterThan(0);
    expect(ongoing.length).toBeGreaterThan(0);

    for (const union of seedFamily.unions) {
      for (const partnerId of [union.partnerAId, union.partnerBId]) {
        if (!partnerId) continue;
        const edge = edges.find(
          (e) => e.source === partnerId && e.target === union.id,
        );
        // Before the style, the edge. `edge?.style` is `undefined` both when
        // an ongoing union is correctly drawn solid and when its edge was
        // never drawn at all, so without this line half of the loop below
        // would pass on an edge that does not exist.
        expect(edge).toBeDefined();
        // Widowhood and divorce are visible on the canvas rather than buried
        // in a detail panel, which is what makes the styling behaviour and
        // not decoration.
        expect(edge?.style).toEqual(
          union.endReason === "ongoing" ? undefined : dashed,
        );
      }
    }
  });

  it("dashes a child link that is not biological", () => {
    const { edges } = layoutFamilyGraph(seedFamily);
    const dashed = { strokeDasharray: "2 3" };

    // Clara is the adopted one, and she is the only reason this branch is
    // reachable from a seeded database at all — `relation` defaults to
    // `biological`.
    const other = seedFamily.childLinks.filter(
      (link) => link.relation !== "biological",
    );
    expect(other.length).toBeGreaterThan(0);

    for (const link of seedFamily.childLinks) {
      const edge = edges.find(
        (e) => e.source === link.unionId && e.target === link.childId,
      );
      // As above: a biological child and a child with no edge at all are the
      // same `undefined` to the assertion underneath.
      expect(edge).toBeDefined();
      expect(edge?.style).toEqual(
        link.relation === "biological" ? undefined : dashed,
      );
    }
  });

  it("connects every edge to two nodes that exist", () => {
    const { nodes, edges } = layoutFamilyGraph(seedFamily);
    const laidOut = new Set(nodes.map((node) => node.id));

    // A half-known union has a null partner column, so that an unknown parent
    // never has to be invented as a placeholder person. The edge for that
    // partner must not be drawn to nothing — React Flow drops an edge whose
    // endpoint it cannot find, silently, which on this canvas would read as a
    // person who was never married.
    for (const edge of edges) {
      expect(laidOut.has(edge.source)).toBe(true);
      expect(laidOut.has(edge.target)).toBe(true);
    }

    // One edge per recorded partner and one per child link, counted off the
    // fixture rather than written down: an edge quietly dropped is otherwise
    // invisible to a test that only ever iterates the edges that survived.
    const partnerEdges = seedFamily.unions.flatMap((union) =>
      [union.partnerAId, union.partnerBId].filter((id) => id !== null),
    );
    expect(edges).toHaveLength(
      partnerEdges.length + seedFamily.childLinks.length,
    );

    expect(seedUnion.u0.partnerBId).toBeNull();
    expect(edges.filter((e) => e.target === seedUnion.u0.id)).toHaveLength(1);
  });
});
