"use client";

import { useEffect, useId, useRef } from "react";

import { FormSelect } from "@/components/FormSelect";
import {
  DATE_QUALIFIERS,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  SEXES,
  type DateQualifier,
  type IndividualField,
  type IndividualFieldErrors,
  type Sex,
} from "@/lib/individual-input";

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
 * `defaultSelected` flag. So the three selects here are `FormSelect`, which
 * keeps that flag in step — without it a refused submission quietly reverts
 * `sex` to `male` and both qualifiers to `exact`. See `components/FormSelect.tsx`.
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
export type IndividualFormValues = Record<IndividualField, string>;

/**
 * A blank person, for a form that is starting one.
 *
 * Frozen for the same reason `emptyIndividualFormState` is: it is a shared
 * default held across renders, and a mutable one would leak a half-typed
 * person from one form into the next that mounted.
 *
 * The two qualifiers start at `exact` rather than blank because they are
 * `select`s with no empty option — a date is exact until somebody says
 * otherwise, which is also the column default.
 */
export const emptyIndividualFormValues: IndividualFormValues = Object.freeze({
  givenName: "",
  surname: "",
  sex: "unknown",
  birthDate: "",
  birthDateQualifier: "exact",
  birthPlace: "",
  deathDate: "",
  deathDateQualifier: "exact",
  deathPlace: "",
  notes: "",
});

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

/**
 * What each date qualifier is called on screen.
 *
 * Prepositions rather than the stored words, because the control sits
 * immediately before the date and the two are read as one phrase: "Born about
 * 1890", "Died before 1953-11-02". "Exact" as a label would be a category
 * name in the middle of a sentence.
 */
const QUALIFIER_LABELS: Record<DateQualifier, string> = {
  exact: "on",
  about: "about",
  before: "before",
  after: "after",
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
  onChange: (field: IndividualField, value: string) => void;
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
  const fieldName = (field: IndividualField) => `${namePrefix}${field}`;
  const fieldId = (field: IndividualField) => `${base}-${field}`;
  const errorId = (field: IndividualField) => `${base}-${field}-error`;
  const describedBy = (field: IndividualField) =>
    fieldErrors[field] === undefined ? undefined : errorId(field);
  const invalid = (field: IndividualField) => fieldErrors[field] !== undefined;

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

      <DateRow
        legend="Born"
        dateField="birthDate"
        qualifierField="birthDateQualifier"
        qualifierLabel="How exact the birth date is"
        fieldName={fieldName}
        values={values}
        onChange={onChange}
        fieldErrors={fieldErrors}
        disabled={disabled}
        fieldId={fieldId}
        errorId={errorId}
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

      <DateRow
        legend="Died"
        dateField="deathDate"
        qualifierField="deathDateQualifier"
        qualifierLabel="How exact the death date is"
        fieldName={fieldName}
        values={values}
        onChange={onChange}
        fieldErrors={fieldErrors}
        disabled={disabled}
        fieldId={fieldId}
        errorId={errorId}
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
 * A date and how much to trust it, as one row.
 *
 * The qualifier is a control rather than a checkbox marked "approximate"
 * because there are four answers and three of them are common in
 * genealogy — "about 1890" off a census age, "before 1920" from a probate
 * record, "after 1918" from a last letter. They are also exactly GEDCOM's
 * `ABT`/`BEF`/`AFT`, so what an author picks here survives an export.
 *
 * Its label is visually hidden: the two controls read as one phrase on screen
 * ("Born · about · 1890-04-12") and repeating "How exact the birth date is"
 * beside them would be noise. A screen reader still gets the sentence, because
 * an unlabelled `select` is a control nobody can identify out of context.
 */
function DateRow({
  legend,
  dateField,
  qualifierField,
  qualifierLabel,
  fieldName,
  values,
  onChange,
  fieldErrors,
  disabled,
  fieldId,
  errorId,
}: {
  legend: string;
  dateField: "birthDate" | "deathDate";
  qualifierField: "birthDateQualifier" | "deathDateQualifier";
  qualifierLabel: string;
  fieldName: (field: IndividualField) => string;
  values: IndividualFormValues;
  onChange: (field: IndividualField, value: string) => void;
  fieldErrors: IndividualFieldErrors;
  disabled: boolean;
  fieldId: (field: IndividualField) => string;
  errorId: (field: IndividualField) => string;
}) {
  return (
    <div>
      <Label htmlFor={fieldId(dateField)}>{legend}</Label>
      <div className="mt-1 flex gap-2">
        <label htmlFor={fieldId(qualifierField)} className="sr-only">
          {qualifierLabel}
        </label>
        <FormSelect
          id={fieldId(qualifierField)}
          name={fieldName(qualifierField)}
          disabled={disabled}
          value={values[qualifierField]}
          onChange={(event) => onChange(qualifierField, event.target.value)}
          aria-invalid={fieldErrors[qualifierField] !== undefined}
          aria-describedby={
            fieldErrors[qualifierField] === undefined
              ? undefined
              : errorId(qualifierField)
          }
          className="rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {DATE_QUALIFIERS.map((qualifier) => (
            <option key={qualifier} value={qualifier}>
              {QUALIFIER_LABELS[qualifier]}
            </option>
          ))}
        </FormSelect>
        <input
          id={fieldId(dateField)}
          name={fieldName(dateField)}
          type="date"
          disabled={disabled}
          value={values[dateField]}
          onChange={(event) => onChange(dateField, event.target.value)}
          aria-invalid={fieldErrors[dateField] !== undefined}
          aria-describedby={
            fieldErrors[dateField] === undefined
              ? undefined
              : errorId(dateField)
          }
          className="min-w-0 flex-1 rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
      <FieldError
        id={errorId(qualifierField)}
        message={fieldErrors[qualifierField]}
      />
      <FieldError id={errorId(dateField)} message={fieldErrors[dateField]} />
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
