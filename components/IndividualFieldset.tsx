"use client";

import { useEffect, useId, useRef } from "react";

import { DateField } from "@/components/DateField";
import { FormSelect } from "@/components/FormSelect";
import {
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  SEXES,
  type IndividualField,
  type IndividualFieldErrors,
  type IndividualFields,
  type Sex,
} from "@/lib/individual-input";
import { formatQualifiedDate } from "@/lib/person-format";

/**
 * One person's details as a set of form controls (E3-T2, `YEO-30`).
 *
 * ## Why the fields are a component of their own
 *
 * Three flows put the same ten fields on screen: adding a person (E3-T2, the
 * panel next door), editing one (E3-T3), and creating a partner inline while
 * building a union (E3-T4). They differ in which action they submit to and in
 * what they do afterwards — not in what a person is. Splitting the fields from
 * the submission is what keeps "the surname input is 200 characters and says
 * so" written once, and it is why this component knows nothing about server
 * actions, panels, or saving.
 *
 * Every input's `name` is the matching key of `IndividualFields`, which is the
 * contract `individualInputFromFormData` was built around: nothing between
 * here and the database renames anything, so a field added to the record is a
 * field added here and nowhere else.
 *
 * `namePrefix` is the one exception, and E3-T4 is why it exists. The
 * add-spouse form submits a person and a *union* in one request, and both
 * records have a `notes` field — so the partner's inputs are namespaced under
 * `partner.` and stripped back off on the server by
 * `addSpouseInputFromFormData`. The prefix only ever moves the whole set at
 * once, so the names stay written down here and nowhere else.
 *
 * ## Why the inputs are controlled
 *
 * React resets an uncontrolled form on *every* submission through a form
 * action — `startHostTransition` calls `requestFormReset` before it calls the
 * action, without waiting to see what the action says. For a form whose whole
 * job is to come back and report which field is wrong, that is the worst
 * possible default: the author fixes the birth date and discovers the name,
 * the places and the notes they typed have all been wiped. Holding the values
 * in the caller's state makes React's reset a no-op and puts clearing the form
 * where it belongs — after a save that actually happened.
 *
 * The cost is that this half of the page needs JavaScript. On `/tree` that is
 * not a cost at all: the tree it adds to is a React Flow canvas.
 *
 * Controlled is necessary and, for `<select>`, not sufficient. React makes a
 * reset harmless for inputs by writing `node.defaultValue` beside the value;
 * it has no equivalent for a select, whose DOM default lives in each option's
 * `defaultSelected` flag. So the one select here is `FormSelect`, which keeps
 * that flag in step — without it a refused submission quietly reverts `sex` to
 * `male`. See `components/FormSelect.tsx`.
 *
 * ## Where the date qualifiers went (E4-T2, `YEO-39`)
 *
 * There used to be three selects, because each date was a `select` of
 * `exact`/`about`/`before`/`after` in front of an `<input type="date">`. Both
 * dates are now a single `DateField` text box that reads "about 1890" and
 * works the qualifier out for itself, so a date's qualifier and precision are
 * derived rather than chosen and are not values this form holds. That is why
 * `IndividualFormValues` below is narrower than `IndividualFields`.
 */

/**
 * The fields as a form holds them: every value a string, including the ones
 * that end up as enums or dates.
 *
 * Not `IndividualFields`, and deliberately. That type is the *record* — nulls
 * for what is unknown, a real `Sex`, an ISO date or nothing. An input has no
 * way to hold a null: an empty text box is `""` and an empty date input is
 * `""` too. Converting between the two is `validateIndividual`'s job, and it
 * already does it for every caller including GEDCOM import, so doing it again
 * here would be a second, quieter set of rules about what blank means.
 */
export type IndividualFormValues = Record<IndividualFormField, string>;

