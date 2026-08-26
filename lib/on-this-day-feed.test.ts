import { describe, expect, it } from "vitest";

import {
  type Anniversary,
  formatAnniversaryEvent,
  formatYearsAgo,
  mergeAnniversaries,
  ON_THIS_DAY_LIMIT,
  todayAnniversary,
  yearOf,
} from "@/lib/on-this-day-feed";

/**
 * The decisions "On this day" makes, checked in the suite that gates a merge.
 *
 * This is the whole reason `lib/on-this-day-feed.ts` is a module separate from
 * `lib/on-this-day.ts`: the ordering across three unlike sources, the words a
 * row is written in and the arithmetic of "how long ago" are the interesting
 * parts of E8-T5, and had the feed been one `UNION ALL` they would live in
 * SQL, where `npm test` — which CI runs with no `DATABASE_URL` at all — could
 * not reach them. See docs/testing.md.
 *
 * What is deliberately *not* here: which rows the queries return at all. That
 * the section skips a date whose qualifier is not `exact` — the ticket's
 * second criterion — is a `WHERE` clause, so it is asserted against a real
 * Postgres in `lib/on-this-day.db.test.ts`, where a mock could not stand in
 * for the thing under test.
 */

/**
 * Each helper returns its own arm rather than the whole `Anniversary`, so that
 * a test can read the field only that arm has — and so that a spread which
 * overrides one is checked rather than rejected. Given the wider type the
 * compiler cannot know which arm it is looking at.
 */
function birth(
  personId: string,
  year: number,
): Extract<Anniversary, { kind: "birth" }> {
  return { kind: "birth", personId, name: `Person ${personId}`, year };
}

function death(
  personId: string,
  year: number,
): Extract<Anniversary, { kind: "death" }> {
  return { kind: "death", personId, name: `Person ${personId}`, year };
}

function union(
  unionId: string,
  year: number,
): Extract<Anniversary, { kind: "union-started" }> {
  return {
    kind: "union-started",
    unionId,
    unionType: "marriage",
    partners: [
      { personId: `${unionId}-a`, name: "Rose Whitfield" },
      { personId: `${unionId}-b`, name: "Walter Whitfield" },
    ],
    year,
  };
}

describe("mergeAnniversaries", () => {
  it("interleaves the three sources oldest first", () => {
    const merged = mergeAnniversaries([
      [birth("a", 1890), birth("b", 1946)],
      [death("c", 1912), death("d", 1971)],
      [union("e", 1901)],
    ]);

    // A page of a calendar rather than a feed: read downwards, the section is
    // the day's own chronology. `mergeRecentChanges` next door sorts the other
    // way, and its docblock and this one both say why.
    expect(merged.map((anniversary) => anniversary.year)).toEqual([
      1890, 1901, 1912, 1946, 1971,
    ]);
  });

  it("takes the sources in any order", () => {
    const sources = [
      [birth("a", 1890)],
      [death("c", 1912)],
      [union("e", 1901)],
    ];
    const forwards = mergeAnniversaries(sources);
    const backwards = mergeAnniversaries([...sources].reverse());

    expect(backwards).toEqual(forwards);
  });

  it("does not reorder the lists it was handed", () => {
    // `sources` is `readonly` at the outer level and its members are not, so
    // a merge that sorted in place would silently reorder a caller's array.
    const births = [birth("b", 1946), birth("a", 1890)];
    mergeAnniversaries([births]);

    expect(births.map((anniversary) => anniversary.personId)).toEqual([
      "b",
      "a",
    ]);
  });

  it("keeps the oldest rows when there are more than the limit", () => {
    const many = Array.from({ length: ON_THIS_DAY_LIMIT + 5 }, (_, index) =>
      birth(`p${index}`, 1900 + index),
    );

    const merged = mergeAnniversaries([many]);

    expect(merged).toHaveLength(ON_THIS_DAY_LIMIT);
    expect(merged.at(-1)?.year).toBe(1900 + ON_THIS_DAY_LIMIT - 1);
  });

  it("takes an explicit limit", () => {
    const merged = mergeAnniversaries(
      [[birth("a", 1890), birth("b", 1946)], [death("c", 1912)]],
      2,
    );

    expect(merged.map((anniversary) => anniversary.year)).toEqual([1890, 1912]);
  });
});

