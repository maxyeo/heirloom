import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { listOnThisDay } from "@/lib/on-this-day";
import type { AnniversaryDate } from "@/lib/on-this-day-feed";

/**
 * The half of E8-T5 that only a real Postgres can answer.
 *
 * `lib/on-this-day-feed.test.ts` owns the merge, the tie-break, the limit and
 * every formatter — all of that is arithmetic over plain values and runs in
 * `npm test`, where CI's `check` job can see it. What is left for this file is
 * what lives in SQL and would otherwise be asserted only by a mock returning
 * what the mock was told to return (docs/testing.md):
 *
 *   - **the `WHERE` clause**, which is the whole of the ticket's second
 *     acceptance criterion and the reason this section is not simply wrong.
 *     A date is four columns and three of them can independently mean "there
 *     is no day here" — see `fallsOnAnniversary`;
 *   - that the month and the day are *both* compared, which a query
 *     comparing only one would pass every other assertion in here;
 *   - that 29 February is 29 February and no other day — the one decision in
 *     `fallsOnAnniversary`'s docblock that no fixture dated to an ordinary
 *     day can protect (`YEO-109`);
 *   - that a union with no partner recorded is not offered as a row with
 *     nobody in it, and that a union with one is;
 *   - and that a `LIMIT` cuts a tie the same way every time.
 *
 * ## Why `today` is a parameter
 *
 * `listOnThisDay` takes the day rather than reading the clock, so these
 * fixtures state a date instead of being written against whenever the suite
 * happens to run. A test that seeded "today" would pass for the wrong reason
 * 364 days a year and fail mysteriously on the 365th — and could never assert
 * the New Year case below at all, which is the one that matters most.
 *
 * ## Fixtures carry the awkward value
 *
 * docs/testing.md's strongest unenforced rule, and this file is the case it
 * was written about: `date_qualifier` defaults to `exact` and
 * `date_precision` to `day`, so a fixture set that took both defaults would
 * make every exclusion below unreachable by construction, and no amount of
 * running these tests would say so. Every non-default value therefore appears
 * at least once, on its own row, with the reason beside it.
 *
 * ## If you change it, break it first
 *
 * Validated by mutation rather than by inspection, the way
 * `app/auth-boundary.test.ts` and `lib/relationship-derivation.test.ts` were.
 * Each of these turns the file red, naming the rule at fault — which matters
 * more here than usual, because every clause below is an *exclusion*, and a
 * test that asserts something is absent is exactly the kind that can pass
 * while asserting nothing at all.
 *
 * | Mutation                                     | Caught by                                     |
 * | -------------------------------------------- | --------------------------------------------- |
 * | `qualifier = 'exact'` dropped                | `is skipped, whichever of the three …`        |
 * | `precision = 'day'` dropped                  | `does not turn a year-precision date …`       |
 * | `upper is null` dropped                      | `is skipped when it is a range …`             |
 * | The month comparison dropped                 | `are both compared`                           |
 * | The day comparison dropped                   | `are both compared`                           |
 * | `asc(individuals.id)` dropped from `ORDER BY`| `cuts a tie the same way every time`          |
 * | The "names somebody" predicate dropped       | `is not offered when it names nobody`         |
 * | The month/day pair replaced by `doy`         | `does not spill over to 1 March …`            |
 * | The pair replaced by a year interval         | `does not fall back to 28 February …`         |
 * | 29 February rerouted to 1 March              | `is shown on 29 February …`                   |
 *
 * Every one of the first seven also fails `interleaves births, deaths and
 * unions into one order`, which is the point of that assertion being one list
 * rather than seven.
 *
 * The last three are the opposite case, and the reason `YEO-109` was raised
 * against a section that was otherwise proved this way. Run against a real
 * Postgres, the year-interval mutation turns exactly **one** test in the
 * repository red — `does not fall back to 28 February in a common year` —
 * and the reroute turns two, both of them in `29 February` below. Nothing
 * else in either suite can see them: every other fixture in this file is
 * dated to a day that exists in every year, so the folded anniversary and the
 * correct one land on the same date.
 */

