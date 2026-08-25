import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

// Imported through the `@/*` alias on purpose: this is the test that proves
// Vitest resolves it the same way `tsc` and Next.js do.
import {
  PERSON_HEIGHT,
  PERSON_WIDTH,
  layoutFamilyGraph,
} from "@/lib/tree-layout";
import { PORTRAIT_NODE_SIZE, portraitSrc } from "@/lib/portrait";
// `import type` matters here. lib/family-graph.ts imports @/db, which pulls in
// postgres.js; taking only the type erases the import entirely and keeps this
// file runnable with no database, which is what lets it run in CI.
import type { FamilyGraph } from "@/lib/family-graph";

/**
 * A small graph in the seed's *shape*, invented for the cases below.
 *
 * Emphatically **not** the seeded family, though this docblock used to say it
 * was — "the seed fixture from docs/architecture.md, trimmed" — while the
 * names, the dates and the child counts were none of `db/seed.ts`'s, and its
 * half-known union carried `marriage`/`ongoing` where the seed's carries
 * `unknown`/`unknown`. Nothing was wrong with the tests; they were simply not
 * testing what they claimed to, and no run could report that. The seeded
 * family is now imported rather than transcribed, in
 * `lib/tree-layout.seed.test.ts` (E10-T3, `YEO-67`).
 *
 * So the two files divide the work. That one asserts what has to hold for the
 * real fixture — who exists, how many times, on which rank, with which edge
 * style. This one keeps the invented graph, because what is left here needs
 * people the seed does not have and should not grow: somebody with no surname,
 * somebody whose death is recorded and whose birth is not, and a fixed row
 * order to pin the arithmetic that turns a dagre centre into a React Flow
 * corner. Do not "correct" the dates below towards `db/seed.ts` — they differ
 * on purpose, and nothing here is a claim about the seed.
 *
 * The shape is still the shape that matters: Mary married Thomas and died;
 * Rose married Thomas and he died; Rose then married Walter. Thomas and Rose
 * are each a partner in two unions, which is precisely the case a
 * parent-pointer model cannot represent — and u0 covers the other awkward
 * case, a union with one unrecorded partner.
 */
