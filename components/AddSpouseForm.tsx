"use client";

import { useActionState, useEffect, useId, useState } from "react";

import { PartnerPicker } from "@/components/PartnerPicker";
import type { GraphPerson } from "@/lib/family-graph";
import { MAX_NOTES_LENGTH } from "@/lib/field-input";
import { MAX_NAME_LENGTH, SEXES } from "@/lib/individual-input";
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
} from "@/lib/union-input";

/**
 * Recording a marriage or partnership (E3-T4, `YEO-32`).
 *
 * ## What the form insists on saying out loud
 *
 * `type` and `endReason` are inputs with no hidden default, because the
 * ticket asks for that in as many words: they are "fields, not defaults to fix
 * later". The database columns do have defaults — `marriage` and `ongoing` —
 * and that is exactly the trap. A form that quietly took them would fill a
 * tree with marriages nobody said were marriages and ongoing unions between
 * people who have been dead for a century, and none of it would look wrong on
 * the canvas until somebody tried to export it.
 *
 * Both dates are optional and both carry a qualifier, because a marriage year
 * read off a parish register is routinely "about". The pair of selects beside
 * each date is deliberately plain; E4-T2 replaces them with one field that
 * parses "abt 1912", and this form is written so that swap touches two inputs
 * rather than the flow around them.
 *
 * ## Why the whole flow is one submission
 *
 * Creating a partner inline could have been "add the person, then add the
 * union", two actions with the author in between. It is one, because half of
 * it is worse than none: a person written without their union is a stranger on
 * the canvas with nothing to say who they are. `addSpouse` writes both rows in
 * one transaction, and this form posts both records at once — the partner's
 * inputs namespaced under `partner.` so that its `notes` and the marriage's
 * `notes` do not collide.
 *
 * ## Why the action arrives as a prop
 *
 * `NewEntryForm` imports its action directly, and this one deliberately does
 * not. Importing `addSpouseAction` reaches `@/lib/session` and therefore
 * Auth.js, and `npm test` runs with no `AUTH_*` and no `DATABASE_URL` at all
 * (docs/testing.md) — so a component that imports it cannot be mounted in
 * jsdom, and neither can anything that renders it. That is not hypothetical:
 * the canvas renders this form, and importing the action here took
 * `components/FamilyTree.test.tsx` down with it.
 *
 * Passing a server action from a Server Component into a Client Component is
 * the framework's own pattern
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`), so
 * `app/tree/page.tsx` — already a Server Component reaching the database —
 * is the one file that names the action, and everything below it stays
 * mountable.
 */
export interface AddSpouseFormProps {
  /** The server action this form submits to. */
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
  /**
   * What the picker had been typed into when the author said the partner was
   * not on the tree. Held so the name fields open already filled in — see
   * `splitTypedName`.
   */
  const [typedName, setTypedName] = useState({ givenName: "", surname: "" });

  /**
   * The union exists, so this form has nothing left to show. Watching the
   * returned state rather than calling back from the submit handler, because
   * the action's answer is the only thing that knows whether the write landed
   * — a submission that came back with field errors must not close the form
   * over the messages it was supposed to be showing.
   */
  useEffect(() => {
    if (state.savedUnionId !== null) onSaved();
  }, [state.savedUnionId, onSaved]);

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
          typedName={typedName}
          errors={state.partnerErrors}
          partnerError={state.unionErrors.partnerBId}
          onSelect={(candidate) => setSelected(candidate)}
          onClear={() => setSelected(null)}
          onCreateNew={(query) => {
            setTypedName(splitTypedName(query));
            setSelected(null);
            setMode("new");
          }}
          onSearchAgain={() => setMode("existing")}
          onUnknown={() => {
            setSelected(null);
            setMode("unknown");
          }}
        />

        <h3>The union</h3>