/** Explicit, recognisable ids — `59` is the ticket. */
const P_BORN = "00000000-0000-4000-8000-000000005901";
const P_BORN_ABOUT = "00000000-0000-4000-8000-000000005902";
const P_BORN_BEFORE = "00000000-0000-4000-8000-000000005903";
const P_BORN_AFTER = "00000000-0000-4000-8000-000000005904";
const P_BORN_RANGE = "00000000-0000-4000-8000-000000005905";
const P_BORN_NEXT_DAY = "00000000-0000-4000-8000-000000005906";
const P_BORN_NEXT_MONTH = "00000000-0000-4000-8000-000000005907";
const P_DIED = "00000000-0000-4000-8000-000000005908";
const P_DIED_ABOUT = "00000000-0000-4000-8000-000000005909";
const P_BORN_AND_DIED = "00000000-0000-4000-8000-00000000590a";

const P_JAN_EXACT = "00000000-0000-4000-8000-000000005911";
const P_JAN_YEAR = "00000000-0000-4000-8000-000000005912";
const P_JAN_MONTH = "00000000-0000-4000-8000-000000005913";

const U_MARRIED = "00000000-0000-4000-8000-000000005921";
const U_ABOUT = "00000000-0000-4000-8000-000000005922";
const U_YEAR = "00000000-0000-4000-8000-000000005923";
const U_NOBODY = "00000000-0000-4000-8000-000000005924";
const U_ONE_PARTNER = "00000000-0000-4000-8000-000000005925";
const U_PARTNERSHIP = "00000000-0000-4000-8000-000000005926";

/** The leap-day fixtures (`YEO-109`), kept together in their own range. */
const P_LEAP = "00000000-0000-4000-8000-000000005941";
const P_FEB_28 = "00000000-0000-4000-8000-000000005942";
const P_MAR_1 = "00000000-0000-4000-8000-000000005943";
const U_LEAP = "00000000-0000-4000-8000-000000005944";

const PERSON_IDS = [
  P_BORN,
  P_BORN_ABOUT,
  P_BORN_BEFORE,
  P_BORN_AFTER,
  P_BORN_RANGE,
  P_BORN_NEXT_DAY,
  P_BORN_NEXT_MONTH,
  P_DIED,
  P_DIED_ABOUT,
  P_BORN_AND_DIED,
  P_JAN_EXACT,
  P_JAN_YEAR,
  P_JAN_MONTH,
  P_LEAP,
  P_FEB_28,
  P_MAR_1,
];

const UNION_IDS = [
  U_MARRIED,
  U_ABOUT,
  U_YEAR,
  U_NOBODY,
  U_ONE_PARTNER,
  U_PARTNERSHIP,
  U_LEAP,
];

/** The day almost everything in this file is dated to: 4 June. */
const JUNE_4: AnniversaryDate = { year: 2026, month: 6, day: 4 };

/**
 * 1 January, which is the *only* interesting day for the precision rule.
 *
 * A year-precision date is stored as the first of January and a
 * month-precision one as the first of its month (`datePrecision` in
 * `db/schema.ts`), so New Year's Day is where a query that checked only the
 * qualifier would put every year-only date in the archive on the home page at
 * once. Nothing else in this file could catch that, because on any other day
 * those rows are excluded by the date comparison for free.
 */
const JANUARY_1: AnniversaryDate = { year: 2026, month: 1, day: 1 };

/** 7 July, used by nothing but the tie fixtures. */
const JULY_7: AnniversaryDate = { year: 2026, month: 7, day: 7 };

