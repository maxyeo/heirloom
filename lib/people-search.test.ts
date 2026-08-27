import { describe, expect, it } from "vitest";

import { seedFamily, seedPerson } from "@/db/seed-family";
import { searchPeople, type PersonSearchRow } from "@/lib/people-search";

/**
 * `/search`'s ranking, checked without a document or a database (E8-T2,
 * `YEO-56`) — the same "prefer no DOM" argument `lib/partner-search.test.ts`
 * makes for its own sibling.
 *
 * The seeded family (`db/seed-family.ts`) supplies most of the fixture data.
 * docs/testing.md's case for reusing it over a literal of this file's own
 * applies here exactly as it does everywhere else: `seedFamily` is real
 * shape rather than invented data, it is what `lib/people.db.test.ts` seeds
 * the database with, and a test written against a copy of it would silently
 * stop matching the seed the day the seed changed under it. What the seed
 * cannot supply is the deliberate spelling-variant fixtures — nobody in it
 * is named Katharine — so those are small literals, built with the same
 * `PersonSearchRow` shape.
 */

const ROWS: readonly PersonSearchRow[] = seedFamily.people;

function ids(...args: Parameters<typeof searchPeople>): string[] {
  return searchPeople(...args).map((match) => match.id);
}

describe("searchPeople", () => {
  it("returns nothing for an empty query, rather than the first page of everyone", () => {
    // Deliberately unlike `searchPartners`: `/search` opens with an
    // invitation to type a name, not a slice of the family standing in for
    // an answer. See this module's own docblock.
    expect(searchPeople(ROWS, "")).toEqual([]);
    expect(searchPeople(ROWS, "   ")).toEqual([]);
  });

  it("finds everyone named Hale, across given name and surname", () => {
    // The first acceptance criterion: given name and surname are searched
    // equally. Agnes, Thomas, Edward, Clara and Arthur all carry the surname
    // Hale; nobody else in the seed does.
    expect(ids(ROWS, "hale")).toEqual(
      expect.arrayContaining([
        seedPerson.agnes.id,
        seedPerson.thomas.id,
        seedPerson.edward.id,
        seedPerson.clara.id,
        seedPerson.arthur.id,
      ]),
    );
    expect(ids(ROWS, "hale")).toHaveLength(5);
  });

  it("finds all eight Shaws by surname", () => {
    const shaws = [
      seedPerson.ruth,
      seedPerson.harold,
      seedPerson.doris,
      seedPerson.frank,
      seedPerson.vera,
      seedPerson.leonard,
      seedPerson.joyce,
      seedPerson.stanley,
    ];

    // Walter Shaw is also a Shaw, so the surname alone finds nine.
    expect(ids(ROWS, "shaw")).toEqual(
      expect.arrayContaining([...shaws.map((s) => s.id), seedPerson.walter.id]),
    );
    expect(ids(ROWS, "shaw")).toHaveLength(9);
  });

  it("finds somebody by their given name alone", () => {
    expect(ids(ROWS, "thomas")).toEqual([seedPerson.thomas.id]);
  });

  it("excludes a person when a term matches nothing about them", () => {
    // Thomas is a Hale; nobody in the seed is both a Hale and a Byrne, and
    // there is no such surname in this family at all.
    expect(ids(ROWS, "hale byrne")).toEqual([]);
  });

  describe("spelling tolerance", () => {
    const CATHERINE_ID = "10000000-0000-4000-8000-000000000001";
    const rows: PersonSearchRow[] = [
      {
        id: CATHERINE_ID,
        givenName: "Katharine",
        surname: "Reed",
        birthDate: "1888-01-01",
        birthDateQualifier: "exact",
        birthDateUpper: null,
        deathDate: null,
        deathDateQualifier: "exact",
        deathDateUpper: null,
      },
    ];

    it("finds a recorded Katharine when searching for Catherine", () => {
      // The worked example from the ticket: two transcriptions of one name.
      expect(ids(rows, "Catherine")).toEqual([CATHERINE_ID]);
    });

    it("still requires every term to match", () => {
      expect(ids(rows, "catherine byrne")).toEqual([]);
    });
  });

  it("ranks an exact match above a phonetic one", () => {
    // Rose and Ross share a `nameKey` — see `lib/name-match.ts`'s own
    // documented trade-off — but a literal tier always outranks a phonetic
    // one, so searching "rose" finds the real Rose first even with a Ross on
    // the tree.
    const rows: PersonSearchRow[] = [
      {
        id: "ross",
        givenName: "Ross",
        surname: "Bennett",
        birthDate: null,
        birthDateQualifier: "exact",
        birthDateUpper: null,
        deathDate: null,
        deathDateQualifier: "exact",
        deathDateUpper: null,
      },
      seedPerson.rose,
    ];

    expect(ids(rows, "rose")).toEqual([seedPerson.rose.id, "ross"]);
  });

  it("does not match a phonetic or edit-distance term shorter than its threshold", () => {
    // "jo" is two letters — too short to trust a phonetic key or an edit
    // distance with, and it also is not a literal prefix, word or substring
    // of "Rose Hale". A short term still gets every literal tier; it does
    // not get to drag in unrelated names under the banner of tolerance.
    const rows: PersonSearchRow[] = [seedPerson.rose];
    expect(ids(rows, "jo")).toEqual([]);
  });

  it("carries the lifespan for disambiguation between same-named relatives", () => {
    const [match] = searchPeople(ROWS, "thomas");
    expect(match.lifespan).toBe("1898–1947");
  });

  it("carries an href of the deep-link shape /tree?person=<id>", () => {
    const [match] = searchPeople(ROWS, "thomas");
    expect(match.href).toBe(`/tree?person=${seedPerson.thomas.id}`);
  });

  it("orders total and stable: rank, then folded name, then id", () => {
    // Two people who tie on every other axis need a tie-break that never
    // varies with the order the rows arrived in.
    const rows: PersonSearchRow[] = [
      {
        id: "b",
        givenName: "Hale",
        surname: null,
        birthDate: null,
        birthDateQualifier: "exact",
        birthDateUpper: null,
        deathDate: null,
        deathDateQualifier: "exact",
        deathDateUpper: null,
      },
      {
        id: "a",
        givenName: "Hale",
        surname: null,
        birthDate: null,
        birthDateQualifier: "exact",
        birthDateUpper: null,
        deathDate: null,
        deathDateQualifier: "exact",
        deathDateUpper: null,
      },
    ];

    expect(ids(rows, "hale")).toEqual(["a", "b"]);
    // Reversing the input order does not change the answer.
    expect(ids([...rows].reverse(), "hale")).toEqual(["a", "b"]);
  });

  it("stops at the limit", () => {
    expect(ids(ROWS, "hale", { limit: 2 })).toHaveLength(2);
  });
});

