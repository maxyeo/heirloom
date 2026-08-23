import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

// Imported through the `@/*` alias on purpose: this is the test that proves
// Vitest resolves it the same way `tsc` and Next.js do.
import { PERSON_HEIGHT, PERSON_WIDTH, layoutFamilyGraph } from "@/lib/tree-layout";
// `import type` matters here. lib/family-graph.ts imports @/db, which pulls in
// postgres.js; taking only the type erases the import entirely and keeps this
// file runnable with no database, which is what lets it run in CI.
import type { FamilyGraph } from "@/lib/family-graph";

/**
 * The seed fixture from docs/architecture.md, trimmed to the shape that
 * matters. Mary married Thomas and died; Rose married Thomas and he died;
 * Rose then married Walter. Thomas and Rose are each a partner in two unions,
 * which is precisely the case a parent-pointer model cannot represent — and u0
 * covers the other awkward case, a union with one unrecorded partner.
 */
function seedGraph(): FamilyGraph {
  return {
    people: [
      person({ id: "mary", givenName: "Mary", birthDate: "1901-03-04", deathDate: "1935-08-09" }),
      person({ id: "thomas", givenName: "Thomas", sex: "male", birthDate: "1899-01-01", deathDate: "1960-06-06" }),
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({ id: "walter", givenName: "Walter", sex: "male", deathDate: "1988-02-02" }),
      person({ id: "alice", givenName: "Alice", surname: null }),
      person({ id: "brian", givenName: "Brian", sex: "male" }),
      person({ id: "clara", givenName: "Clara" }),
      person({ id: "dora", givenName: "Dora" }),
      person({ id: "grandpa", givenName: "Silas", sex: "male" }),
    ],
    unions: [
      union({ id: "u0", partnerAId: "grandpa", partnerBId: null, sequence: 1 }),
      union({ id: "u1", partnerAId: "mary", partnerBId: "thomas", endReason: "death", sequence: 1 }),
      union({ id: "u2", partnerAId: "rose", partnerBId: "thomas", endReason: "death", sequence: 2 }),
      union({ id: "u3", partnerAId: "rose", partnerBId: "walter", endReason: "ongoing", sequence: 3 }),
    ],
    childLinks: [
      { unionId: "u0", childId: "thomas", relation: "biological" },
      { unionId: "u1", childId: "alice", relation: "biological" },
      { unionId: "u2", childId: "brian", relation: "biological" },
      { unionId: "u2", childId: "clara", relation: "adopted" },
      { unionId: "u3", childId: "dora", relation: "biological" },
    ],
  };
}

function person(overrides: Partial<FamilyGraph["people"][number]> & { id: string; givenName: string }) {
  return {
    surname: "Hale",
    sex: "female",
    birthDate: null,
    birthDateQualifier: "exact",
    deathDate: null,
    deathDateQualifier: "exact",
    pageId: null,
    ...overrides,
  } satisfies FamilyGraph["people"][number];
}