/**
 * The three days a leap-day date could plausibly be shown on, and against
 * which `lib/on-this-day.ts`'s "29 February" section says only the first
 * counts.
 *
 * 2028 is a leap year and 2027 is not, which is the only property of these
 * three values that matters. Written as year-bearing dates rather than as a
 * bare month and day because that difference is the whole test: 29 February
 * exists in `LEAP_DAY`'s year and in neither of the others, so a query that
 * folded the leap day onto a neighbouring date would have to pick one of the
 * two below to fold it onto.
 */
const LEAP_DAY: AnniversaryDate = { year: 2028, month: 2, day: 29 };
const FEB_28_COMMON: AnniversaryDate = { year: 2027, month: 2, day: 28 };
const MAR_1_COMMON: AnniversaryDate = { year: 2027, month: 3, day: 1 };

beforeAll(async () => {
  await db.insert(schema.individuals).values([
    /* Shown: an exact, day-precision date that is not a range. */
    {
      id: P_BORN,
      givenName: "Rose",
      surname: "Whitfield",
      birthDate: "1890-06-04",
    },
    /*
      The ticket's own example. "About 1890" does not claim its stored day, so
      the person has no birthday to celebrate on it — and the row was written
      with a real day only because Postgres has nowhere else to put one.
    */
    {
      id: P_BORN_ABOUT,
      givenName: "About",
      surname: "Whitfield",
      birthDate: "1891-06-04",
      birthDateQualifier: "about",
    },
    /* `before` and `after` on the same terms — three of the four members of
       `date_qualifier` are "this day is not the day". */
    {
      id: P_BORN_BEFORE,
      givenName: "Before",
      surname: "Whitfield",
      birthDate: "1892-06-04",
      birthDateQualifier: "before",
    },
    {
      id: P_BORN_AFTER,
      givenName: "After",
      surname: "Whitfield",
      birthDate: "1893-06-04",
      birthDateQualifier: "after",
    },
    /*
      `YEO-88`'s range: `BET 1894 AND 1900`. It legally carries `exact` —
      there is deliberately no `between` member on the enum — so the
      qualifier clause does not catch it and the upper-bound clause has to.
      Two points are an anniversary of neither.
    */
    {
      id: P_BORN_RANGE,
      givenName: "Range",
      surname: "Whitfield",
      birthDate: "1894-06-04",
      birthDateUpper: "1900-06-04",
    },
    /* The day next door, which a query comparing only the month would show. */
    {
      id: P_BORN_NEXT_DAY,
      givenName: "Fifth",
      surname: "Whitfield",
      birthDate: "1890-06-05",
    },
    /* The same day one month later, which a query comparing only the day
       would show — the two decoys together pin both halves of the
       comparison. */
    {
      id: P_BORN_NEXT_MONTH,
      givenName: "July",
      surname: "Whitfield",
      birthDate: "1890-07-04",
    },
    /* Shown, from the deaths query: this person has no birth date at all. */
    {
      id: P_DIED,
      givenName: "Walter",
      surname: "Whitfield",
      deathDate: "1947-06-04",
    },
    /* The qualifier rule again, on the other pair of columns — a query that
       filtered births and forgot deaths would pass every test above. */
    {
      id: P_DIED_ABOUT,
      givenName: "Departed",
      surname: "Whitfield",
      deathDate: "1948-06-04",
      deathDateQualifier: "about",
    },
    /*
      Born and died on the same date, so this person is two rows. The surname
      is null on purpose: for the oldest generations it is routinely unknown,
      and `formatPersonName` has to drop it rather than leave a trailing space.
    */
    {
      id: P_BORN_AND_DIED,
      givenName: "Agnes",
      surname: null,
      birthDate: "1900-06-04",
      deathDate: "1975-06-04",
    },

    /* The New Year trio — same stored date, three different precisions. */
    {
      id: P_JAN_EXACT,
      givenName: "NewYear",
      surname: "Whitfield",
      birthDate: "1895-01-01",
    },
    {
      id: P_JAN_YEAR,
      givenName: "YearOnly",
      surname: "Whitfield",
      // "1894", off a headstone. The day is an anchor the schema had to
      // invent, not something a source recorded.
      birthDate: "1894-01-01",
      birthDatePrecision: "year",
    },
    {
      id: P_JAN_MONTH,
      givenName: "MonthOnly",
      surname: "Whitfield",
      // "January 1896", off a parish register. The 1st is an anchor too.
      birthDate: "1896-01-01",
      birthDatePrecision: "month",
    },

    /*
      The leap day itself (`YEO-109`). This person was born and died on a 29
      February — 1896 and 1968 are both leap years — so one row is both a
      birth and a death, and `U_LEAP` below carries the third pair of date
      columns. The
      predicate is literally one function, so a leap-day fixture on any one of
      the three would prove the rule; all three are here because the cost is
      two rows and the thing being protected is a decision a later
      "simplification" of one query could lose without touching the others.
    */
    {
      id: P_LEAP,
      givenName: "LeapDay",
      surname: "Whitfield",
      birthDate: "1896-02-29",
      deathDate: "1968-02-29",
    },
    /*
      The two neighbours, and the reason the exclusions are not vacuous: a
      predicate that matched nothing whatsoever on 28 February or 1 March
      would satisfy "the leap-day person is absent" perfectly and mean
      nothing. These two are present on exactly those days, so each assertion
      below is a whole answer rather than an absence.
    */
    {
      id: P_FEB_28,
      givenName: "FebTwentyEighth",
      surname: "Whitfield",
      birthDate: "1895-02-28",
    },
    {
      id: P_MAR_1,
      givenName: "MarchFirst",
      surname: "Whitfield",
      birthDate: "1897-03-01",
    },
  ]);

  await db.insert(schema.unions).values([
    /* Shown, and the only arm that names two people. */
    {
      id: U_MARRIED,
      partnerAId: P_BORN,
      partnerBId: P_DIED,
      startDate: "1912-06-04",
    },
    /* The qualifier and precision rules, on the third pair of date columns. */
    {
      id: U_ABOUT,
      partnerAId: P_BORN,
      partnerBId: P_DIED,
      startDate: "1913-06-04",
      startDateQualifier: "about",
    },
    {
      id: U_YEAR,
      partnerAId: P_BORN,
      partnerBId: P_DIED,
      startDate: "1914-06-04",
      startDatePrecision: "year",
    },
    /*
      Legal and useless: a union with neither partner recorded still holds its
      children together, but there is nobody to name and nowhere to link, so
      the section must not offer a bare "Married 1915".
    */
    {
      id: U_NOBODY,
      partnerAId: null,
      partnerBId: null,
      startDate: "1915-06-04",
    },
    /*
      Half recorded, which `db/schema.ts` says is extremely common in older
      generations — and the row an inner join would silently drop.
    */
    {
      id: U_ONE_PARTNER,
      partnerAId: P_BORN,
      partnerBId: null,
      startDate: "1916-06-04",
    },
    /*
      A partnership rather than a marriage. Shown, because excluding it would
      mean a couple recorded this way never has an anniversary at all; the
      *word* is what differs, and `formatAnniversaryEvent` owns that.
    */
    {
      id: U_PARTNERSHIP,
      partnerAId: P_BORN,
      partnerBId: P_DIED,
      type: "partnership",
      startDate: "1917-06-04",
    },
    /*
      A wedding on a leap day, so `fallsOnAnniversary` is exercised by
      `YEO-109` through the third pair of date columns as well. 1920 is a leap
      year; the partners are two of the fixtures above, so the row names
      somebody and is not excluded for the unrelated reason `U_NOBODY` is.
    */
    {
      id: U_LEAP,
      partnerAId: P_LEAP,
      partnerBId: P_FEB_28,
      startDate: "1920-02-29",
    },
  ]);
});

