import {
  DATE_PRECISIONS,
  DATE_QUALIFIERS,
  type DatePrecision,
  type DateQualifier,
  isImpossibleOrder,
  isInvertedRange,
  MAX_NOTES_LENGTH,
  readDate,
  readEnum,
  readText,
  withoutPrefix,
} from "./field-input";
import {
  type IndividualFields,
  type IndividualInput,
  individualInputFromFormData,
  type ValidationIssue,
  validateIndividual,
} from "./individual-input";
import { isRowId } from "./row-id";

/**
 * The one place a union's details are checked before they become a row
 * (E3-T4, `YEO-32`).
 *
 * ## The same shape as `lib/individual-input.ts`, for the same reason
 *
 * `unions` is the second table the app writes to, and it has the same problem
 * the first one had: several doors lead to the insert and only one of them is
 * a request. The add-spouse form comes through `app/tree/actions.ts`; E3-T5's
 * add-child and E3-T6's set-parents will reach the same rows from their own
 * flows; and **E6-T2's GEDCOM import** maps every `FAM` record onto a union
 * with no session, no `FormData`, and no request scope at all.
 *
 * So nothing in this file may touch `headers()`, `cookies()`, `@/db`, or any
 * other ambient state. Its imports are `lib/field-input.ts`,
 * `lib/individual-input.ts` and `lib/row-id.ts`, which are themselves pure —
 * the whole chain can be called from a loop, a script, a test, or a server
 * action and behave identically in all four.
 *
 * ## What a union is, and why both partners are nullable
 *
 * A union is the first-class entity the whole data model rests on
 * (docs/architecture.md): children belong to a union rather than to
 * individuals, which is what makes remarriage, half-siblings and adoption
 * ordinary rather than special. Both partner columns are nullable because "we
 * know the mother, the father is unknown" is common in older generations, and
 * a model that cannot express it forces you to invent placeholder people.
 *
 * That nullability is a *permission*, not an invitation: a union with neither
 * partner names nobody and connects nothing, so `validateUnion` refuses it.
 * One partner is the smallest thing that is still a fact.
 *
 * ## Why `sequence` can be null here when the column cannot
 *
 * `unions.sequence` is `not null default 0`, and it exists because families
 * remember the *order* of marriages long after the years are lost ("she
 * remarried after he died"). A caller that knows the order says so; a caller
 * that is simply adding one more union does not, and should not have to
 * invent a number that silently ties with an existing one.
 *
 * So `null` here means "place it after the ones already recorded", and
 * `lib/save-union.ts` — which can see the other rows — is what turns that into
 * an integer. This is the field that makes "a person can be given a second
 * union without touching the first" true: the new row gets the next number,
 * and the existing union is never read for update, let alone written.
 */

/**
 * The values `unions.type` accepts, mirroring the `union_type` enum in
 * `db/schema.ts`.
 *
 * Re-declared rather than derived from the Drizzle table for the reason
 * `SEXES` gives in `lib/individual-input.ts`: importing the schema, even for a
 * type, drags postgres.js into every consumer — including a form component and
 * a test with no `DATABASE_URL`.
 */
export const UNION_TYPES = ["marriage", "partnership", "unknown"] as const;

export type UnionType = (typeof UNION_TYPES)[number];

/**
 * The values `unions.end_reason` accepts, mirroring the `union_end_reason`
 * enum in `db/schema.ts`.
 *
 * `ongoing` is the member that means "it has not ended", which is why it is
 * the fallback for an absent value and why it is contradicted by an end date
 * — see the cross-field rule in `validateUnion`.
 */
export const UNION_END_REASONS = [
  "ongoing",
  "death",
  "divorce",
  "separation",
  "unknown",
] as const;

export type UnionEndReason = (typeof UNION_END_REASONS)[number];

/**
 * A union's details, cleaned and ready to be written.
 *
 * Every field is settled: text is trimmed, "not given" is `null` rather than
 * `""`, and every enum holds a real member rather than a string that happens
 * to look like one. This is the type `lib/save-union.ts` inserts.
 *
 * The field names are the Drizzle column names, so the value goes straight
 * into `db.insert(schema.unions).values(...)` with nothing to map.
 */