/**
 * The fields a person form actually holds a value for.
 *
 * `IndividualFields` minus the four columns nobody types: a date's qualifier
 * and its precision are read out of the date the author wrote (E4-T2,
 * `YEO-39`), so holding them here as well would be a second copy free to
 * disagree with the text on screen. `DateField` derives them on every render
 * and posts them as hidden inputs, which is what keeps this form's state and
 * what it submits from drifting apart.
 */
export type IndividualFormField = Exclude<
  IndividualField,
  | "birthDateQualifier"
  | "birthDatePrecision"
  | "deathDateQualifier"
  | "deathDatePrecision"
>;

/**
 * A blank person, for a form that is starting one.
 *
 * Frozen for the same reason `emptyIndividualFormState` is: it is a shared
 * default held across renders, and a mutable one would leak a half-typed
 * person from one form into the next that mounted.
 *
 * Both dates start blank, qualifier and all: a date nobody has typed has
 * nothing to qualify, and `DateField` posts the column defaults for an empty
 * box.
 */
export const emptyIndividualFormValues: IndividualFormValues = Object.freeze({
  givenName: "",
  surname: "",
  sex: "unknown",
  birthDate: "",
  birthPlace: "",
  deathDate: "",
  deathPlace: "",
  notes: "",
});

/**
 * A person who already exists, as a form can hold them (E3-T3, `YEO-31`).
 *
 * The other direction of the conversion described above, and the one the edit
 * form needs: `IndividualFields` is the record — `null` for what is unknown —
 * and an input has no way to hold a null, so every absent value becomes the
 * empty string the control would show anyway. Going back is
 * `validateIndividual`'s job, and it collapses blank to `null` again, which is
 * what makes clearing a field on the edit form write a null rather than an
 * empty string. The round trip closes by construction rather than by two sets
 * of rules agreeing with each other.
 *
 * Deliberately not written when the fieldset was: E3-T2 starts from a blank
 * person and has nothing to convert. It appears now because E3-T3 is the first
 * caller with a record in hand, and it lives beside `IndividualFormValues` so
 * that the type and both ways of producing it stay in one place.
 *
 * Written out field by field rather than mapped over the keys, so that a
 * column added to `IndividualFields` is a type error here rather than a value
 * quietly missing from a prefilled form.
 *
 * Each date goes back through `formatQualifiedDate`, which is the same
 * function the detail panel renders with — so what the edit form shows is
 * literally what the rest of the app shows, and `parseDateInput` reads it
 * straight back into the three columns it came from. That round trip
 * (asserted in `lib/parse-date.test.ts`) is what lets a free-text date box be
 * prefilled without a second, quieter formatter written to serve it.
 *
 * The parameter is `IndividualFields` rather than `GraphPerson` on purpose —
 * the graph's person is that type plus an `id` and a `pageId`, so it is
 * accepted as it stands, and so is a row read any other way.
 */
export function individualFormValuesFrom(
  fields: IndividualFields,
): IndividualFormValues {
  return {
    givenName: fields.givenName,
    surname: fields.surname ?? "",
    sex: fields.sex,
    birthDate:
      formatQualifiedDate(
        fields.birthDate,
        fields.birthDateQualifier,
        fields.birthDatePrecision,
      ) ?? "",
    birthPlace: fields.birthPlace ?? "",
    deathDate:
      formatQualifiedDate(
        fields.deathDate,
        fields.deathDateQualifier,
        fields.deathDatePrecision,
      ) ?? "",
    deathPlace: fields.deathPlace ?? "",
    notes: fields.notes ?? "",
  };
}

/**
 * What each `sex` value is called on screen.
 *
 * A record rather than capitalising the stored value, so the wording is a
 * product decision made here rather than a side effect of what the enum
 * happens to be spelled like.
 */
const SEX_LABELS: Record<Sex, string> = {
  male: "Male",
  female: "Female",
  other: "Other",
  unknown: "Unknown",
};

const CONTROL_CLASS =
  "mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