afterAll(async () => {
  // Unions first: both partner columns are `on delete cascade`, so deleting
  // the people would take the unions with them — but deleting a child before
  // its parent is the habit that keeps a future foreign key from turning
  // teardown red.
  await db.delete(schema.unions).where(inArray(schema.unions.id, UNION_IDS));
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PERSON_IDS));
});

/**
 * The section, narrowed to this file's own rows.
 *
 * The limit is generous rather than the default: these tests run against a
 * database that may hold other files' fixtures, and truncating to ten before
 * filtering would make the assertions depend on what else happens to be in the
 * tables. The default limit is checked in `lib/on-this-day-feed.test.ts`, over
 * data nothing else can touch.
 */
async function fixtureAnniversaries(today: AnniversaryDate) {
  const anniversaries = await listOnThisDay(today, 500);

  return anniversaries.filter((anniversary) => {
    switch (anniversary.kind) {
      case "birth":
      case "death":
        return PERSON_IDS.includes(anniversary.personId);
      case "union-started":
        return UNION_IDS.includes(anniversary.unionId);
    }
  });
}

describe("listOnThisDay", () => {
  it("interleaves births, deaths and unions into one order", async () => {
    const anniversaries = await fixtureAnniversaries(JUNE_4);

    /*
      One assertion, because the interesting behaviour is the *whole* answer —
      asserting each rule separately would let a query that got two of them
      right and dropped a row in between still pass. Every fixture that is not
      in this list is excluded by a clause named in its own comment above.
    */
    expect(anniversaries).toEqual([
      {
        kind: "birth",
        personId: P_BORN,
        name: "Rose Whitfield",
        year: 1890,
      },
      {
        kind: "birth",
        personId: P_BORN_AND_DIED,
        // The surname was null, so the name is the given name and no more.
        name: "Agnes",
        year: 1900,
      },
      {
        kind: "union-started",
        unionId: U_MARRIED,
        unionType: "marriage",
        partners: [
          { personId: P_BORN, name: "Rose Whitfield" },
          { personId: P_DIED, name: "Walter Whitfield" },
        ],
        year: 1912,
      },
      {
        kind: "union-started",
        unionId: U_ONE_PARTNER,
        unionType: "marriage",
        partners: [{ personId: P_BORN, name: "Rose Whitfield" }],
        year: 1916,
      },
      {
        kind: "union-started",
        unionId: U_PARTNERSHIP,
        unionType: "partnership",
        partners: [
          { personId: P_BORN, name: "Rose Whitfield" },
          { personId: P_DIED, name: "Walter Whitfield" },
        ],
        year: 1917,
      },
      {
        kind: "death",
        personId: P_DIED,
        name: "Walter Whitfield",
        year: 1947,
      },
      {
        kind: "death",
        personId: P_BORN_AND_DIED,
        name: "Agnes",
        year: 1975,
      },
    ]);
  });

  it("shows nothing at all on a day the archive says nothing about", async () => {
    /*
      The third acceptance criterion, from the query's end — the component
      renders no heading (`components/OnThisDayList.test.tsx`), and this is
      what it is given in order to do so. 30 November: no fixture in this file
      is dated to it.
    */
    const anniversaries = await fixtureAnniversaries({
      year: 2026,
      month: 11,
      day: 30,
    });

    expect(anniversaries).toEqual([]);
  });
});