export type UnionFields = {
  /** An `individuals.id`, or null when this partner is unrecorded. */
  partnerAId: string | null;
  /** An `individuals.id`, or null when this partner is unrecorded. */
  partnerBId: string | null;
  type: UnionType;
  /**
   * ISO `YYYY-MM-DD`, or null when unknown. An *anchor* rather than a day
   * whenever `startDatePrecision` is coarser than `day` — see
   * `DATE_PRECISIONS` in `lib/field-input.ts`.
   */
  startDate: string | null;
  startDateQualifier: DateQualifier;
  startDatePrecision: DatePrecision;
  /**
   * The upper bound of a range (`YEO-88`) — `startDate` is the lower bound.
   * `null` when the start date is a single point, which is every union
   * recorded before this ticket. `_upper` names the bound, not the event —
   * this has nothing to do with `endDate`.
   */
  startDateUpper: string | null;
  startDateUpperPrecision: DatePrecision;
  /** ISO `YYYY-MM-DD`, or null when unknown. An anchor, as `startDate` is. */
  endDate: string | null;
  endDateQualifier: DateQualifier;
  endDatePrecision: DatePrecision;
  /**
   * The upper bound of the *end date's* range, as `startDateUpper` is for the
   * start date — nothing to do with `endReason`.
   */
  endDateUpper: string | null;
  endDateUpperPrecision: DatePrecision;
  endReason: UnionEndReason;
  /** Explicit display order, or null to be placed after the existing unions. */
  sequence: number | null;
  notes: string | null;
};

/** The name of a field a problem can be attached to. */
export type UnionField = keyof UnionFields;

/**
 * A union's details as they arrive: one property per field, every value
 * `unknown`.
 *
 * `unknown` rather than `string` for the reason `IndividualInput` gives: the
 * values come from a `FormData` entry (`string | File | null`), from a GEDCOM
 * record, or from a POST somebody hand-crafted, so "it is a string" is a
 * conclusion `validateUnion` reaches rather than a premise a caller may
 * assert.
 */
export type UnionInput = {
  [Field in UnionField]?: unknown;
};

/**
 * One problem with one field, in words meant for the person who typed it.
 *
 * Separate from `ValidationIssue` in `lib/individual-input.ts` rather than
 * generic over the field name, because the add-spouse flow validates a person
 * and a union in the same submission and the form has to render each message
 * beside the right input. One shared type would make `{ field: "notes" }`
 * ambiguous between the partner's notes and the marriage's.
 */
export type UnionValidationIssue = {
  field: UnionField;
  /** A complete sentence, safe to render directly. */
  message: string;
};

/**
 * Problems keyed by field, which is the shape a form actually renders. At most
 * one message per field — the first one found.
 */
export type UnionFieldErrors = Partial<Record<UnionField, string>>;

/**
 * Either a clean record or the reasons there isn't one. Never both.
 *
 * A discriminated union rather than `{ value, issues }` with one of them
 * empty, so a caller cannot write the value without having checked.
 */
export type UnionValidation =
  | { ok: true; value: UnionFields }
  | { ok: false; issues: UnionValidationIssue[] };

/**
 * The largest explicit `sequence` a caller may set.
 *
 * `sequence` orders one person's unions against each other, and nobody has
 * had a thousand marriages. The column is a plain `integer`, so without a
 * bound a direct POST could store `2147483647` and leave E3-T7's reorder UI
 * with a number it cannot increment past. A small ceiling also keeps the
 * "place it last" arithmetic in `lib/save-union.ts` honest.
 */
export const MAX_UNION_SEQUENCE = 1000;

/**
 * Read the display-order field.
 *
 * Accepts a number as well as text, because only one of this module's callers
 * is a form: E3-T7's reorder and E6-T2's import both hold real integers and
 * should not have to stringify them to get past a validator.
 *
 * @returns the order, `null` when it was not given, or `undefined` when it was
 *   given as something that is not a whole non-negative number
 */
