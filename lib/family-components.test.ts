import { describe, expect, it } from "vitest";

import { compareIds, connectedFamilies } from "@/lib/family-components";
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

    // The expectation is built with the same code-unit rule the module sorts
    // by (`YEO-111`). It used to be built with `localeCompare`, which agreed
    // only because every id in this fixture is lowercase ASCII — a test whose
    // expectation is computed by a locale-sensitive comparator is not a pin
    // on a locale-independent one.
    expect(connectedFamilies(graph)).toEqual(
      [...graph.people]
        .map((p) => [p.id])
        .sort((a, b) => compareIds(a[0], b[0])),
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

/**
 * The locale question (`YEO-111`).
 *
 * `YEO-103` asked for an order that is deterministic — "the same graph always
 * tabs the same way" — and the id comparison is the only thing holding that
 * up. It used to be `localeCompare`, whose answer is drawn from the collation
 * data the process happens to have rather than from the two strings, so the
 * guarantee that actually shipped was "the same way on this machine, under
 * this `LANG`, against this ICU build".
 *
 * Every fixture above is lowercase ASCII kebab-case, which is precisely the
 * input on which the two rules agree — so none of those tests could have
 * caught the difference. These use ids that collate the other way round.
 */
describe("component order does not depend on the runtime's collation", () => {
  /**
   * Two families and two loose ends, with ids chosen so that code units and
   * collation disagree about all four.
   *
   * `Z` is code unit 0x5A and `a` is 0x61, so by code unit every capital
   * sorts ahead of every lowercase letter: `Zeta-root` before `apple-root`,
   * `Yolk` before `aardvark`. Collation compares letters before it compares
   * case, so ICU puts `apple` and `aardvark` first instead. The assertions
   * below the fixture check that this is still true of the ICU this test is
   * running against, rather than trusting the paragraph.
   */
  function mixedCaseArchive(): FamilyGraph {
    return {
      people: [
        person({ id: "apple-spouse", givenName: "Anne", sex: "male" }),
        person({ id: "Zeta-root", givenName: "Zoe" }),
        person({ id: "aardvark-alone", givenName: "Ada" }),
        person({ id: "Zeta-spouse", givenName: "Zack", sex: "male" }),
        person({ id: "Yolk-alone", givenName: "Yuri", sex: "male" }),
        person({ id: "apple-root", givenName: "Amy" }),
      ],
      unions: [
        union({
          id: "u-zeta",
          partnerAId: "Zeta-root",
          partnerBId: "Zeta-spouse",
        }),
        union({
          id: "u-apple",
          partnerAId: "apple-root",
          partnerBId: "apple-spouse",
        }),
      ],
      childLinks: [],
    };
  }

  /**
   * Locales picked to span the ways collation is tailored, not at random:
   * `en` is the default most developers run under, `sv` reorders letters at
   * the end of its alphabet, `tr` has its own rules for dotted and dotless
   * `i`, and `de-DE-u-co-phonebk` is a non-default collation of a locale that
   * also has a default one. If the order were collation's to decide, this is
   * the axis along which it could move.
   */
  const locales = ["en-US", "sv-SE", "tr-TR", "de-DE-u-co-phonebk"];

  it("uses ids that collation really does order the other way", () => {
    // Guarding the fixture rather than the module: a test that pins an order
    // against ids every locale sorts identically pins nothing, and would go
    // on passing if `localeCompare` came back tomorrow. If ICU ever stopped
    // disagreeing here, the tests below would become vacuous silently — this
    // is what makes that loud instead.
    for (const locale of locales) {
      const collator = new Intl.Collator(locale);
      expect(collator.compare("Zeta-root", "apple-root")).toBeGreaterThan(0);
      expect(compareIds("Zeta-root", "apple-root")).toBeLessThan(0);

      expect(collator.compare("Yolk-alone", "aardvark-alone")).toBeGreaterThan(
        0,
      );
      expect(compareIds("Yolk-alone", "aardvark-alone")).toBeLessThan(0);
    }
  });

  it("orders families by code unit rather than by the ambient locale", () => {
    // `Zeta` first is the code-unit answer. Under any collation in `locales`
    // above, `apple` would come first — so this asserts which of the two
    // rules is in force, not merely that some order came out.
    // `grouped`, like every ordering test above, because membership within a
    // family is explicitly not ordered by this module — the order *of* the
    // families is what is under test.
    expect(grouped(mixedCaseArchive())).toEqual([
      ["Zeta-root", "Zeta-spouse"],
      ["apple-root", "apple-spouse"],
      ["Yolk-alone"],
      ["aardvark-alone"],
    ]);
  });

  it("gives the same order whichever order the rows arrive in", () => {
    // The pairing of the two properties is the point: `YEO-103`'s criterion
    // is that the order is a fact about the archive, and an order that is
    // stable against row order but not against `LANG` only moves the
    // non-determinism somewhere a test does not look.
    const forwards = mixedCaseArchive();
    const backwards: FamilyGraph = {
      people: [...forwards.people].reverse(),
      unions: [...forwards.unions].reverse(),
      childLinks: [...forwards.childLinks].reverse(),
    };

    expect(grouped(backwards)).toEqual(grouped(forwards));
  });
});

describe("compareIds", () => {
  it("orders by code unit, not by collation", () => {
    expect(compareIds("Zeta", "apple")).toBeLessThan(0);
    expect(compareIds("apple", "Zeta")).toBeGreaterThan(0);

    // Accents sit above `z` in code-unit order and below it in every
    // collation. Stated so that the file records what the comparator is,
    // rather than only that it is not `localeCompare`.
    expect(compareIds("\u00e9lodie", "zoe")).toBeGreaterThan(0);
    expect(
      new Intl.Collator("en-US").compare("\u00e9lodie", "zoe"),
    ).toBeLessThan(0);
  });

  it("returns 0 only for ids that are identical", () => {
    /**
     * `Array.prototype.sort` is stable, so a comparator returning 0 keeps
     * input order — and input order is `graph.people`, the unordered `SELECT`
     * `YEO-103` was written to escape. A 0 between two *different* ids would
     * put that bug back in miniature.
     *
     * Collation could return one, which is the second reason this is not
     * `localeCompare`: a tailoring that ignores case or accents calls two
     * distinct ids equal. The pairs below are exactly those, and the
     * collators are shown doing it.
     */
    expect(compareIds("person-1", "person-1")).toBe(0);

    for (const [a, b] of [
      ["Ada", "ada"],
      ["resume", "r\u00e9sum\u00e9"],
      ["co-op", "coop"],
    ] as const) {
      expect(compareIds(a, b)).not.toBe(0);
      expect(compareIds(b, a)).not.toBe(0);
      expect(Math.sign(compareIds(a, b))).toBe(-Math.sign(compareIds(b, a)));
    }

    const blunt = new Intl.Collator("en-US", { sensitivity: "base" });
    expect(blunt.compare("Ada", "ada")).toBe(0);
    expect(blunt.compare("resume", "r\u00e9sum\u00e9")).toBe(0);
  });
});
