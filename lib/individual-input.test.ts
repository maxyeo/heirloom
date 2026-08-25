import { describe, expect, it } from "vitest";

import {
  DATE_QUALIFIERS,
  fieldErrorsFrom,
  type IndividualFields,
  type IndividualInput,
  individualInputFromFormData,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  SEXES,
  validateIndividual,
} from "@/lib/individual-input";

/**
 * `validateIndividual` is the module every other E3 ticket and E6's import
 * write through, so these tests are the specification of what it accepts
 * rather than a sample of it. No database and no request: the whole point of
 * the module is that it needs neither. See docs/testing.md.
 */

/** The smallest input that passes, for tests that vary one field. */
const MINIMAL: IndividualInput = { givenName: "Ada" };

/** The cleaned record `MINIMAL` produces, with every default settled. */
const MINIMAL_FIELDS: IndividualFields = {
  givenName: "Ada",
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
};

/** Assert success and hand back the value, so tests need no `ok` guard. */
function expectValid(input: IndividualInput): IndividualFields {
  const result = validateIndividual(input);
  if (!result.ok) {
    throw new Error(
      `Expected valid, got: ${result.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
    );
  }
  return result.value;
}

/** Assert failure and hand back the fields that were faulted. */
function expectInvalid(input: IndividualInput): string[] {
  const result = validateIndividual(input);
  if (result.ok) throw new Error("Expected invalid, but validation passed.");
  return result.issues.map((issue) => issue.field);
}

describe("validateIndividual", () => {
  it("accepts a person with nothing but a given name", () => {
    expect(expectValid(MINIMAL)).toEqual(MINIMAL_FIELDS);
  });

  it("accepts a fully specified person unchanged", () => {
    const fields = expectValid({
      givenName: "Ada",
      surname: "Lovelace",
      sex: "female",
      birthDate: "1815-12-10",
      birthDateQualifier: "exact",
      birthDatePrecision: "day",
      birthPlace: "London",
      deathDate: "1852-11-27",
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
      deathPlace: "Marylebone",
      notes: "Countess of Lovelace.",
      portraitKey: null,
      portraitThumbKey: null,
    });

    expect(fields).toEqual({
      givenName: "Ada",
      surname: "Lovelace",
      sex: "female",
      birthDate: "1815-12-10",
      birthDateQualifier: "exact",
      birthDatePrecision: "day",
      birthDateUpper: null,
      birthDateUpperPrecision: "day",
      birthPlace: "London",
      deathDate: "1852-11-27",
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
      deathDateUpper: null,
      deathDateUpperPrecision: "day",
      deathPlace: "Marylebone",
      notes: "Countess of Lovelace.",
      portraitKey: null,
      portraitThumbKey: null,
    });
  });

  describe("the given name", () => {
    it("is required", () => {
      expect(expectInvalid({})).toEqual(["givenName"]);
    });

    it("treats whitespace as absent, so a form of spaces is refused", () => {
      expect(expectInvalid({ givenName: "   " })).toEqual(["givenName"]);
    });

    it("is trimmed", () => {
      expect(expectValid({ givenName: "  Ada  " }).givenName).toBe("Ada");
    });

    it("is refused past the length limit", () => {
      expect(
        expectValid({ givenName: "a".repeat(MAX_NAME_LENGTH) }),
      ).toBeTruthy();
      expect(
        expectInvalid({ givenName: "a".repeat(MAX_NAME_LENGTH + 1) }),
      ).toEqual(["givenName"]);
    });

    it("refuses a value that is not text at all", () => {
      // What `FormData.get` returns for a file input, and what a hand-made
      // POST can send. Without this it would be stored as "[object Object]".
      expect(expectInvalid({ givenName: { toString: () => "Ada" } })).toEqual([
        "givenName",
      ]);
      expect(expectInvalid({ givenName: 42 })).toEqual(["givenName"]);
    });
  });

  describe("optional text", () => {
    it("stores blank as null rather than as an empty string", () => {
      // An HTML form posts every field it contains, so an untouched optional
      // input arrives as "". Storing that would give "unknown" two spellings.
      const fields = expectValid({
        givenName: "Ada",
        surname: "",
        birthPlace: "   ",
        deathPlace: "",
        notes: "",
        portraitKey: null,
        portraitThumbKey: null,
      });

      expect(fields.surname).toBeNull();
      expect(fields.birthPlace).toBeNull();
      expect(fields.deathPlace).toBeNull();
      expect(fields.notes).toBeNull();
    });

    it("trims what is there", () => {
      expect(expectValid({ ...MINIMAL, surname: " Lovelace " }).surname).toBe(
        "Lovelace",
      );
    });

    it("holds notes to a shorter limit than a wiki entry would", () => {
      expect(
        expectInvalid({ ...MINIMAL, notes: "n".repeat(MAX_NOTES_LENGTH + 1) }),
      ).toEqual(["notes"]);
    });
  });

  describe("sex", () => {
    it("defaults to unknown when absent or blank", () => {
      expect(expectValid(MINIMAL).sex).toBe("unknown");
      expect(expectValid({ ...MINIMAL, sex: "" }).sex).toBe("unknown");
    });

    it.each([...SEXES])("accepts %s", (value) => {
      expect(expectValid({ ...MINIMAL, sex: value }).sex).toBe(value);
    });

    it("refuses a value outside the enum", () => {
      // A value the database enum would reject, which reaches Postgres as a
      // thrown error rather than as a message anybody can act on.
      expect(expectInvalid({ ...MINIMAL, sex: "Female" })).toEqual(["sex"]);
      expect(expectInvalid({ ...MINIMAL, sex: "m" })).toEqual(["sex"]);
    });
  });

  describe("date qualifiers", () => {
    it("defaults to exact", () => {
      expect(
        expectValid({ ...MINIMAL, birthDate: "1815-12-10" }),
      ).toHaveProperty("birthDateQualifier", "exact");
    });

    it.each([...DATE_QUALIFIERS])("accepts %s beside a date", (qualifier) => {
      const fields = expectValid({
        ...MINIMAL,
        birthDate: "1815-12-10",
        birthDateQualifier: qualifier,
      });
      expect(fields.birthDateQualifier).toBe(qualifier);
    });

    it("refuses a value outside the enum", () => {
      expect(
        expectInvalid({ ...MINIMAL, birthDateQualifier: "circa" }),
      ).toEqual(["birthDateQualifier"]);
    });

    it("normalises a qualifier with no date beside it back to exact", () => {
      // The schema's note: a qualifier is only ever read alongside its date,
      // so "about" next to a null date is a second way of saying nothing —
      // and one that would export as a stray GEDCOM `ABT`.
      const fields = expectValid({
        ...MINIMAL,
        birthDateQualifier: "about",
        birthDatePrecision: "day",
        deathDateQualifier: "before",
        deathDatePrecision: "day",
      });

      expect(fields.birthDateQualifier).toBe("exact");
      expect(fields.deathDateQualifier).toBe("exact");
    });
  });

  describe("dates", () => {
    it("accepts ISO YYYY-MM-DD, which is what a date input submits", () => {
      expect(
        expectValid({ ...MINIMAL, birthDate: "1815-12-10" }).birthDate,
      ).toBe("1815-12-10");
    });

    it("accepts a leap day in a leap year", () => {
      expect(
        expectValid({ ...MINIMAL, birthDate: "2024-02-29" }).birthDate,
      ).toBe("2024-02-29");
    });

    it.each([
      ["a day the calendar does not have", "2023-02-30"],
      ["a leap day in a common year", "2023-02-29"],
      ["a month past December", "1890-13-01"],
      ["a zero month", "1890-00-10"],
      ["a zero day", "1890-01-00"],
      ["year zero", "0000-01-01"],
      ["a two-digit year", "90-01-01"],
      ["a year on its own", "1890"],
      ["a year and month", "1890-04"],
      ["a written date", "12 April 1890"],
      ["a GEDCOM date", "ABT 1890"],
      ["a slashed date", "12/04/1890"],
      ["an unpadded month", "1890-4-12"],
      ["a timestamp", "1890-04-12T00:00:00Z"],
      ["trailing text", "1890-04-12x"],
    ])("refuses %s", (_name, value) => {
      expect(expectInvalid({ ...MINIMAL, birthDate: value })).toEqual([
        "birthDate",
      ]);
    });

    it("treats a blank date as unknown rather than as an error", () => {
      const fields = expectValid({
        ...MINIMAL,
        birthDate: "",
        deathDate: "  ",
      });
      expect(fields.birthDate).toBeNull();
      expect(fields.deathDate).toBeNull();
    });
  });

  describe("death not before birth", () => {
    it("refuses a death before a birth when both are exact", () => {
      expect(
        expectInvalid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          deathDate: "1889-12-31",
        }),
      ).toEqual(["deathDate"]);
    });

    it("reports it against the death date, which is the field to change", () => {
      const result = validateIndividual({
        ...MINIMAL,
        birthDate: "1890-01-01",
        deathDate: "1889-12-31",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues[0].field).toBe("deathDate");
      expect(result.issues[0].message).toMatch(/before the birth date/i);
    });

    it("allows a death on the day of birth", () => {
      // An infant who lived hours is a record a family wiki has to hold.
      const fields = expectValid({
        ...MINIMAL,
        birthDate: "1890-01-01",
        deathDate: "1890-01-01",
      });
      expect(fields.deathDate).toBe("1890-01-01");
    });

    it("allows an ordinary lifetime", () => {
      expect(
        expectValid({
          ...MINIMAL,
          birthDate: "1815-12-10",
          deathDate: "1852-11-27",
        }).deathDate,
      ).toBe("1852-11-27");
    });

    it("does not fire when either date is only approximate", () => {
      // "born about 1890, died 1889" reads as "born around 1889 or 1890" to
      // any genealogist. Rejecting it would require inventing a tolerance.
      expect(
        expectValid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          birthDateQualifier: "about",
          birthDatePrecision: "day",
          deathDate: "1889-12-01",
        }).deathDate,
      ).toBe("1889-12-01");

      expect(
        expectValid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          deathDate: "1889-12-01",
          deathDateQualifier: "about",
          deathDatePrecision: "day",
        }).deathDate,
      ).toBe("1889-12-01");
    });

    it("reads a year-only date as the whole year, not as 1 January", () => {
      // The case a `date_precision` column exists for (E4-T2, `YEO-39`). A
      // year is stored on the first of January because Postgres needs a day,
      // so comparing the stored days alone would refuse a woman born in June
      // 1890 who died later the same year — the death's anchor reads as five
      // months before her birth.
      expect(
        expectValid({
          ...MINIMAL,
          birthDate: "1890-06-01",
          deathDate: "1890-01-01",
          deathDatePrecision: "year",
        }).deathDate,
      ).toBe("1890-01-01");

      // And the other side of it: a year genuinely earlier is still refused,
      // so widening the anchor has not turned the rule off.
      expect(
        expectInvalid({
          ...MINIMAL,
          birthDate: "1890-06-01",
          deathDate: "1889-01-01",
          deathDatePrecision: "year",
        }),
      ).toEqual(["deathDate"]);
    });

    it("does not fire when the qualifiers leave room for an overlap", () => {
      // Born *before* 1890 and died 1889: entirely consistent.
      expect(
        expectValid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          birthDateQualifier: "before",
          birthDatePrecision: "day",
          deathDate: "1889-12-01",
        }).deathDate,
      ).toBe("1889-12-01");

      // Died *after* 1889 and born 1890: also consistent.
      expect(
        expectValid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          deathDate: "1889-12-01",
          deathDateQualifier: "after",
          deathDatePrecision: "day",
        }).deathDate,
      ).toBe("1889-12-01");
    });

    it("still fires when the qualifiers cannot rescue the order", () => {
      // Born *after* 1890 and died *before* 1889: no reading overlaps.
      expect(
        expectInvalid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          birthDateQualifier: "after",
          birthDatePrecision: "day",
          deathDate: "1889-01-01",
          deathDateQualifier: "before",
          deathDatePrecision: "day",
        }),
      ).toEqual(["deathDate"]);
    });

    it("stays quiet when a date could not be read, so one fault is one message", () => {
      // The ordering rule would otherwise report a second problem caused
      // entirely by the first, sending the author to the wrong field.
      expect(
        expectInvalid({
          ...MINIMAL,
          birthDate: "1890-13-45",
          deathDate: "1889-01-01",
        }),
      ).toEqual(["birthDate"]);
    });
  });

  it("reports every problem at once rather than stopping at the first", () => {
    // An author fixing a form should see everything wrong with it in one pass.
    const fields = expectInvalid({
      givenName: "",
      sex: "yes",
      birthDate: "not a date",
      notes: "n".repeat(MAX_NOTES_LENGTH + 1),
    });

    expect(fields).toEqual(["givenName", "sex", "birthDate", "notes"]);
  });

  it("never returns a value alongside issues", () => {
    const result = validateIndividual({});
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });

  it("ignores a field it does not own, so a stray form input cannot be written", () => {
    // `pageId` is E2's to set. A person form that posted one must not be able
    // to re-point somebody's wiki entry.
    // `Object.assign` rather than a literal with a cast: an extra property is
    // exactly what an untrusted POST sends, and TypeScript's excess-property
    // check would reject the literal before the test could make its point.
    const input: IndividualInput = { ...MINIMAL };
    Object.assign(input, { pageId: "00000000-0000-4000-8000-000000000001" });

    const fields = expectValid(input);

    expect(fields).not.toHaveProperty("pageId");
    expect(fields).toEqual(MINIMAL_FIELDS);
  });

  describe("date ranges (YEO-88)", () => {
    it("accepts a range's upper bound and its own precision", () => {
      const fields = expectValid({
        ...MINIMAL,
        birthDate: "1890-03-01",
        birthDatePrecision: "month",
        birthDateUpper: "1900-01-01",
        birthDateUpperPrecision: "year",
      });

      expect(fields.birthDateUpper).toBe("1900-01-01");
      expect(fields.birthDateUpperPrecision).toBe("year");
    });

    it("refuses a non-exact qualifier beside a non-null upper bound", () => {
      // A stored range's qualifier is always `exact` (`db/schema.ts`) — the
      // qualifier describes the whole date expression, not either endpoint.
      expect(
        expectInvalid({
          ...MINIMAL,
          birthDate: "1890-01-01",
          birthDateQualifier: "about",
          birthDateUpper: "1900-01-01",
        }),
      ).toEqual(["birthDateUpper"]);
    });

    it("refuses an inverted range, reported against the upper-bound field", () => {
      expect(
        expectInvalid({
          ...MINIMAL,
          birthDate: "1900-01-01",
          birthDateUpper: "1890-01-01",
        }),
      ).toEqual(["birthDateUpper"]);
    });

    it("normalises an upper bound to null when there is no lower date", () => {
      const fields = expectValid({
        ...MINIMAL,
        birthDateUpper: "1900-01-01",
        birthDateUpperPrecision: "year",
      });

      expect(fields.birthDate).toBeNull();
      expect(fields.birthDateUpper).toBeNull();
      expect(fields.birthDateUpperPrecision).toBe("day");
    });

    it("normalises the upper precision to day beside a null upper bound", () => {
      const fields = expectValid({
        ...MINIMAL,
        birthDate: "1890-01-01",
        birthDateUpperPrecision: "year",
      });

      expect(fields.birthDateUpper).toBeNull();
      expect(fields.birthDateUpperPrecision).toBe("day");
    });

    it("refuses the same rules on the death date", () => {
      expect(
        expectInvalid({
          ...MINIMAL,
          deathDate: "1900-01-01",
          deathDateUpper: "1890-01-01",
        }),
      ).toEqual(["deathDateUpper"]);

      expect(
        expectInvalid({
          ...MINIMAL,
          deathDate: "1890-01-01",
          deathDateQualifier: "before",
          deathDateUpper: "1900-01-01",
        }),
      ).toEqual(["deathDateUpper"]);
    });

    describe("isImpossibleOrder against a range", () => {
      it("refuses a birth after a death range's upper bound — the collapsed reading could never catch this", () => {
        // Under the collapse this ticket reversed, `BET 1890 AND 1900`
        // stored as `after 1890` has an unbounded `latest`, so "born 1950,
        // died between 1890 and 1900" could never be refused. Stored whole,
        // `latest` is 1900-12-31, and the refusal is exactly what a
        // genealogist would expect.
        expect(
          expectInvalid({
            ...MINIMAL,
            birthDate: "1950-01-01",
            deathDate: "1890-01-01",
            deathDateUpper: "1900-01-01",
          }),
        ).toEqual(["deathDate"]);
      });

      it("accepts a birth range that could overlap a later death", () => {
        expect(
          expectValid({
            ...MINIMAL,
            birthDate: "1890-01-01",
            birthDateUpper: "1900-01-01",
            deathDate: "1895-01-01",
          }).deathDate,
        ).toBe("1895-01-01");
      });

      it("refuses a death before every possible reading of a birth range", () => {
        expect(
          expectInvalid({
            ...MINIMAL,
            birthDate: "1890-01-01",
            birthDateUpper: "1900-01-01",
            deathDate: "1889-01-01",
          }),
        ).toEqual(["deathDate"]);
      });

      it("accepts a death range that could overlap a birth", () => {
        expect(
          expectValid({
            ...MINIMAL,
            birthDate: "1890-01-01",
            deathDate: "1889-01-01",
            deathDateUpper: "1895-01-01",
          }).deathDate,
        ).toBe("1889-01-01");
      });
    });
  });

  /**
   * The two portrait keys (E5-T4, `YEO-44`). Nobody types these — they arrive
   * from the upload endpoint through a hidden input — so what is checked here
   * is the same three-way contract `lib/portrait.ts`'s `readPortraitKey`
   * promises: a good key survives, a bad one is an issue, and the
   * thumbnail-with-no-portrait state is normalised away exactly as a date
   * qualifier with no date is.
   */
  describe("the portrait", () => {
    const KEY = "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";
    const THUMB = "images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp";

    it("survives a good portrait key pair unchanged", () => {
      const fields = expectValid({
        ...MINIMAL,
        portraitKey: KEY,
        portraitThumbKey: THUMB,
      });

      expect(fields.portraitKey).toBe(KEY);
      expect(fields.portraitThumbKey).toBe(THUMB);
    });

    it("reports a bad key as an issue on the field it arrived on", () => {
      expect(
        expectInvalid({ ...MINIMAL, portraitKey: "not-an-image-key" }),
      ).toEqual(["portraitKey"]);
      expect(
        expectInvalid({ ...MINIMAL, portraitThumbKey: "not-an-image-key" }),
      ).toEqual(["portraitThumbKey"]);
    });

    it("normalises a thumbnail with no portrait beside it to null, both fields", () => {
      // A thumbnail of nothing is a second way of saying "no portrait", and
      // one that would leave a file referenced by a column nothing renders.
      const fields = expectValid({ ...MINIMAL, portraitThumbKey: THUMB });

      expect(fields.portraitKey).toBeNull();
      expect(fields.portraitThumbKey).toBeNull();
    });

    it("treats a blank string as no portrait, for both fields", () => {
      const fields = expectValid({
        ...MINIMAL,
        portraitKey: "",
        portraitThumbKey: "",
      });

      expect(fields.portraitKey).toBeNull();
      expect(fields.portraitThumbKey).toBeNull();
    });
  });
});

describe("fieldErrorsFrom", () => {
  it("keys messages by field", () => {
    const result = validateIndividual({ givenName: "", sex: "yes" });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const errors = fieldErrorsFrom(result.issues);
    expect(Object.keys(errors).sort()).toEqual(["givenName", "sex"]);
    expect(errors.givenName).toMatch(/first name/i);
  });

  it("keeps the first message for a field rather than stacking them", () => {
    const errors = fieldErrorsFrom([
      { field: "givenName", message: "First." },
      { field: "givenName", message: "Second." },
    ]);

    expect(errors.givenName).toBe("First.");
  });

  it("is empty for no issues", () => {
    expect(fieldErrorsFrom([])).toEqual({});
  });
});

describe("individualInputFromFormData", () => {
  it("reads the fields under the names IndividualFields uses", () => {
    const form = new FormData();
    form.set("givenName", "Ada");
    form.set("surname", "Lovelace");
    form.set("sex", "female");
    form.set("birthDate", "1815-12-10");
    form.set("birthDateQualifier", "about");
    form.set("birthPlace", "London");
    form.set("deathDate", "1852-11-27");
    form.set("deathDateQualifier", "exact");
    form.set("deathPlace", "Marylebone");
    form.set("notes", "Countess of Lovelace.");

    expect(expectValid(individualInputFromFormData(form))).toEqual({
      givenName: "Ada",
      surname: "Lovelace",
      sex: "female",
      birthDate: "1815-12-10",
      birthDateQualifier: "about",
      birthDatePrecision: "day",
      birthDateUpper: null,
      birthDateUpperPrecision: "day",
      birthPlace: "London",
      deathDate: "1852-11-27",
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
      deathDateUpper: null,
      deathDateUpperPrecision: "day",
      deathPlace: "Marylebone",
      notes: "Countess of Lovelace.",
      portraitKey: null,
      portraitThumbKey: null,
    });
  });

  it("reads both portrait fields (E5-T4, YEO-44)", () => {
    const form = new FormData();
    form.set("givenName", "Ada");
    form.set(
      "portraitKey",
      "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg",
    );
    form.set(
      "portraitThumbKey",
      "images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp",
    );

    const fields = expectValid(individualInputFromFormData(form));
    expect(fields.portraitKey).toBe(
      "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg",
    );
    expect(fields.portraitThumbKey).toBe(
      "images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp",
    );
  });

  it("reads a range's upper bound and its precision (YEO-88)", () => {
    // The highest-consequence guard in this ticket: if this field were left
    // out, every edit-form save would silently drop the upper bound.
    const form = new FormData();
    form.set("givenName", "Ada");
    form.set("birthDate", "1890-01-01");
    form.set("birthDateUpper", "1900-01-01");
    form.set("birthDateUpperPrecision", "year");

    const fields = expectValid(individualInputFromFormData(form));
    expect(fields.birthDateUpper).toBe("1900-01-01");
    expect(fields.birthDateUpperPrecision).toBe("year");
  });

  it("passes a missing field through as absent, not as a string", () => {
    const form = new FormData();
    form.set("givenName", "Ada");

    expect(expectValid(individualInputFromFormData(form))).toEqual(
      MINIMAL_FIELDS,
    );
  });

  it("hands a posted file to validation rather than coercing it to text", () => {
    // Without this the name column would receive the string "[object File]".
    const form = new FormData();
    form.set("givenName", new File(["x"], "name.txt"));

    expect(expectInvalid(individualInputFromFormData(form))).toEqual([
      "givenName",
    ]);
  });

  it("ignores form fields that are not a person's, such as the update id", () => {
    // `updateIndividualAction` posts a hidden `id`; it is a reference, not a
    // column this module writes.
    const form = new FormData();
    form.set("givenName", "Ada");
    form.set("id", "00000000-0000-4000-8000-000000000001");

    expect(individualInputFromFormData(form)).not.toHaveProperty("id");
  });
});
