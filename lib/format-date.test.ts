import { describe, expect, it } from "vitest";

import {
  formatLifespan,
  formatQualifiedDate,
  formatQualifiedYear,
  type Lifespan,
  type QualifiedDate,
} from "@/lib/format-date";

/**
 * A lifespan fixture whose qualifiers default to `exact` and whose dates
 * default to single points.
 *
 * Every test that cares about a qualifier or a range states it. Everything
 * else reads as the ordinary case, which is what keeps the qualified and
 * ranged assertions below visibly different from the unqualified ones.
 */
function lifespan(overrides: Partial<Lifespan> = {}): Lifespan {
  return {
    birthDate: null,
    birthDateQualifier: "exact",
    birthDateUpper: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDateUpper: null,
    ...overrides,
  };
}

/** A `QualifiedDate` fixture, single-point by default (`YEO-88`). */
function qd(overrides: Partial<QualifiedDate> = {}): QualifiedDate {
  return {
    date: "1912-03-12",
    qualifier: "exact",
    precision: "day",
    upper: null,
    upperPrecision: "day",
    ...overrides,
  };
}

describe("formatQualifiedDate", () => {
  it("renders an exact date with no qualifier at all", () => {
    expect(formatQualifiedDate(qd())).toBe("12 March 1912");
  });

  it.each([
    ["about", "about 12 March 1912"],
    ["before", "before 12 March 1912"],
    ["after", "after 12 March 1912"],
  ] as const)("prefixes a %s date", (qualifier, expected) => {
    // The four values are GEDCOM 5.5.1's date modifiers. They exist so that
    // imprecision has somewhere to live other than the notes field, which
    // means the imprecision has to actually reach the page.
    expect(formatQualifiedDate(qd({ qualifier }))).toBe(expected);
  });

  it("renders nothing at all when there is no date", () => {
    // The columns are a pair: `date_qualifier` is `not null` precisely because
    // "no date at all" is already said by the date column being null. Null
    // out of here is what lets every surface omit the row rather than print
    // "unknown" or a dash — a missing date is the ordinary state of a
    // nineteenth-century record, not a defect to be marked as one.
    expect(
      formatQualifiedDate(
        qd({ date: null, qualifier: "about", precision: "year" }),
      ),
    ).toBeNull();
    expect(formatQualifiedDate(qd({ date: null }))).toBeNull();
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
        expect(formatQualifiedDate(qd({ date: "1912-03-01" }))).toBe(
          "1 March 1912",
        );
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("falls back to the stored string rather than printing Invalid Date", () => {
    // Nothing should ever put this in the column, but "Invalid Date" tells a
    // reader nothing about what the row actually holds.
    expect(formatQualifiedDate(qd({ date: "not-a-date" }))).toBe("not-a-date");
  });

  describe("precision", () => {
    it("shows only as much of the date as was recorded", () => {
      // The whole point of the `date_precision` column (E4-T2, `YEO-39`). A
      // year read off a headstone is stored on 1 January because a `date`
      // column has to hold a day, and printing that day back would be
      // inventing a fact and then attributing it to the author.
      expect(
        formatQualifiedDate(qd({ date: "1912-01-01", precision: "year" })),
      ).toBe("1912");
      expect(
        formatQualifiedDate(qd({ date: "1912-03-01", precision: "month" })),
      ).toBe("March 1912");
      expect(
        formatQualifiedDate(qd({ date: "1912-03-12", precision: "day" })),
      ).toBe("12 March 1912");
    });

    it("keeps the qualifier in front of a coarse date", () => {
      expect(
        formatQualifiedDate(
          qd({ date: "1890-01-01", qualifier: "about", precision: "year" }),
        ),
      ).toBe("about 1890");
      expect(
        formatQualifiedDate(
          qd({ date: "1920-01-01", qualifier: "before", precision: "year" }),
        ),
      ).toBe("before 1920");
      expect(
        formatQualifiedDate(
          qd({ date: "1890-03-01", qualifier: "after", precision: "month" }),
        ),
      ).toBe("after March 1890");
    });

    it("never prints the anchor day of a coarse date", () => {
      // The regression this module was consolidated to make unrepeatable. The
      // anchor is always 1 January or the 1st of the month, so "1 January"
      // and "1 " appearing in the output is precisely the failure: a day the
      // author never typed, printed in the voice of one they did.
      for (const qualifier of ["exact", "about", "before", "after"] as const) {
        expect(
          formatQualifiedDate(
            qd({ date: "1890-01-01", qualifier, precision: "year" }),
          ),
        ).not.toMatch(/January/);
        expect(
          formatQualifiedDate(
            qd({ date: "1890-06-01", qualifier, precision: "month" }),
          ),
        ).not.toMatch(/\b1\b/);
      }
    });
  });

  describe("ranges (YEO-88)", () => {
    it("renders between the two endpoints, each at its own precision", () => {
      expect(
        formatQualifiedDate(
          qd({
            date: "1890-01-01",
            precision: "year",
            upper: "1900-01-01",
            upperPrecision: "year",
          }),
        ),
      ).toBe("between 1890 and 1900");
    });

    it("keeps a mixed-precision range honest — the case that proves precision doubled", () => {
      expect(
        formatQualifiedDate(
          qd({
            date: "1890-03-01",
            precision: "month",
            upper: "1900-01-01",
            upperPrecision: "year",
          }),
        ),
      ).toBe("between March 1890 and 1900");
    });

    it("renders a day-precision range on both ends", () => {
      expect(
        formatQualifiedDate(
          qd({
            date: "1912-03-12",
            precision: "day",
            upper: "1918-07-04",
            upperPrecision: "day",
          }),
        ),
      ).toBe("between 12 March 1912 and 4 July 1918");
    });

    it("never renders a range as a bare single date", () => {
      const ranges = [
        qd({
          date: "1890-01-01",
          precision: "year",
          upper: "1900-01-01",
          upperPrecision: "year",
        }),
        qd({
          date: "1890-03-01",
          precision: "month",
          upper: "1900-01-01",
          upperPrecision: "year",
        }),
        qd({
          date: "1912-03-12",
          precision: "day",
          upper: "1918-07-04",
          upperPrecision: "day",
        }),
      ];

      for (const value of ranges) {
        const shown = formatQualifiedDate(value);
        expect(shown).not.toBe("1890");
        expect(shown).not.toBe("after 1890");
        expect(shown).toContain("between");
      }
    });

    it("renders an illegal-but-representable row honestly, leaving the refusal to the validator", () => {
      // `validateIndividual`/`validateUnion` are the gate that keeps a
      // non-`exact` qualifier beside a non-null upper from ever being
      // written — but a hand-made `INSERT` can still produce one, and this
      // function renders it rather than hiding a word.
      expect(
        formatQualifiedDate(
          qd({
            qualifier: "about",
            date: "1890-01-01",
            precision: "year",
            upper: "1900-01-01",
            upperPrecision: "year",
          }),
        ),
      ).toBe("about between 1890 and 1900");
    });

    it("renders a malformed upper bound verbatim, on the upper side only", () => {
      expect(
        formatQualifiedDate(
          qd({
            date: "1890-01-01",
            precision: "year",
            upper: "not-a-date",
            upperPrecision: "year",
          }),
        ),
      ).toBe("between 1890 and not-a-date");
    });
  });
});

describe("formatLifespan", () => {
  it.each([
    ["1901-03-04", "1935-08-09", "1901–1935"],
    ["1910-05-05", null, "b. 1910"],
    [null, "1988-02-02", "d. 1988"],
    [null, null, ""],
  ])("renders (%s, %s) as %s", (birthDate, deathDate, expected) => {
    // Genealogy data is full of half-known lives, so every combination has to
    // read as something rather than as a dangling dash.
    expect(formatLifespan(lifespan({ birthDate, deathDate }))).toBe(expected);
  });

  it("renders nothing at all when neither date is recorded", () => {
    // Not "unknown", not "—", not "?". An empty string is what lets every
    // caller write `lifespan ? ... : null` and omit the element entirely.
    expect(formatLifespan(lifespan())).toBe("");
  });

  it("uses an en dash between the years, not a hyphen", () => {
    expect(
      formatLifespan(
        lifespan({ birthDate: "1901-03-04", deathDate: "1935-08-09" }),
      ),
    ).toContain("–");
  });

  describe("qualifiers", () => {
    it("says a birth is approximate rather than asserting the year", () => {
      // `b. 1890` and `b. about 1890` are different claims. Dropping the
      // qualifier here promoted a guess to a fact on the single most-read
      // surface in the application.
      expect(
        formatLifespan(
          lifespan({ birthDate: "1890-01-01", birthDateQualifier: "about" }),
        ),
      ).toBe("b. about 1890");
    });

    it("says a death is bounded rather than dated", () => {
      expect(
        formatLifespan(
          lifespan({ deathDate: "1920-01-01", deathDateQualifier: "before" }),
        ),
      ).toBe("d. before 1920");
    });

    it("leaves an exact span completely unadorned", () => {
      expect(
        formatLifespan(
          lifespan({ birthDate: "1890-04-02", deathDate: "1962-11-30" }),
        ),
      ).toBe("1890–1962");
    });

    it("keeps both qualifiers when both dates are known", () => {
      // Longer than the bare span, and true. The node truncates; it does not
      // get to drop the half of the record that says how much to trust it.
      expect(
        formatLifespan(
          lifespan({
            birthDate: "1890-01-01",
            birthDateQualifier: "about",
            deathDate: "1962-01-01",
            deathDateQualifier: "before",
          }),
        ),
      ).toBe("about 1890–before 1962");
    });

    it.each([
      ["about", "b. about 1890"],
      ["before", "b. before 1890"],
      ["after", "b. after 1890"],
      ["exact", "b. 1890"],
    ] as const)("renders a %s birth", (birthDateQualifier, expected) => {
      expect(
        formatLifespan(
          lifespan({ birthDate: "1890-01-01", birthDateQualifier }),
        ),
      ).toBe(expected);
    });
  });

  describe("precision", () => {
    it("reads the same year out of a date at every precision", () => {
      // Why this function takes no `DatePrecision` and is not thereby making
      // the mistake `formatQualifiedDate`'s required parameter exists to
      // prevent. The anchor convention puts the year in the same four
      // characters whether the source gave a day, a month or a year, so the
      // year is the one part that is always genuinely recorded.
      const year = "1890";
      for (const birthDate of ["1890-01-01", "1890-06-01", "1890-06-14"]) {
        expect(formatLifespan(lifespan({ birthDate }))).toBe(`b. ${year}`);
      }
    });

    it("never leaks the anchor day into the label", () => {
      expect(
        formatLifespan(
          lifespan({
            birthDate: "1890-01-01",
            birthDateQualifier: "about",
            deathDate: "1962-01-01",
          }),
        ),
      ).not.toMatch(/January|\b1\b/);
    });
  });

  describe("ranges (YEO-88)", () => {
    it("labels both dates when the birth is a range and the death is not", () => {
      expect(
        formatLifespan(
          lifespan({
            birthDate: "1890-01-01",
            birthDateUpper: "1900-01-01",
            deathDate: "1962-01-01",
          }),
        ),
      ).toBe("b. 1890–1900, d. 1962");
    });

    it("labels both dates when the death is a range and the birth is not", () => {
      expect(
        formatLifespan(
          lifespan({
            birthDate: "1890-01-01",
            deathDate: "1950-01-01",
            deathDateUpper: "1955-01-01",
          }),
        ),
      ).toBe("b. 1890, d. 1950–1955");
    });

    it("labels both dates when both are ranges", () => {
      expect(
        formatLifespan(
          lifespan({
            birthDate: "1890-01-01",
            birthDateUpper: "1895-01-01",
            deathDate: "1950-01-01",
            deathDateUpper: "1955-01-01",
          }),
        ),
      ).toBe("b. 1890–1895, d. 1950–1955");
    });

    it("labels a ranged birth alone", () => {
      expect(
        formatLifespan(
          lifespan({ birthDate: "1890-01-01", birthDateUpper: "1900-01-01" }),
        ),
      ).toBe("b. 1890–1900");
    });

    it("keeps the compact form when neither date is a range — the regression guard", () => {
      expect(
        formatLifespan(
          lifespan({ birthDate: "1890-01-01", deathDate: "1962-01-01" }),
        ),
      ).toBe("1890–1962");
    });
  });
});

/**
 * The year alone, extracted for E11-T5's infobox: Wikipedia writes a union as
 * "m. 1933; died 1947" beside a name, where the full dates would be a record
 * rather than a summary.
 */
describe("formatQualifiedYear", () => {
  it("gives the year, with no anchor day and no month", () => {
    expect(
      formatQualifiedYear({
        date: "1933-02-11",
        qualifier: "exact",
        upper: null,
      }),
    ).toBe("1933");
    expect(
      formatQualifiedYear({
        date: "1948-01-01",
        qualifier: "exact",
        upper: null,
      }),
    ).toBe("1948");
  });

  it("keeps the qualifier, because a guess is not a fact", () => {
    expect(
      formatQualifiedYear({
        date: "1948-07-03",
        qualifier: "about",
        upper: null,
      }),
    ).toBe("about 1948");
    expect(
      formatQualifiedYear({
        date: "1920-01-01",
        qualifier: "before",
        upper: null,
      }),
    ).toBe("before 1920");
    expect(
      formatQualifiedYear({
        date: "1890-06-14",
        qualifier: "after",
        upper: null,
      }),
    ).toBe("after 1890");
  });

  it("is null when there is no date, never a dash or a word", () => {
    expect(
      formatQualifiedYear({ date: null, qualifier: "exact", upper: null }),
    ).toBeNull();
    expect(
      formatQualifiedYear({ date: null, qualifier: "about", upper: null }),
    ).toBeNull();
  });

  it("reads the same year whatever precision the date was stored at", () => {
    // A year-precision date is anchored to 1 January and a day-precision one
    // is not, and this returns the four characters both of them genuinely
    // recorded — which is why it needs no `precision` argument where
    // `formatQualifiedDate` requires one.
    for (const date of ["1908-01-01", "1908-05-01", "1908-05-30"]) {
      expect(
        formatQualifiedYear({ date, qualifier: "exact", upper: null }),
      ).toBe("1908");
    }
  });

  describe("ranges (YEO-88)", () => {
    it("renders a range as two years joined by an en dash", () => {
      expect(
        formatQualifiedYear({
          date: "1890-03-01",
          qualifier: "exact",
          upper: "1900-01-01",
        }),
      ).toBe("1890–1900");
    });

    it("collapses a same-year range to one year — it says nothing a bare year does not", () => {
      expect(
        formatQualifiedYear({
          date: "1890-03-01",
          qualifier: "exact",
          upper: "1890-06-01",
        }),
      ).toBe("1890");
    });
  });
});
