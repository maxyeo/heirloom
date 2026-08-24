/**
 * The one place a person's details are checked before they become a row
 * (E3-T1, `YEO-29`).
 *
 * ## Why this is a module and not a function inside the action
 *
 * Three callers need exactly this logic, and only one of them is a request:
 *
 * - the add-person form (E3-T2) and the edit-person form (E3-T3), through
 *   `app/tree/actions.ts`;
 * - the add-spouse and add-child flows (E3-T4, E3-T5), which create a person
 *   inline while creating a union;
 * - **GEDCOM import (E6-T2)**, which runs over a file with no session, no
 *   `FormData`, and potentially thousands of people, and must be able to
 *   report per-row problems without writing anything.
 *
 * That last caller is the constraint that shapes everything here. Nothing in
 * this file may touch `headers()`, `cookies()`, `@/db`, or any other ambient
 * request state: it is a pure function from an untrusted value to either a
 * clean record or a list of problems. It can be called in a loop, in a script,
 * in a test, or in a server action, and behaves identically in all four.
 *
 * ## Why validation returns values instead of throwing
 *
 * A refusal here is an ordinary outcome — somebody left the name blank, or
 * typed the death year wrong. Throwing would push that into an error boundary
 * and lose which field was wrong, which is the only part the author needs. It
 * would also make import all-or-nothing, when the useful behaviour is to
 * import the 900 good rows and hand back a list of the 6 bad ones.
 *
 * ## Why there is no validation library
 *
 * The repository has no schema-validation dependency and this does not need
 * one. The rules below are not shape checks: "death not before birth" is a
 * cross-field comparison over two dates whose *qualifiers* decide whether the
 * comparison means anything at all (see `isImpossibleOrder`), and the
 * normalising behaviour — blank becomes null, a qualifier without a date
 * becomes `exact` — is domain logic rather than parsing. A library would
 * still leave all of that written by hand, underneath a second vocabulary.
 */

/**
 * The values `individuals.sex` accepts, mirroring the `sex` enum in
 * `db/schema.ts`.
 *
 * Deliberately re-declared rather than derived from the Drizzle table: this
 * module must stay importable by client components and by tests that have no
 * `DATABASE_URL`, and importing the schema — even for a type — drags
 * postgres.js in with it (see docs/testing.md, and the same note on
 * `DateQualifier` in `lib/family-graph.ts`).
 *
 * Drift is caught at compile time anyway, in the direction that matters:
 * `lib/save-individual.ts` inserts these values into the Drizzle column, so a
 * member here that the database enum does not have is a type error at the
 * insert. The reverse — the enum gaining a value this list does not offer —
 * is a deliberate product change, and the form that exposes it is the edit
 * that adds it here.
 */
export const SEXES = ["male", "female", "other", "unknown"] as const;

export type Sex = (typeof SEXES)[number];

/**
 * How much to trust the date sitting next to this qualifier — GEDCOM 5.5.1's
 * date modifiers, mirroring the `date_qualifier` enum in `db/schema.ts`.
 *
 * Structurally identical to `DateQualifier` in `lib/family-graph.ts`, which
 * that module declares for the read path for the same "do not pull in the
 * schema" reason. They are not shared because the dependency would run the
 * wrong way: `lib/family-graph.ts` imports `@/db`, so a write-path module
 * importing its type would make every consumer of this file — including a
 * form component — reach for postgres.js.
 */
export const DATE_QUALIFIERS = ["exact", "about", "before", "after"] as const;

export type DateQualifier = (typeof DATE_QUALIFIERS)[number];

/**
 * A person's details, cleaned and ready to be written.
 *
 * Every field is settled: text is trimmed, "not given" is `null` rather than
 * `""`, and both enums hold a real member rather than a string that happens
 * to look like one. This is the type `lib/save-individual.ts` inserts, and
 * the only type any caller should be passing to the database.
 *
 * `pageId` is absent on purpose. Linking a person to their wiki entry is E2's
 * job, and a create/update path that accepted it would let a direct POST
 * re-point somebody else's entry at a person of its choosing — an authority
 * this form neither has nor needs.
 */