        <Field label="Kind">
          {(id) => (
            <Select id={id} name="type" defaultValue="marriage">
              {UNION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {UNION_TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FieldError message={state.unionErrors.type} />

        <DateField
          label="Started"
          name="startDate"
          error={state.unionErrors.startDate}
        />

        <DateField
          label="Ended"
          name="endDate"
          error={state.unionErrors.endDate}
        />

        <Field label="How it ended">
          {(id) => (
            <Select id={id} name="endReason" defaultValue="ongoing">
              {UNION_END_REASONS.map((value) => (
                <option key={value} value={value}>
                  {END_REASON_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FieldError message={state.unionErrors.endReason} />

        <Field label="Notes">
          {(id) => (
            <textarea
              id={id}
              name="notes"
              rows={2}
              maxLength={MAX_NOTES_LENGTH}
              className={inputClass}
            />
          )}
        </Field>
        <FieldError message={state.unionErrors.notes} />

        {/*
          `partnerAId` faults the hidden `personId` field, which has no input to
          sit under — so it is shown here with the general failures instead.
        */}
        <FormError
          message={state.error ?? state.unionErrors.partnerAId}
        />

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

const DATE_QUALIFIER_LABELS = {
  exact: "on",
  about: "about",
  before: "before",
  after: "after",
} as const;

const inputClass =
  "mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink";

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
  typedName,
  errors,
  partnerError,
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
  typedName: { givenName: string; surname: string };
  errors: SpouseFormState["partnerErrors"];
  partnerError: string | undefined;
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

        <Field label="First name">
          {(id) => (
            <input
              id={id}
              name={`${PARTNER_FIELD_PREFIX}givenName`}
              type="text"
              required
              defaultValue={typedName.givenName}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              className={inputClass}
            />
          )}
        </Field>
        <FieldError message={errors.givenName} />

        <Field label="Surname">
          {(id) => (
            <input
              id={id}
              name={`${PARTNER_FIELD_PREFIX}surname`}
              type="text"
              defaultValue={typedName.surname}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              className={inputClass}
            />
          )}
        </Field>
        <FieldError message={errors.surname} />

        <Field label="Sex">
          {(id) => (
            <Select
              id={id}
              name={`${PARTNER_FIELD_PREFIX}sex`}
              defaultValue="unknown"
            >
              {SEXES.map((value) => (
                <option key={value} value={value}>
                  {value === "unknown" ? "Not recorded" : value}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Born">
          {(id) => (
            <input
              id={id}
              name={`${PARTNER_FIELD_PREFIX}birthDate`}
              type="date"
              className={inputClass}
            />
          )}
        </Field>
        <FieldError message={errors.birthDate} />

        <Field label="Died">
          {(id) => (
            <input
              id={id}
              name={`${PARTNER_FIELD_PREFIX}deathDate`}
              type="date"
              className={inputClass}
            />
          )}
        </Field>
        <FieldError message={errors.deathDate} />

        {/*
          Five fields, not ten. Places, notes and the date qualifiers belong to
          E3-T3's edit form on the person themselves; asking for them here
          would turn "record a marriage" into "fill in a stranger's life
          first", which is the detour this flow exists to remove.
        */}
        <button
          type="button"
          onClick={onSearchAgain}
          className="mt-1 text-note text-link hover:underline"
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
        invalid={partnerError !== undefined}
        describedBy={partnerError === undefined ? undefined : errorId}
      />
      {partnerError === undefined ? null : (
        <p id={errorId} role="alert" className="mt-1 text-note text-ink">
          {partnerError}
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
 * share one generated id without the caller writing `useId` for every field.
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-caption text-ink-muted">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * A date and the qualifier that says how much to trust it.
 *
 * The two are only ever meaningful as a pair (`db/schema.ts`), so they are one
 * control here rather than two rows an author can fill in half of.
 */
function DateField({
  label,
  name,
  error,
}: {
  label: string;
  name: "startDate" | "endDate";
  error: string | undefined;
}) {
  const id = useId();
  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-caption text-ink-muted">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <select
          name={`${name}Qualifier`}
          defaultValue="exact"
          aria-label={`How precise the ${label.toLowerCase()} date is`}
          className="rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink"
        >
          {(
            Object.keys(DATE_QUALIFIER_LABELS) as (keyof typeof DATE_QUALIFIER_LABELS)[]
          ).map((value) => (
            <option key={value} value={value}>
              {DATE_QUALIFIER_LABELS[value]}
            </option>
          ))}
        </select>
        <input
          id={id}
          name={name}
          type="date"
          className="min-w-0 flex-1 rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink"
        />
      </div>
      <FieldError message={error} />
    </div>
  );
}

function Select({
  id,
  name,
  defaultValue,
  children,
}: {
  id: string;
  name: string;
  defaultValue: string;
  children: React.ReactNode;
}) {
  return (
    <select id={id} name={name} defaultValue={defaultValue} className={inputClass}>
      {children}
    </select>
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
