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
    });
  });

  it("reads every spelling of about", () => {
    const about: ParsedDate = {
      date: "1890-01-01",
      qualifier: "about",
      precision: "year",
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
    });
    expect(parsed("bef 1920")).toEqual(parsed("before 1920"));
    expect(parsed("<1920")).toEqual(parsed("before 1920"));
    expect(parsed("prior to 1920")).toEqual(parsed("before 1920"));

    expect(parsed("after 1885")).toEqual({
      date: "1885-01-01",
      qualifier: "after",
      precision: "year",
    });
    expect(parsed("aft. 1885")).toEqual(parsed("after 1885"));
    expect(parsed(">1885")).toEqual(parsed("after 1885"));
  });

  it("reads a full date written out, or written as ISO", () => {
    const day: ParsedDate = {
      date: "1890-03-12",
      qualifier: "exact",
      precision: "day",
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
    });
    expect(parsed("abt March 1890")).toEqual({
      date: "1890-03-01",
      qualifier: "about",
      precision: "month",
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
    });
    expect(parsed("1 May 1890").qualifier).toBe("exact");
  });

  it("accepts an unpadded ISO date", () => {
    expect(parsed("1890-3-2")).toEqual({
      date: "1890-03-02",
      qualifier: "exact",
      precision: "day",
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
});

describe("the round trip through the formatter", () => {
  /**
   * The property the edit form depends on.
   *
   * `individualFormValuesFrom` prefills a free-text date box by formatting the
   * stored columns, and this parser has to read that sentence back as the same
   * three values — otherwise opening a person and saving them again would
   * quietly change their dates. Asserting it here rather than in the component
   * is what keeps it a property of the two pure modules.
   */
  const cases: ParsedDate[] = [
    { date: "1890-01-01", qualifier: "exact", precision: "year" },
    { date: "1890-01-01", qualifier: "about", precision: "year" },
    { date: "1920-01-01", qualifier: "before", precision: "year" },
    { date: "1885-01-01", qualifier: "after", precision: "year" },
    { date: "1890-03-01", qualifier: "exact", precision: "month" },
    { date: "1890-03-01", qualifier: "about", precision: "month" },
    { date: "1890-03-12", qualifier: "exact", precision: "day" },
    { date: "1890-03-12", qualifier: "before", precision: "day" },
    { date: "1953-11-02", qualifier: "after", precision: "day" },
  ];

  for (const value of cases) {
    it(`survives ${value.qualifier}/${value.precision} ${value.date}`, () => {
      const shown = formatQualifiedDate(
        value.date,
        value.qualifier,
        value.precision,
      );
      expect(shown).not.toBeNull();
      expect(parsed(shown ?? "")).toEqual(value);
    });
  }

  it("shows a year-only date as a year, not as 1 January", () => {
    expect(formatQualifiedDate("1890-01-01", "about", "year")).toBe(
      "about 1890",
    );
    expect(formatQualifiedDate("1890-03-01", "exact", "month")).toBe(
      "March 1890",
    );
    expect(formatQualifiedDate("1890-01-01", "exact", "day")).toBe(
      "1 January 1890",
    );
  });
});