function union(overrides: Partial<FamilyGraph["unions"][number]> & { id: string }) {
  return {
    partnerAId: null,
    partnerBId: null,
    endReason: "ongoing",
    sequence: 1,
    startDate: null,
    startDateQualifier: "exact",
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
}

// Mirrors the module-private constant of the same name. Union markers are not
// exported the way PERSON_WIDTH is, because nothing outside the layout renders
// one at a fixed size.
const UNION_SIZE = 14;

function nodeById(nodes: Node[], id: string): Node {
  const found = nodes.find((node) => node.id === id);
  if (!found) throw new Error(`no node laid out for "${id}"`);
  return found;
}

function edgeById(edges: Edge[], id: string): Edge {
  const found = edges.find((edge) => edge.id === id);
  if (!found) throw new Error(`no edge produced for "${id}"`);
  return found;
}

/** Dagre positions from centres; the layout converts to React Flow's top-left. */
function centreX(node: Node, width: number): number {
  return node.position.x + width / 2;
}

describe("layoutFamilyGraph", () => {
  it("lays out every person and every union exactly once", () => {
    const { nodes } = layoutFamilyGraph(seedGraph());

    // The whole reason unions are their own nodes: Thomas and Rose each belong
    // to two unions and must still appear once. Duplicating them is the
    // failure mode this guards.
    expect(nodes.map((node) => node.id).sort()).toEqual(
      ["alice", "brian", "clara", "dora", "grandpa", "mary", "rose", "thomas", "u0", "u1", "u2", "u3", "walter"],
    );
    expect(nodes.filter((node) => node.type === "person")).toHaveLength(9);
    expect(nodes.filter((node) => node.type === "union")).toHaveLength(4);
  });

  it("ranks each generation below the one above it", () => {
    const { nodes } = layoutFamilyGraph(seedGraph());

    // Generation is dagre rank, top to bottom: partners sit above their union,
    // and the union sits above its children. Reversing an edge or flipping
    // rankdir would scramble the tree while still producing a valid-looking
    // graph, so this is asserted rather than assumed.
    for (const [parents, unionId, children] of [
      [["mary", "thomas"], "u1", ["alice"]],
      [["rose", "thomas"], "u2", ["brian", "clara"]],
      [["rose", "walter"], "u3", ["dora"]],
    ] as const) {
      const unionY = nodeById(nodes, unionId).position.y;
      for (const parent of parents) {
        expect(nodeById(nodes, parent).position.y + PERSON_HEIGHT).toBeLessThanOrEqual(unionY);
      }
      for (const child of children) {
        expect(nodeById(nodes, child).position.y).toBeGreaterThan(unionY);
      }
    }
  });

  it("reports each node by its top-left corner, not its centre", () => {
    const { nodes } = layoutFamilyGraph(seedGraph());

    // Dagre reports centres and translates its graph so the bounding box
    // starts at the origin; React Flow positions from the top-left. Subtract
    // the half-sizes and the outermost corners land exactly on (0, 0) — so if
    // that conversion is ever dropped, the whole canvas drifts down-right by
    // half a box and this is what notices.
    expect(Math.min(...nodes.map((node) => node.position.x))).toBe(0);
    expect(Math.min(...nodes.map((node) => node.position.y))).toBe(0);

    // Persons and unions are offset by *different* half-widths, so the check
    // that pins both is where a union marker ends up: exactly midway between
    // the partners it joins. Asserting a range instead would leave ~100px of
    // slack — enough for a dropped half-width to slip through unnoticed.
    for (const [unionId, partners] of [
      ["u1", ["mary", "thomas"]],
      ["u2", ["rose", "thomas"]],
      ["u3", ["rose", "walter"]],
      // One recorded partner, so "midway between" is that partner.
      ["u0", ["grandpa"]],
    ] as const) {
      const centres = partners.map((id) => centreX(nodeById(nodes, id), PERSON_WIDTH));
      const midpoint = centres.reduce((a, b) => a + b, 0) / centres.length;

      expect(centreX(nodeById(nodes, unionId), UNION_SIZE)).toBe(midpoint);
    }
  });

  it("carries the fields the person and union nodes render from", () => {
    const { nodes } = layoutFamilyGraph(seedGraph());

    expect(nodeById(nodes, "thomas").data).toMatchObject({
      name: "Thomas Hale",
      lifespan: "1899–1960",
      sex: "male",
      pageId: null,
    });

    const u1 = nodeById(nodes, "u1");
    expect(u1.data).toMatchObject({ endReason: "death" });
    // A union marker is a connector, not a record — clicking it should do
    // nothing, so it must not be selectable.
    expect(u1.selectable).toBe(false);
  });

  it("formats a lifespan from whichever dates are known", () => {
    const { nodes } = layoutFamilyGraph(seedGraph());
    const lifespan = (id: string) => nodeById(nodes, id).data.lifespan;

    // Genealogy data is full of half-known dates, so every combination has to
    // render as something a reader can parse.
    expect(lifespan("mary")).toBe("1901–1935");
    expect(lifespan("rose")).toBe("b. 1910");
    expect(lifespan("walter")).toBe("d. 1988");
    expect(lifespan("alice")).toBe("");
    // A missing surname must not leave a trailing space behind the given name.
    expect(nodeById(nodes, "alice").data.name).toBe("Alice");
  });

  it("skips the edge for a partner nobody recorded", () => {
    const { edges } = layoutFamilyGraph(seedGraph());

    // Both partner columns are nullable so that an unknown parent never has to
    // be invented as a placeholder person. u0 has one recorded partner, so it
    // gets one partner edge and no edge dangling from null.
    expect(edges.filter((edge) => edge.target === "u0")).toHaveLength(1);
    expect(edgeById(edges, "p-grandpa-u0").source).toBe("grandpa");
    expect(edges.filter((edge) => edge.source === null || edge.target === null)).toHaveLength(0);
    expect(edges.filter((edge) => edge.id.startsWith("p-"))).toHaveLength(7);
  });

  it("dashes the edges that carry a qualification", () => {
    const { edges } = layoutFamilyGraph(seedGraph());

    // Widowhood, divorce, and adoption are visible on the canvas rather than
    // buried in a detail panel, which means the styling is behaviour.
    expect(edgeById(edges, "p-mary-u1").style).toEqual({ strokeDasharray: "4 4" });
    expect(edgeById(edges, "p-rose-u3").style).toBeUndefined();
    expect(edgeById(edges, "c-u2-clara").style).toEqual({ strokeDasharray: "2 3" });
    expect(edgeById(edges, "c-u2-brian").style).toBeUndefined();
  });

  it("returns an empty layout for an empty family", () => {
    // The tree renders before anyone has been entered.
    expect(layoutFamilyGraph({ people: [], unions: [], childLinks: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });
});