export type IndividualFields = {
  givenName: string;
  surname: string | null;
  sex: Sex;
  /** ISO `YYYY-MM-DD`, or null when unknown. */
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  birthPlace: string | null;
  /** ISO `YYYY-MM-DD`, or null when unknown. */
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
  deathPlace: string | null;
  notes: string | null;
};

/** The name of a field a problem can be attached to. */
export type IndividualField = keyof IndividualFields;

/**
 * A person's details as they arrive: one property per field, every value
 * `unknown`.
 *
 * `unknown` rather than `string` is the point of this type. The values come
 * from a `FormData` entry (`string | File | null`), from a GEDCOM record, or
 * from a POST somebody hand-crafted — so "it is a string" is a conclusion
 * `validateIndividual` reaches, not a premise a caller may assert. Typing it
 * as `string` would push every caller into a cast at the boundary, which is
 * the `any` this ticket exists to avoid wearing a different hat.
 *
 * Every property is optional, because a caller that knows nothing about a
 * field should be able to leave it out rather than invent a value for it.
 */
export type IndividualInput = {
  [Field in IndividualField]?: unknown;
};

/**
 * One problem with one field, in words meant for the person who typed it.
 *
 * `field` is always a real field rather than a general "form" bucket, so a
 * form can render the message beside the input it belongs to. Cross-field
 * rules pick the field the author would change to fix them: "death before
 * birth" is reported against the death date, because that is the one being
 * questioned.
 */
export type ValidationIssue = {
  field: IndividualField;
  /** A complete sentence, safe to render directly. */
  message: string;
};

/**
 * Problems keyed by field, which is the shape a form actually renders.
 *
 * At most one message per field — the first one found. A field with two
 * things wrong with it is a field whose author should fix the first and look
 * again; stacking messages under one input reads as shouting.
 */
export type IndividualFieldErrors = Partial<Record<IndividualField, string>>;

/**
 * Either a clean record or the reasons there isn't one. Never both.
 *
 * A discriminated union rather than `{ value, issues }` with one of them
 * empty, so a caller cannot write the value without having checked, and
 * TypeScript narrows `value` to non-optional the moment they have.
 */
export type IndividualValidation =
  | { ok: true; value: IndividualFields }
  | { ok: false; issues: ValidationIssue[] };

/**
 * How long a name or a place may be.
 *
 * The columns are `text` and therefore unbounded, and a server action is an
 * open POST endpoint — so without a limit here, "given name" is a way to put
 * a megabyte into a row that every tree render then reads. The number is
 * generous enough that no real name or place reaches it (the longest place
 * names in use are around 90 characters), which is what makes it a guard
 * against abuse rather than a rule an author can trip over.
 *
 * Exported so E3-T2's form can put the same number in `maxLength` and stop
 * the problem at the input, rather than discovering it after a round trip.
 */
export const MAX_NAME_LENGTH = 200;

/**
 * How long the notes field may be.
 *
 * Larger than a name and much smaller than an essay, because an essay belongs
 * in the person's wiki entry (E1), which is versioned, searchable and
 * formatted. `individuals.notes` is the margin of the index card — "adopted,
 * per the 1911 census" — and a limit that says so is kinder than one that
 * silently accepts a life story into a field nothing renders well.
 */
export const MAX_NOTES_LENGTH = 2000;

/** `YYYY-MM-DD`, the only date format stored or accepted. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Read a text field: trim it, and treat blank as absent.
 *
 * The blank-is-null rule is the one that matters. An HTML form posts every
 * field it contains, so a place nobody filled in arrives as `""` — and `""`
 * stored in a nullable column is a third state that means the same as null
 * but does not compare, sort, or coalesce like it. Collapsing it here means
 * "unknown" has exactly one representation in the database.
 *
 * @returns the trimmed text, `null` for blank or absent, or `undefined` when
 *   the value was present but not text at all, which is a caller error rather
 *   than an author's
 */
