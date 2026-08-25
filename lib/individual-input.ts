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
 *
 * ## Where the field readers went
 *
 * `readText`, `readDate`, `readEnum` and `isImpossibleOrder` were private to
 * this file until `lib/union-input.ts` (E3-T4, `YEO-32`) needed exactly the
 * same three kinds of field and the same comparison over two qualified dates.
 * They now live in `lib/field-input.ts`, which is equally dependency-free, and
 * are imported back here. Nothing this module exports changed:
 * `DATE_QUALIFIERS`, `DateQualifier` and `MAX_NOTES_LENGTH` are re-exported
 * below, so every caller that already names this module keeps working.
 */

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
} from "./field-input";
import { readPortraitKey } from "./portrait";

export {
  DATE_PRECISIONS,
  DATE_QUALIFIERS,
  type DatePrecision,
  type DateQualifier,
  MAX_NOTES_LENGTH,
} from "./field-input";

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
  /**
   * ISO `YYYY-MM-DD`, or null when unknown. An *anchor* rather than a day
   * whenever `birthDatePrecision` is coarser than `day` — see
   * `DATE_PRECISIONS` in `lib/field-input.ts`.
   */
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  birthDatePrecision: DatePrecision;
  /**
   * The upper bound of a range (`YEO-88`) — `BET 1890 AND 1900` stores
   * `1890` here as `birthDate` and `1900` here. `null` when the birth date is
   * a single point, which is every record that predates this ticket.
   */
  birthDateUpper: string | null;
  birthDateUpperPrecision: DatePrecision;
  birthPlace: string | null;
  /** ISO `YYYY-MM-DD`, or null when unknown. An anchor, as `birthDate` is. */
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
  deathDatePrecision: DatePrecision;
  /** The upper bound of a range, as `birthDateUpper` is. */
  deathDateUpper: string | null;
  deathDateUpperPrecision: DatePrecision;
  deathPlace: string | null;
  notes: string | null;
  /**
   * The person's portrait, as a storage key (E5-T4, `YEO-44`).
   *
   * A **key**, and this is the one field here that is not something anybody
   * types. The photograph is uploaded by `POST /api/images` before this form
   * is submitted, and what reaches the form is the key that endpoint minted —
   * carried in a hidden input, the same way a date's derived precision is.
   * So the value arriving here has already been through the endpoint's
   * allowlist, its metadata scrub and its own key mint.
   *
   * That is not a reason to trust it. A server action is an open POST, so the
   * key is checked against the same rules `lib/storage-key.ts` applies on the
   * way in — inside the `images/` namespace, and legal as a path — before it
   * can become a column that something later renders as a URL. See
   * `readPortraitKey`.
   */
  portraitKey: string | null;
  /**
   * The downscaled copy of {@link IndividualFields.portraitKey} the tree
   * canvas loads, as a storage key.
   *
   * Normalised away when there is no portrait beside it, exactly as a date
   * qualifier with no date is: a thumbnail of nothing is a second way of
   * saying "no portrait", and one that would leave a file referenced by a
   * column nothing renders. The reverse — a portrait with no thumbnail — is a
   * legal state and is left alone, because the browser that made the upload
   * may not have been able to produce one.
   */
  portraitThumbKey: string | null;
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
      "That birth date could not be read. Try a year like 1890, or a full date like 12 March 1890.",
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

  const birthDatePrecision = readEnum(
    input.birthDatePrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (birthDatePrecision === undefined) {
    add(
      "birthDatePrecision",
      "That is not one of the options for how much of a date is known.",
    );
  }

  const birthDateUpper = readDate(input.birthDateUpper);
  if (birthDateUpper === undefined) {
    add(
      "birthDateUpper",
      "That birth date's upper bound could not be read. Try a year like 1900, or a full date like 4 July 1900.",
    );
  }

  const birthDateUpperPrecision = readEnum(
    input.birthDateUpperPrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (birthDateUpperPrecision === undefined) {
    add(
      "birthDateUpper",
      "That is not one of the options for how much of a date is known.",
    );
  }

  // A range's qualifier is always `exact` — `exact` is what already means
  // "the value is as given, widened by its precision", and extending that
  // reading to a second bound is what a stored range *is* (`YEO-88`, see
  // `db/schema.ts`). Any other qualifier beside a non-null upper bound is a
  // state this schema has no honest reading for.
  if (
    birthDateUpper &&
    birthDateQualifier !== undefined &&
    birthDateQualifier !== "exact"
  ) {
    add(
      "birthDateUpper",
      `A range's date cannot also be qualified "${birthDateQualifier}" — a range already says how uncertain the date is.`,
    );
  }

  // A range written backwards, `BET 1900 AND 1890`. Reported against the
  // upper bound: it is the value most likely to be the typo, since the lower
  // bound is the one that reads first.
  if (
    birthDate &&
    birthDateUpper &&
    isInvertedRange(birthDate, birthDateUpper)
  ) {
    add(
      "birthDateUpper",
      "The upper bound of the birth date is before the lower bound. Check whether one of them has the wrong year.",
    );
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
      "That death date could not be read. Try a year like 1953, or a full date like 2 November 1953.",
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

  const deathDatePrecision = readEnum(
    input.deathDatePrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (deathDatePrecision === undefined) {
    add(
      "deathDatePrecision",
      "That is not one of the options for how much of a date is known.",
    );
  }

  const deathDateUpper = readDate(input.deathDateUpper);
  if (deathDateUpper === undefined) {
    add(
      "deathDateUpper",
      "That death date's upper bound could not be read. Try a year like 1953, or a full date like 2 November 1953.",
    );
  }

  const deathDateUpperPrecision = readEnum(
    input.deathDateUpperPrecision,
    DATE_PRECISIONS,
    "day",
  );
  if (deathDateUpperPrecision === undefined) {
    add(
      "deathDateUpper",
      "That is not one of the options for how much of a date is known.",
    );
  }

  if (
    deathDateUpper &&
    deathDateQualifier !== undefined &&
    deathDateQualifier !== "exact"
  ) {
    add(
      "deathDateUpper",
      `A range's date cannot also be qualified "${deathDateQualifier}" — a range already says how uncertain the date is.`,
    );
  }

  if (
    deathDate &&
    deathDateUpper &&
    isInvertedRange(deathDate, deathDateUpper)
  ) {
    add(
      "deathDateUpper",
      "The upper bound of the death date is before the lower bound. Check whether one of them has the wrong year.",
    );
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
   * The two portrait keys (E5-T4, `YEO-44`).
   *
   * The message is written for somebody who did not do this on purpose,
   * because nobody can: the field is hidden and its value comes from the
   * upload endpoint. Reaching it means the upload half went wrong or the
   * request was assembled by hand, and neither is worth a sentence about
   * storage namespaces.
   */
  const portraitKey = readPortraitKey(input.portraitKey);
  if (portraitKey === undefined) {
    add("portraitKey", "That photograph could not be attached. Try again.");
  }

  const portraitThumbKey = readPortraitKey(input.portraitThumbKey);
  if (portraitThumbKey === undefined) {
    add(
      "portraitThumbKey",
      "That photograph could not be attached. Try again.",
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
    birthDatePrecision !== undefined &&
    deathDatePrecision !== undefined &&
    isImpossibleOrder(
      {
        date: birthDate,
        qualifier: birthDateQualifier,
        precision: birthDatePrecision,
        upper: birthDateUpper ?? null,
        upperPrecision: birthDateUpperPrecision ?? "day",
      },
      {
        date: deathDate,
        qualifier: deathDateQualifier,
        precision: deathDatePrecision,
        upper: deathDateUpper ?? null,
        upperPrecision: deathDateUpperPrecision ?? "day",
      },
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
      /** Normalised away with no date beside it, for the reason above. */
      birthDatePrecision: birthDate ? (birthDatePrecision ?? "day") : "day",
      /**
       * An upper bound with no lower bound is normalised away the same way a
       * qualifier with no date is, above (`YEO-88`): `null` in `birthDate` is
       * already "this date is unknown", and a range needs a lower bound to
       * range *from*.
       */
      birthDateUpper: birthDate ? (birthDateUpper ?? null) : null,
      birthDateUpperPrecision:
        birthDate && birthDateUpper
          ? (birthDateUpperPrecision ?? "day")
          : "day",
      birthPlace: birthPlace ?? null,
      deathDate: deathDate ?? null,
      deathDateQualifier: deathDate ? (deathDateQualifier ?? "exact") : "exact",
      deathDatePrecision: deathDate ? (deathDatePrecision ?? "day") : "day",
      deathDateUpper: deathDate ? (deathDateUpper ?? null) : null,
      deathDateUpperPrecision:
        deathDate && deathDateUpper
          ? (deathDateUpperPrecision ?? "day")
          : "day",
      deathPlace: deathPlace ?? null,
      notes: notes ?? null,
      portraitKey: portraitKey ?? null,
      /**
       * A thumbnail with no portrait beside it is normalised away, exactly as
       * a qualifier with no date is above and for the same reason: the
       * portrait column being null is already the whole of "this person has
       * no photograph", and a second column disagreeing with it would leave a
       * file referenced by nothing anything renders — which is also a file
       * E5-T5's sweep would then be wrong to collect and wrong to keep.
       */
      portraitThumbKey: portraitKey ? (portraitThumbKey ?? null) : null,
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
    birthDatePrecision: form.get("birthDatePrecision"),
    birthDateUpper: form.get("birthDateUpper"),
    birthDateUpperPrecision: form.get("birthDateUpperPrecision"),
    birthPlace: form.get("birthPlace"),
    deathDate: form.get("deathDate"),
    deathDateQualifier: form.get("deathDateQualifier"),
    deathDatePrecision: form.get("deathDatePrecision"),
    deathDateUpper: form.get("deathDateUpper"),
    deathDateUpperPrecision: form.get("deathDateUpperPrecision"),
    deathPlace: form.get("deathPlace"),
    notes: form.get("notes"),
    portraitKey: form.get("portraitKey"),
    portraitThumbKey: form.get("portraitThumbKey"),
  };
}
