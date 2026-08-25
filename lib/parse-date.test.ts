import { describe, expect, it } from "vitest";

import { parseDateInput, type ParsedDate } from "@/lib/parse-date";
import { formatQualifiedDate } from "@/lib/format-date";

/**
 * What the date field understands (E4-T2, `YEO-39`).
 *
 * This file is the ticket's acceptance criteria written as assertions, and it
 * needs no DOM to do it — which is the whole reason the parser is a module
 * rather than logic inside a component. Every case below is a string somebody
 * could plausibly type off a headstone, a census return or a parish register.
 */

/** The parse, or a failed assertion naming what came back instead. */
function parsed(input: string): ParsedDate {
  const result = parseDateInput(input);
  if (!result.ok) throw new Error(`${input} was refused: ${result.message}`);
  if (result.value === null) throw new Error(`${input} read as no date`);
  return result.value;
}

/** The refusal message, or a failed assertion if the input was accepted. */
function refused(input: string): string {
  const result = parseDateInput(input);
  if (result.ok) throw new Error(`${input} was accepted`);
  return result.message;
}

describe("the shapes the ticket names", () => {
  it("reads a bare year as a year", () => {
    expect(parsed("1890")).toEqual({
      // Anchored to 1 January because a `date` column has to hold a real day.
      // `precision` is what stops anything downstream reading it as one — the
      // acceptance criterion this pair exists to satisfy.
      date: "1890-01-01",
      qualifier: "exact",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("reads every spelling of about", () => {
    const about: ParsedDate = {
      date: "1890-01-01",
      qualifier: "about",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    };

    expect(parsed("abt 1890")).toEqual(about);
    expect(parsed("about 1890")).toEqual(about);
    expect(parsed("c. 1890")).toEqual(about);
    expect(parsed("c.1890")).toEqual(about);
    expect(parsed("ca 1890")).toEqual(about);
    expect(parsed("circa 1890")).toEqual(about);
    expect(parsed("around 1890")).toEqual(about);
    expect(parsed("approx 1890")).toEqual(about);
    expect(parsed("~1890")).toEqual(about);
    // GEDCOM's EST has no home among four qualifiers, and "roughly" is what
    // both words mean. Refusing it would send the author back to a field they
    // had already answered.
    expect(parsed("est. 1890")).toEqual(about);
  });

  it("reads before and after", () => {
    expect(parsed("before 1920")).toEqual({
      date: "1920-01-01",
      qualifier: "before",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
    expect(parsed("bef 1920")).toEqual(parsed("before 1920"));
    expect(parsed("<1920")).toEqual(parsed("before 1920"));
    expect(parsed("prior to 1920")).toEqual(parsed("before 1920"));

    expect(parsed("after 1885")).toEqual({
      date: "1885-01-01",
      qualifier: "after",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
    expect(parsed("aft. 1885")).toEqual(parsed("after 1885"));
    expect(parsed(">1885")).toEqual(parsed("after 1885"));
  });

  it("reads a full date written out, or written as ISO", () => {
    const day: ParsedDate = {
      date: "1890-03-12",
      qualifier: "exact",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    };

    expect(parsed("12 March 1890")).toEqual(day);
    expect(parsed("1890-03-12")).toEqual(day);
  });
});

describe("the shapes a real source produces", () => {
  it("reads a month and a year as a month", () => {
    const march: ParsedDate = {
      date: "1890-03-01",
      qualifier: "exact",
      precision: "month",
      upper: null,
      upperPrecision: "day",
    };

    expect(parsed("March 1890")).toEqual(march);
    expect(parsed("Mar 1890")).toEqual(march);
    expect(parsed("1890-03")).toEqual(march);
  });

  it("reads abbreviations, ordinals and the American order", () => {
    const day: ParsedDate = {
      date: "1890-03-12",
      qualifier: "exact",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    };

    expect(parsed("12 Mar 1890")).toEqual(day);
    expect(parsed("12th March 1890")).toEqual(day);
    expect(parsed("March 12, 1890")).toEqual(day);
    expect(parsed("Mar 12 1890")).toEqual(day);
  });

  it("does not care about case or spacing", () => {
    expect(parsed("ABT 1890")).toEqual(parsed("abt 1890"));
    expect(parsed("  12   MARCH   1890 ")).toEqual(parsed("12 March 1890"));
    // A value pasted out of a spreadsheet arrives with the line break on it.
    expect(parsed("about\n1890")).toEqual(parsed("about 1890"));
  });

  it("combines a qualifier with a full date", () => {
    expect(parsed("before 12 March 1890")).toEqual({
      date: "1890-03-12",
      qualifier: "before",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    });
    expect(parsed("abt March 1890")).toEqual({
      date: "1890-03-01",
      qualifier: "about",
      precision: "month",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("does not mistake a month for a qualifier", () => {
    // "may", "mar" and "apr" all begin with letters that start a qualifier in
    // some spelling. A prefix has to be followed by a space or end in a full
    // stop, which is what keeps May out of it.
    expect(parsed("May 1890")).toEqual({
      date: "1890-05-01",
      qualifier: "exact",
      precision: "month",
      upper: null,
      upperPrecision: "day",
    });
    expect(parsed("1 May 1890").qualifier).toBe("exact");
  });

  it("accepts an unpadded ISO date", () => {
    expect(parsed("1890-3-2")).toEqual({
      date: "1890-03-02",
      qualifier: "exact",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    });
  });
});

describe("no date at all", () => {
  it("reads a blank field as no date rather than as a mistake", () => {
    // Overwhelmingly the normal state of a genealogical record, and not a
    // failure. A field that complained about being empty would complain on
    // every person anybody ever added.
    expect(parseDateInput("")).toEqual({ ok: true, value: null });
    expect(parseDateInput("   ")).toEqual({ ok: true, value: null });
  });
});

describe("what it refuses, and what it says", () => {
  it("never silently drops what it cannot read", () => {
    // The acceptance criterion behind every case in this block: unreadable
    // input produces a message, never `{ ok: true, value: null }`, which the
    // field would render as an empty date and save without a word.
    for (const input of ["hello", "18", "19th century", "1890s", "?"]) {
      expect(parseDateInput(input).ok, input).toBe(false);
    }
  });

  it("refuses a day-first-or-month-first date rather than guessing", () => {
    // Both readings are plausible dates, so a wrong guess is invisible — the
    // author would never see the birthday it silently invented.
    expect(refused("12/03/1890")).toContain("March or December");
    expect(refused("12.03.1890")).toContain("March or December");
  });

  it("says which part is missing when a year is", () => {
    expect(refused("12 March")).toContain("needs a year");
    expect(refused("March")).toContain("needs a year");
  });

  it("refuses a day the calendar does not have", () => {
    expect(refused("30 February 1890")).toContain("not a day the calendar has");
    expect(refused("1890-02-30")).toContain("not a day the calendar has");
    expect(refused("1890-13-01")).toContain("not a day the calendar has");
  });

  it("refuses a qualifier with nothing after it", () => {
    expect(parseDateInput("about").ok).toBe(false);
    expect(parseDateInput("~").ok).toBe(false);
  });

  it("offers examples rather than a grammar", () => {
    // The field is for somebody holding a photocopied parish register, not
    // for somebody reading a manual.
    const message = refused("hello");
    expect(message).toContain("1890");
    expect(message).toContain("about 1890");
    expect(message).toContain("12 March 1890");
  });

  it("keeps a leap day that exists and refuses one that does not", () => {
    expect(parsed("29 February 1892").date).toBe("1892-02-29");
    expect(parseDateInput("29 February 1893").ok).toBe(false);
  });

  it("reads a range, now that the schema has somewhere to put the upper bound (YEO-88)", () => {
    // The decision this replaces: this module used to refuse every range
    // outright, on the grounds that there was nowhere for a dropped upper
    // bound to go — `DateField.tsx` has one inline echo, not a report. The
    // schema now has a second column per date, so the box that used to be a
    // dead end for a ranged date is the box that reads it.
    const yearYear = parsed("between 1890 and 1900");
    expect(yearYear).toEqual({
      date: "1890-01-01",
      qualifier: "exact",
      precision: "year",
      upper: "1900-01-01",
      upperPrecision: "year",
    });
    expect(parsed("1890 to 1900")).toEqual(yearYear);
    expect(parsed("BETWEEN 1890 AND 1900")).toEqual(yearYear);
  });

  it("keeps each endpoint at its own precision — the proof the range doubled precision, not just dates", () => {
    expect(parsed("between March 1890 and 1900")).toEqual({
      date: "1890-03-01",
      qualifier: "exact",
      precision: "month",
      upper: "1900-01-01",
      upperPrecision: "year",
    });

    expect(parsed("between 12 March 1912 and 4 July 1918")).toEqual({
      date: "1912-03-12",
      qualifier: "exact",
      precision: "day",
      upper: "1918-07-04",
      upperPrecision: "day",
    });
  });

  it("teaches the two accepted words rather than guessing at a hyphen or an en dash", () => {
    // The hyphen already means "ISO field separator" here (`ISO_YEAR_MONTH`,
    // `ISO_FULL`), and the en dash is `formatLifespan`'s birth/death joiner —
    // accepting either as a second meaning for "range" is the `12/03/1890`
    // failure this module already refuses, one character later.
    expect(refused("1890-1900")).toContain('"between" or "to"');
    expect(refused("1890–1900")).toContain('"between" or "to"');
  });

  it("refuses a malformed range rather than half-reading it", () => {
    expect(parseDateInput("between 1890").ok).toBe(false);
    expect(parseDateInput("between and 1900").ok).toBe(false);
    expect(parseDateInput("1890 to").ok).toBe(false);
    // Each endpoint is real text a person is looking at, so each is read —
    // and a problem with either one is reported, rather than the whole range
    // failing with one generic message.
    expect(refused("between garbage and 1900")).toContain("could not be read");
    expect(refused("between 1890 and garbage")).toContain("could not be read");
  });

  it("refuses a qualifier in front of a range, with a dedicated message", () => {
    // A range already says how uncertain a date is — `about between 1890 and
    // 1900` names a state `validateIndividual`/`validateUnion` never accept
    // (a stored range's qualifier is always `exact`), so this module says so
    // rather than silently dropping the qualifier or the range.
    expect(refused("about between 1890 and 1900")).toContain(
      "already says how uncertain",
    );
  });

  it("still refuses GEDCOM's own spellings — that grammar belongs to lib/gedcom.ts, not this module", () => {
    for (const input of [
      "BET 1890 AND 1900",
      "FROM 1912 TO 1918",
      "INT 1890 (x)",
    ]) {
      expect(parseDateInput(input).ok, input).toBe(false);
    }
  });
});

describe("the round trip through the formatter", () => {
  /**
   * The property the edit form depends on.
   *
   * `individualFormValuesFrom` prefills a free-text date box by formatting the
   * stored columns, and this parser has to read that sentence back as the same
   * five values — otherwise opening a person and saving them again would
   * quietly change their dates. Asserting it here rather than in the component
   * is what keeps it a property of the two pure modules.
   *
   * Legal values only: `formatQualifiedDate` also renders a row with a
   * non-`exact` qualifier beside a non-null `upper` (`about between 1890 and
   * 1900`), because a hand-made `INSERT` can produce one and this function
   * would rather render it honestly than hide a word. This parser refuses
   * that same string on the way back in — the division of labour is that
   * `validateIndividual`/`validateUnion` are the gate that keeps such a row
   * from ever being written, not this round trip.
   */
  const cases: ParsedDate[] = [
    {
      date: "1890-01-01",
      qualifier: "exact",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1890-01-01",
      qualifier: "about",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1920-01-01",
      qualifier: "before",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1885-01-01",
      qualifier: "after",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1890-03-01",
      qualifier: "exact",
      precision: "month",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1890-03-01",
      qualifier: "about",
      precision: "month",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1890-03-12",
      qualifier: "exact",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1890-03-12",
      qualifier: "before",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    },
    {
      date: "1953-11-02",
      qualifier: "after",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    },
    // Four range cases (`YEO-88`): year/year, month/year (mixed precision —
    // the case that proves precision doubled), day/day, and a same-year range
    // whose `formatQualifiedYear` collapse has no bearing on this full-date
    // round trip.
    {
      date: "1890-01-01",
      qualifier: "exact",
      precision: "year",
      upper: "1900-01-01",
      upperPrecision: "year",
    },
    {
      date: "1890-03-01",
      qualifier: "exact",
      precision: "month",
      upper: "1900-01-01",
      upperPrecision: "year",
    },
    {
      date: "1912-03-12",
      qualifier: "exact",
      precision: "day",
      upper: "1918-07-04",
      upperPrecision: "day",
    },
    {
      date: "1890-03-01",
      qualifier: "exact",
      precision: "month",
      upper: "1890-06-01",
      upperPrecision: "month",
    },
  ];

  for (const value of cases) {
    const label = value.upper
      ? `${value.qualifier}/${value.precision} ${value.date} to ${value.upperPrecision} ${value.upper}`
      : `${value.qualifier}/${value.precision} ${value.date}`;
    it(`survives ${label}`, () => {
      const shown = formatQualifiedDate(value);
      expect(shown).not.toBeNull();
      expect(parsed(shown ?? "")).toEqual(value);
    });
  }

  it("shows a year-only date as a year, not as 1 January", () => {
    expect(
      formatQualifiedDate({
        date: "1890-01-01",
        qualifier: "about",
        precision: "year",
        upper: null,
        upperPrecision: "day",
      }),
    ).toBe("about 1890");
    expect(
      formatQualifiedDate({
        date: "1890-03-01",
        qualifier: "exact",
        precision: "month",
        upper: null,
        upperPrecision: "day",
      }),
    ).toBe("March 1890");
    expect(
      formatQualifiedDate({
        date: "1890-01-01",
        qualifier: "exact",
        precision: "day",
        upper: null,
        upperPrecision: "day",
      }),
    ).toBe("1 January 1890");
  });
});
