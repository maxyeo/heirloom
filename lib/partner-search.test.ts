import { describe, expect, it } from "vitest";

import type { GraphPerson } from "@/lib/family-graph";
import { foldName } from "@/lib/name-match";
import { searchPartners, splitTypedName } from "@/lib/partner-search";

/**
 * The partner picker's whole decision, checked without a document (E3-T4,
 * `YEO-32`).
 *
 * docs/testing.md's "prefer no DOM" rule is why this file exists: "does typing
 * `hal` find Thomas Hale, and does it rank him above Rosalind" is a decision
 * about a value, and mounting an input to ask it would prove less and cost
 * more. `components/PartnerPicker.test.tsx` is left with only what needs a
 * document — that a click reports the right person back.
 *
 * `import type` for `GraphPerson`, which erases entirely: a plain import would
 * drag `@/db` and postgres.js into a test that has no `DATABASE_URL`.
 */

function person(overrides: Partial<GraphPerson> & { id: string }): GraphPerson {
  return {
    givenName: "Someone",
    surname: null,
    sex: "unknown",
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
  };
}

/** The seed fixture's cast, which docs/architecture.md is written against. */
const PEOPLE: GraphPerson[] = [
  person({
    id: "rose",
    givenName: "Rose",
    surname: "Hale",
    birthDate: "1910-05-05",
    deathDate: "1994-01-01",
  }),
  person({
    id: "thomas",
    givenName: "Thomas",
    surname: "Hale",
    birthDate: "1899-03-02",
  }),
  person({ id: "walter", givenName: "Walter", surname: "Byrne" }),
  person({ id: "mary", givenName: "Mary", surname: "Byrne" }),
  person({ id: "jose", givenName: "José", surname: "Ferreira" }),
];

function ids(...args: Parameters<typeof searchPartners>): string[] {
  return searchPartners(...args).map((candidate) => candidate.id);
}

describe("searchPartners", () => {
  it("offers everybody when nothing has been typed yet", () => {
    // In name order, so the picker opens with a list rather than a prompt.
    expect(ids(PEOPLE, "")).toEqual([
      "jose",
      "mary",
      "rose",
      "thomas",
      "walter",
    ]);
  });

  it("finds a person by the start of their given name", () => {
    expect(ids(PEOPLE, "ro")).toEqual(["rose"]);
  });

  it("finds a person by their surname", () => {
    expect(ids(PEOPLE, "byrne")).toEqual(["mary", "walter"]);
  });

  it("ignores case and surrounding space", () => {
    expect(ids(PEOPLE, "  HALE ")).toEqual(["rose", "thomas"]);
  });

  /**
   * Genealogical sources disagree about diacritics constantly — a name is
   * transcribed off a headstone, a census, an emigration record — so an author
   * who types the plain letters must not be told nobody is there.
   */
  it("matches across accents in both directions", () => {
    expect(ids(PEOPLE, "jose")).toEqual(["jose"]);
    expect(ids(PEOPLE, "josé")).toEqual(["jose"]);
  });

  /**
   * The case the picker exists to get right: two Hales, and choosing the
   * wrong one silently marries the wrong couple.
   */
  it("lets a year tell two people of the same surname apart", () => {
    expect(ids(PEOPLE, "hale 1899")).toEqual(["thomas"]);
    // Order between the terms is not a question the author should have to ask.
    expect(ids(PEOPLE, "1899 hale")).toEqual(["thomas"]);
  });

  it("requires every term to match something", () => {
    expect(ids(PEOPLE, "hale byrne")).toEqual([]);
  });

  it("ranks a name that starts with the query above one that merely contains it", () => {
    const people = [
      person({ id: "ambrose", givenName: "Ambrose" }),
      person({ id: "rosalind", givenName: "Rosalind" }),
    ];
    expect(ids(people, "ros")).toEqual(["rosalind", "ambrose"]);
  });

  /**
   * A given name and a surname are equally good ways to ask for somebody, so
   * both rank as a prefix match and the tie breaks on name.
   */
  it("treats a surname prefix as being as good as a given-name prefix", () => {
    const people = [
      person({ id: "aaron", givenName: "Aaron", surname: "Rose" }),
      person({ id: "rosalind", givenName: "Rosalind" }),
    ];
    expect(ids(people, "ros")).toEqual(["aaron", "rosalind"]);
  });

  it("finds a middle name, below a name that starts with the term", () => {
    const people = [
      person({ id: "mary", givenName: "Mary Anne", surname: "Hale" }),
      person({ id: "anne", givenName: "Anne", surname: "Byrne" }),
    ];
    expect(ids(people, "anne")).toEqual(["anne", "mary"]);
  });

  it("leaves out the people it is told to", () => {
    expect(ids(PEOPLE, "hale", { excludeIds: ["thomas"] })).toEqual(["rose"]);
  });

  it("stops at the limit", () => {
    expect(ids(PEOPLE, "", { limit: 2 })).toEqual(["jose", "mary"]);
  });

  it("carries the name and lifespan the picker shows", () => {
    expect(searchPartners(PEOPLE, "rose")[0]).toEqual({
      id: "rose",
      name: "Rose Hale",
      lifespan: "1910–1994",
    });
  });

  it("finds a person who has no surname recorded", () => {
    const people = [person({ id: "walter", givenName: "Walter" })];
    expect(searchPartners(people, "walter")[0]).toEqual({
      id: "walter",
      name: "Walter",
      lifespan: "",
    });
  });

  it("answers nothing rather than everything for a query nobody matches", () => {
    expect(ids(PEOPLE, "zzz")).toEqual([]);
  });
});

