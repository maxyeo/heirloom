import { describe, expect, it } from "vitest";

import type { GraphPerson } from "@/lib/family-graph";
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
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathPlace: null,
    notes: null,
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