function readSequence(value: unknown): number | null | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  const text = readText(value);
  if (text === null || text === undefined) return text;

  // `Number("12 ")` is 12 and `Number("1e3")` is 1000; neither is a display
  // order anybody typed. The pattern is what makes this a digit string rather
  // than "whatever JavaScript will coerce".
  if (!/^\d+$/.test(text)) return undefined;

  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Read a partner reference.
 *
 * The id names a row this caller did not write and is not otherwise entitled
 * to describe — the Next.js server-actions guide's "send a reference plus the
 * user's change" rule. Its *shape* is checked here so that a non-UUID becomes
 * a message beside the picker instead of `invalid input syntax for type uuid`
 * thrown out of the driver; whether the row exists is a database question and
 * belongs in `lib/save-union.ts`.
 *
 * @returns the id, `null` when this partner is deliberately unrecorded, or
 *   `undefined` when the value is not a usable reference
 */
function readPartnerId(value: unknown): string | null | undefined {
  const text = readText(value);
  if (text === null || text === undefined) return text;
  return isRowId(text) ? text : undefined;
}

/**
 * Check and clean one union's details.
 *
 * Pure: no database, no session, no request. Every field is examined even
 * after one has failed, so an author fixing a form sees everything that is
 * wrong with it in one pass rather than discovering the next problem each
 * time they resubmit.
 *
 * @param input the details as they arrived, untrusted and untyped
 * @returns the cleaned record, or every problem found
 */