describe("a date whose qualifier is not exact", () => {
  /*
    The ticket's second acceptance criterion, stated on its own as well as
    inside the order above, because this is the predicate whose absence would
    not fail loudly: the section would still render, and would simply be
    telling the family things the record does not say.
  */
  it("is skipped, whichever of the three qualifiers it carries", async () => {
    const anniversaries = await fixtureAnniversaries(JUNE_4);
    const ids = anniversaries.map((anniversary) =>
      anniversary.kind === "union-started"
        ? anniversary.unionId
        : anniversary.personId,
    );

    // `about` — the ticket's own example, "about 1890 has no day".
    expect(ids).not.toContain(P_BORN_ABOUT);
    expect(ids).not.toContain(P_DIED_ABOUT);
    expect(ids).not.toContain(U_ABOUT);
    // `before` and `after` say even less about the stored day than `about`.
    expect(ids).not.toContain(P_BORN_BEFORE);
    expect(ids).not.toContain(P_BORN_AFTER);
  });

  it("is skipped when it is a range rather than a point", async () => {
    /*
      `YEO-88`. A stored range carries `exact` by design — there is no
      `between` member on the enum — so this row passes the criterion as
      literally written and still has no day in it. The upper-bound clause is
      what catches it.
    */
    const anniversaries = await fixtureAnniversaries(JUNE_4);
    const people = anniversaries.filter(
      (anniversary) => anniversary.kind === "birth",
    );

    expect(people.map((person) => person.personId)).not.toContain(P_BORN_RANGE);
  });
});

