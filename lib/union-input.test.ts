import { describe, expect, it } from "vitest";

import { MAX_NOTES_LENGTH } from "@/lib/field-input";
import {
  type AddSpouseInput,
  addSpouseInputFromFormData,
  MAX_UNION_SEQUENCE,
  PARTNER_MODES,
  UNION_END_REASONS,
  UNION_TYPES,
  type UnionFields,
  unionFieldErrorsFrom,
  type UnionInput,
  unionInputFromFormData,
  validateAddSpouse,
  validateUnion,
} from "@/lib/union-input";

/**
 * `validateUnion` and `validateAddSpouse` are what every E3 union flow and
 * E6's GEDCOM import will write through, so these tests are the specification
 * of what they accept rather than a sample of it. No database and no request:
 * the whole point of the module is that it needs neither. See docs/testing.md.
 */

/** Two ids that are shaped like the `uuid` primary keys the schema uses. */
const ROSE = "11111111-2222-4333-8444-555555555555";
const THOMAS = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const WALTER = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

/** The smallest input that passes, for tests that vary one field. */
const MINIMAL: UnionInput = { partnerAId: ROSE, partnerBId: THOMAS };

/** The cleaned record `MINIMAL` produces, with every default settled. */
const MINIMAL_FIELDS: UnionFields = {
  partnerAId: ROSE,
  partnerBId: THOMAS,
  type: "unknown",
  startDate: null,
  startDateQualifier: "exact",
  startDatePrecision: "day",
  startDateUpper: null,
  startDateUpperPrecision: "day",
  endDate: null,
  endDateQualifier: "exact",
  endDatePrecision: "day",
  endDateUpper: null,
  endDateUpperPrecision: "day",
  endReason: "ongoing",
  sequence: null,
  notes: null,
};