function readText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether a `YYYY-MM-DD` string names a day that exists.
 *
 * The pattern alone accepts `2023-02-30` and `2024-13-01`, and Postgres would
 * reject both with `date/time field value out of range` — a thrown error from
 * the driver rather than a message the author can act on. Round-tripping
 * through `Date.UTC` and comparing the parts back is what separates a date
 * that is merely well-shaped from one that happened: JavaScript rolls
 * February 30th forward to March 2nd, so a mismatch on any part means the
 * input named a day the calendar does not have.
 *
 * UTC rather than local time throughout, so the answer does not depend on the
 * `TZ` of whatever machine is running the import.
 */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  // Year zero is not a year in the proleptic Gregorian calendar Postgres uses,
  // and `Date.UTC` maps 0..99 to 1900..1999 — so it would round-trip as 1900
  // and quietly pass.
  if (year < 1) return false;

  const stamp = new Date(Date.UTC(year, month - 1, day));
  return (
    stamp.getUTCFullYear() === year &&
    stamp.getUTCMonth() === month - 1 &&
    stamp.getUTCDate() === day
  );
}

/**
 * Read a date field.
 *
 * Only ISO `YYYY-MM-DD` is accepted, which is exactly what `<input
 * type="date">` submits — so the form ticket needs no conversion, and the
 * stored value needs no interpretation.
 *
 * What this deliberately does *not* do is parse "abt 1890" or "before 1920".
 * That is E4-T2's date input, whose whole job is to turn what a person types
 * into a date plus a qualifier — the pair this module then validates. Putting
 * a second, looser parser here would give the app two answers to "what does
 * `1890` mean", and the one nobody could see would win on the import path.
 *
 * @returns the date, `null` when absent, or `undefined` when it is not a
 *   usable date — the caller turns that into an issue
 */
function readDate(value: unknown): string | null | undefined {
  const text = readText(value);
  if (text === null || text === undefined) return text;

  const match = ISO_DATE_PATTERN.exec(text);
  if (!match) return undefined;

  const [, year, month, day] = match;
  if (!isRealCalendarDay(Number(year), Number(month), Number(day))) {
    return undefined;
  }

  return text;
}

/**
 * Read one of the fixed vocabularies (`sex`, the two date qualifiers).
 *
 * An absent or blank value takes the column's default rather than failing:
 * both enums have a member that means "nothing was said" (`unknown`,
 * `exact`), so a form that omits the field entirely is expressing something
 * the schema can already hold. Anything else present but unrecognised *is* an
 * error — it can only come from a hand-made POST or from a bug, and silently
 * defaulting it would write a value nobody chose.
 */
function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T | undefined {
  const text = readText(value);
  if (text === null) return fallback;
  if (text === undefined) return undefined;

  return (allowed as readonly string[]).includes(text)
    ? (text as T)
    : undefined;
}

/**
 * The earliest and latest day a date-plus-qualifier could actually mean.
 *
 * This is what makes "death not before birth" defensible rather than
 * annoying. A qualifier is not decoration: `before 1920` genuinely asserts
 * nothing about how much earlier, and `about 1890` asserts nothing precise in
 * either direction. Comparing the stored days alone would reject a perfectly
 * ordinary record — born *about* 1890-01-01, died 1889-12-01, which any
 * genealogist would read as "born around 1889 or 1890" and accept.
 *
 * So each date becomes an interval and the rule fires only when the intervals
 * cannot overlap:
 *
 * | qualifier | means | interval |
 * | --- | --- | --- |
 * | `exact` | that day | `[d, d]` |
 * | `before` | at some point up to then | `(−∞, d]` |
 * | `after` | at some point from then on | `[d, +∞)` |
 * | `about` | roughly then, unquantified | `(−∞, +∞)` |
 *
 * `about` widening to everything is the conservative reading, and the right
 * one for a validator: the alternative is inventing a tolerance (five years?
 * ten?) and refusing records that fall outside a number nobody chose.
 *
 * `null` for a bound means unbounded in that direction.
 */
function dateRange(
  date: string,
  qualifier: DateQualifier,
): { earliest: string | null; latest: string | null } {
  switch (qualifier) {
    case "exact":
      return { earliest: date, latest: date };
    case "before":
      return { earliest: null, latest: date };
    case "after":
      return { earliest: date, latest: null };
    case "about":
      return { earliest: null, latest: null };
  }
}