describe("a date whose day was never recorded", () => {
  /*
    The clause the acceptance criterion predates, and the one this section
    would be most embarrassing without. E4-T2 (`YEO-39`) arrived after E4-T1,
    and it made a year-only date storable as **1 January** with `year` beside
    it — an anchor, not an assertion. A query that checked only the qualifier
    would therefore be correct for 364 days and, on New Year's Day, announce
    that every person in the archive whose birth year came off a headstone was
    born that morning.
  */
  it("does not turn a year-precision date into a New Year's Day birthday", async () => {
    const anniversaries = await fixtureAnniversaries(JANUARY_1);
    const ids = anniversaries.map((anniversary) =>
      anniversary.kind === "union-started"
        ? anniversary.unionId
        : anniversary.personId,
    );

    expect(ids).not.toContain(P_JAN_YEAR);
    expect(ids).not.toContain(P_JAN_MONTH);
  });

  it("still shows a date that really is the first of January", async () => {
    /*
      The control, and the reason the test above is not simply "exclude 1
      January". All three fixtures store the *same day*; only
      `date_precision` tells them apart, so this pair is what proves the
      predicate reads the column rather than the date.
    */
    const anniversaries = await fixtureAnniversaries(JANUARY_1);
    const births = anniversaries.filter(
      (anniversary) => anniversary.kind === "birth",
    );

    expect(births.map((birth) => birth.personId)).toEqual([P_JAN_EXACT]);
  });
});

describe("the day and the month", () => {
  it("are both compared", async () => {
    const anniversaries = await fixtureAnniversaries(JUNE_4);
    const births = anniversaries.filter(
      (anniversary) => anniversary.kind === "birth",
    );
    const ids = births.map((birth) => birth.personId);

    // 5 June and 4 July. Each decoy fails exactly one half of the comparison,
    // so a query that dropped either half would show one of them.
    expect(ids).not.toContain(P_BORN_NEXT_DAY);
    expect(ids).not.toContain(P_BORN_NEXT_MONTH);
  });
});