describe("two anniversaries in the same year", () => {
  /*
    Not a hypothetical: every row in this feed already shares a month and a
    day, so a shared year is a tie — twins are the everyday example, and a
    couple married on the day one of them was born is another. Sorting on
    `year` alone is not a total order, so the section could reshuffle between
    two requests that read identical rows.
  */
  it("orders them the same way whatever order they arrive in", () => {
    const forwards = mergeAnniversaries([
      [birth("rose", 1912)],
      [death("agnes", 1912)],
      [union("whitfield", 1912)],
    ]);
    const backwards = mergeAnniversaries([
      [union("whitfield", 1912)],
      [death("agnes", 1912)],
      [birth("rose", 1912)],
    ]);

    expect(backwards).toEqual(forwards);
  });

  it("cuts a limit through a tie the same way every time", () => {
    // The failure `YEO-58`'s review caught one section along: a `LIMIT` over
    // a tie group with no unique tie-break drops a different row each time.
    const tied = [birth("c", 1912), birth("a", 1912), birth("b", 1912)];

    const first = mergeAnniversaries([tied], 2);
    const second = mergeAnniversaries([[...tied].reverse()], 2);

    expect(first.map((anniversary) => anniversary.year)).toEqual([1912, 1912]);
    expect(second).toEqual(first);
  });

  it("separates a person's own birth from their own death", () => {
    /*
      Somebody born and dead on the same date shares an `id` across two arms,
      so the tie-break key has to be prefixed by the kind or the two rows are
      indistinguishable to the sort — and would be to React's keys as well
      (see `anniversaryKey` in `components/OnThisDayList.tsx`).
    */
    const merged = mergeAnniversaries([
      [birth("rose", 1912)],
      [death("rose", 1912)],
    ]);

    expect(merged.map((anniversary) => anniversary.kind)).toEqual([
      "birth",
      "death",
    ]);
  });
});

describe("todayAnniversary", () => {
  it("reads the day in UTC, with a one-based month", () => {
    // One-based because Postgres's `extract(month from …)` is, and the query
    // compares the two directly. `Date`'s own 0-based month is converted here
    // rather than at the call site that builds the SQL.
    expect(todayAnniversary(new Date("2026-08-25T12:00:00.000Z"))).toEqual({
      year: 2026,
      month: 8,
      day: 25,
    });
  });

  it("does not follow the host machine's zone across midnight", () => {
    /*
      The instant is 23:30 UTC on the 25th, which is the 26th in Auckland and
      still the 25th in London. A `getMonth`/`getDate` here instead of their
      UTC forms would make the section's day depend on where the server
      happens to run — the same drift `formatQualifiedDate` pins `en-GB` and
      UTC to avoid.
    */
    expect(todayAnniversary(new Date("2026-08-25T23:30:00.000Z")).day).toBe(25);
  });

  it("reads a leap day as itself", () => {
    expect(todayAnniversary(new Date("2024-02-29T00:00:00.000Z"))).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
  });
});

describe("yearOf", () => {
  it("takes the year out of a stored date", () => {
    expect(yearOf("1890-08-25")).toBe(1890);
  });

  it("keeps a leading zero year", () => {
    // Postgres pads to four digits, and `Number` reads the padding away.
    expect(yearOf("0850-03-02")).toBe(850);
  });
});

describe("formatAnniversaryEvent", () => {
  it("says what happened, and in which year", () => {
    expect(formatAnniversaryEvent(birth("rose", 1890))).toBe("Born 1890");
    expect(formatAnniversaryEvent(death("rose", 1947))).toBe("Died 1947");
    expect(formatAnniversaryEvent(union("w", 1912))).toBe("Married 1912");
  });

  it("does not call a partnership a marriage", () => {
    /*
      `db/schema.ts` records the distinction and `components/PersonPanel.tsx`
      settled the vocabulary — "a partnership was not a marriage and should
      not borrow the word for it" (`UNION_PREFIX` in `lib/person-infobox.ts`).
      The section still shows it, which is the point: filtering partnerships
      out would mean a couple recorded as one never has an anniversary.
    */
    expect(
      formatAnniversaryEvent({ ...union("w", 1912), unionType: "partnership" }),
    ).toBe("Partnered 1912");
  });

  it("says only what is recorded when the type never was", () => {
    // `unknown` is a real member of the enum and the honest answer for an
    // imported union whose type GEDCOM did not carry. The preposition is what
    // keeps "Together 1912" from reading as a year they *were* together.
    expect(
      formatAnniversaryEvent({ ...union("w", 1912), unionType: "unknown" }),
    ).toBe("Together from 1912");
  });
});

describe("formatYearsAgo", () => {
  it("counts the years", () => {
    expect(formatYearsAgo(1890, 2026)).toBe("136 years ago");
  });

  it("says one year in the singular", () => {
    // Easy to get wrong and easy never to see: every fixture anybody reaches
    // for is decades old.
    expect(formatYearsAgo(2025, 2026)).toBe("1 year ago");
  });

  it("says nothing at all for this year", () => {
    // Today is not an anniversary of itself, and the row already says the
    // year. "0 years ago" would be a sentence about arithmetic.
    expect(formatYearsAgo(2026, 2026)).toBeNull();
  });

  it("says nothing at all for a year in the future", () => {
    // Nothing stops a typo putting a birth in 2091. "-65 years ago" reads as
    // a defect in the page rather than in the record; the year stays on
    // screen, which is the part somebody can go and fix.
    expect(formatYearsAgo(2091, 2026)).toBeNull();
  });
});
