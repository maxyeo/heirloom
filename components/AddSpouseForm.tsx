"use client";

import { useActionState, useCallback, useEffect, useId, useState } from "react";

import { FormSelect } from "@/components/FormSelect";
import {
  emptyIndividualFormValues,
  IndividualFieldset,
  type IndividualFormValues,
} from "@/components/IndividualFieldset";
import { PartnerPicker } from "@/components/PartnerPicker";
import type { GraphPerson } from "@/lib/family-graph";
import { DATE_QUALIFIERS, MAX_NOTES_LENGTH } from "@/lib/field-input";
import type { IndividualField } from "@/lib/individual-input";
import { type PartnerCandidate, splitTypedName } from "@/lib/partner-search";
import {
  type AddSpouseFormAction,
  emptySpouseFormState,
  type SpouseFormState,
} from "@/lib/spouse-form-state";
import {
  PARTNER_FIELD_PREFIX,
  type PartnerMode,
  UNION_END_REASONS,
  UNION_TYPES,
  type UnionField,
} from "@/lib/union-input";

/**
 * Recording a marriage or partnership (E3-T4, `YEO-32`).
 *
 * ## What the form insists on saying out loud
 *
 * `type` and `endReason` are controls with no hidden default, because the
 * ticket asks for that in as many words: they are "fields, not defaults to fix
 * later". The database columns do have defaults — `marriage` and `ongoing` —
 * and that is exactly the trap. A form that quietly took them would fill a
 * tree with marriages nobody said were marriages and ongoing unions between
 * people who have been dead for a century, and none of it would look wrong on
 * the canvas until somebody tried to export it. The two selects *open* on
 * those values because they are the commonest answers, but they are submitted
 * because the author left them there, not because the column filled them in.
 *
 * Both dates are optional and both carry a qualifier, because a marriage year
 * read off a parish register is routinely "about". The pair of controls beside
 * each date is deliberately plain; E4-T2 replaces them with one field that
 * parses "abt 1912", and this form is written so that swap touches two inputs
 * rather than the flow around them.
 *
 * ## Why every input is controlled
 *
 * React calls `requestFormReset` on *every* submission through a form action,
 * before the action has run and without waiting to see what it says. For a
 * form whose whole job is to come back and report which field is wrong, that
 * is the worst possible default: the author fixes the end reason and finds the
 * dates, the notes and the half-typed partner they entered have all been
 * wiped. Holding the values in state makes React's reset a no-op. E3-T2 found
 * this first and `IndividualFieldset` is built on it; this form follows.
 *
 * ## Why the partner's fields are E3-T2's fieldset
 *
 * `components/IndividualFieldset.tsx` says in its own header that E3-T4 is one
 * of its three callers, and a second copy of "the surname input is 200
 * characters and says so" is exactly how two forms end up disagreeing about
 * what a person is. It is reused wholesale, with `namePrefix` set so the
 * partner's `notes` and the marriage's `notes` do not collide in one
 * `FormData` — `addSpouseInputFromFormData` strips the prefix back off.
 *
 * ## Why the whole flow is one submission
 *
 * Creating a partner inline could have been "add the person, then add the
 * union", two actions with the author in between. It is one, because half of
 * it is worse than none: a person written without their union is a stranger on
 * the canvas with nothing to say who they are. `addSpouse` writes both rows in
 * one transaction.
 *
 * ## Why the action arrives as a prop
 *
 * Importing `addSpouseAction` reaches Auth.js and `@/db`, and `npm test` runs
 * with no `AUTH_*` and no `DATABASE_URL` at all (docs/testing.md) — so a
 * component that imports it cannot be mounted in jsdom, and neither can
 * anything that renders it. That is not hypothetical: the canvas renders this
 * form, and importing the action here took `components/FamilyTree.test.tsx`
 * down with it. `app/tree/page.tsx` hands it down instead, which is the
 * framework's own pattern and the same one `AddPersonPanel` settled on.
 */

/** The union's own fields, as a form holds them: every value a string. */
export type UnionFormValues = Record<UnionFormField, string>;

/**
 * The union fields this form puts on screen.
 *
 * `partnerAId`, `partnerBId` and `sequence` are deliberately absent. The first
 * two are decided by whose panel the flow was opened from and what the picker
 * was told — never typed — and `sequence` is chosen by `lib/save-union.ts`
 * from the unions that already exist, which is what places a remarriage after
 * the marriage it followed without touching it.
 */