/**
 * The half of `lib/on-this-day.ts`'s leap-day section that a docblock cannot
 * do (`YEO-109`).
 *
 * The decision there is that a leap-day date comes round every four years: it
 * appears on 29 February and on no other day, rather than being folded onto
 * 28 February or 1 March in a common year. That is a deliberate refusal of
 * the obvious kindness — the record says the 29th, and this section does not
 * move a date the archive holds — and until this block it was argued in prose
 * and asserted nowhere.
 *
 * It is also the clause most exposed to a well-meaning tidy-up, because 29
 * February is the *only* date on which the obvious simplifications of a
 * month/day comparison disagree with the one in the file — every other
 * fixture here is dated to a day that exists in every year, so a folded
 * anniversary and a correct one land on the same date and nothing goes red.
 * Three such simplifications, and the day each of them gets wrong:
 *
 *   - **day-of-year.** `extract(doy from …)` is off by one after February in
 *     a common year, so 29 February and 1 March are both day 60. Caught by
 *     `does not spill over to 1 March`, and again from the other direction by
 *     `is shown on 29 February` — the 1 March fixture turns up on the 29th.
 *   - **an interval.** Computing this year's anniversary as
 *     `date + make_interval(years => …)` reads better than two `extract`s and
 *     asks Postgres to normalise 29 February into 28 February whenever the
 *     target year has no 29th. Caught by `does not fall back to 28 February`.
 *   - **the kindness itself**, written as a reroute rather than an addition:
 *     leap-day people celebrated on 1 March, every year. Caught by `is shown
 *     on 29 February`, which is why the positive case is asserted as a whole
 *     list rather than left implicit.
 *
 * The three fixtures are read on three different days rather than compared
 * within one, because the predicate takes `today` as a parameter precisely so
 * that a test can state the day instead of waiting four years for one.
 *
 * Two of those three days are asserted by what is *absent*, which is the kind
 * of test that can pass while checking nothing, so each is asserted as a whole
 * list with a neighbour in it. Replacing the month/day comparison with `false`
 * — a predicate that matches nothing anywhere — turns all three of these red,
 * which is the check that the two exclusions are load-bearing rather than
 * vacuously true.
 */
describe("29 February", () => {
  it("is shown on 29 February, from all three source queries", async () => {
    const anniversaries = await fixtureAnniversaries(LEAP_DAY);

    /*
      A whole list, for the reason `interleaves births, deaths and unions into
      one order` gives: this is also what proves `fallsOnAnniversary` is
      genuinely shared, since one leap-day person and one leap-day union
      produce a birth, a union and a death from three separate queries and a
      predicate that had been specialised in any one of them would be short a
      row here.
    */
    expect(anniversaries).toEqual([
      {
        kind: "birth",
        personId: P_LEAP,
        name: "LeapDay Whitfield",
        year: 1896,
      },
      {
        kind: "union-started",
        unionId: U_LEAP,
        unionType: "marriage",
        partners: [
          { personId: P_LEAP, name: "LeapDay Whitfield" },
          { personId: P_FEB_28, name: "FebTwentyEighth Whitfield" },
        ],
        year: 1920,
      },
      {
        kind: "death",
        personId: P_LEAP,
        name: "LeapDay Whitfield",
        year: 1968,
      },
    ]);
  });

  it("does not fall back to 28 February in a common year", async () => {
    const anniversaries = await fixtureAnniversaries(FEB_28_COMMON);

    // The 28 February person and nobody else. Asserted as the whole answer
    // rather than as `not.toContain(P_LEAP)`, so that a predicate which had
    // stopped matching anything at all could not pass it.
    expect(anniversaries).toEqual([
      {
        kind: "birth",
        personId: P_FEB_28,
        name: "FebTwentyEighth Whitfield",
        year: 1895,
      },
    ]);
  });

  it("does not spill over to 1 March in a common year", async () => {
    const anniversaries = await fixtureAnniversaries(MAR_1_COMMON);

    expect(anniversaries).toEqual([
      {
        kind: "birth",
        personId: P_MAR_1,
        name: "MarchFirst Whitfield",
        year: 1897,
      },
    ]);
  });
});

describe("a union", () => {
  it("is not offered when it names nobody", async () => {
    const anniversaries = await fixtureAnniversaries(JUNE_4);
    const unions = anniversaries.filter(
      (anniversary) => anniversary.kind === "union-started",
    );

    expect(unions.map((union) => union.unionId)).not.toContain(U_NOBODY);
  });

  it("survives with only one partner recorded", async () => {
    /*
      The row an inner join would have dropped, and the one whose anniversary
      is most likely to be all the archive still knows about the couple.
    */
    const anniversaries = await fixtureAnniversaries(JUNE_4);
    const half = anniversaries.find(
      (anniversary) =>
        anniversary.kind === "union-started" &&
        anniversary.unionId === U_ONE_PARTNER,
    );

    expect(half).toMatchObject({
      partners: [{ personId: P_BORN, name: "Rose Whitfield" }],
    });
  });
});