/**
 * Whether a death could not possibly have followed a birth.
 *
 * True only when the *latest* the death could have been is still earlier than
 * the *earliest* the birth could have been — the one case that is wrong under
 * every reading of the qualifiers.
 *
 * Same-day is allowed, and that is not an oversight: an infant who lived
 * hours is a record a family wiki has to be able to hold, and a validator
 * that refused it would be telling a bereaved family their data is invalid.
 *
 * ISO `YYYY-MM-DD` is fixed-width and zero-padded, so its lexicographic order
 * is its chronological order and no parsing is needed to compare two of them.
 */
function isImpossibleOrder(
  birth: { date: string; qualifier: DateQualifier },
  death: { date: string; qualifier: DateQualifier },
): boolean {
  const birthEarliest = dateRange(birth.date, birth.qualifier).earliest;
  const deathLatest = dateRange(death.date, death.qualifier).latest;

  if (birthEarliest === null || deathLatest === null) return false;
  return deathLatest < birthEarliest;
}

/**
 * Check and clean one person's details.
 *
 * Pure: no database, no session, no request. Call it from a server action, a
 * script, an import loop, or a test — it cannot tell the difference, which is
 * the property E6-T2 depends on.
 *
 * Every field is examined even after one has failed, so an author fixing a
 * form sees everything that is wrong with it in one pass rather than
 * discovering the next problem each time they resubmit.
 *
 * @param input the details as they arrived, untrusted and untyped
 * @returns the cleaned record, or every problem found
 */
export function validateIndividual(
  input: IndividualInput,
): IndividualValidation {
  const issues: ValidationIssue[] = [];
  const add = (field: IndividualField, message: string) =>
    issues.push({ field, message });

  const givenName = readText(input.givenName);
  if (givenName === undefined) {
    add("givenName", "The first name could not be read as text.");
  } else if (givenName === null) {
    // The one required field, and the ticket says so. A person with no name
    // at all is not a record anybody can find again — the tree would draw an
    // unlabelled box, and the index would sort it nowhere.
    add("givenName", "Give this person a first name.");
  } else if (givenName.length > MAX_NAME_LENGTH) {
    add(
      "givenName",
      `The first name is too long — keep it under ${MAX_NAME_LENGTH} characters.`,
    );
  }

  const surname = readText(input.surname);
  if (surname === undefined) {
    add("surname", "The surname could not be read as text.");
  } else if (surname !== null && surname.length > MAX_NAME_LENGTH) {
    add(
      "surname",
      `The surname is too long — keep it under ${MAX_NAME_LENGTH} characters.`,
    );
  }

  const sex = readEnum(input.sex, SEXES, "unknown");
  if (sex === undefined) {
    add("sex", "That is not one of the options for sex.");
  }

  const birthDate = readDate(input.birthDate);
  if (birthDate === undefined) {
    add(
      "birthDate",
      "The birth date needs to be a real date, like 1890-04-12.",
    );
  }

  const birthDateQualifier = readEnum(
    input.birthDateQualifier,
    DATE_QUALIFIERS,
    "exact",
  );
  if (birthDateQualifier === undefined) {
    add("birthDateQualifier", "That is not one of the options for a date.");
  }

  const birthPlace = readText(input.birthPlace);
  if (birthPlace === undefined) {
    add("birthPlace", "The birth place could not be read as text.");
  } else if (birthPlace !== null && birthPlace.length > MAX_NAME_LENGTH) {
    add(
      "birthPlace",
      `The birth place is too long — keep it under ${MAX_NAME_LENGTH} characters.`,
    );
  }

  const deathDate = readDate(input.deathDate);
  if (deathDate === undefined) {
    add(
      "deathDate",
      "The death date needs to be a real date, like 1953-11-02.",
    );
  }

  const deathDateQualifier = readEnum(
    input.deathDateQualifier,
    DATE_QUALIFIERS,
    "exact",
  );
  if (deathDateQualifier === undefined) {
    add("deathDateQualifier", "That is not one of the options for a date.");
  }

  const deathPlace = readText(input.deathPlace);
  if (deathPlace === undefined) {
    add("deathPlace", "The death place could not be read as text.");
  } else if (deathPlace !== null && deathPlace.length > MAX_NAME_LENGTH) {
    add(
      "deathPlace",
      `The death place is too long — keep it under ${MAX_NAME_LENGTH} characters.`,
    );
  }

  const notes = readText(input.notes);
  if (notes === undefined) {
    add("notes", "The notes could not be read as text.");
  } else if (notes !== null && notes.length > MAX_NOTES_LENGTH) {
    add(
      "notes",
      `The notes are too long — keep them under ${MAX_NOTES_LENGTH} characters. Longer stories belong in this person's entry.`,
    );
  }

  /**
   * The cross-field rule, checked only once both dates are known to be
   * readable. Running it on a date that failed above would report a second
   * problem caused entirely by the first, and send the author looking at the
   * wrong field.
   */
  if (
    birthDate &&
    deathDate &&
    birthDateQualifier !== undefined &&
    deathDateQualifier !== undefined &&
    isImpossibleOrder(
      { date: birthDate, qualifier: birthDateQualifier },
      { date: deathDate, qualifier: deathDateQualifier },
    )
  ) {
    add(
      "deathDate",
      "The death date is before the birth date. Check whether one of them has the wrong year.",
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
      givenName: givenName ?? "",
      surname: surname ?? null,
      sex: sex ?? "unknown",
      birthDate: birthDate ?? null,
      /**
       * A qualifier with no date beside it is normalised away. The schema's
       * note is explicit that a qualifier is only ever read alongside its
       * date and that "no date at all" is already said by the date being
       * null — so storing `about` next to a null birth date would be a second
       * way of saying nothing, and one that survives into a GEDCOM export as
       * a stray `ABT`.
       */
      birthDateQualifier: birthDate ? (birthDateQualifier ?? "exact") : "exact",
      birthPlace: birthPlace ?? null,
      deathDate: deathDate ?? null,
      deathDateQualifier: deathDate ? (deathDateQualifier ?? "exact") : "exact",
      deathPlace: deathPlace ?? null,
      notes: notes ?? null,
    },
  };
}

