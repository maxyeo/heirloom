"use client";

import { useId } from "react";

import { DateField } from "@/components/DateField";
import { FormSelect } from "@/components/FormSelect";
import { MAX_NOTES_LENGTH } from "@/lib/field-input";
import { formatQualifiedDate, unionEnd, unionStart } from "@/lib/format-date";
import {
  UNION_END_REASONS,
  UNION_TYPES,
  type UnionEndReason,
  type UnionField,
  type UnionFieldErrors,
  type UnionFields,
  type UnionType,
} from "@/lib/union-input";

/**
 * One union's details as a set of form controls.
 *
 * ## Why the fields are a component of their own
 *
 * The same reason `components/IndividualFieldset.tsx` is one, arrived at from
 * the other direction. Two flows put the same five fields on screen: recording
 * a marriage (E3-T4's add-spouse form) and correcting one that is already
 * stored (the edit form next door). They differ in which action they submit
 * to, in what surrounds them, and in what they do afterwards — not in what a
 * union *is*.
 *
 * Until the edit form existed this markup lived inside `AddSpouseForm`, which
 * was correct while there was one caller and would have been the beginning of
 * a drift with two: "the notes are capped at `MAX_NOTES_LENGTH` and the
 * textarea says so", "the kind is a field rather than a default", "the two
 * dates are one text box each" are facts about a union, and a second copy of
 * them is a second place for them to stop agreeing.
 *
 * Every input's `name` is the matching key of `UnionFields`, which is the
 * contract `unionInputFromFormData` was built around: nothing between here and
 * the database renames anything.
 *
 * ## What it insists on saying out loud
 *
 * `type` and `endReason` are controls with no hidden default, because E3-T4
 * asked for that in as many words: they are "fields, not defaults to fix
 * later". The database columns do have defaults — `marriage` and `ongoing` —
 * and that is exactly the trap. A form that quietly took them would fill a
 * tree with marriages nobody said were marriages and ongoing unions between
 * people who have been dead for a century, and none of it would look wrong on
 * the canvas until somebody tried to export it. The two selects *open* on
 * those values when a union is being added because they are the commonest
 * answers, but they are submitted because the author left them there, not
 * because the column filled them in.
 *
 * ## Why the inputs are controlled
 *
 * React calls `requestFormReset` on *every* submission through a form action,
 * before the action has run and without waiting to see what it says. For a
 * form whose whole job is to come back and report which field is wrong, that
 * is the worst possible default: the author fixes the end reason and finds the
 * dates and notes they entered have all been wiped. Holding the values in the
 * caller's state makes React's reset a no-op. `IndividualFieldset` found this
 * first and this follows it, `FormSelect` included — React has no equivalent
 * of `defaultValue` for a `<select>`, so without it a refused submission
 * quietly reverts the kind to whatever the first option is.
 */

/** The union's own fields, as a form holds them: every value a string. */
export type UnionFormValues = Record<UnionFormField, string>;

/**
 * The union fields a form actually puts on screen.
 *
 * `partnerAId`, `partnerBId` and `sequence` are deliberately absent. The first
 * two are decided by whose panel a flow was opened from and what the picker
 * was told — never typed — and `sequence` is chosen by `lib/save-union.ts`
 * from the unions that already exist, which is what places a remarriage after
 * the marriage it followed without touching it. The edit form leaves all three
 * where they are for the same reason from the other end: changing who is in a
 * union is `detachPartner`'s question and reordering it is `UnionOrder`'s, and
 * a form that silently posted a null over either would answer both by
 * accident.
 *
 * So are the two dates' qualifier and precision columns, since E4-T2
 * (`YEO-39`): they are read out of what the author typed into the date box
 * rather than picked, and `DateField` posts them as hidden inputs. Holding
 * them here as well would be a second copy free to disagree with the text on
 * screen. Same reasoning, and same shape, as `IndividualFormField`.
 */
export type UnionFormField = Extract<
  UnionField,
  "type" | "startDate" | "endDate" | "endReason" | "notes"
>;

/**
 * A blank union, for a form that is starting one.
 *
 * Frozen for the reason `emptyIndividualFormValues` is: it is a shared default
 * held across renders, and a mutable one would leak a half-filled union from
 * one form into the next that mounted.
 */
export const emptyUnionFormValues: UnionFormValues = Object.freeze({
  type: "marriage",
  startDate: "",
  endDate: "",
  endReason: "ongoing",
  notes: "",
});

/**
 * A stored union, as the form holds it.
 *
 * The counterpart of `individualFormValuesFrom`, and it does the same two
 * things: it turns nulls into the empty strings an input can actually hold,
 * and it renders each date back into the phrasing `DateField` parses — so a
 * marriage stored as "about 1912" is prefilled as `about 1912` rather than as
 * a bare ISO day the author never typed.
 *
 * Note what it does *not* do: it does not decide what a cleared field means.
 * `validateUnion` collapses blank text to `null` for every caller including
 * GEDCOM import, so emptying the end date here writes a null without this file
 * containing a rule about it.
 *
 * Structural rather than a `GraphUnion`, so a row read any other way — a
 * `UnionFields` record, a fixture in a test — is accepted as it stands. The
 * five columns it does not name are the five a form does not hold: both
 * partners and the sequence.
 */