function sampleGraph(): FamilyGraph {
  return {
    people: [
      person({
        id: "mary",
        givenName: "Mary",
        birthDate: "1901-03-04",
        deathDate: "1935-08-09",
      }),
      person({
        id: "thomas",
        givenName: "Thomas",
        sex: "male",
        birthDate: "1899-01-01",
        deathDate: "1960-06-06",
      }),
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({
        id: "walter",
        givenName: "Walter",
        sex: "male",
        deathDate: "1988-02-02",
      }),
      person({ id: "alice", givenName: "Alice", surname: null }),
      person({ id: "brian", givenName: "Brian", sex: "male" }),
      person({ id: "clara", givenName: "Clara" }),
      person({ id: "dora", givenName: "Dora" }),
      person({ id: "grandpa", givenName: "Silas", sex: "male" }),
    ],
    unions: [
      union({ id: "u0", partnerAId: "grandpa", partnerBId: null, sequence: 1 }),
      union({
        id: "u1",
        partnerAId: "mary",
        partnerBId: "thomas",
        endReason: "death",
        sequence: 1,
      }),
      union({
        id: "u2",
        partnerAId: "rose",
        partnerBId: "thomas",
        endReason: "death",
        sequence: 2,
      }),
      union({
        id: "u3",
        partnerAId: "rose",
        partnerBId: "walter",
        endReason: "ongoing",
        sequence: 3,
      }),
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
    const { nodes } = layoutFamilyGraph(sampleGraph());

    // The whole reason unions are their own nodes: Thomas and Rose each belong
    // to two unions and must still appear once. Duplicating them is the
    // failure mode this guards.
    expect(nodes.map((node) => node.id).sort()).toEqual([
      "alice",
      "brian",
      "clara",
      "dora",
      "grandpa",
      "mary",
      "rose",
      "thomas",
      "u0",
      "u1",
      "u2",
      "u3",
      "walter",
    ]);
    expect(nodes.filter((node) => node.type === "person")).toHaveLength(9);
    expect(nodes.filter((node) => node.type === "union")).toHaveLength(4);
  });

  it("ranks each generation below the one above it", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());

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
        expect(
          nodeById(nodes, parent).position.y + PERSON_HEIGHT,
        ).toBeLessThanOrEqual(unionY);
      }
      for (const child of children) {
        expect(nodeById(nodes, child).position.y).toBeGreaterThan(unionY);
      }
    }
  });

  it("reports each node by its top-left corner, not its centre", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());

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
      const centres = partners.map((id) =>
        centreX(nodeById(nodes, id), PERSON_WIDTH),
      );
      const midpoint = centres.reduce((a, b) => a + b, 0) / centres.length;

      expect(centreX(nodeById(nodes, unionId), UNION_SIZE)).toBe(midpoint);
    }
  });

  it("carries the fields the person and union nodes render from", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());

    expect(nodeById(nodes, "thomas").data).toMatchObject({
      name: "Thomas Hale",
      lifespan: "1899–1960",
      sex: "male",
      pageId: null,
    });

    const u1 = nodeById(nodes, "u1");
    expect(u1.data).toMatchObject({ endReason: "death" });
    // A union marker is a connector, not a record — clicking it should do
    // nothing and tabbing should skip it, so it is neither selectable nor
    // focusable. Both matter now that selection is what opens the detail
    // panel (E2-T1) and the tab order is how a keyboard reaches a person.
    expect(u1.selectable).toBe(false);
    expect(u1.focusable).toBe(false);
  });

  it("labels a person node for anything that cannot see it", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());

    // The wrapper React Flow puts in the tab order has no text of its own, so
    // without this a screen reader announces every person as "group, node".
    expect(nodeById(nodes, "thomas").ariaLabel).toBe("Thomas Hale, 1899–1960");
    // Nobody's dates are recorded, so the label is the name and nothing else
    // — not a name trailing an empty parenthetical.
    expect(nodeById(nodes, "alice").ariaLabel).toBe("Alice");
  });

  it("formats a lifespan from whichever dates are known", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());
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

  it("says on the node when a date is only approximate", () => {
    // `b. 1890` and `b. about 1890` are different claims, and the node label
    // is the most-read surface in the application to be making the wrong one
    // on. E4-T3 moved `formatLifespan` into `lib/format-date.ts` and gave it
    // the qualifier columns precisely so this reaches the canvas.
    const graph = sampleGraph();
    graph.people.push(
      person({
        id: "silas",
        givenName: "Silas",
        surname: "Byrne",
        birthDate: "1890-01-01",
        birthDateQualifier: "about",
        birthDatePrecision: "year",
      }),
      person({
        id: "eliza",
        givenName: "Eliza",
        surname: "Byrne",
        deathDate: "1920-01-01",
        deathDateQualifier: "before",
        deathDatePrecision: "year",
      }),
    );

    const { nodes } = layoutFamilyGraph(graph);

    expect(nodeById(nodes, "silas").data.lifespan).toBe("b. about 1890");
    expect(nodeById(nodes, "eliza").data.lifespan).toBe("d. before 1920");
    // And into the accessible name, so a screen reader is told the same thing
    // the sighted reader is rather than a more confident version of it.
    expect(nodeById(nodes, "silas").ariaLabel).toBe(
      "Silas Byrne, b. about 1890",
    );
  });

  it("never prints a coarse date's anchor day on a node", () => {
    // A year read off a headstone is stored on 1 January and a month on the
    // 1st. The lifespan is years only, so neither can leak — this is the
    // assertion that notices if it ever starts rendering the whole date.
    const graph = sampleGraph();
    graph.people.push(
      person({
        id: "silas",
        givenName: "Silas",
        birthDate: "1890-01-01",
        birthDatePrecision: "year",
        deathDate: "1962-06-01",
        deathDatePrecision: "month",
      }),
    );

    const { nodes } = layoutFamilyGraph(graph);

    expect(nodeById(nodes, "silas").data.lifespan).toBe("1890–1962");
  });

  it("skips the edge for a partner nobody recorded", () => {
    const { edges } = layoutFamilyGraph(sampleGraph());

    // Both partner columns are nullable so that an unknown parent never has to
    // be invented as a placeholder person. u0 has one recorded partner, so it
    // gets one partner edge and no edge dangling from null.
    expect(edges.filter((edge) => edge.target === "u0")).toHaveLength(1);
    expect(edgeById(edges, "p-grandpa-u0").source).toBe("grandpa");
    expect(
      edges.filter((edge) => edge.source === null || edge.target === null),
    ).toHaveLength(0);
    expect(edges.filter((edge) => edge.id.startsWith("p-"))).toHaveLength(7);
  });

  it("dashes the edges that carry a qualification", () => {
    const { edges } = layoutFamilyGraph(sampleGraph());

    // Widowhood, divorce, and adoption are visible on the canvas rather than
    // buried in a detail panel, which means the styling is behaviour.
    expect(edgeById(edges, "p-mary-u1").style).toEqual({
      strokeDasharray: "4 4",
    });
    expect(edgeById(edges, "p-rose-u3").style).toBeUndefined();
    expect(edgeById(edges, "c-u2-clara").style).toEqual({
      strokeDasharray: "2 3",
    });
    expect(edgeById(edges, "c-u2-brian").style).toBeUndefined();
  });

  it("returns an empty layout for an empty family", () => {
    // The tree renders before anyone has been entered.
    expect(
      layoutFamilyGraph({ people: [], unions: [], childLinks: [] }),
    ).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

/**
 * The acceptance criterion this ticket is written against, stated as an
 * assertion (E5-T4, `YEO-44`).
 *
 * "Layout must stay stable whether or not a portrait exists" is the kind of
 * property that is obviously true when it is written and quietly false a year
 * later, because the natural way to break it is an improvement: measuring a
 * card and passing dagre its real height, or giving a person with no
 * photograph a narrower box so the tree looks tidier. Both would work, would
 * review well, and would mean that uploading one great-grandmother's portrait
 * moved every one of her descendants sideways.
 *
 * So the test is a comparison rather than a set of expected numbers: lay the
 * same family out twice, once with portraits and once without, and require
 * that every node lands in exactly the same place. It cannot pass by
 * coincidence, and it does not have to be updated when the constants change.
 */
describe("layout stability with and without portraits", () => {
  const KEY = "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";
  const THUMB = "images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp";

  /** The sample family, with a photograph on whoever `ids` names. */
  function withPortraits(ids: readonly string[]): FamilyGraph {
    const graph = sampleGraph();
    return {
      ...graph,
      people: graph.people.map((p) =>
        ids.includes(p.id)
          ? { ...p, portraitKey: KEY, portraitThumbKey: THUMB }
          : p,
      ),
    };
  }

  function positions(graph: FamilyGraph): Record<string, unknown> {
    return Object.fromEntries(
      layoutFamilyGraph(graph).nodes.map((node) => [node.id, node.position]),
    );
  }

  it("puts every node in the same place whether or not anyone has one", () => {
    const bare = positions(sampleGraph());

    // One person, several people, and everybody — because a layout that
    // depended on the portrait *count* rather than on any single portrait
    // would survive a one-person check.
    expect(positions(withPortraits(["rose"]))).toEqual(bare);
    expect(positions(withPortraits(["rose", "thomas"]))).toEqual(bare);
    expect(
      positions(withPortraits(sampleGraph().people.map((p) => p.id))),
    ).toEqual(bare);
  });

  it("reserves the portrait's width on every person, not just the ones who have one", () => {
    // The other half of the same property, and the one that says *why* the
    // positions above agree: the box is a fixed slot. If this ever became
    // conditional, the assertion above would start failing rather than this
    // one — which is why both are here.
    expect(PERSON_WIDTH).toBe(PORTRAIT_NODE_SIZE + 8 + 176);
    expect(PERSON_HEIGHT).toBeGreaterThanOrEqual(PORTRAIT_NODE_SIZE);
  });

  it("hands the node the thumbnail, resolved as a path", () => {
    const { nodes } = layoutFamilyGraph(withPortraits(["rose"]));
    const rose = nodes.find((node) => node.id === "rose");

    // The thumbnail, never the original: a few hundred of these load at once.
    expect(rose?.data.portraitSrc).toBe(portraitSrc(THUMB));
    // And a path of this application's own rather than a storage URL, which
    // would be a credential with a fifteen-minute timer on it.
    expect(rose?.data.portraitSrc).toMatch(/^\/api\/images\//);
  });

  it("falls back to the original when no thumbnail was made", () => {
    const graph = sampleGraph();
    const only = {
      ...graph,
      people: graph.people.map((p) =>
        p.id === "rose" ? { ...p, portraitKey: KEY, portraitThumbKey: null } : p,
      ),
    };

    const rose = layoutFamilyGraph(only).nodes.find((n) => n.id === "rose");
    expect(rose?.data.portraitSrc).toBe(portraitSrc(KEY));
  });

  it("gives a person with no portrait a null rather than a placeholder path", () => {
    // The component decides what "no photograph" looks like. The layout only
    // says that there is none — inventing a path to a placeholder image here
    // would be a request per person for a picture that is markup.
    const rose = layoutFamilyGraph(sampleGraph()).nodes.find(
      (n) => n.id === "rose",
    );
    expect(rose?.data.portraitSrc).toBeNull();
  });
});
