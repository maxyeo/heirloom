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

/**
 * An archive that is not one tree (`YEO-103`).
 *
 * Two lineages nobody has joined and one person attached to nobody, which is
 * what a GEDCOM import of two branches looks like on the first render and what
 * `lib/tree-onboarding.ts` calls `unconnected` while somebody is still typing a
 * tree in. `sampleGraph` above is a single connected family and always was, so
 * every ordering test written before this ticket exercised the one case where
 * dagre's rank is the whole answer.
 *
 * The ids carry their family as a prefix so the tab order can be read as a
 * sequence of families below. `abbott-alone` sorts before every other id here
 * on purpose: families come out in order of their smallest id, so a version of
 * this that had no rule about people joined to nobody would tab to her first.
 */
function unjoinedArchive(): FamilyGraph {
  return {
    people: [
      // Not in family order and not in id order: `getFamilyGraph` puts no
      // `ORDER BY` on `individuals`.
      person({ id: "birch-root", givenName: "Bertha" }),
      person({ id: "abbott-alone", givenName: "Ada", surname: "Abbott" }),
      person({ id: "ash-child", givenName: "Alec", sex: "male" }),
      person({ id: "birch-spouse", givenName: "Basil", sex: "male" }),
      person({ id: "ash-root", givenName: "Agnes" }),
      person({ id: "ash-grandchild", givenName: "Amy" }),
      person({ id: "birch-child", givenName: "Bram", sex: "male" }),
      person({ id: "ash-spouse", givenName: "Arthur", sex: "male" }),
    ],
    unions: [
      union({
        id: "u-ash-1",
        partnerAId: "ash-root",
        partnerBId: "ash-spouse",
      }),
      union({ id: "u-ash-2", partnerAId: "ash-child", partnerBId: null }),
      union({
        id: "u-birch-1",
        partnerAId: "birch-root",
        partnerBId: "birch-spouse",
      }),
    ],
    childLinks: [
      { unionId: "u-ash-1", childId: "ash-child", relation: "biological" },
      { unionId: "u-ash-2", childId: "ash-grandchild", relation: "biological" },
      { unionId: "u-birch-1", childId: "birch-child", relation: "biological" },
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

/** Every person's x, which is the only thing an order constraint can move. */
function xById(nodes: Node[]): Record<string, number> {
  return Object.fromEntries(
    nodes
      .filter((node) => node.type === "person")
      .map((node) => [node.id, node.position.x]),
  );
}

function edgeById(edges: Edge[], id: string): Edge {
  const found = edges.find((edge) => edge.id === id);
  if (!found) throw new Error(`no edge produced for "${id}"`);
  return found;
}

/** The people, in the order React Flow hands them to the browser. */
function peopleInTabOrder(nodes: Node[]): Node[] {
  return nodes.filter((node) => node.type === "person");
}

/** Which family each stop belongs to, read off the id prefix. */
function familyOf(node: Node): string {
  return node.id.replace(/-.*$/, "");
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

  it("orders the person nodes the way the tree is read", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());

    /**
     * The tab order, expressed as an array (E10-T5).
     *
     * React Flow renders nodes in the order it is handed them and puts
     * `tabIndex={0}` on each, so this array *is* what a keyboard walks. Left
     * as `graph.people` it was whatever order `getFamilyGraph` returned rows
     * in, which sent Tab bouncing between generations. Sorted, each stop is
     * below or to the right of the one before it.
     *
     * Asserted as a monotone walk rather than as a fixed list of names,
     * because the names would pin dagre's exact horizontal placement — a
     * different dagre version could reasonably put two siblings the other way
     * round without breaking anything this criterion is about.
     */
    const people = nodes.filter((node) => node.type === "person");
    expect(people.length).toBeGreaterThan(1);

    /**
     * The walk below branches on whether two neighbours share a rank, and a
     * fixture that never put two people on one rank would leave the "then by
     * x" half of the rule unexercised while the test still passed. Nine
     * people over four generations always does, but "always" is what this
     * line is for.
     */
    expect(
      people.some(
        (node, index) =>
          index > 0 && node.position.y === people[index - 1].position.y,
      ),
    ).toBe(true);

    for (const [before, after] of people
      .slice(0, -1)
      .map((node, index) => [node, people[index + 1]] as const)) {
      const sameRank = before.position.y === after.position.y;
      expect(
        sameRank
          ? before.position.x < after.position.x
          : before.position.y < after.position.y,
      ).toBe(true);
    }
  });

  it("puts the oldest generation first and the youngest last", () => {
    const { nodes } = layoutFamilyGraph(sampleGraph());
    const people = nodes
      .filter((node) => node.type === "person")
      .map((node) => node.id);

    // The concrete version of the walk above, on the fixture's own ranks:
    // Grandpa is on the top rank, his children below him, and Alice, Brian,
    // Clara and Dora are the leaves. A keyboard reaches them in that order.
    expect(people[0]).toBe("grandpa");
    for (const leaf of ["alice", "brian", "clara", "dora"]) {
      expect(people.indexOf(leaf)).toBeGreaterThan(people.indexOf("thomas"));
      expect(people.indexOf(leaf)).toBeGreaterThan(people.indexOf("rose"));
    }
  });

  it("keeps the union markers out of the way of that order", () => {
    const family = sampleGraph();
    const { nodes } = layoutFamilyGraph(family);

    // They are `focusable: false`, so they are not tab stops and have no
    // business being sequenced among the people. The sort is over the people.
    //
    // Counted off the fixture rather than written as a literal: the people
    // come first and the unions after them, so the boundary is however many
    // people there happen to be, and a tenth person added below should not
    // send somebody hunting for the number that broke.
    const firstUnion = nodes.findIndex((node) => node.type === "union");
    expect(firstUnion).toBe(family.people.length);
    expect(nodes.slice(firstUnion).every((node) => node.type === "union")).toBe(
      true,
    );
    expect(
      nodes.every((node) => node.type !== "union" || node.focusable === false),
    ).toBe(true);
  });

  it("finishes one family before it starts the next", () => {
    const { nodes } = layoutFamilyGraph(unjoinedArchive());
    const families = peopleInTabOrder(nodes).map(familyOf);

    /**
     * The bug this ticket is about, stated as a property (`YEO-103`).
     *
     * Dagre ranks every connected component from its own root, so both roots
     * here land on rank 0 and sorting on `y` alone interleaved them:
     * `ash-root, birch-root, abbott-alone, ash-child, birch-child, …`. Tab
     * crossed between two unrelated lineages a generation at a time.
     *
     * Asserted as "each family occupies one unbroken run" rather than as a
     * list of names, for the reason the walk above gives: which family is
     * first is this file's business, but where dagre puts two siblings inside
     * one is not.
     */
    const runs = families.filter(
      (family, index) => index === 0 || families[index - 1] !== family,
    );
    expect(runs).toEqual([...new Set(families)]);

    // And concretely, on this fixture: the Ash family in full, then the Birch
    // family in full, then the one person joined to nobody.
    expect(runs).toEqual(["ash", "birch", "abbott"]);
  });

  it("keeps each family in generation order inside its own run", () => {
    const { nodes } = layoutFamilyGraph(unjoinedArchive());
    const people = peopleInTabOrder(nodes);

    // The E10-T5 rule, now scoped to a family rather than to the canvas: the
    // grouping above must not have cost the order *within* a group. Neighbours
    // in different families are skipped, because dagre's ranks are not
    // comparable across components — which is the whole reason for the fix.
    for (const [before, after] of people
      .slice(0, -1)
      .map((node, index) => [node, people[index + 1]] as const)) {
      if (familyOf(before) !== familyOf(after)) continue;
      const sameRank = before.position.y === after.position.y;
      expect(
        sameRank
          ? before.position.x < after.position.x
          : before.position.y < after.position.y,
      ).toBe(true);
    }
  });

  it("tabs to somebody joined to nobody last, not into the middle of a family", () => {
    const { nodes } = layoutFamilyGraph(unjoinedArchive());
    const people = peopleInTabOrder(nodes).map((node) => node.id);

    // The decision `lib/family-components.ts` makes explicitly, asserted from
    // the canvas: a loose end is where a keyboard finishes.
    expect(people.at(-1)).toBe("abbott-alone");
  });

  it("tabs the same way whichever order the rows arrived in", () => {
    // `getFamilyGraph` reads `individuals` with no `ORDER BY`, so the same
    // archive can arrive in a different order tomorrow. The families it tabs
    // through, and the order it tabs through them in, must not move when it
    // does — which is why the family key is the smallest id in the family and
    // not anything dagre decided from insertion order.
    const forwards = unjoinedArchive();
    const backwards: FamilyGraph = {
      people: [...forwards.people].reverse(),
      unions: [...forwards.unions].reverse(),
      childLinks: [...forwards.childLinks].reverse(),
    };

    const families = (graph: FamilyGraph) => [
      ...new Set(
        peopleInTabOrder(layoutFamilyGraph(graph).nodes).map(familyOf),
      ),
    ];

    expect(families(backwards)).toEqual(families(forwards));
    expect(families(backwards)).toEqual(["ash", "birch", "abbott"]);
  });

  it("still puts the union markers after every person on a canvas of several families", () => {
    const archive = unjoinedArchive();
    const { nodes } = layoutFamilyGraph(archive);

    // The people are grouped by family now, and the unions are still not
    // sequenced among them at all — they are `focusable: false`, so they are
    // no family's tab stop.
    const firstUnion = nodes.findIndex((node) => node.type === "union");
    expect(firstUnion).toBe(archive.people.length);
    expect(nodes.slice(firstUnion).every((node) => node.type === "union")).toBe(
      true,
    );
  });

  it("says what a line means with a dash and never with a colour", () => {
    const { edges } = layoutFamilyGraph(sampleGraph());

    /**
     * E10-T5's "colour is never the only signal", asserted from the direction
     * that can actually regress.
     *
     * Every edge on this canvas is React Flow's own grey, and what a line
     * means rides entirely on `strokeDasharray` — so a reader who cannot
     * separate two hues loses nothing today. The risk is somebody later
     * making an ended marriage "clearer" by tinting it, which would move the
     * signal onto the one channel that is not universally available while
     * looking, in review, like an improvement. So: no edge declares a colour,
     * of any kind, ever.
     */
    for (const edge of edges) {
      const declared = Object.keys(edge.style ?? {});
      expect(
        declared.filter((property) => /color|stroke$/i.test(property)),
      ).toEqual([]);
      expect(declared.every((property) => property === "strokeDasharray")).toBe(
        true,
      );
    }
  });

  it("hides the edges from assistive technology", () => {
    const { edges } = layoutFamilyGraph(sampleGraph());

    /**
     * React Flow names an unlabelled edge "Edge from <source> to <target>",
     * and both ids here are database UUIDs. What a relationship *is* is said
     * in words by `components/PersonPanel.tsx`, one keystroke from the node,
     * so the lines themselves are decoration — see `EDGE_A11Y`.
     *
     * `aria-hidden` rather than a presentational role, because React Flow
     * writes the label whatever the role says and a global ARIA attribute
     * negates `role="presentation"`.
     */
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.domAttributes).toEqual({ "aria-hidden": true });
    }
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
        p.id === "rose"
          ? { ...p, portraitKey: KEY, portraitThumbKey: null }
          : p,
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

/**
 * The tab order does not move with the runtime's locale (`YEO-111`).
 *
 * `layoutFamilyGraph` sorts families by the smallest member id and breaks its
 * last tie on the node id, and both used to be `localeCompare` — whose answer
 * comes from the process's ICU data rather than from the strings. Every other
 * fixture in this file uses lowercase ASCII ids, on which collation and code
 * units agree, so none of them could tell the two rules apart. These ids can.
 */
describe("tab order under a different collation", () => {
  /**
   * Two families whose smallest ids are `Zeta-root` and `apple-root`, plus a
   * loose end at each end of the same disagreement.
   *
   * By code unit every capital precedes every lowercase letter, so the Zetas
   * lead; every ICU collation compares the letters first and would lead with
   * the apples. The order asserted below is therefore a statement about which
   * comparator is in force, not just that something came out sorted.
   */
  function mixedCaseArchive(): FamilyGraph {
    return {
      people: [
        person({ id: "apple-root", givenName: "Amy" }),
        person({ id: "Yolk-alone", givenName: "Yuri", sex: "male" }),
        person({ id: "Zeta-child", givenName: "Zack", sex: "male" }),
        person({ id: "aardvark-alone", givenName: "Ada" }),
        person({ id: "Zeta-root", givenName: "Zoe" }),
        person({ id: "apple-child", givenName: "Anne", sex: "male" }),
      ],
      unions: [
        union({ id: "u-zeta", partnerAId: "Zeta-root", partnerBId: null }),
        union({ id: "u-apple", partnerAId: "apple-root", partnerBId: null }),
      ],
      childLinks: [
        { unionId: "u-zeta", childId: "Zeta-child", relation: "biological" },
        { unionId: "u-apple", childId: "apple-child", relation: "biological" },
      ],
    };
  }

  it("tabs the Zeta family first, which is the code-unit answer", () => {
    const { nodes } = layoutFamilyGraph(mixedCaseArchive());

    // Parent before child within each family is dagre's rank talking, and is
    // the E10-T5 rule the other tests already cover. What is new here is
    // which family the keyboard reaches first, and that the two loose ends
    // come last in the same code-unit order.
    expect(peopleInTabOrder(nodes).map((node) => node.id)).toEqual([
      "Zeta-root",
      "Zeta-child",
      "apple-root",
      "apple-child",
      "Yolk-alone",
      "aardvark-alone",
    ]);
  });

  it("would tab the other way round under any collation", () => {
    // The guard that makes the assertion above mean something. If ICU ever
    // agreed with code units on these ids, the test would keep passing while
    // testing nothing — this fails loudly instead of going quiet.
    for (const locale of ["en-US", "sv-SE", "tr-TR", "de-DE-u-co-phonebk"]) {
      const collator = new Intl.Collator(locale);
      expect(collator.compare("Zeta-root", "apple-root")).toBeGreaterThan(0);
      expect(collator.compare("Yolk-alone", "aardvark-alone")).toBeGreaterThan(
        0,
      );
    }
  });

  it("still finishes with the union markers", () => {
    const archive = mixedCaseArchive();
    const { nodes } = layoutFamilyGraph(archive);

    // Cheap, and it is the invariant most likely to be broken by a change to
    // the person comparator: the markers sit after the people because they
    // are appended, not because they sorted there.
    expect(nodes.findIndex((node) => node.type === "union")).toBe(
      archive.people.length,
    );
  });
});

/**
 * Which partner a reader meets first.
 *
 * Dagre orders a rank to minimise crossings and has no opinion about couples,
 * so before this the side a parent landed on was a by-product of the rest of
 * the tree and moved when the rest of the tree did. These assert the opinion,
 * and — just as much — the two cases where the layout declines to have one.
 *
 * The fixtures here are their own, rather than `sampleGraph`'s: every couple
 * in that one contains somebody married twice, which is precisely the case
 * this feature leaves alone, so it can say nothing about the ordinary one.
 */
describe("partner lead", () => {
  /** One couple, one child, and nobody married twice. */
  function couple(
    overrides: {
      motherSex?: FamilyGraph["people"][number]["sex"];
      fatherSex?: FamilyGraph["people"][number]["sex"];
    } = {},
  ): FamilyGraph {
    return {
      people: [
        /*
         * Listed father-first, and the union names him first too, because
         * that is the arrangement dagre left to itself lays out *mother*
         * first — verified by running the fixture under `neither`. So the
         * default below has real work to do, and "the father is on the left"
         * cannot pass by accident as the input order surviving unexamined.
         * Dagre's untouched order is not intuitive and not stable across its
         * versions, which is the entire reason this feature exists; if a
         * dagre upgrade makes the assertion vacuous rather than failing, the
         * paired test after it is the one that still bites.
         */
        person({
          id: "father",
          givenName: "Frank",
          sex: overrides.fatherSex ?? "male",
        }),
        person({
          id: "mother",
          givenName: "Maud",
          sex: overrides.motherSex ?? "female",
        }),
        person({ id: "child", givenName: "Cass" }),
      ],
      unions: [
        { ...union({ id: "u1" }), partnerAId: "father", partnerBId: "mother" },
      ],
      childLinks: [{ unionId: "u1", childId: "child", relation: "biological" }],
    };
  }

  it("puts the father left of the mother by default", () => {
    const x = xById(layoutFamilyGraph(couple()).nodes);

    expect(x.father).toBeLessThan(x.mother);
  });

  it("orders the couple by the lead, not by dagre's own tie-break", () => {
    /*
     * The assertion that cannot go vacuous. Either side on its own is only
     * ever one dagre tie-break away from passing for the wrong reason — the
     * test above passes untouched under some fixtures and some dagre versions
     * — but a layout that ignores the lead entirely returns the *same*
     * arrangement for both, and no arrangement satisfies both lines below.
     */
    const withFather = xById(
      layoutFamilyGraph(couple(), { partnerLead: "father" }).nodes,
    );
    const withMother = xById(
      layoutFamilyGraph(couple(), { partnerLead: "mother" }).nodes,
    );

    expect(withFather.father).toBeLessThan(withFather.mother);
    expect(withMother.mother).toBeLessThan(withMother.father);
  });

  it("keeps them on one rank either way", () => {
    // The couple is ordered by exchanging places within a generation, never
    // by moving one of them to another. A lead that re-ranked a parent would
    // satisfy both assertions above and draw a nonsense tree.
    for (const lead of ["father", "mother", "neither"] as const) {
      const { nodes } = layoutFamilyGraph(couple(), { partnerLead: lead });
      const y = (id: string) => nodeById(nodes, id).position.y;

      expect(y("father")).toBe(y("mother"));
      expect(y("child")).toBeGreaterThan(y("mother"));
    }
  });

  it("leaves a same-sex couple where dagre put them", () => {
    // Asserted as "the setting makes no difference", which is the honest
    // shape of the claim: there is no father and mother to order, so leading
    // with either must be indistinguishable. Asserting a side would be
    // asserting dagre's tie-break, which is not this feature's to promise.
    const twoMothers = couple({ fatherSex: "female" });

    expect(xById(layoutFamilyGraph(twoMothers).nodes)).toEqual(
      xById(layoutFamilyGraph(twoMothers, { partnerLead: "mother" }).nodes),
    );
  });

  it("leaves a couple whose second partner is still unknown", () => {
    // The half-entered couple, which is most of them while somebody is typing
    // a tree in. Same shape of assertion, same reason.
    const halfKnown = couple({ motherSex: "unknown" });

    expect(xById(layoutFamilyGraph(halfKnown).nodes)).toEqual(
      xById(layoutFamilyGraph(halfKnown, { partnerLead: "mother" }).nodes),
    );
  });

  it("declines to lead, rather than laying out differently, when told neither", () => {
    // `neither` has to be dagre untouched. A graph nobody can order — every
    // sex unknown — is dagre untouched by construction whatever the setting
    // is, so the two agreeing is what says the option turns the constraints
    // off rather than merely changing them.
    const unorderable = couple({ motherSex: "unknown", fatherSex: "unknown" });

    expect(
      xById(layoutFamilyGraph(unorderable, { partnerLead: "neither" }).nodes),
    ).toEqual(xById(layoutFamilyGraph(unorderable).nodes));
  });

  it("leaves a twice-married person between their two unions", () => {
    // The documented trade-off, and the reason `sampleGraph` gets no
    // constraints at all: Thomas is a partner in u1 and u2, and sitting
    // between them is what makes one node serve both marriages — the whole
    // point of unions being nodes. Leading him would pull him to the outside
    // of one wife and drag that marriage's edge back across the canvas.
    const { nodes } = layoutFamilyGraph(sampleGraph());
    const x = (id: string) => nodeById(nodes, id).position.x;

    expect(x("thomas")).toBeGreaterThan(Math.min(x("u1"), x("u2")));
    expect(x("thomas")).toBeLessThan(Math.max(x("u1"), x("u2")));
  });
});

/**
 * Which child a reader meets first.
 *
 * The same problem as the couples above, on the other axis of the same rank:
 * dagre arranges siblings to minimise crossings, so the order four children
 * came out in was decided by where their own families fell and moved when any
 * of those did. Every family chart runs eldest to youngest, so an order
 * nothing chose was still read as a claim about birth order.
 *
 * These fixtures are their own again. `sampleGraph`'s only sibships are
 * Brian and Clara, who share a birth date of `null`, which says nothing about
 * dates at all.
 */
describe("sibling order", () => {
  type Child = { id: string; givenName: string; birthDate?: string | null };

  /**
   * One couple, their children, and nobody married twice.
   *
   * The children are laid out in whatever order the constraints put them in,
   * never the order they are listed here — and the lists below are written to
   * make that visible. Dagre left to itself lays this fixture's children out
   * in the *reverse* of the order the child links arrive in, verified by
   * removing the sibling constraints and running it. So a list written
   * eldest-first is one an untouched dagre answers backwards, and the tests
   * that assert a plain eldest-to-youngest order are written that way rather
   * than passing on a tie-break. It is dagre's tie-break, though, not a
   * promise — a release could reasonably change it — which is why the test
   * that cannot go vacuous whatever dagre does is the one directly below.
   */
  function sibship(children: Child[]): FamilyGraph {
    return {
      people: [
        person({ id: "father", givenName: "Frank", sex: "male" }),
        person({ id: "mother", givenName: "Maud" }),
        ...children.map(({ id, givenName, birthDate = null }) =>
          person({ id, givenName, birthDate }),
        ),
      ],
      unions: [
        { ...union({ id: "u1" }), partnerAId: "father", partnerBId: "mother" },
      ],
      childLinks: children.map(({ id }) => ({
        unionId: "u1",
        childId: id,
        relation: "biological" as const,
      })),
    };
  }

  it("puts the eldest child on the left and the youngest on the right", () => {
    const x = xById(
      layoutFamilyGraph(
        sibship([
          { id: "eldest", givenName: "Edwin", birthDate: "1904-01-01" },
          { id: "middle", givenName: "Martha", birthDate: "1908-07-07" },
          { id: "youngest", givenName: "Yvonne", birthDate: "1912-02-02" },
        ]),
      ).nodes,
    );

    expect(x.eldest).toBeLessThan(x.middle);
    expect(x.middle).toBeLessThan(x.youngest);
  });

  it("orders them by the dates, not by dagre's own tie-break", () => {
    /*
     * The assertion that cannot go vacuous, in the shape the couples above
     * use: one fixture cannot distinguish "ordered by birth" from "dagre
     * happened to lay it out that way", but two fixtures that differ *only*
     * in which sibling holds which date can. A layout that ignores the dates
     * returns the same arrangement for both, and no arrangement satisfies
     * both pairs of lines below.
     */
    const first = xById(
      layoutFamilyGraph(
        sibship([
          { id: "a", givenName: "Alice", birthDate: "1900-01-01" },
          { id: "b", givenName: "Bram", birthDate: "1905-01-01" },
          { id: "c", givenName: "Cass", birthDate: "1910-01-01" },
        ]),
      ).nodes,
    );
    const swapped = xById(
      layoutFamilyGraph(
        sibship([
          { id: "a", givenName: "Alice", birthDate: "1910-01-01" },
          { id: "b", givenName: "Bram", birthDate: "1905-01-01" },
          { id: "c", givenName: "Cass", birthDate: "1900-01-01" },
        ]),
      ).nodes,
    );

    expect(first.a).toBeLessThan(first.b);
    expect(first.b).toBeLessThan(first.c);
    expect(swapped.c).toBeLessThan(swapped.b);
    expect(swapped.b).toBeLessThan(swapped.a);
  });

  it("puts a child with no recorded birth after the ones that have one", () => {
    // `compareByBirth`'s rule, which the detail panel and the infobox already
    // read the same way: an undated sibling follows the dated ones, because
    // no recorded date is not a claim to have been born first. Ada is named
    // to sort ahead of both her siblings, so a layout that fell back to names
    // when a date was missing would put her on the left and fail here.
    const x = xById(
      layoutFamilyGraph(
        sibship([
          { id: "older", givenName: "Cass", birthDate: "1901-01-01" },
          { id: "younger", givenName: "Bram", birthDate: "1909-09-09" },
          { id: "undated", givenName: "Ada" },
        ]),
      ).nodes,
    );

    expect(x.older).toBeLessThan(x.younger);
    expect(x.younger).toBeLessThan(x.undated);
  });

  it("keeps the children on one rank", () => {
    // Birth order is settled by exchanging places within a generation, never
    // by moving a child out of it. A layout that ranked siblings by age would
    // satisfy every x assertion above and draw a nonsense tree.
    const { nodes } = layoutFamilyGraph(
      sibship([
        { id: "youngest", givenName: "Yvonne", birthDate: "1912-02-02" },
        { id: "eldest", givenName: "Edwin", birthDate: "1904-01-01" },
      ]),
    );
    const y = (id: string) => nodeById(nodes, id).position.y;

    expect(y("eldest")).toBe(y("youngest"));
    expect(y("eldest")).toBeGreaterThan(y("father"));
  });

  it("orders each sibship on its own, not the whole generation", () => {
    /*
     * Half-siblings are two families, not one queue. Frank's children by
     * Maud and by Nora interleave by date — 1900, 1905, 1910, 1915 alternates
     * between the two marriages — so a layout that sorted the *rank* by birth
     * would have to cross one marriage's children over the other's. Each
     * sibship is ordered within itself and nothing is claimed between them.
     */
    const graph: FamilyGraph = {
      people: [
        person({ id: "father", givenName: "Frank", sex: "male" }),
        person({ id: "maud", givenName: "Maud" }),
        person({ id: "nora", givenName: "Nora" }),
        person({
          id: "maud-elder",
          givenName: "Edwin",
          birthDate: "1900-01-01",
        }),
        person({
          id: "maud-younger",
          givenName: "Ida",
          birthDate: "1910-01-01",
        }),
        person({
          id: "nora-elder",
          givenName: "Owen",
          birthDate: "1905-01-01",
        }),
        person({
          id: "nora-younger",
          givenName: "Ruth",
          birthDate: "1915-01-01",
        }),
      ],
      unions: [
        {
          ...union({ id: "u-maud", sequence: 1 }),
          partnerAId: "father",
          partnerBId: "maud",
          endReason: "death",
        },
        {
          ...union({ id: "u-nora", sequence: 2 }),
          partnerAId: "father",
          partnerBId: "nora",
        },
      ],
      childLinks: [
        { unionId: "u-maud", childId: "maud-younger", relation: "biological" },
        { unionId: "u-maud", childId: "maud-elder", relation: "biological" },
        { unionId: "u-nora", childId: "nora-younger", relation: "biological" },
        { unionId: "u-nora", childId: "nora-elder", relation: "biological" },
      ],
    };

    const x = xById(layoutFamilyGraph(graph).nodes);

    expect(x["maud-elder"]).toBeLessThan(x["maud-younger"]);
    expect(x["nora-elder"]).toBeLessThan(x["nora-younger"]);
  });

  /**
   * A family whose couples and sibships cannot both be honoured.
   *
   * Nothing exotic in it. `shared` was born to one couple and adopted by
   * another, which the schema has always allowed — so he has two sibships
   * that share nobody else. `groom` from one of them married `bride` from the
   * other, and there is no blood between them. That closes a loop across the
   * two rules: the groom leads the bride because he is the father, the bride
   * precedes `shared` because she is the elder of that sibship, and `shared`
   * precedes the groom because he is the elder of the other.
   *
   * Left to dagre, a cycle does not come out as one pair the wrong way round.
   * It resolves the contradiction its own way and drops whichever constraint
   * it likes — on this fixture, the couple — so the guarantee that goes
   * missing is not the new one. `withoutCycles` is what decides instead, and
   * this is the fixture it decides on.
   */
  function conflictingArchive(): FamilyGraph {
    return {
      people: [
        person({ id: "birth-father", givenName: "Bertram", sex: "male" }),
        person({ id: "birth-mother", givenName: "Beatrice" }),
        person({ id: "adoptive-father", givenName: "Alan", sex: "male" }),
        person({ id: "adoptive-mother", givenName: "Agnes" }),
        person({ id: "bride", givenName: "Delia", birthDate: "1900-01-01" }),
        person({
          id: "shared",
          givenName: "Sam",
          sex: "male",
          birthDate: "1902-01-01",
        }),
        person({
          id: "groom",
          givenName: "Gerald",
          sex: "male",
          birthDate: "1905-01-01",
        }),
      ],
      unions: [
        {
          ...union({ id: "u-birth" }),
          partnerAId: "birth-father",
          partnerBId: "birth-mother",
        },
        {
          ...union({ id: "u-adoptive" }),
          partnerAId: "adoptive-father",
          partnerBId: "adoptive-mother",
        },
        {
          ...union({ id: "u-marriage" }),
          partnerAId: "groom",
          partnerBId: "bride",
        },
      ],
      childLinks: [
        { unionId: "u-birth", childId: "bride", relation: "biological" },
        { unionId: "u-birth", childId: "shared", relation: "biological" },
        { unionId: "u-adoptive", childId: "shared", relation: "adopted" },
        { unionId: "u-adoptive", childId: "groom", relation: "biological" },
      ],
    };
  }

  it("drops the sibling constraint rather than the couple", () => {
    const { nodes } = layoutFamilyGraph(conflictingArchive());
    const x = xById(nodes);

    // Which of the three gave way, stated exactly. The couple is untouched —
    // the partner constraints are offered first and none of them is ever the
    // one dropped — so the groom still leads his bride; the bride still leads
    // the brother she is older than; and the one claim that cannot hold with
    // those two, that the brother comes before the groom he is older than, is
    // the one lost. Handed the cycle instead, dagre keeps the siblings and
    // discards the couple, which is how this line fails when the filter goes.
    expect(x.groom).toBeLessThan(x.bride);
    expect(x.bride).toBeLessThan(x.shared);

    // Cheap insurance on the worse of the two failure modes: a node dagre
    // could not release from a rank comes back with no coordinates at all.
    // Nothing built from this schema has reached that — see `withoutCycles` —
    // so this is a canary rather than a reproduction.
    for (const node of nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  it("tabs through a generation eldest first", () => {
    // Not a second rule, but the consequence of the first: the node array is
    // sorted by rank and then by x, so ordering the rank *is* ordering the
    // keyboard. See the tab order tests above.
    const { nodes } = layoutFamilyGraph(
      sibship([
        { id: "middle", givenName: "Martha", birthDate: "1908-07-07" },
        { id: "youngest", givenName: "Yvonne", birthDate: "1912-02-02" },
        { id: "eldest", givenName: "Edwin", birthDate: "1904-01-01" },
      ]),
    );

    expect(
      peopleInTabOrder(nodes)
        .map((node) => node.id)
        .slice(-3),
    ).toEqual(["eldest", "middle", "youngest"]);
  });
});