describe("what comes back", () => {
  it("selects no more of a person than the section renders", async () => {
    const [first] = await fixtureAnniversaries(JUNE_4);

    /*
      Checked here rather than by the compiler, for the reason
      `lib/recent-changes.db.test.ts` gives about its own narrow select:
      `Anniversary` constrains what a *caller* may read and says nothing about
      what the query asked Postgres for. A `notes` added to the select and not
      to the type would type-check perfectly while shipping every birthday
      person's authored prose into a home page that renders three fields.
    */
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "kind",
      "name",
      "personId",
      "year",
    ]);
  });

  it("brings the year back as a number", async () => {
    const [first] = await fixtureAnniversaries(JUNE_4);

    // What the driver plus `yearOf` hand back, which nothing in TypeScript
    // can promise: `mergeAnniversaries` subtracts these and `formatYearsAgo`
    // subtracts them again, and a string would satisfy neither while
    // type-checking perfectly at every layer in between.
    expect(typeof first?.year).toBe("number");
    expect(first?.year).toBe(1890);
  });
});

describe("ties", () => {
  /**
   * The failure `YEO-58`'s review caught one section along, and the reason
   * every source query orders on its id as well as on its date.
   *
   * Ties are the *ordinary* case here rather than a hypothetical one: every
   * row this query returns already shares a month and a day, so two people
   * born in the same year are a tie, and twins are the everyday example.
   * `db/seed.ts` inserts every seeded person in one statement, so a freshly
   * seeded database is full of rows the plan is free to return in any order.
   * A `LIMIT` cutting through the middle of a tie group with no unique
   * tie-break returns whichever rows the plan happened to produce — a
   * different person dropped after an autovacuum reorders the heap, with
   * nothing on screen to suggest the list is arbitrary.
   *
   * `mergeAnniversaries` cannot rescue it: by the time it sorts, the rows the
   * database declined to return are already gone.
   */
  /*
    7 July, and years far older than anything else in the suite, so that a
    small limit reaches these three rows and only these three. A limit is a
    global cut, so a tie test that shared a date with another fixture would be
    asserting what else is in the database.
  */
  const TIED_IDS = [
    "00000000-0000-4000-8000-000000005931",
    "00000000-0000-4000-8000-000000005932",
    "00000000-0000-4000-8000-000000005933",
  ];

  beforeAll(async () => {
    await db.insert(schema.individuals).values(
      // Inserted highest-id-first, so that "the order they were written in"
      // and "the order the query must return" disagree.
      [...TIED_IDS].reverse().map((id, index) => ({
        id,
        givenName: `Tied ${index}`,
        surname: "Whitfield",
        birthDate: "1601-07-07",
      })),
    );
  });

  afterAll(async () => {
    await db
      .delete(schema.individuals)
      .where(inArray(schema.individuals.id, TIED_IDS));
  });

  it("cuts a tie the same way every time", async () => {
    const tiedPeople = async () => {
      // A limit that lands inside the tie group rather than around it, which
      // is the only case where the tie-break can be observed at all.
      const anniversaries = await listOnThisDay(JULY_7, 2);
      return anniversaries
        .filter((anniversary) => anniversary.kind === "birth")
        .map((birth) => birth.personId)
        .filter((id) => TIED_IDS.includes(id));
    };

    const first = await tiedPeople();
    const second = await tiedPeople();

    // Same answer twice, and specifically the *lowest* ids — `id asc` is the
    // tie-break, so which rows survive the limit is a property of the data
    // rather than of the plan.
    expect(first).toEqual(second);
    expect(first).toEqual([TIED_IDS[0], TIED_IDS[1]]);
  });
});
