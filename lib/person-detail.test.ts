import { describe, expect, it } from "vitest";

import {
  compareByBirth,
  compareUnions,
  derivePersonDetail,
} from "@/lib/person-detail";
import { portraitSrc } from "@/lib/portrait";
// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph } from "@/lib/family-graph";

/**
 * The seed fixture from docs/architecture.md, which is the reason these tests
 * are worth writing at all:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │             │
 *           Alice      Brian, Clara      Dora
 *
 * Thomas and Rose are each a partner in two unions; Alice and Dora share no
 * parent whatsoever and are connected only by the chain of remarriages; Clara
 * is adopted; and u0 records one partner and leaves the other unknown. Every
 * one of those is a case that a `parent_id` column cannot express and that a
 * derivation over unions has to get right.
 */
function seedGraph(): FamilyGraph {
  return {
    people: [
      person({
        id: "mary",
        givenName: "Mary",
        surname: "Ellis",
        birthDate: "1901-03-14",
        birthPlace: "Cork",
        deathDate: "1931-08-02",
        deathPlace: "Cork",
      }),
      person({
        id: "thomas",
        givenName: "Thomas",
        sex: "male",
        birthDate: "1898-11-20",
        birthDateQualifier: "about",
        birthDatePrecision: "day",
        deathDate: "1947-06-11",
        notes: "Emigrated in 1921.",
      }),
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({ id: "walter", givenName: "Walter", sex: "male" }),
      person({ id: "alice", givenName: "Alice", birthDate: "1925-02-01" }),
      person({
        id: "brian",
        givenName: "Brian",
        sex: "male",
        birthDate: "1934-04-04",
      }),
      person({ id: "clara", givenName: "Clara", birthDate: "1932-01-09" }),
      person({ id: "dora", givenName: "Dora" }),
      person({ id: "silas", givenName: "Silas", sex: "male" }),
    ],
    unions: [
      // Silas partnered with somebody nobody recorded.
      union({ id: "u0", partnerAId: "silas", partnerBId: null, sequence: 1 }),
      union({
        id: "u1",
        partnerAId: "mary",
        partnerBId: "thomas",
        startDate: "1923-09-01",
        endDate: "1931-08-02",
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
    notes: null,
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
}

function detailFor(id: string) {
  const detail = derivePersonDetail(seedGraph(), id);
  if (!detail) throw new Error(`no detail derived for "${id}"`);
  return detail;
}

const names = (people: { person: { name: string } }[]) =>
  people.map((entry) => entry.person.name);

describe("the person's own record", () => {
  it("shows the name, the lifespan, and the dates with their qualifiers", () => {
    const thomas = detailFor("thomas");

    expect(thomas.name).toBe("Thomas Hale");
    // "about" is recorded on the birth date, so it belongs in the lifespan
    // too (E4-T3): `1898–1947` would assert a birth year the record does not
    // support, on the line that appears under every mention of him.
    expect(thomas.lifespan).toBe("about 1898–1947");
    // The same qualifier has to survive to the full date row, which is the
    // entire reason the qualifier columns exist.
    expect(thomas.birth).toEqual({
      date: "about 20 November 1898",
      place: null,
    });
    expect(thomas.death).toEqual({ date: "11 June 1947", place: null });
    expect(thomas.notes).toBe("Emigrated in 1921.");
  });

  it("reads a date and the place it happened as one event", () => {
    const mary = detailFor("mary");

    expect(mary.birth).toEqual({ date: "14 March 1901", place: "Cork" });
    expect(mary.death).toEqual({ date: "2 August 1931", place: "Cork" });
  });

  it("returns no event at all when neither date nor place is recorded", () => {
    // Null rather than an object of two nulls, so the panel can drop the row
    // instead of rendering an empty one.
    expect(detailFor("walter").birth).toBeNull();
    expect(detailFor("walter").death).toBeNull();
  });

  it("renders a year-precision date as the bare year, not 1 January", () => {
    // YEO-39 added `date_precision`; this is the regression it exists to
    // catch — a coarse date silently formatted as if it were exact.
    const graph: FamilyGraph = {
      people: [
        person({
          id: "ivy",
          givenName: "Ivy",
          birthDate: "1890-01-01",
          birthDatePrecision: "year",
          deathDate: "1950-01-01",
          deathDatePrecision: "year",
        }),
      ],
      unions: [],
      childLinks: [],
    };

    const detail = derivePersonDetail(graph, "ivy");

    expect(detail?.birth).toEqual({ date: "1890", place: null });
    expect(detail?.birth?.date).not.toBe("1 January 1890");
    expect(detail?.death).toEqual({ date: "1950", place: null });
  });

  it("renders a month-precision date as month and year, not a fabricated day", () => {
    const graph: FamilyGraph = {
      people: [
        person({
          id: "ivy",
          givenName: "Ivy",
          birthDate: "1890-03-01",
          birthDatePrecision: "month",
        }),
      ],
      unions: [],
      childLinks: [],
    };

    const detail = derivePersonDetail(graph, "ivy");

    expect(detail?.birth?.date).toBe("March 1890");
    expect(detail?.birth?.date).not.toBe("1 March 1890");
  });

  it("returns null for somebody the graph does not hold", () => {
    // Not defensive: E2-T4 opens this panel from `?person=<id>`, where the id
    // is whatever was pasted into the address bar.
    expect(derivePersonDetail(seedGraph(), "nobody")).toBeNull();
  });

  /**
   * The panel's portrait is the **full-resolution** image, never the
   * thumbnail (E5-T4, `YEO-44`) — deliberately the opposite of the tree
   * node, which loads the thumbnail because a canvas draws hundreds at once.
   * The panel is the one place somebody has asked to look at a particular
   * person, and there is exactly one image on screen.
   */
  it("resolves portraitSrc to the full portrait, not the thumbnail", () => {
    const graph: FamilyGraph = {
      people: [
        person({
          id: "ivy",
          givenName: "Ivy",
          portraitKey: "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg",
          portraitThumbKey:
            "images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp",
        }),
      ],
      unions: [],
      childLinks: [],
    };

    const detail = derivePersonDetail(graph, "ivy");

    expect(detail?.portraitSrc).toBe(
      portraitSrc("images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg"),
    );
    expect(detail?.portraitSrc).not.toBe(
      portraitSrc("images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp"),
    );
  });

  it("is null when there is no portrait", () => {
    expect(detailFor("walter").portraitSrc).toBeNull();
  });
});

describe("spouses", () => {
  it("lists both of a twice-married person's unions, in order", () => {
    const rose = detailFor("rose");

    // u2 and u3 have no start dates at all, so `sequence` is the only thing
    // saying she married Thomas before Walter. Sorting on dates alone would
    // silently reorder the story.
    expect(rose.spouses.map((spouse) => spouse.person?.name)).toEqual([
      "Thomas Hale",
      "Walter Hale",
    ]);
  });

  it("carries the union's span and how it ended", () => {
    const [marriage] = detailFor("mary").spouses;

    expect(marriage.person?.name).toBe("Thomas Hale");
    expect(marriage.start).toBe("1 September 1923");
    expect(marriage.end).toBe("2 August 1931");
    expect(marriage.endReason).toBe("death");
    expect(marriage.type).toBe("marriage");
  });

  it("carries a union's own start/end precision, not the day it anchors to", () => {
    const graph: FamilyGraph = {
      people: [
        person({ id: "a", givenName: "A" }),
        person({ id: "b", givenName: "B" }),
      ],
      unions: [
        union({
          id: "u1",
          partnerAId: "a",
          partnerBId: "b",
          startDate: "1890-01-01",
          startDatePrecision: "year",
          endDate: "1900-03-01",
          endDatePrecision: "month",
        }),
      ],
      childLinks: [],
    };

    const [marriage] = derivePersonDetail(graph, "a")!.spouses;

    expect(marriage.start).toBe("1890");
    expect(marriage.end).toBe("March 1900");
  });

  it("keeps a union whose other partner was never recorded", () => {
    const silas = detailFor("silas");

    // Both partner columns are nullable so that an unknown partner never has
    // to be invented as a placeholder person. Dropping the union would lose
    // Thomas's parentage along with it.
    expect(silas.spouses).toHaveLength(1);
    expect(silas.spouses[0].person).toBeNull();
    expect(silas.children.map((child) => child.person.name)).toEqual([
      "Thomas Hale",
    ]);
  });
});

describe("children", () => {
  it("gathers a person's children across every union they belong to", () => {
    const rose = detailFor("rose");

    // Grouped by union in the same order as the spouse list, and by birth
    // date within a union: Clara (1932) before Brian (1934), then Dora.
    expect(names(rose.children)).toEqual([
      "Clara Hale",
      "Brian Hale",
      "Dora Hale",
    ]);
  });

  it("says which union each child came through", () => {
    const rose = detailFor("rose");
    const byName = new Map(
      rose.children.map((child) => [child.person.name, child]),
    );

    // This is what makes half-siblings legible. Two by Thomas and one by
    // Walter is a different family from three children, and the co-parent is
    // the only thing that distinguishes them.
    expect(byName.get("Brian Hale")?.otherParent?.name).toBe("Thomas Hale");
    expect(byName.get("Dora Hale")?.otherParent?.name).toBe("Walter Hale");
  });

  it("sorts a child with no birth date after the ones that have one", () => {
    // Nulls first would read as a claim that Dora was the eldest, rather than
    // as the absence of a claim.
    expect(detailFor("rose").children.at(-1)?.person.name).toBe("Dora Hale");
  });

  it("carries adoption from the child↔union link rather than inventing it", () => {
    const clara = detailFor("rose").children.find(
      (child) => child.person.name === "Clara Hale",
    );

    expect(clara?.relation).toBe("adopted");
  });

  it("leaves the co-parent null when nobody recorded them", () => {
    expect(detailFor("silas").children[0].otherParent).toBeNull();
  });
});

describe("parents", () => {
  it("walks the child↔union edge backwards to both partners", () => {
    expect(names(detailFor("alice").parents)).toEqual([
      "Mary Ellis",
      "Thomas Hale",
    ]);
  });

  it("returns only the partner who was recorded", () => {
    expect(names(detailFor("thomas").parents)).toEqual(["Silas Hale"]);
  });

  it("reports the same relation the child list reports", () => {
    // Adoption is an attribute of the link, so it reads identically from
    // either end. Anything else would mean the fact is stored twice.
    expect(detailFor("clara").parents.map((p) => p.relation)).toEqual([
      "adopted",
      "adopted",
    ]);
  });

  it("gives the root of the tree no parents rather than throwing", () => {
    expect(detailFor("silas").parents).toEqual([]);
  });
});

describe("the chain of remarriages", () => {
  it("leaves the two ends of the chain sharing no parent at all", () => {
    // docs/architecture.md's sharpest case: Alice and Dora are connected only
    // by Thomas marrying Rose and Rose then marrying Walter. If the
    // derivation ever leaked across a union boundary, this is where it shows.
    const alice = new Set(names(detailFor("alice").parents));
    const dora = names(detailFor("dora").parents);

    expect(dora.some((parent) => alice.has(parent))).toBe(false);
  });

  it("does not order a person's unions by the order the rows arrived", () => {
    const graph = seedGraph();
    graph.unions.reverse();

    // `getFamilyGraph` sorts, but a `FamilyGraph` is a plain value and this
    // module is handed one by whoever built it. The ordering rule belongs in
    // both places or in neither.
    expect(
      derivePersonDetail(graph, "rose")?.spouses.map((s) => s.person?.name),
    ).toEqual(["Thomas Hale", "Walter Hale"]);
  });
});

/**
 * `compareUnions` and `compareByBirth`'s id tie-breaks do not move with the
 * runtime's locale (`YEO-116`). Both used to be `localeCompare`, whose answer
 * comes from the process's ICU data rather than from the ids themselves —
 * `lib/compare-ids.ts` makes the full argument; this is that argument pinned
 * against these two functions specifically, the way `lib/family-components.
 * test.ts` and `lib/tree-layout.test.ts` already pin it for the tab order.
 */
describe("id tie-breaks under a different collation", () => {
  /**
   * Same four locales `lib/family-components.test.ts` picked, for the same
   * reason: `en` is the default most developers run under, `sv` reorders
   * letters at the end of its alphabet, `tr` has its own rules for dotted and
   * dotless `i`, and `de-DE-u-co-phonebk` is a non-default collation of a
   * locale that also has a default one.
   */
  const locales = ["en-US", "sv-SE", "tr-TR", "de-DE-u-co-phonebk"];

  it("uses ids that collation really does order the other way", () => {
    // Guards the two fixtures below rather than the module: if ICU ever
    // stopped disagreeing with code units on these ids, the pinning tests
    // would keep passing while testing nothing — this fails loudly instead.
    for (const locale of locales) {
      const collator = new Intl.Collator(locale);
      expect(collator.compare("Zeta-union", "apple-union")).toBeGreaterThan(0);
      expect(collator.compare("Zeta-child", "apple-child")).toBeGreaterThan(0);
    }
  });

  it("breaks a tied sequence and start date on the union id, by code unit", () => {
    const a = union({ id: "apple-union", partnerAId: "a", partnerBId: "b" });
    const zeta = union({ id: "Zeta-union", partnerAId: "a", partnerBId: "b" });

    // Same `sequence` (both default to 1) and both `startDate: null`, so
    // nothing but the id decides — and `Zeta-union` first is the code-unit
    // answer, which every locale above would reverse.
    expect(compareUnions(zeta, a)).toBeLessThan(0);
    expect(compareUnions(a, zeta)).toBeGreaterThan(0);
  });

  it("breaks a tied birth date and formatted name on the person id, by code unit", () => {
    const a = person({
      id: "apple-child",
      givenName: "Sam",
      surname: "Doyle",
      birthDate: "1900-01-01",
    });
    const zeta = person({
      id: "Zeta-child",
      givenName: "Sam",
      surname: "Doyle",
      birthDate: "1900-01-01",
    });

    // Same birth date and the same formatted name ("Sam Doyle" both sides),
    // so the name comparison above this one also ties and only the id is
    // left. `Zeta-child` first is the code-unit answer.
    expect(compareByBirth(zeta, a)).toBeLessThan(0);
    expect(compareByBirth(a, zeta)).toBeGreaterThan(0);
  });
});

/**
 * `compareByBirth`'s *name* comparison, unlike its id tie-break, keeps
 * `localeCompare` on purpose (`YEO-116`, ticket AC5) — it is reached only
 * once two siblings already share a birth date, and what it is comparing at
 * that point is text a reader looks at, not an opaque id. `lib/
 * compare-ids.ts` names this split explicitly; this is the regression the
 * split exists to prevent.
 */
describe("the name inside a birth-date tie is read, not compared", () => {
  it("puts an accented name where a reader expects it, not after every unaccented one", () => {
    // Two siblings sharing a birth date, whose given names collation and code
    // units disagree about: "Zoe" < "Élodie" by code unit (capital-and-plain
    // Latin letters sort before `É`), while collation reads `É` as a variant
    // of `E` and puts Élodie first, the way a reader would expect a family
    // Bible's two entries to read.
    const zoe = person({
      id: "z",
      givenName: "Zoe",
      surname: "Doyle",
      birthDate: "1900-01-01",
    });
    const elodie = person({
      id: "e",
      givenName: "Élodie",
      surname: "Doyle",
      birthDate: "1900-01-01",
    });

    expect(compareByBirth(elodie, zoe)).toBeLessThan(0);
    expect(compareByBirth(zoe, elodie)).toBeGreaterThan(0);

    // The guard: code units alone would have reversed this, which is exactly
    // why this comparison is `localeCompare` and the id tie-break is not.
    expect("Zoe" < "Élodie").toBe(true);
  });
});