export type StoredUnion = Omit<
  UnionFields,
  "partnerAId" | "partnerBId" | "sequence"
> & {
  type: UnionType;
  endReason: UnionEndReason;
};

export function unionFormValuesFrom(union: StoredUnion): UnionFormValues {
  return {
    type: union.type,
    startDate: formatQualifiedDate(unionStart(union)) ?? "",
    endDate: formatQualifiedDate(unionEnd(union)) ?? "",
    endReason: union.endReason,
    notes: union.notes ?? "",
  };
}

const UNION_TYPE_LABELS: Record<(typeof UNION_TYPES)[number], string> = {
  marriage: "Marriage",
  partnership: "Partnership",
  unknown: "Not recorded",
};

const END_REASON_LABELS: Record<(typeof UNION_END_REASONS)[number], string> = {
  ongoing: "It did not end",
  death: "Ended by death",
  divorce: "Divorce",
  separation: "Separation",
  unknown: "Ended, reason unknown",
};

export interface UnionFieldsetProps {
  values: UnionFormValues;
  onChange: (field: UnionFormField, value: string) => void;
  /** What the server said, per field. Empty when all is well. */
  fieldErrors: UnionFieldErrors;
  disabled?: boolean;
  /**
   * The caller's own input styling, so each form keeps one class list rather
   * than this file holding an opinion about two different surfaces.
   */
  controlClassName: string;
}

export function UnionFieldset({
  values,
  onChange,
  fieldErrors,
  disabled = false,
  controlClassName,
}: UnionFieldsetProps) {
  /**
   * Every message a union date can come back with, in one place.
   *
   * `DateField` derives the qualifier and the precision, so only a hand-made
   * POST can get either refused — but a message with no field on screen to
   * hang under is a message nobody ever sees. The same fold as
   * `IndividualFieldset`'s `dateError`, and for the same reason.
   */
  const dateError = (field: "startDate" | "endDate") =>
    fieldErrors[field] ??
    fieldErrors[`${field}Qualifier`] ??
    fieldErrors[`${field}Precision`] ??
    fieldErrors[`${field}Upper`];

  return (
    <>
      <Field label="Kind" name="type">
        {(id) => (
          <FormSelect
            id={id}
            name="type"
            disabled={disabled}
            value={values.type}
            onChange={(event) => onChange("type", event.target.value)}
            className={controlClassName}
          >
            {UNION_TYPES.map((value) => (
              <option key={value} value={value}>
                {UNION_TYPE_LABELS[value]}
              </option>
            ))}
          </FormSelect>
        )}
      </Field>
      <FieldError message={fieldErrors.type} />

      <div className="mt-3">
        <DateField
          legend="Started"
          name="startDate"
          value={values.startDate}
          onChange={(value) => onChange("startDate", value)}
          error={dateError("startDate")}
          disabled={disabled}
          className={controlClassName}
        />
      </div>

      <div className="mt-3">
        <DateField
          legend="Ended"
          name="endDate"
          value={values.endDate}
          onChange={(value) => onChange("endDate", value)}
          error={dateError("endDate")}
          disabled={disabled}
          className={controlClassName}
        />
      </div>

      <Field label="How it ended" name="endReason">
        {(id) => (
          <FormSelect
            id={id}
            name="endReason"
            disabled={disabled}
            value={values.endReason}
            onChange={(event) => onChange("endReason", event.target.value)}
            className={controlClassName}
          >
            {UNION_END_REASONS.map((value) => (
              <option key={value} value={value}>
                {END_REASON_LABELS[value]}
              </option>
            ))}
          </FormSelect>
        )}
      </Field>
      <FieldError message={fieldErrors.endReason} />

      <Field label="Notes" name="notes">
        {(id) => (
          <textarea
            id={id}
            name="notes"
            rows={2}
            maxLength={MAX_NOTES_LENGTH}
            disabled={disabled}
            value={values.notes}
            onChange={(event) => onChange("notes", event.target.value)}
            className={controlClassName}
          />
        )}
      </Field>
      <FieldError message={fieldErrors.notes} />
    </>
  );
}

/**
 * A labelled row. The child is a function so that the label and its control
 * share one generated id without the caller writing `useId` per field.
 */
function Field({
  label,
  name,
  children,
}: {
  label: string;
  name: UnionFormField;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="mt-3" data-field={name}>
      <label htmlFor={id} className="block text-caption text-ink-muted">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className="mt-1 text-note text-ink">
      {message}
    </p>
  );
}