type UnionFormField = Extract<
  UnionField,
  | "type"
  | "startDate"
  | "startDateQualifier"
  | "endDate"
  | "endDateQualifier"
  | "endReason"
  | "notes"
>;

/**
 * A blank union.
 *
 * Frozen for the reason `emptyIndividualFormValues` is: it is a shared default
 * held across renders, and a mutable one would leak a half-filled union from
 * one form into the next that mounted.
 */
export const emptyUnionFormValues: UnionFormValues = Object.freeze({
  type: "marriage",
  startDate: "",
  startDateQualifier: "exact",
  endDate: "",
  endDateQualifier: "exact",
  endReason: "ongoing",
  notes: "",
});

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

/**
 * Prepositions rather than the stored words, because each sits immediately
 * before its date and the two read as one phrase. The same wording
 * `IndividualFieldset` uses, so a union's dates and a person's read alike.
 */
const QUALIFIER_LABELS: Record<(typeof DATE_QUALIFIERS)[number], string> = {
  exact: "on",
  about: "about",
  before: "before",
  after: "after",
};

const CONTROL_CLASS =
  "mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

export interface AddSpouseFormProps {
  /** Where a submission goes. `addSpouseAction`, from `app/tree/page.tsx`. */
  action: AddSpouseFormAction;
  /** The person gaining a spouse — whose panel this was opened from. */
  person: { id: string; name: string };
  /** Everyone on the tree, for the picker to search. */
  people: readonly GraphPerson[];
  /** The union was written; the caller closes the form and shows the result. */
  onSaved: () => void;
  /** The author backed out. Nothing was written. */
  onCancel: () => void;
}