export function validateUnion(input: UnionInput): UnionValidation {
  const issues: UnionValidationIssue[] = [];
  const add = (field: UnionField, message: string) =>
    issues.push({ field, message });

  const partnerAId = readPartnerId(input.partnerAId);
  if (partnerAId === undefined) {
    add("partnerAId", "That is not a person this tree can link to.");
  }

  const partnerBId = readPartnerId(input.partnerBId);
  if (partnerBId === undefined) {
    add("partnerBId", "That is not a person this tree can link to.");
  }

  /**
   * Both columns are nullable so that an unrecorded partner never has to be
   * invented as a placeholder person — but a union with *neither* partner
   * names nobody, connects nothing, and would draw as an orphaned marker on
   * the canvas. One partner is the smallest thing that is still a fact.
   */
  if (partnerAId === null && partnerBId === null) {
    add("partnerAId", "A union needs at least one partner.");
  }

  /**
   * Reported against B rather than A because B is the one the add-spouse
   * picker chose: A is the person whose panel the flow was opened from, and
   * telling them to change *that* would be telling them to start again.
   */
  if (partnerAId && partnerBId && partnerAId === partnerBId) {
    add("partnerBId", "A person cannot be in a union with themselves.");
  }

  const type = readEnum(input.type, UNION_TYPES, "unknown");
  if (type === undefined) {
    add("type", "That is not one of the options for a union.");
  }

  const startDate = readDate(input.startDate);
  if (startDate === undefined) {
    add(
      "startDate",
      "That start date could not be read. Try a year like 1912, or a full date like 4 June 1912.",
    );
  }

  const startDateQualifier = readEnum(
    input.startDateQualifier,
    DATE_QUALIFIERS,
    "exact",
  );
  if (startDateQualifier === undefined) {
    add("startDateQualifier", "That is not one of the options for a date.");
  }

  const startDatePrecision = readEnum(
    input.startDatePrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (startDatePrecision === undefined) {
    add(
      "startDatePrecision",
      "That is not one of the options for how much of a date is known.",
    );
  }

  const startDateUpper = readDate(input.startDateUpper);
  if (startDateUpper === undefined) {
    add(
      "startDateUpper",
      "That start date's upper bound could not be read. Try a year like 1913, or a full date like 4 June 1913.",
    );
  }

  const startDateUpperPrecision = readEnum(
    input.startDateUpperPrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (startDateUpperPrecision === undefined) {
    add(
      "startDateUpper",
      "That is not one of the options for how much of a date is known.",
    );
  }

  if (
    startDateUpper &&
    startDateQualifier !== undefined &&
    startDateQualifier !== "exact"
  ) {
    add(
      "startDateUpper",
      `A range's date cannot also be qualified "${startDateQualifier}" — a range already says how uncertain the date is.`,
    );
  }

  if (
    startDate &&
    startDateUpper &&
    isInvertedRange(startDate, startDateUpper)
  ) {
    add(
      "startDateUpper",
      "The upper bound of the start date is before the lower bound. Check whether one of them has the wrong year.",
    );
  }

  const endDate = readDate(input.endDate);
  if (endDate === undefined) {
    add(
      "endDate",
      "That end date could not be read. Try a year like 1938, or a full date like 19 February 1938.",
    );
  }

  const endDateQualifier = readEnum(
    input.endDateQualifier,
    DATE_QUALIFIERS,
    "exact",
  );
  if (endDateQualifier === undefined) {
    add("endDateQualifier", "That is not one of the options for a date.");
  }

  const endDatePrecision = readEnum(
    input.endDatePrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (endDatePrecision === undefined) {
    add(
      "endDatePrecision",
      "That is not one of the options for how much of a date is known.",
    );
  }

  const endDateUpper = readDate(input.endDateUpper);
  if (endDateUpper === undefined) {
    add(
      "endDateUpper",
      "That end date's upper bound could not be read. Try a year like 1939, or a full date like 19 February 1939.",
    );
  }

  const endDateUpperPrecision = readEnum(
    input.endDateUpperPrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (endDateUpperPrecision === undefined) {
    add(
      "endDateUpper",
      "That is not one of the options for how much of a date is known.",
    );
  }

  if (
    endDateUpper &&
    endDateQualifier !== undefined &&
    endDateQualifier !== "exact"
  ) {
    add(
      "endDateUpper",
      `A range's date cannot also be qualified "${endDateQualifier}" — a range already says how uncertain the date is.`,
    );
  }

  if (endDate && endDateUpper && isInvertedRange(endDate, endDateUpper)) {
    add(
      "endDateUpper",
      "The upper bound of the end date is before the lower bound. Check whether one of them has the wrong year.",
    );
  }

  const endReason = readEnum(input.endReason, UNION_END_REASONS, "ongoing");
  if (endReason === undefined) {
    add("endReason", "That is not one of the options for how a union ended.");
  }

  const sequence = readSequence(input.sequence);
  if (sequence === undefined) {
    add(
      "sequence",
      "The order needs to be a whole number, counting from zero.",
    );
  } else if (sequence !== null && sequence > MAX_UNION_SEQUENCE) {
    add("sequence", `The order has to be ${MAX_UNION_SEQUENCE} or less.`);
  }

  const notes = readText(input.notes);
  if (notes === undefined) {
    add("notes", "The notes could not be read as text.");
  } else if (notes !== null && notes.length > MAX_NOTES_LENGTH) {
    add(
      "notes",
      `The notes are too long — keep them under ${MAX_NOTES_LENGTH} characters. Longer stories belong in an entry of their own.`,
    );
  }

  /**
   * A union cannot have ended before it began. Checked only once both dates
   * are known to be readable, so that a mistyped start date does not also
   * fault the end date and send the author looking at the wrong field.
   *
   * The qualifiers do the real work here (see `isImpossibleOrder`): married
   * *about* 1912 and widowed in 1911 is an ordinary record, and only a pair
   * whose possible ranges cannot overlap at all is refused.
   */
  if (
    startDate &&
    endDate &&
    startDateQualifier !== undefined &&
    endDateQualifier !== undefined &&
    startDatePrecision !== undefined &&
    endDatePrecision !== undefined &&
    isImpossibleOrder(
      {
        date: startDate,
        qualifier: startDateQualifier,
        precision: startDatePrecision,
        upper: startDateUpper ?? null,
        upperPrecision: startDateUpperPrecision ?? "day",
      },
      {
        date: endDate,
        qualifier: endDateQualifier,
        precision: endDatePrecision,
        upper: endDateUpper ?? null,
        upperPrecision: endDateUpperPrecision ?? "day",
      },
    )
  ) {
    add(
      "endDate",
      "The union ends before it starts. Check whether one of the dates has the wrong year.",
    );
  }

  /**
   * An end date says the union ended; `ongoing` says it did not. Exactly one
   * of them can be true.
   *
   * This is refused rather than quietly coerced to `unknown`, and the ticket's
   * wording is the reason: type and end reason are "fields, not defaults to
   * fix later". `ongoing` is also the column's default, so this combination is
   * overwhelmingly a caller that forgot to send the reason rather than one
   * making a claim — and repairing it silently would write "ended, cause
   * unrecorded" over an author who was one keystroke from saying "divorced".
   *
   * The converse is *not* an error: `divorce` with no end date is the normal
   * state of an old record, where the family remembers the outcome and not
   * the year.
   */
  if (endDate && endReason === "ongoing") {
    add(
      "endReason",
      "This union has an end date, so it is not ongoing. Say how it ended.",
    );
  }

  if (issues.length > 0) return { ok: false, issues };

  /**
   * Everything below has been narrowed by the checks above, but TypeScript
   * cannot see that across `issues.length` — so the values are re-asserted
   * with `??` defaults that are unreachable rather than with a cast. If a
   * check above is ever deleted, this keeps writing a legal row instead of
   * writing `undefined` into a `not null` column.
   */
  return {
    ok: true,
    value: {
      partnerAId: partnerAId ?? null,
      partnerBId: partnerBId ?? null,
      /**
       * `unknown` rather than the column's `marriage` default. The column's
       * default exists for a row somebody writes by hand in a SQL console;
       * every row written through this module states the value, and asserting
       * a *marriage* over a caller who said nothing is inventing a fact. A
       * form that offers the field — which this ticket requires — sends it.
       */
      type: type ?? "unknown",
      startDate: startDate ?? null,
      /**
       * A qualifier with no date beside it is normalised away, matching
       * `validateIndividual`. The schema's note is explicit that a qualifier
       * is only ever read alongside its date, so storing `about` next to a
       * null date would be a second way of saying nothing — and one that
       * survives into a GEDCOM export as a stray `ABT`.
       */
      startDateQualifier: startDate ? (startDateQualifier ?? "exact") : "exact",
      /** Normalised away with no date beside it, for the reason above. */
      startDatePrecision: startDate ? (startDatePrecision ?? "day") : "day",
      /**
       * An upper bound with no lower bound is normalised away the same way a
       * qualifier with no date is, above (`YEO-88`).
       */
      startDateUpper: startDate ? (startDateUpper ?? null) : null,
      startDateUpperPrecision:
        startDate && startDateUpper
          ? (startDateUpperPrecision ?? "day")
          : "day",
      endDate: endDate ?? null,
      endDateQualifier: endDate ? (endDateQualifier ?? "exact") : "exact",
      endDatePrecision: endDate ? (endDatePrecision ?? "day") : "day",
      endDateUpper: endDate ? (endDateUpper ?? null) : null,
      endDateUpperPrecision:
        endDate && endDateUpper ? (endDateUpperPrecision ?? "day") : "day",
      endReason: endReason ?? "ongoing",
      sequence: sequence ?? null,
      notes: notes ?? null,
    },
  };
}

/**
 * Collapse a list of issues into one message per field.
 *
 * The list is what an importer wants (every problem, in order, for a report);
 * this is what a form wants (a message to hang under each input). First issue
 * wins per field, matching the order `validateUnion` finds them in.
 *
 * Named for unions rather than exported as `fieldErrorsFrom` because
 * `lib/individual-input.ts` already exports that name, and the add-spouse
 * action calls both in the same breath.
 */
export function unionFieldErrorsFrom(
  issues: readonly UnionValidationIssue[],
): UnionFieldErrors {
  const errors: UnionFieldErrors = {};
  for (const issue of issues) {
    errors[issue.field] ??= issue.message;
  }
  return errors;
}

/**
 * Pull a union's fields out of a submitted form.
 *
 * The input names are the property names of `UnionFields`, so a form writes
 * `name="startDate"` and nothing has to be mapped or renamed — the same
 * division of labour `individualInputFromFormData` sets up.
 *
 * A web API, not a Next.js one: `FormData` is a global in Node 18+, so this is
 * callable from a script or a test with no request in sight.
 */
export function unionInputFromFormData(form: FormData): UnionInput {
  return {
    partnerAId: form.get("partnerAId"),
    partnerBId: form.get("partnerBId"),
    type: form.get("type"),
    startDate: form.get("startDate"),
    startDateQualifier: form.get("startDateQualifier"),
    startDatePrecision: form.get("startDatePrecision"),
    startDateUpper: form.get("startDateUpper"),
    startDateUpperPrecision: form.get("startDateUpperPrecision"),
    endDate: form.get("endDate"),
    endDateQualifier: form.get("endDateQualifier"),
    endDatePrecision: form.get("endDatePrecision"),
    endDateUpper: form.get("endDateUpper"),
    endDateUpperPrecision: form.get("endDateUpperPrecision"),
    endReason: form.get("endReason"),
    sequence: form.get("sequence"),
    notes: form.get("notes"),
  };
}

/**
 * How the add-spouse flow says who the partner is.
 *
 * Three answers, because the partner picker offers three and the schema can
 * hold all of them:
 *
 * - `existing` — somebody already on the tree, named by `partnerId`. The
 *   ordinary case, and the one that keeps a remarriage from duplicating a
 *   person onto the canvas.
 * - `new` — somebody not recorded yet, created inline from `partner`. Without
 *   this the author has to leave the flow, add a person, come back, and find
 *   them again.
 * - `unknown` — the marriage is recorded and the spouse is not. Both partner
 *   columns are nullable precisely so this never has to become a placeholder
 *   person, and the detail panel already renders it as "Unknown partner".
 *
 * An explicit mode rather than inferring one from which fields arrived: a form
 * posts every input it contains, so "the partner fields are blank" and "the
 * author chose an existing person" are indistinguishable by presence. Guessing
 * would mean a mistyped id silently creating an unnamed stranger.
 */
export const PARTNER_MODES = ["existing", "new", "unknown"] as const;

export type PartnerMode = (typeof PARTNER_MODES)[number];

/**
 * One submission of the add-spouse form, still untrusted.
 *
 * `personId` is the person the flow was opened from and becomes `partnerAId`;
 * the partner becomes `partnerBId`. That asymmetry is only about who was on
 * screen — nothing in the schema or the layout treats A and B differently.
 */
export type AddSpouseInput = {
  /** The person gaining a spouse. */
  personId: unknown;
  /** Which of the three answers the picker gave. */
  partnerMode: unknown;
  /** An existing person's id, read only when the mode is `existing`. */
  partnerId: unknown;
  /** Details for a person to create, read only when the mode is `new`. */
  partner: IndividualInput;
  /**
   * The union's own fields. Its partner columns are ignored — they are
   * decided by `personId` and the mode above, so a hand-made POST cannot
   * marry two people it was not given.
   */
  union: UnionInput;
};

/** The prefix the add-spouse form gives its inline-partner inputs. */
export const PARTNER_FIELD_PREFIX = "partner.";

/**
 * Pull one add-spouse submission out of a form.
 *
 * Exported so that E3-T5's add-child flow — which has the same "pick someone
 * or create them inline" half — can reuse the field names rather than invent a
 * second set.
 */
export function addSpouseInputFromFormData(form: FormData): AddSpouseInput {
  return {
    personId: form.get("personId"),
    partnerMode: form.get("partnerMode"),
    partnerId: form.get("partnerId"),
    partner: individualInputFromFormData(
      withoutPrefix(form, PARTNER_FIELD_PREFIX),
    ),
    union: unionInputFromFormData(form),
  };
}

/**
 * Either everything the add-spouse flow needs to write, or every problem with
 * it. Never both.
 *
 * `partner` is the person to create and is non-null only in `new` mode — in
 * the other two the partner is either already a row or deliberately not one.
 * `union.partnerBId` is null in `new` mode too, because the id does not exist
 * yet; `lib/save-union.ts` fills it in from the insert it does first.
 */
export type AddSpouseValidation =
  | {
      ok: true;
      mode: PartnerMode;
      partner: IndividualFields | null;
      union: UnionFields;
    }
  | {
      ok: false;
      unionIssues: UnionValidationIssue[];
      partnerIssues: ValidationIssue[];
    };

/**
 * Check one add-spouse submission: the union, and the partner if one is being
 * created with it.
 *
 * Pure, and both halves are checked even when the first has already failed.
 * That is the same rule `validateIndividual` follows within one record,
 * applied across two: an author who mistyped the marriage year *and* left the
 * new partner's name blank should see both, not discover the second after
 * fixing the first.
 *
 * The two issue lists stay separate all the way to the form, because both
 * records have a `notes` field and a single keyed map could not say which one
 * a message belonged to.
 *
 * This is where the ticket's "a second union without touching the first" is
 * enforced, by omission: nothing here reads, references, or rewrites an
 * existing union. A remarriage is one new row, and the previous marriage is
 * not a party to it.
 */
export function validateAddSpouse(input: AddSpouseInput): AddSpouseValidation {
  const unionIssues: UnionValidationIssue[] = [];
  const partnerIssues: ValidationIssue[] = [];

  const mode = readEnum(input.partnerMode, PARTNER_MODES, "unknown");

  /**
   * Reported against `partnerBId` because that is the control the author
   * touched. A mode this module does not recognise cannot come from the form
   * — it is a hand-made POST or a bug — so the message says what a valid
   * submission looks like rather than trying to explain the value.
   */
  if (mode === undefined) {
    unionIssues.push({
      field: "partnerBId",
      message:
        "Choose a partner from the tree, add a new person, or record the partner as unknown.",
    });
  }

  /**
   * In `existing` mode the id is the whole answer, so a blank one is the
   * author having opened the picker and chosen nobody. Without this the union
   * would validate — one partner is legal — and quietly become an
   * unknown-partner marriage the author never asked for.
   */
  if (mode === "existing" && readText(input.partnerId) === null) {
    unionIssues.push({
      field: "partnerBId",
      message: "Choose the partner from the list, or add them as a new person.",
    });
  }

  const partnerChecked =
    mode === "new" ? validateIndividual(input.partner) : null;
  if (partnerChecked && !partnerChecked.ok) {
    partnerIssues.push(...partnerChecked.issues);
  }

  /**
   * The partner columns are overwritten rather than read from `input.union`.
   * A union is not a field of the form — it is decided by whose panel this was
   * opened from and what the picker was told — so a hand-crafted POST cannot
   * use this action to marry two people it was simply handed.
   *
   * In `new` mode B is null here on purpose: the person does not exist yet, so
   * the only honest value is "not yet known", and every rule that could fire
   * on it (both-null, self-partner) is either satisfied by A or impossible.
   */
  const unionChecked = validateUnion({
    ...input.union,
    partnerAId: input.personId,
    partnerBId: mode === "existing" ? input.partnerId : null,
  });
  if (!unionChecked.ok) unionIssues.push(...unionChecked.issues);

  if (unionIssues.length > 0 || partnerIssues.length > 0) {
    return { ok: false, unionIssues, partnerIssues };
  }

  /**
   * Both `ok` branches were taken above, but TypeScript cannot see that across
   * the length checks, so this narrows rather than casts. Neither throw is
   * reachable; both are cheaper than an `as`.
   */
  if (!unionChecked.ok) throw new Error("unreachable: union issues were empty");
  if (partnerChecked && !partnerChecked.ok) {
    throw new Error("unreachable: partner issues were empty");
  }

  return {
    ok: true,
    mode: mode ?? "unknown",
    partner: partnerChecked ? partnerChecked.value : null,
    union: unionChecked.value,
  };
}

/**
 * The fields the edit-union flow lets an author change.
 *
 * `UnionFields` minus the three references nobody types into a form. That is
 * not a convenience — it is the whole safety property of the edit flow, and it
 * is stated as a type so the compiler keeps it:
 *
 * - **`partnerAId` / `partnerBId`** — who is in a union is not an edit, it is
 *   a different union. Changing a partner would silently move every child
 *   hanging off the row to a family they were not born into, which is what
 *   `detachPartner` and `lib/union-merge.ts` exist to do deliberately and with
 *   a confirmation in front of them.
 * - **`sequence`** — the display order belongs to E3-T7's reorder control,
 *   which restates one person's whole list at once so the numbers stay
 *   coherent. A form posting a single number would renumber a union out from
 *   under the sibling it was ordered against.
 *
 * A form that simply omitted them would be worse than one that excludes them:
 * `unionInputFromFormData` reads every key it knows, and a missing input is
 * `null` rather than absent — so an edit submission run through it would
 * *clear* both partners and reset the order, and `validateUnion` would refuse
 * it with "a union needs at least one partner" against a field the author
 * cannot see. Naming the editable set is what stops that being possible.
 */
export type EditableUnionField = Exclude<
  UnionField,
  "partnerAId" | "partnerBId" | "sequence"
>;

/** A union's editable details as they arrive: every value `unknown`. */
export type EditableUnionInput = {
  [Field in EditableUnionField]?: unknown;
};

/**
 * One submission of the edit-union form, still untrusted.
 *
 * `unionId` is a reference the form is entitled to send — the row being
 * corrected, exactly as the edit-person form sends an `id`. Everything else is
 * the author's change. Whether the id names a union that still exists is a
 * database question and belongs in `lib/save-union.ts`.
 */
export type EditUnionInput = {
  /** The union being corrected. */
  unionId: unknown;
  /** Its editable fields. */
  union: EditableUnionInput;
};

/**
 * The three columns an edit is not allowed to move, read from the row as it
 * stands.
 *
 * They are supplied by `lib/save-union.ts` from the stored union rather than
 * by the submission, which is what makes "an edit cannot change who is in a
 * union" a property of the code rather than of the form's markup.
 */
export type UnionAnchors = Pick<UnionFields, "partnerAId" | "partnerBId"> & {
  /**
   * A real number rather than `UnionFields`' `number | null`. That null means
   * "place this union after the ones already recorded" and is only ever an
   * answer for a row being *inserted*; a row being corrected has a sequence
   * already, and saying so here is what keeps `updateUnion` from having to
   * defend against a case it cannot reach.
   */
  sequence: number;
};

/**
 * Pull one edit-union submission out of a form.
 *
 * Reads only the editable fields, so a hand-made POST that includes
 * `partnerAId` or `sequence` is not refused — it is simply not listened to.
 * `validateUnionEdit` then puts the stored values back in their place.
 */
export function editUnionInputFromFormData(form: FormData): EditUnionInput {
  return {
    unionId: form.get("unionId"),
    union: {
      type: form.get("type"),
      startDate: form.get("startDate"),
      startDateQualifier: form.get("startDateQualifier"),
      startDatePrecision: form.get("startDatePrecision"),
      startDateUpper: form.get("startDateUpper"),
      startDateUpperPrecision: form.get("startDateUpperPrecision"),
      endDate: form.get("endDate"),
      endDateQualifier: form.get("endDateQualifier"),
      endDatePrecision: form.get("endDatePrecision"),
      endDateUpper: form.get("endDateUpper"),
      endDateUpperPrecision: form.get("endDateUpperPrecision"),
      endReason: form.get("endReason"),
      notes: form.get("notes"),
    },
  };
}

/**
 * Check one correction to a union that already exists.
 *
 * Every rule is `validateUnion`'s — this adds none and relaxes none. A
 * marriage that ends before it starts is refused here for the same reason and
 * in the same words as one entered that way in the first place, and a rule
 * added there arrives here without this function being touched. What this does
 * is decide *what a union being edited consists of*: the author's five fields,
 * plus three columns taken from the row rather than from the request.
 *
 * Pure, like everything else in this module: the anchors are passed in, not
 * looked up.
 *
 * @param input the editable fields as they arrived, untrusted and untyped
 * @param anchors the partner columns and sequence, read from the stored row
 * @returns the cleaned record — the whole row, ready to be written — or every
 *   problem found
 */
export function validateUnionEdit(
  input: EditableUnionInput,
  anchors: UnionAnchors,
): UnionValidation {
  return validateUnion({ ...input, ...anchors });
}
