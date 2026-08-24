import { describe, expect, it } from "vitest";

import {
  formatLifespan,
  formatPersonName,
  formatQualifiedDate,
} from "@/lib/person-format";

describe("formatPersonName", () => {
  it("joins the two halves of a name", () => {
    expect(formatPersonName("Thomas", "Hale")).toBe("Thomas Hale");
  });

  it("leaves no trailing space when the surname is unknown", () => {
    // `individuals.surname` is nullable because for the oldest generations it
    // routinely is unknown. A trailing space is invisible in a mockup and
    // very visible in a `truncate`d node.
    expect(formatPersonName("Alice", null)).toBe("Alice");
    expect(formatPersonName("Alice", "")).toBe("Alice");
  });
});

describe("formatLifespan", () => {
  it.each([
    ["1901-03-04", "1935-08-09", "1901–1935"],
    ["1910-05-05", null, "b. 1910"],
    [null, "1988-02-02", "d. 1988"],
    [null, null, ""],
  ])("renders (%s, %s) as %s", (birth, death, expected) => {
    // Genealogy data is full of half-known lives, so every combination has to
    // read as something rather than as a dangling dash.
    expect(formatLifespan(birth, death)).toBe(expected);
  });

  it("uses an en dash between the years, not a hyphen", () => {
    expect(formatLifespan("1901-03-04", "1935-08-09")).toContain("–");
  });
});

describe("formatQualifiedDate", () => {
  it("renders an exact date with no qualifier at all", () => {
    expect(formatQualifiedDate("1912-03-12", "exact")).toBe("12 March 1912");
  });

  it.each([
    ["about", "about 12 March 1912"],
    ["before", "before 12 March 1912"],
    ["after", "after 12 March 1912"],
  ] as const)("prefixes a %s date", (qualifier, expected) => {
    // The four values are GEDCOM 5.5.1's date modifiers. They exist so that
    // imprecision has somewhere to live other than the notes field, which
    // means the imprecision has to actually reach the page.
    expect(formatQualifiedDate("1912-03-12", qualifier)).toBe(expected);
  });

  it("returns null when there is no date, whatever the qualifier says", () => {
    // The columns are a pair: `date_qualifier` is `not null` precisely because
    // "no date at all" is already said by the date column being null.
    expect(formatQualifiedDate(null, "about")).toBeNull();
  });

  it("does not slide a date into the previous day west of Greenwich", () => {
    // A `date` column has no time part, so an unpinned formatter would parse
    // midnight in the runtime's zone and format it in the runtime's zone —
    // and a birthday recorded as the 1st would print as the 31st on a machine
    // running in New York. Both ends are pinned to UTC; this is the assertion
    // that notices if either is dropped.
    const original = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = zone;
        expect(formatQualifiedDate("1912-03-01", "exact")).toBe("1 March 1912");
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("falls back to the stored string rather than printing Invalid Date", () => {
    // Nothing should ever put this in the column, but "Invalid Date" tells a
    // reader nothing about what the row actually holds.
    expect(formatQualifiedDate("not-a-date", "exact")).toBe("not-a-date");
  });

  describe("precision", () => {
    it("shows only as much of the date as was recorded", () => {
      // The whole point of the `date_precision` column (E4-T2, `YEO-39`). A
      // year read off a headstone is stored on 1 January because a `date`
      // column has to hold a day, and printing that day back would be
      // inventing a fact and then attributing it to the author.
      expect(formatQualifiedDate("1912-01-01", "exact", "year")).toBe("1912");
      expect(formatQualifiedDate("1912-03-01", "exact", "month")).toBe(
        "March 1912",
      );
      expect(formatQualifiedDate("1912-03-12", "exact", "day")).toBe(
        "12 March 1912",
      );
    });

    it("keeps the qualifier in front of a coarse date", () => {
      expect(formatQualifiedDate("1890-01-01", "about", "year")).toBe(
        "about 1890",
      );
      expect(formatQualifiedDate("1920-01-01", "before", "year")).toBe(
        "before 1920",
      );
      expect(formatQualifiedDate("1890-03-01", "after", "month")).toBe(
        "after March 1890",
      );
    });

    it("defaults to the whole day, which is the column default", () => {
      // Every caller written before E4-T2 passes two arguments, and every row
      // written before the column existed came from an `<input type="date">`.
      // Both mean the same thing, and it is this.
      expect(formatQualifiedDate("1912-03-12", "exact")).toBe(
        formatQualifiedDate("1912-03-12", "exact", "day"),
      );
    });
  });
});