/** Assert success and hand back the value, so tests need no `ok` guard. */
function expectValid(input: UnionInput): UnionFields {
  const result = validateUnion(input);
  if (!result.ok) {
    throw new Error(
      `Expected valid, got: ${result.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
    );
  }
  return result.value;
}

/** Assert failure and hand back the fields that were faulted. */
function expectInvalid(input: UnionInput): string[] {
  const result = validateUnion(input);
  if (result.ok) throw new Error("Expected invalid, but validation passed.");
  return result.issues.map((issue) => issue.field);
}

describe("validateUnion", () => {
  it("accepts a union with nothing but two partners", () => {
    expect(expectValid(MINIMAL)).toEqual(MINIMAL_FIELDS);
  });

  it("accepts a fully specified union unchanged", () => {
    expect(
      expectValid({
        partnerAId: ROSE,
        partnerBId: THOMAS,
        type: "marriage",
        startDate: "1912-06-04",
        startDateQualifier: "about",
        startDatePrecision: "day",
        endDate: "1938-02-19",
        endDateQualifier: "exact",
        endDatePrecision: "day",
        endReason: "death",
        sequence: 2,
        notes: "Married at St Anne's.",
      }),
    ).toEqual({
      partnerAId: ROSE,
      partnerBId: THOMAS,
      type: "marriage",
      startDate: "1912-06-04",
      startDateQualifier: "about",
      startDatePrecision: "day",
      startDateUpper: null,
      startDateUpperPrecision: "day",
      endDate: "1938-02-19",
      endDateQualifier: "exact",
      endDatePrecision: "day",
      endDateUpper: null,
      endDateUpperPrecision: "day",
      endReason: "death",
      sequence: 2,
      notes: "Married at St Anne's.",
    });
  });

  it.each(UNION_TYPES)("accepts %s as a type", (type) => {
    expect(expectValid({ ...MINIMAL, type }).type).toBe(type);
  });

  it.each(UNION_END_REASONS)("accepts %s as an end reason", (endReason) => {
    expect(expectValid({ ...MINIMAL, endReason }).endReason).toBe(endReason);
  });
});

describe("the partners", () => {
  /**
   * The unknown-parent case docs/architecture.md builds the whole model
   * around: you never have to invent a placeholder person.
   */
  it.each([
    ["only A", { partnerAId: ROSE, partnerBId: null }],
    ["only B", { partnerAId: null, partnerBId: THOMAS }],
    ["A with B absent", { partnerAId: ROSE }],
  ])("accepts a union with %s", (_case, input) => {
    expect(validateUnion(input).ok).toBe(true);
  });

  it("treats a blank partner id as unrecorded rather than as a mistake", () => {
    expect(expectValid({ partnerAId: ROSE, partnerBId: "  " }).partnerBId).toBe(
      null,
    );
  });

  it("refuses a union with neither partner", () => {
    expect(expectInvalid({ partnerAId: null, partnerBId: null })).toEqual([
      "partnerAId",
    ]);
  });

  it("refuses a person partnered with themselves", () => {
    expect(expectInvalid({ partnerAId: ROSE, partnerBId: ROSE })).toEqual([
      "partnerBId",
    ]);
  });

  /**
   * `unions.partner_a_id` is a `uuid` column, so a non-UUID reaching `eq`
   * raises out of the driver rather than matching no rows. The shape check is
   * what turns that into a message beside the picker.
   */
  it("refuses a partner reference that is not shaped like a row id", () => {
    expect(expectInvalid({ ...MINIMAL, partnerBId: "thomas" })).toEqual([
      "partnerBId",
    ]);
  });

  it("refuses a partner reference that is not text", () => {
    expect(expectInvalid({ ...MINIMAL, partnerBId: 7 })).toEqual([
      "partnerBId",
    ]);
  });
});

describe("the dates", () => {
  it("keeps both dates optional", () => {
    const fields = expectValid(MINIMAL);
    expect(fields.startDate).toBe(null);
    expect(fields.endDate).toBe(null);
  });

  it("accepts a start date with no end date", () => {
    expect(expectValid({ ...MINIMAL, startDate: "1912-06-04" }).startDate).toBe(
      "1912-06-04",
    );
  });

  it("accepts an end date with no start date", () => {
    expect(
      expectValid({ ...MINIMAL, endDate: "1938-02-19", endReason: "death" })
        .endDate,
    ).toBe("1938-02-19");
  });

  it.each(["1912-6-4", "4 June 1912", "1912", "1912-02-30", "0000-01-01"])(
    "refuses %s as a start date",
    (startDate) => {
      expect(expectInvalid({ ...MINIMAL, startDate })).toContain("startDate");
    },
  );

  it("refuses a qualifier that is not one of the four", () => {
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1912-06-04",
        startDateQualifier: "roughly",
        startDatePrecision: "day",
      }),
    ).toEqual(["startDateQualifier"]);
  });

  /**
   * The schema is explicit that a qualifier is only ever read alongside its
   * date, so `about` with nothing to qualify would survive into a GEDCOM
   * export as a stray `ABT`.
   */
  it("drops a qualifier that has no date beside it", () => {
    const fields = expectValid({
      ...MINIMAL,
      startDateQualifier: "about",
      startDatePrecision: "day",
      endDateQualifier: "before",
      endDatePrecision: "day",
    });
    expect(fields.startDateQualifier).toBe("exact");
    expect(fields.endDateQualifier).toBe("exact");
  });

  it("refuses a union that ended before it began", () => {
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1938-02-19",
        endDate: "1912-06-04",
        endReason: "divorce",
      }),
    ).toContain("endDate");
  });

  it("allows a union that ended the day it began", () => {
    expect(
      validateUnion({
        ...MINIMAL,
        startDate: "1912-06-04",
        endDate: "1912-06-04",
        endReason: "death",
      }).ok,
    ).toBe(true);
  });

  /**
   * The qualifiers are what make the ordering rule defensible rather than
   * annoying: married *about* 1912 and widowed in 1911 is an ordinary record,
   * and only a pair whose ranges cannot overlap at all is refused.
   */
  it("allows an out-of-order pair when a qualifier makes it possible", () => {
    expect(
      validateUnion({
        ...MINIMAL,
        startDate: "1912-06-04",
        startDateQualifier: "about",
        startDatePrecision: "day",
        endDate: "1911-01-01",
        endReason: "death",
      }).ok,
    ).toBe(true);
  });

  /**
   * The precision half of the same argument, which this file had no fixture
   * for at all (`YEO-85`): every `*Precision` in it said `day`, so
   * `isImpossibleOrder` only ever compared two single days and the widening
   * in `precisionSpan` was never run from here.
   *
   * What the widening is for: a marriage recorded on a known day in June, and
   * an end recorded as a bare year. The year is stored on its 1 January
   * *anchor*, so reading that anchor as a day says the union ended five months
   * before it started — and the validator refuses a true record, in the voice
   * of a rule, because a caller left a column out. Honouring the precision
   * widens the end back out to the whole of 1912, which overlaps June, and the
   * record stands.
   */
  it("allows an end recorded only as a year that the start falls inside", () => {
    expect(
      validateUnion({
        ...MINIMAL,
        startDate: "1912-06-04",
        endDate: "1912-01-01",
        endDatePrecision: "year",
        endReason: "death",
      }).ok,
    ).toBe(true);

    // The same two dates with the anchor taken literally, which is what the
    // missing precision used to mean.
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1912-06-04",
        endDate: "1912-01-01",
        endDatePrecision: "day",
        endReason: "death",
      }),
    ).toContain("endDate");
  });

  /**
   * Month precision, and specifically the last day of the month — the one
   * value in `precisionSpan` that is computed rather than written down.
   *
   * 1912 is a leap year, so February's span ends on the 29th, and a union that
   * began on 29 February and ended some time that same February is possible by
   * exactly one day. A table that assumed 28 would refuse it.
   */
  it("widens a month to its real last day, leap year included", () => {
    expect(
      validateUnion({
        ...MINIMAL,
        startDate: "1912-02-29",
        endDate: "1912-02-01",
        endDatePrecision: "month",
        endReason: "death",
      }).ok,
    ).toBe(true);

    // March of a non-leap year ends on the 31st, and February of one ends on
    // the 28th — so this pair genuinely cannot overlap.
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1913-03-01",
        endDate: "1913-02-01",
        endDatePrecision: "month",
        endReason: "death",
      }),
    ).toContain("endDate");
  });

  it("does not fault the end date when the start date was unreadable", () => {
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "nonsense",
        endDate: "1800-01-01",
      }),
    ).toEqual(["startDate", "endReason"]);
  });
});

describe("date ranges (YEO-88)", () => {
  it("accepts a range's upper bound on the start date", () => {
    const fields = expectValid({
      ...MINIMAL,
      startDate: "1912-01-01",
      startDateUpper: "1913-01-01",
      startDateUpperPrecision: "year",
    });

    expect(fields.startDateUpper).toBe("1913-01-01");
    expect(fields.startDateUpperPrecision).toBe("year");
  });

  it("accepts a range's upper bound on the end date — nothing to do with endReason", () => {
    const fields = expectValid({
      ...MINIMAL,
      endDate: "1938-01-01",
      endDateUpper: "1939-01-01",
      endDateUpperPrecision: "year",
      endReason: "divorce",
    });

    expect(fields.endDateUpper).toBe("1939-01-01");
    expect(fields.endDateUpperPrecision).toBe("year");
    expect(fields.endReason).toBe("divorce");
  });

  it("refuses a non-exact qualifier beside a non-null upper bound, on either date", () => {
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1912-01-01",
        startDateQualifier: "about",
        startDateUpper: "1913-01-01",
      }),
    ).toEqual(["startDateUpper"]);

    expect(
      expectInvalid({
        ...MINIMAL,
        endDate: "1938-01-01",
        endDateQualifier: "before",
        endDateUpper: "1939-01-01",
        endReason: "death",
      }),
    ).toEqual(["endDateUpper"]);
  });

  it("refuses an inverted range, reported against the upper-bound field", () => {
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1913-01-01",
        startDateUpper: "1912-01-01",
      }),
    ).toEqual(["startDateUpper"]);

    expect(
      expectInvalid({
        ...MINIMAL,
        endDate: "1939-01-01",
        endDateUpper: "1938-01-01",
        endReason: "death",
      }),
    ).toEqual(["endDateUpper"]);
  });

  it("normalises an upper bound to null when there is no lower date", () => {
    const fields = expectValid({
      ...MINIMAL,
      startDateUpper: "1913-01-01",
      startDateUpperPrecision: "year",
    });

    expect(fields.startDate).toBeNull();
    expect(fields.startDateUpper).toBeNull();
    expect(fields.startDateUpperPrecision).toBe("day");
  });

  it("catches an ordering error a collapsed reading could never catch", () => {
    // Under the collapse this ticket reversed, `BET 1912 AND 1913` stored as
    // `after 1912` has an unbounded `latest`, so a union that ended before
    // its own start range could never be refused. Stored whole, it can be.
    expect(
      expectInvalid({
        ...MINIMAL,
        startDate: "1912-01-01",
        startDateUpper: "1913-01-01",
        endDate: "1911-01-01",
        endReason: "divorce",
      }),
    ).toEqual(["endDate"]);
  });
});

describe("how a union ended", () => {
  it("refuses an end date on a union still described as ongoing", () => {
    expect(expectInvalid({ ...MINIMAL, endDate: "1938-02-19" })).toEqual([
      "endReason",
    ]);
  });

  /**
   * The converse is the normal state of an old record: the family remembers
   * the outcome and not the year.
   */
  it.each(["death", "divorce", "separation", "unknown"] as const)(
    "accepts %s with no end date",
    (endReason) => {
      expect(expectValid({ ...MINIMAL, endReason }).endReason).toBe(endReason);
    },
  );

  it("refuses an end reason that is not one of the five", () => {
    expect(expectInvalid({ ...MINIMAL, endReason: "estranged" })).toEqual([
      "endReason",
    ]);
  });
});

describe("the display order", () => {
  /**
   * Null rather than 0, because "place it after the ones already recorded" and
   * "put it first" are different instructions, and only `lib/save-union.ts`
   * can carry out the first.
   */
  it("leaves an unstated order for the writer to decide", () => {
    expect(expectValid(MINIMAL).sequence).toBe(null);
    expect(expectValid({ ...MINIMAL, sequence: "" }).sequence).toBe(null);
  });

  it("accepts a stated order as a number or as digits", () => {
    expect(expectValid({ ...MINIMAL, sequence: 0 }).sequence).toBe(0);
    expect(expectValid({ ...MINIMAL, sequence: "3" }).sequence).toBe(3);
    // Trimmed like every other text field, so a form that pads it still works.
    expect(expectValid({ ...MINIMAL, sequence: " 3 " }).sequence).toBe(3);
  });

  it.each([-1, 1.5, "two", "1e3", "-1", "3.0"])(
    "refuses %s as an order",
    (sequence) => {
      expect(expectInvalid({ ...MINIMAL, sequence })).toEqual(["sequence"]);
    },
  );

  it("refuses an order beyond the ceiling", () => {
    expect(
      expectInvalid({ ...MINIMAL, sequence: MAX_UNION_SEQUENCE + 1 }),
    ).toEqual(["sequence"]);
  });
});

describe("the notes", () => {
  it("trims them, and treats blank as nothing recorded", () => {
    expect(expectValid({ ...MINIMAL, notes: "  at St Anne's " }).notes).toBe(
      "at St Anne's",
    );
    expect(expectValid({ ...MINIMAL, notes: "   " }).notes).toBe(null);
  });

  it("refuses notes longer than the limit", () => {
    expect(
      expectInvalid({ ...MINIMAL, notes: "x".repeat(MAX_NOTES_LENGTH + 1) }),
    ).toEqual(["notes"]);
  });
});

describe("reporting problems", () => {
  it("finds every problem in one pass rather than stopping at the first", () => {
    expect(
      expectInvalid({
        partnerAId: "not-an-id",
        partnerBId: "also-not",
        type: "engagement",
        notes: 7,
      }),
    ).toEqual(["partnerAId", "partnerBId", "type", "notes"]);
  });

  it("collapses issues to one message per field, first winning", () => {
    expect(
      unionFieldErrorsFrom([
        { field: "endDate", message: "first" },
        { field: "endDate", message: "second" },
        { field: "type", message: "third" },
      ]),
    ).toEqual({ endDate: "first", type: "third" });
  });
});

describe("unionInputFromFormData", () => {
  it("reads the union's fields by their column names", () => {
    const form = new FormData();
    form.set("partnerAId", ROSE);
    form.set("partnerBId", THOMAS);
    form.set("type", "marriage");
    form.set("startDate", "1912-06-04");
    form.set("startDateQualifier", "about");
    form.set("endDate", "1938-02-19");
    form.set("endDateQualifier", "exact");
    form.set("endReason", "death");
    form.set("sequence", "1");
    form.set("notes", "at St Anne's");

    expect(expectValid(unionInputFromFormData(form))).toEqual({
      partnerAId: ROSE,
      partnerBId: THOMAS,
      type: "marriage",
      startDate: "1912-06-04",
      startDateQualifier: "about",
      startDatePrecision: "day",
      startDateUpper: null,
      startDateUpperPrecision: "day",
      endDate: "1938-02-19",
      endDateQualifier: "exact",
      endDatePrecision: "day",
      endDateUpper: null,
      endDateUpperPrecision: "day",
      endReason: "death",
      sequence: 1,
      notes: "at St Anne's",
    });
  });

  it("passes a field that is not text through as a problem, not as a string", () => {
    const form = new FormData();
    form.set("partnerAId", ROSE);
    form.set("notes", new File(["x"], "note.txt"));

    expect(expectInvalid(unionInputFromFormData(form))).toEqual(["notes"]);
  });

  it("reads a range's upper bound and its precision (YEO-88)", () => {
    const form = new FormData();
    form.set("partnerAId", ROSE);
    form.set("partnerBId", THOMAS);
    form.set("startDate", "1912-01-01");
    form.set("startDateUpper", "1913-01-01");
    form.set("startDateUpperPrecision", "year");

    const fields = expectValid(unionInputFromFormData(form));
    expect(fields.startDateUpper).toBe("1913-01-01");
    expect(fields.startDateUpperPrecision).toBe("year");
  });
});

/** The smallest add-spouse submission that passes. */
function spouse(overrides: Partial<AddSpouseInput> = {}): AddSpouseInput {
  return {
    personId: ROSE,
    partnerMode: "existing",
    partnerId: THOMAS,
    partner: {},
    union: {},
    ...overrides,
  };
}

describe("validateAddSpouse", () => {
  it("builds the union out of the person and the chosen partner", () => {
    const result = validateAddSpouse(spouse({ union: { type: "marriage" } }));
    if (!result.ok) throw new Error("expected valid");

    expect(result.mode).toBe("existing");
    expect(result.partner).toBe(null);
    expect(result.union.partnerAId).toBe(ROSE);
    expect(result.union.partnerBId).toBe(THOMAS);
    expect(result.union.type).toBe("marriage");
  });

  /**
   * The action is an open POST endpoint. The partner columns are decided by
   * whose panel the flow was opened from and what the picker was told, so a
   * hand-crafted body cannot use them to marry two people it was simply
   * handed.
   */
  it("ignores partner columns sent in the union's own fields", () => {
    const result = validateAddSpouse(
      spouse({ union: { partnerAId: WALTER, partnerBId: WALTER } }),
    );
    if (!result.ok) throw new Error("expected valid");

    expect(result.union.partnerAId).toBe(ROSE);
    expect(result.union.partnerBId).toBe(THOMAS);
  });

  it("refuses an existing-partner choice with nobody chosen", () => {
    const result = validateAddSpouse(spouse({ partnerId: "" }));
    if (result.ok) throw new Error("expected invalid");
    expect(result.unionIssues.map((issue) => issue.field)).toEqual([
      "partnerBId",
    ]);
  });

  it("validates a partner being created inline, and leaves B unset for the writer", () => {
    const result = validateAddSpouse(
      spouse({
        partnerMode: "new",
        partnerId: "",
        partner: { givenName: "  Walter ", surname: "Hale" },
      }),
    );
    if (!result.ok) throw new Error("expected valid");

    expect(result.mode).toBe("new");
    expect(result.partner?.givenName).toBe("Walter");
    expect(result.partner?.surname).toBe("Hale");
    // The row does not exist yet; `lib/save-union.ts` fills the id in.
    expect(result.union.partnerBId).toBe(null);
  });

  it("reports the partner's problems and the union's in the same answer", () => {
    const result = validateAddSpouse(
      spouse({
        partnerMode: "new",
        partnerId: "",
        partner: { givenName: "   " },
        union: { endDate: "1938-02-19" },
      }),
    );
    if (result.ok) throw new Error("expected invalid");

    expect(result.partnerIssues.map((issue) => issue.field)).toEqual([
      "givenName",
    ]);
    expect(result.unionIssues.map((issue) => issue.field)).toEqual([
      "endReason",
    ]);
  });

  /**
   * Both partner columns are nullable precisely so this never has to become a
   * placeholder person.
   */
  it("records a union whose partner is deliberately not known", () => {
    const result = validateAddSpouse(
      spouse({ partnerMode: "unknown", partnerId: "" }),
    );
    if (!result.ok) throw new Error("expected valid");

    expect(result.partner).toBe(null);
    expect(result.union.partnerAId).toBe(ROSE);
    expect(result.union.partnerBId).toBe(null);
  });

  it("does not create a person unless the mode asks for one", () => {
    const result = validateAddSpouse(
      spouse({ partner: { givenName: "Walter" } }),
    );
    if (!result.ok) throw new Error("expected valid");
    expect(result.partner).toBe(null);
  });

  it("refuses a partner mode it does not recognise", () => {
    const result = validateAddSpouse(spouse({ partnerMode: "invent" }));
    if (result.ok) throw new Error("expected invalid");
    expect(result.unionIssues.map((issue) => issue.field)).toContain(
      "partnerBId",
    );
  });

  it.each(PARTNER_MODES)("accepts %s as a mode", (partnerMode) => {
    const result = validateAddSpouse(
      spouse({
        partnerMode,
        partnerId: partnerMode === "existing" ? THOMAS : "",
        partner: partnerMode === "new" ? { givenName: "Walter" } : {},
      }),
    );
    expect(result.ok).toBe(true);
  });

  /**
   * The ticket's headline requirement, and it is true here by omission:
   * nothing in this module reads, references or rewrites an existing union.
   * Two submissions naming the same person produce two independent records.
   */
  it("builds a second union for a person without referring to the first", () => {
    const first = validateAddSpouse(spouse({ partnerId: THOMAS }));
    const second = validateAddSpouse(spouse({ partnerId: WALTER }));
    if (!first.ok || !second.ok) throw new Error("expected valid");

    expect(first.union.partnerBId).toBe(THOMAS);
    expect(second.union.partnerBId).toBe(WALTER);
    // Neither states an order; the writer places each after what is recorded.
    expect(first.union.sequence).toBe(null);
    expect(second.union.sequence).toBe(null);
  });
});

describe("addSpouseInputFromFormData", () => {
  it("reads the union unprefixed and the inline partner under `partner.`", () => {
    const form = new FormData();
    form.set("personId", ROSE);
    form.set("partnerMode", "new");
    form.set("partnerId", "");
    form.set("type", "marriage");
    form.set("notes", "the marriage");
    form.set("partner.givenName", "Walter");
    form.set("partner.surname", "Hale");
    form.set("partner.notes", "the person");

    const input = addSpouseInputFromFormData(form);

    expect(input.personId).toBe(ROSE);
    expect(input.partnerMode).toBe("new");
    expect(input.partner.givenName).toBe("Walter");
    // The two `notes` fields are the reason for the prefix in the first place.
    expect(input.partner.notes).toBe("the person");
    expect(input.union.notes).toBe("the marriage");
  });

  it("produces a submission the validator accepts end to end", () => {
    const form = new FormData();
    form.set("personId", ROSE);
    form.set("partnerMode", "existing");
    form.set("partnerId", THOMAS);
    form.set("type", "partnership");
    form.set("startDate", "1946-03-02");
    form.set("startDateQualifier", "about");
    form.set("endReason", "ongoing");

    const result = validateAddSpouse(addSpouseInputFromFormData(form));
    if (!result.ok) throw new Error("expected valid");

    expect(result.union).toEqual({
      partnerAId: ROSE,
      partnerBId: THOMAS,
      type: "partnership",
      startDate: "1946-03-02",
      startDateQualifier: "about",
      startDatePrecision: "day",
      startDateUpper: null,
      startDateUpperPrecision: "day",
      endDate: null,
      endDateQualifier: "exact",
      endDatePrecision: "day",
      endDateUpper: null,
      endDateUpperPrecision: "day",
      endReason: "ongoing",
      sequence: null,
      notes: null,
    });
  });
});