/**
 * The rank tie-break split into two independent fields (`YEO-116`): the
 * folded name, which a reader does see, stays on `localeCompare`; only the
 * id underneath it — never read — moved to `compareIds`. An earlier version
 * of this ticket moved *both* halves to `compareIds`, on the mistaken claim
 * that `foldName` already makes code-unit order match reading order. It does
 * not: folding lowercases and strips combining marks, but a Latin letter
 * that does not canonically decompose survives folding and then sits above
 * `z` in code units. The first test below pins that case through the
 * empty-query browse path, where every candidate ties on rank and this
 * tie-break is the whole visible order. The second pins the id half the
 * other way, on code units, with the paired locale guard
 * `lib/compare-ids.ts` calls for.
 *
 * ## Why the fixture is `Ł` and not `Æ`
 *
 * `Æ` is the obvious choice and the wrong one. It survives folding, so code
 * units do sort it after `z` — but Swedish, Danish, Norwegian and Icelandic
 * all genuinely alphabetise `Æ` *after* `Z`, so under those locales
 * collation and code units agree and the fixture stops telling the two rules
 * apart. A test written on `Æ` therefore asserts an `en-US` answer while
 * looking like it asserts a general one: it passes on CI because the runner
 * happens to resolve to `en-US`, and fails under `LC_ALL=sv_SE.UTF-8`.
 *
 * That is not a reason to pin the locale. `searchPartners` runs in the
 * reader's browser — `components/PartnerPicker.tsx` is a client component
 * and calls it from a `useMemo` — so the unpinned `localeCompare` in the
 * comparator is reading the *reader's* own collation, which is the whole
 * point of keeping that half off code units. Pinning a locale in the test
 * environment would make the suite deterministic for a reason production
 * does not share, and deriving the expected order from `localeCompare` at
 * runtime would restate the implementation instead of checking it.
 *
 * `Ł` is the fixture that makes the property itself locale-invariant. It
 * survives folding exactly as `Æ` does — `foldName("Łukasz")` is `"łukasz"`,
 * and `ł` (U+0142) is above `z` (U+007A) — but no locale alphabetises it
 * after `Z`: it is a Polish letter, and even `pl-PL` files it immediately
 * after `l`. So "collation puts Łukasz before Zorro, code units put it
 * after" is true *everywhere*, and the assertion below can be checked
 * against the same four locales the id half uses rather than against one.
 */