/**
 * The name tie-break is pinned to one collation, and this is the test that
 * would notice if it stopped (`YEO-120`).
 *
 * ## The position being pinned
 *
 * `lib/people-search.ts` builds `new Intl.Collator("en")` deliberately.
 * `/search` renders server-side and its ordering is a property of the
 * *answer* rather than of who is reading it, so the same query has to return
 * the same page — and the same second page — for every reader. A tie broken
 * by the host's collation would make the boundary between page one and page
 * two depend on which machine rendered it.
 *
 * `lib/partner-search.ts` takes the opposite position for the opposite
 * reason: it runs in the reader's browser, from a `useMemo` in
 * `components/PartnerPicker.tsx`, so its unpinned `localeCompare` is reading
 * the reader's own collation on purpose. `lib/partner-search.test.ts` carries
 * the mirror of this test.
 *
 * Both positions are right and both were unverified before this ticket. The
 * pin was never checked against a second collation, so nothing would have
 * gone red if somebody had deleted the `"en"` argument.
 *
 * ## Where this test's discriminating power comes from
 *
 * Under `en_US` — which is what CI resolved to before `YEO-120`, by accident
 * rather than by decision — a pinned `en` collator and an unpinned one give
 * identical answers, so this test would pass either way. It is the
 * `sv_SE` and `da_DK` runs in `.github/workflows/ci.yml` that make it a test:
 * there, an unpinned comparator returns the other order and this goes red.
 * The workflow change and this file are one mechanism.
 *
 * `Æ` is the fixture because it survives `foldName` (no canonical
 * decomposition, so stripping combining marks leaves it whole) and because
 * collations genuinely disagree about it: English files it with `A`, and
 * Swedish, Danish and Norwegian alphabetise it after `Z`.
 */
describe("the name tie-break is pinned to one collation, not the reader's", () => {
  function row(id: string, givenName: string): PersonSearchRow {
    return {
      id,
      givenName,
      surname: "Doyle",
      birthDate: null,
      birthDateQualifier: "exact",
      birthDateUpper: null,
      deathDate: null,
      deathDateQualifier: "exact",
      deathDateUpper: null,
    };
  }

  it("orders Æ where `en` orders it, whatever collation the process runs under", () => {
    const rows: PersonSearchRow[] = [row("zorro", "Zorro"), row("aesa", "Æsa")];

    // Guards the fixture: it says nothing unless collations really do
    // disagree about this pair. A `small-icu` Node resolves every locale to
    // the root collation, under which all three of these agree — and the
    // assertion below would then pass without testing anything.
    // `test/collation-environment.test.ts` is the file that fails first when
    // that is what has happened.
    expect(
      new Intl.Collator("en").compare("æsa doyle", "zorro doyle"),
    ).toBeLessThan(0);
    expect(
      new Intl.Collator("sv").compare("æsa doyle", "zorro doyle"),
    ).toBeGreaterThan(0);
    expect(
      new Intl.Collator("da").compare("æsa doyle", "zorro doyle"),
    ).toBeGreaterThan(0);

    // Both rows tie on rank — "doyle" is a tier-0 surname prefix for each —
    // so the pinned collator decides the order outright. `en`'s answer, on
    // every machine: under `LC_ALL=sv_SE.UTF-8` or `LC_ALL=da_DK.UTF-8` an
    // unpinned comparator would put Zorro first.
    expect(ids(rows, "doyle")).toEqual(["aesa", "zorro"]);
  });
});