export function AddSpouseForm({
  action,
  person,
  people,
  onSaved,
  onCancel,
}: AddSpouseFormProps) {
  const [state, formAction, pending] = useActionState<SpouseFormState, FormData>(
    action,
    emptySpouseFormState,
  );

  const [mode, setMode] = useState<PartnerMode>("existing");
  const [selected, setSelected] = useState<PartnerCandidate | null>(null);
  const [partner, setPartner] = useState<IndividualFormValues>(
    emptyIndividualFormValues,
  );
  const [union, setUnion] = useState<UnionFormValues>(emptyUnionFormValues);

  const setPartnerField = useCallback(
    (field: IndividualField, value: string) => {
      setPartner((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  const setUnionField = useCallback((field: UnionFormField, value: string) => {
    setUnion((current) => ({ ...current, [field]: value }));
  }, []);

  /**
   * The union exists, so this form has nothing left to show. Watching the
   * returned state rather than calling back from a submit handler, because the
   * action's answer is the only thing that knows whether the write landed — a
   * submission that came back with field errors must not close the form over
   * the messages it was supposed to be showing.
   */
  useEffect(() => {
    if (state.savedUnionId !== null) onSaved();
  }, [state.savedUnionId, onSaved]);

  /**
   * "They are not on the tree yet" — carrying what was typed into the name
   * fields, so the author does not type it twice. See `splitTypedName`.
   */
  const createNew = useCallback((query: string) => {
    setPartner({ ...emptyIndividualFormValues, ...splitTypedName(query) });
    setSelected(null);
    setMode("new");
  }, []);

  // The person gaining a spouse cannot be their own partner, so they are not
  // offered. Everybody else is, previous spouses included: a couple who
  // divorced and remarried each other is a real record.
  const excludeIds = [person.id];

  return (
    <aside
      aria-label={`Add a spouse for ${person.name}`}
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[75%] flex-col border-t border-rule bg-panel sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-2 border-b border-rule-soft px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate border-0 pb-0 text-h2">Add a spouse</h2>
          <p className="text-caption text-ink-muted">for {person.name}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash"
        >
          Cancel
        </button>
      </div>

      <form
        action={formAction}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-caption"
      >
        <input type="hidden" name="personId" value={person.id} />
        <input type="hidden" name="partnerMode" value={mode} />
        <input type="hidden" name="partnerId" value={selected?.id ?? ""} />

        <Partner
          mode={mode}
          people={people}
          excludeIds={excludeIds}
          selected={selected}
          values={partner}
          onChangeField={setPartnerField}
          partnerErrors={state.partnerErrors}
          pickerError={state.unionErrors.partnerBId}
          disabled={pending}
          onSelect={setSelected}
          onClear={() => setSelected(null)}
          onCreateNew={createNew}
          onSearchAgain={() => setMode("existing")}
          onUnknown={() => {
            setSelected(null);
            setMode("unknown");
          }}
        />

        <h3>The union</h3>

        <UnionField label="Kind" name="type">
          {(id) => (
            <FormSelect
              id={id}
              name="type"
              disabled={pending}
              value={union.type}
              onChange={(event) => setUnionField("type", event.target.value)}
              className={CONTROL_CLASS}
            >
              {UNION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {UNION_TYPE_LABELS[value]}
                </option>
              ))}
            </FormSelect>
          )}
        </UnionField>
        <FieldError message={state.unionErrors.type} />

        <DateRow
          legend="Started"
          dateField="startDate"
          qualifierField="startDateQualifier"
          qualifierLabel="How exact the start date is"
          values={union}
          onChange={setUnionField}
          errors={state.unionErrors}
          disabled={pending}
        />

        <DateRow
          legend="Ended"
          dateField="endDate"
          qualifierField="endDateQualifier"
          qualifierLabel="How exact the end date is"
          values={union}
          onChange={setUnionField}
          errors={state.unionErrors}
          disabled={pending}
        />

        <UnionField label="How it ended" name="endReason">
          {(id) => (
            <FormSelect
              id={id}
              name="endReason"
              disabled={pending}
              value={union.endReason}
              onChange={(event) =>
                setUnionField("endReason", event.target.value)
              }
              className={CONTROL_CLASS}
            >
              {UNION_END_REASONS.map((value) => (
                <option key={value} value={value}>
                  {END_REASON_LABELS[value]}
                </option>
              ))}
            </FormSelect>
          )}
        </UnionField>
        <FieldError message={state.unionErrors.endReason} />

        <UnionField label="Notes" name="notes">
          {(id) => (
            <textarea
              id={id}
              name="notes"
              rows={2}
              maxLength={MAX_NOTES_LENGTH}
              disabled={pending}
              value={union.notes}
              onChange={(event) => setUnionField("notes", event.target.value)}
              className={CONTROL_CLASS}
            />
          )}
        </UnionField>
        <FieldError message={state.unionErrors.notes} />

        {/*
          `partnerAId` faults the hidden `personId` field, which has no input
          to sit under — so it is shown here with the general failures instead.
        */}
        <FormError message={state.error ?? state.unionErrors.partnerAId} />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-paper disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
          >
            {/*
              Disabled while in flight, and that is not polish: creating a
              union is not idempotent, so a double-clicked button would record
              the same marriage twice — and with an inline partner, invent a
              second copy of them to marry.
            */}
            {pending ? "Saving…" : "Add spouse"}
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * The partner half of the form, in whichever of its three states the picker
 * has been left in.
 *
 * Split out because the three are genuinely different forms — a search, a
 * person record, and a sentence — and interleaving them into the main body
 * with conditionals made it impossible to see which inputs are posted when.
 */
function Partner({
  mode,
  people,
  excludeIds,
  selected,
  values,
  onChangeField,
  partnerErrors,
  pickerError,
  disabled,
  onSelect,
  onClear,
  onCreateNew,
  onSearchAgain,
  onUnknown,
}: {
  mode: PartnerMode;
  people: readonly GraphPerson[];
  excludeIds: readonly string[];
  selected: PartnerCandidate | null;
  values: IndividualFormValues;
  onChangeField: (field: IndividualField, value: string) => void;
  partnerErrors: SpouseFormState["partnerErrors"];
  pickerError: string | undefined;
  disabled: boolean;
  onSelect: (candidate: PartnerCandidate) => void;
  onClear: () => void;
  onCreateNew: (query: string) => void;
  onSearchAgain: () => void;
  onUnknown: () => void;
}) {
  const searchId = useId();
  const errorId = useId();

  if (mode === "unknown") {
    return (
      <section>
        <h3>The partner</h3>
        <p className="text-caption text-ink-muted">
          {/*
            Both partner columns are nullable so that an unrecorded spouse
            never has to be invented as a placeholder person. Saying so here is
            what makes that reachable from the UI rather than only from SQL.
          */}
          Not recorded. The union will be saved with one partner named.
        </p>
        <button
          type="button"
          onClick={onSearchAgain}
          className="mt-1 text-note text-link hover:underline"
        >
          Name the partner after all
        </button>
      </section>
    );
  }

  if (mode === "new") {
    return (
      <section>
        <h3>The partner — a new person</h3>
        {/*
          E3-T2's fieldset, whole. `namePrefix` is the only thing this flow
          needs from it that the add-person panel does not: both records in
          this submission have a `notes` field, and the prefix is what keeps
          them apart until `addSpouseInputFromFormData` strips it off.
        */}
        <IndividualFieldset
          values={values}
          namePrefix={PARTNER_FIELD_PREFIX}
          onChange={onChangeField}
          fieldErrors={partnerErrors}
          disabled={disabled}
          autoFocusFirstField
        />
        <button
          type="button"
          onClick={onSearchAgain}
          className="mt-3 text-note text-link hover:underline"
        >
          Search the tree instead
        </button>
      </section>
    );
  }

  return (
    <section>
      <h3>The partner</h3>
      <label htmlFor={searchId} className="block text-caption text-ink-muted">
        Who
      </label>
      <PartnerPicker
        people={people}
        excludeIds={excludeIds}
        selected={selected}
        onSelect={onSelect}
        onClear={onClear}
        onCreateNew={onCreateNew}
        inputId={searchId}
        invalid={pickerError !== undefined}
        describedBy={pickerError === undefined ? undefined : errorId}
      />
      {pickerError === undefined ? null : (
        <p id={errorId} role="alert" className="mt-1 text-note text-ink">
          {pickerError}
        </p>
      )}
      <button
        type="button"
        onClick={onUnknown}
        className="mt-2 block text-note text-link hover:underline"
      >
        The partner is not recorded
      </button>
    </section>
  );
}

/**
 * A labelled row. The child is a function so that the label and its control
 * share one generated id without the caller writing `useId` per field.
 */
function UnionField({
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

/**
 * A date and how much to trust it, as one row — the union's equivalent of
 * `IndividualFieldset`'s `DateRow`, and deliberately the same shape.
 *
 * The two are only ever meaningful as a pair (`db/schema.ts`), so they are one
 * control here rather than two rows an author can fill in half of. The
 * qualifier's label is visually hidden because the pair reads as one phrase on
 * screen ("Started · about · 1912-06-04"); a screen reader still gets it,
 * since an unlabelled `select` is a control nobody can identify out of
 * context.
 */
function DateRow({
  legend,
  dateField,
  qualifierField,
  qualifierLabel,
  values,
  onChange,
  errors,
  disabled,
}: {
  legend: string;
  dateField: "startDate" | "endDate";
  qualifierField: "startDateQualifier" | "endDateQualifier";
  qualifierLabel: string;
  values: UnionFormValues;
  onChange: (field: UnionFormField, value: string) => void;
  errors: SpouseFormState["unionErrors"];
  disabled: boolean;
}) {
  const id = useId();
  const qualifierId = `${id}-qualifier`;

  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-caption text-ink-muted">
        {legend}
      </label>
      <div className="mt-1 flex gap-2">
        <label htmlFor={qualifierId} className="sr-only">
          {qualifierLabel}
        </label>
        <FormSelect
          id={qualifierId}
          name={qualifierField}
          disabled={disabled}
          value={values[qualifierField]}
          onChange={(event) => onChange(qualifierField, event.target.value)}
          className="rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {DATE_QUALIFIERS.map((qualifier) => (
            <option key={qualifier} value={qualifier}>
              {QUALIFIER_LABELS[qualifier]}
            </option>
          ))}
        </FormSelect>
        <input
          id={id}
          name={dateField}
          type="date"
          disabled={disabled}
          value={values[dateField]}
          onChange={(event) => onChange(dateField, event.target.value)}
          aria-invalid={errors[dateField] !== undefined}
          className="min-w-0 flex-1 rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
      <FieldError message={errors[qualifierField]} />
      <FieldError message={errors[dateField]} />
    </div>
  );
}

/**
 * A failure belonging to no single input: the person deleted in another tab,
 * or a `partnerAId` fault against the hidden field naming them.
 */
function FormError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p role="alert" className="mt-3 text-note text-ink">
      {message}
    </p>
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