describe("the rank tie-break: name by collation, id by code unit", () => {
  /**
   * The same four locales the id tie-break is guarded against, and the same
   * ones `lib/family-components.test.ts` picked: `en` is the default most
   * developers run under, `sv` reorders letters at the end of its alphabet,
   * `tr` has its own rules for dotted and dotless `i`, and
   * `de-DE-u-co-phonebk` is a non-default collation of a locale that also
   * has a default one.
   */
  const locales = ["en-US", "sv-SE", "tr-TR", "de-DE-u-co-phonebk"];

  it("orders a name whose folded form sits above 'z' in code units the way a reader expects, not the way code units do", () => {
    const people = [
      person({ id: "zorro", givenName: "Zorro", surname: "Doyle" }),
      person({ id: "lukasz", givenName: "Łukasz", surname: "Doyle" }),
      person({ id: "anna", givenName: "Anna", surname: "Doyle" }),
    ];

    // Guards the fixture rather than the module, in both directions, so that
    // this cannot quietly stop discriminating. Code units put the folded
    // "łukasz" after "zorro"...
    expect(foldName("Łukasz") > foldName("Zorro")).toBe(true);
    // ...while every locale puts it before — which is what makes the
    // assertion below a statement about which of the two rules is in force
    // rather than about the machine the suite happens to run on. Unlike a
    // fixture built on `Æ`, this holds under all of them, so the test does
    // not depend on an ambient locale it does not control.
    for (const locale of locales) {
      expect(
        foldName("Łukasz").localeCompare(foldName("Zorro"), locale),
      ).toBeLessThan(0);
    }

    // Every candidate ties on rank with an empty query, so this tie-break
    // decides the whole browse order the picker opens with. Code units would
    // have given ["anna", "zorro", "lukasz"], dumping Łukasz after Zorro.
    expect(ids(people, "")).toEqual(["anna", "lukasz", "zorro"]);
  });

  it("orders two candidates who share a name by id, by code unit, not by collation", () => {
    const sameRank: GraphPerson[] = [
      person({ id: "apple-person", givenName: "Amy" }),
      person({ id: "Zeta-person", givenName: "Amy" }),
    ];

    // Guard: if ICU ever stopped disagreeing with code units here, the
    // pinning test below would keep passing while testing nothing.
    for (const locale of locales) {
      expect(
        new Intl.Collator(locale).compare("Zeta-person", "apple-person"),
      ).toBeGreaterThan(0);
    }

    // `Zeta-person` first is the code-unit answer. Every locale above would
    // put `apple-person` first instead.
    expect(ids(sameRank, "amy")).toEqual(["Zeta-person", "apple-person"]);
  });

  /**
   * The composite `\0`-joined sort key this ticket removed doesn't need a
   * replacement test of its own — comparing the name and id as two separate
   * terms rules out the "Mary Anne" + id vs "Mary" + " Anne…" ambiguity the
   * separator existed for structurally, with no separator to get wrong. What
   * is still worth pinning is *why* patching the separator was never the
   * right fix: ICU treats U+0000 as completely ignorable, so under
   * `localeCompare` a joined key with a `\0` in it and one without compared
   * equal — the separator was a no-op under the very comparator this module
   * used to run.
   */
  it("shows why the old \\0-joined key could not have been patched: ICU ignores U+0000 entirely", () => {
    const withSeparator = `${foldName("Mary")}\0`;
    const withoutSeparator = foldName("Mary");

    expect(
      new Intl.Collator("en-US", { sensitivity: "variant" }).compare(
        withSeparator,
        withoutSeparator,
      ),
    ).toBe(0);
  });
});

describe("how a candidate's years read", () => {
  const lifespanOf = (id: string, people: GraphPerson[] = PEOPLE) => {
    const found = searchPartners(people, "").find(
      (candidate) => candidate.id === id,
    );
    if (!found) throw new Error(`no candidate for "${id}"`);
    return found.lifespan;
  };

  it("does not present an approximate year as a recorded one", () => {
    // The picker exists to stop somebody marrying the wrong Thomas. Choosing
    // between two of them on a birth year means the confidence attached to
    // that year is part of what is being chosen on.
    const people = [
      person({
        id: "silas",
        givenName: "Silas",
        birthDate: "1890-01-01",
        birthDateQualifier: "about",
        birthDatePrecision: "year",
      }),
    ];

    expect(lifespanOf("silas", people)).toBe("b. about 1890");
  });

  it("shows years only, whatever precision the dates were recorded at", () => {
    const people = [
      person({
        id: "silas",
        givenName: "Silas",
        birthDate: "1890-06-01",
        birthDatePrecision: "month",
        deathDate: "1962-01-01",
        deathDatePrecision: "year",
      }),
    ];

    expect(lifespanOf("silas", people)).toBe("1890–1962");
  });

  it("renders nothing at all for somebody with no dates", () => {
    // Not "unknown", not a dash. Most of an older record is missing, and a
    // list of em dashes reads as a broken picker rather than an honest one.
    expect(lifespanOf("walter")).toBe("");
  });
});

describe("splitTypedName", () => {
  it("treats a single word as a given name", () => {
    // `given_name` is the required column and the label every node falls back
    // to, so a lone "Walter" belongs there rather than in the surname.
    expect(splitTypedName("Walter")).toEqual({
      givenName: "Walter",
      surname: "",
    });
  });

  it("takes the last word as the surname", () => {
    expect(splitTypedName("Rose Hale")).toEqual({
      givenName: "Rose",
      surname: "Hale",
    });
  });

  it("keeps middle names with the given name", () => {
    expect(splitTypedName("Mary Anne Hale")).toEqual({
      givenName: "Mary Anne",
      surname: "Hale",
    });
  });

  it("survives padding and an empty query", () => {
    expect(splitTypedName("  Rose   Hale  ")).toEqual({
      givenName: "Rose",
      surname: "Hale",
    });
    expect(splitTypedName("   ")).toEqual({ givenName: "", surname: "" });
  });
});