export interface IndividualFieldsetProps {
  /** The current values, held by the caller. See the note on control above. */
  values: IndividualFormValues;
  /**
   * Prepended to every input's `name`, for a form that posts a person
   * alongside another record. Empty by default, which is the plain case.
   */
  namePrefix?: string;
  /** One field changed. The caller merges it into `values`. */
  onChange: (field: IndividualFormField, value: string) => void;
  /** Messages to show under the inputs they belong to. Empty when all is well. */
  fieldErrors: IndividualFieldErrors;
  /** Grey everything out while a submission is in flight. */
  disabled?: boolean;
  /**
   * Put focus on the first field once this is mounted — for a panel that has
   * just opened, where the author's next action is certainly to start typing.
   */
  autoFocusFirstField?: boolean;
}

export function IndividualFieldset({
  values,
  namePrefix = "",
  onChange,
  fieldErrors,
  disabled = false,
  autoFocusFirstField = false,
}: IndividualFieldsetProps) {
  /**
   * One generated base, suffixed per field, rather than a `useId()` per
   * input. Ten hooks would say nothing extra: `useId` already guarantees the
   * base is unique to this instance, which is what lets two of these sit on
   * one page — E3-T4 puts an existing partner beside a new one.
   */
  const base = useId();
  const fieldName = (field: IndividualFormField) => `${namePrefix}${field}`;
  const fieldId = (field: IndividualFormField) => `${base}-${field}`;
  const errorId = (field: IndividualFormField) => `${base}-${field}-error`;
  const describedBy = (field: IndividualFormField) =>
    fieldErrors[field] === undefined ? undefined : errorId(field);
  const invalid = (field: IndividualFormField) =>
    fieldErrors[field] !== undefined;

  /**
   * Every message a date can come back with, in one place.
   *
   * The qualifier and the precision are derived by `DateField`, so only a
   * hand-made POST can get them refused — but "only" is not "never", and a
   * message with no field on screen to hang under is a message nobody ever
   * sees. Folding them into the date's own slot keeps the promise that nothing
   * is silently dropped.
   */
  const dateError = (field: "birthDate" | "deathDate") =>
    fieldErrors[field] ??
    fieldErrors[`${field}Qualifier`] ??
    fieldErrors[`${field}Precision`];

  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusFirstField) firstField.current?.focus();
  }, [autoFocusFirstField]);

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor={fieldId("givenName")} required>
          First name
        </Label>
        <input
          ref={firstField}
          id={fieldId("givenName")}
          name={fieldName("givenName")}
          type="text"
          /**
           * The one field a person cannot be recorded without, so the browser
           * catches it before the round trip — the same reasoning as
           * `NewEntryForm`'s title. `validateIndividual` checks it again
           * regardless: the action is a POST endpoint, not a form.
           */
          required
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          disabled={disabled}
          value={values.givenName}
          onChange={(event) => onChange("givenName", event.target.value)}
          aria-invalid={invalid("givenName")}
          aria-describedby={describedBy("givenName")}
          className={CONTROL_CLASS}
        />
        <FieldError id={errorId("givenName")} message={fieldErrors.givenName} />
      </div>

      <div>
        <Label htmlFor={fieldId("surname")}>Surname</Label>
        <input
          id={fieldId("surname")}
          name={fieldName("surname")}
          type="text"
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          disabled={disabled}
          value={values.surname}
          onChange={(event) => onChange("surname", event.target.value)}
          aria-invalid={invalid("surname")}
          aria-describedby={describedBy("surname")}
          className={CONTROL_CLASS}
        />
        <FieldError id={errorId("surname")} message={fieldErrors.surname} />
      </div>

      <div>
        <Label htmlFor={fieldId("sex")}>Sex</Label>
        <FormSelect
          id={fieldId("sex")}
          name={fieldName("sex")}
          disabled={disabled}
          value={values.sex}
          onChange={(event) => onChange("sex", event.target.value)}
          aria-invalid={invalid("sex")}
          aria-describedby={describedBy("sex")}
          className={CONTROL_CLASS}
        >
          {SEXES.map((sex) => (
            <option key={sex} value={sex}>
              {SEX_LABELS[sex]}
            </option>
          ))}
        </FormSelect>
        <FieldError id={errorId("sex")} message={fieldErrors.sex} />
      </div>

      <DateField
        legend="Born"
        name={fieldName("birthDate")}
        value={values.birthDate}
        onChange={(value) => onChange("birthDate", value)}
        error={dateError("birthDate")}
        disabled={disabled}
        className={CONTROL_CLASS}
      />

      <div>
        <Label htmlFor={fieldId("birthPlace")}>Birth place</Label>
        <input
          id={fieldId("birthPlace")}
          name={fieldName("birthPlace")}
          type="text"
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          disabled={disabled}
          value={values.birthPlace}
          onChange={(event) => onChange("birthPlace", event.target.value)}
          aria-invalid={invalid("birthPlace")}
          aria-describedby={describedBy("birthPlace")}
          className={CONTROL_CLASS}
        />
        <FieldError
          id={errorId("birthPlace")}
          message={fieldErrors.birthPlace}
        />
      </div>

      <DateField
        legend="Died"
        name={fieldName("deathDate")}
        value={values.deathDate}
        onChange={(value) => onChange("deathDate", value)}
        error={dateError("deathDate")}
        disabled={disabled}
        className={CONTROL_CLASS}
      />

      <div>
        <Label htmlFor={fieldId("deathPlace")}>Death place</Label>
        <input
          id={fieldId("deathPlace")}
          name={fieldName("deathPlace")}
          type="text"
          maxLength={MAX_NAME_LENGTH}
          autoComplete="off"
          disabled={disabled}
          value={values.deathPlace}
          onChange={(event) => onChange("deathPlace", event.target.value)}
          aria-invalid={invalid("deathPlace")}
          aria-describedby={describedBy("deathPlace")}
          className={CONTROL_CLASS}
        />
        <FieldError
          id={errorId("deathPlace")}
          message={fieldErrors.deathPlace}
        />
      </div>

      <div>
        <Label htmlFor={fieldId("notes")}>Notes</Label>
        <textarea
          id={fieldId("notes")}
          name={fieldName("notes")}
          rows={3}
          maxLength={MAX_NOTES_LENGTH}
          disabled={disabled}
          value={values.notes}
          onChange={(event) => onChange("notes", event.target.value)}
          aria-invalid={invalid("notes")}
          aria-describedby={describedBy("notes")}
          className={CONTROL_CLASS}
        />
        <FieldError id={errorId("notes")} message={fieldErrors.notes} />
        <p className="mt-1 text-note text-ink-muted">
          A line from a census or a headstone. Longer stories belong in this
          person&rsquo;s entry.
        </p>
      </div>
    </div>
  );
}

/**
 * A field's label.
 *
 * Only the first name is marked, and as "(required)" in words rather than an
 * asterisk — partial knowledge is the normal case in genealogy, so the useful
 * thing to say is which single field is not optional, not to decorate the nine
 * that are with a legend the author has to go and find.
 */
function Label({
  htmlFor,
  required = false,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-caption text-ink-muted">
      {children}
      {required ? <span className="text-ink-muted"> (required)</span> : null}
    </label>
  );
}

/**
 * What is wrong with one field, under that field.
 *
 * `role="alert"` so the message is announced when it appears rather than only
 * when the author next tabs onto the input — a submission that came back
 * refused has already moved on from the field it is about. The sentences
 * themselves come from `validateIndividual`, which writes them in plain
 * language for exactly this spot; nothing is reworded on the way here.
 */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (message === undefined) return null;

  return (
    <p id={id} role="alert" className="mt-1 text-note text-ink">
      {message}
    </p>
  );
}