/**
 * Collapse a list of issues into one message per field.
 *
 * The list is what an importer wants (every problem, in order, for a report);
 * this is what a form wants (a message to hang under each input). Keeping
 * both means neither caller has to reshape the other's answer.
 *
 * First issue wins per field, matching the order `validateIndividual` finds
 * them in — which is the order the fields appear on the form.
 */
export function fieldErrorsFrom(
  issues: readonly ValidationIssue[],
): IndividualFieldErrors {
  const errors: IndividualFieldErrors = {};
  for (const issue of issues) {
    errors[issue.field] ??= issue.message;
  }
  return errors;
}

/**
 * Pull a person's fields out of a submitted form.
 *
 * The input names are the property names of `IndividualFields`, so a form
 * writes `name="givenName"` and nothing has to be mapped or renamed. Sibling
 * tickets get this for free: an `<input name="birthDate" type="date">` is
 * already wired to the right column.
 *
 * `FormData.get` returns `string | File | null`, and all three are passed
 * straight through as `unknown` rather than being coerced here. That is the
 * division of labour this module is built on — this function knows the field
 * *names*, `validateIndividual` knows what a valid *value* is, and neither
 * has to be changed when the other does. A `File` posted into the name field
 * therefore comes back as an ordinary validation issue rather than as the
 * string `"[object File]"` in somebody's family tree.
 *
 * A web API, not a Next.js one: `FormData` is a global in Node 18+, so this
 * is callable from a script or a test with no request in sight.
 */
export function individualInputFromFormData(form: FormData): IndividualInput {
  return {
    givenName: form.get("givenName"),
    surname: form.get("surname"),
    sex: form.get("sex"),
    birthDate: form.get("birthDate"),
    birthDateQualifier: form.get("birthDateQualifier"),
    birthPlace: form.get("birthPlace"),
    deathDate: form.get("deathDate"),
    deathDateQualifier: form.get("deathDateQualifier"),
    deathPlace: form.get("deathPlace"),
    notes: form.get("notes"),
  };
}
