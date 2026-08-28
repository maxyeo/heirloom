"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  emptyIndividualFormValues,
  IndividualFieldset,
  type IndividualFormField,
  type IndividualFormValues,
} from "@/components/IndividualFieldset";
import { PartnerPicker } from "@/components/PartnerPicker";
import { useDismissableSurface } from "@/components/surface-stack";
import {
  emptyUnionFormValues,
  UnionFieldset,
  type UnionFormField,
  type UnionFormValues,
} from "@/components/UnionFieldset";
import type { GraphPerson } from "@/lib/family-graph";
import { type PartnerCandidate, splitTypedName } from "@/lib/partner-search";
import {
  type AddSpouseFormAction,
  emptySpouseFormState,
  type SpouseFormState,
} from "@/lib/spouse-form-state";
import { PARTNER_FIELD_PREFIX, type PartnerMode } from "@/lib/union-input";

/**
 * Recording a marriage or partnership (E3-T4, `YEO-32`).
 *
 * ## Why the union's fields are their own fieldset
 *
 * `components/UnionFieldset.tsx` holds them, and holds the reasoning that goes
 * with them: that `type` and `endReason` are fields rather than defaults to
 * fix later, that both dates are optional and both carry a qualifier because a
 * marriage year read off a parish register is routinely "about". They lived
 * here while this was the only form that put a union on screen. The edit form
 * is the second, and a second copy of those rules is how two forms end up
 * disagreeing about what a union is — the same argument that split
 * `IndividualFieldset` out of the add-person panel, arrived at from the other
 * direction.
 *
 * What stays here is what is particular to *adding* one: the partner half
 * above it, the three-way picker, and the single submission that writes a
 * person and a union together.
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

/**
 * The input styling for this panel, handed to `UnionFieldset` and to E3-T2's
 * `IndividualFieldset` beside it — each surface on this canvas owns one class
 * list rather than every fieldset holding an opinion about widths it cannot
 * see.
 */
const CONTROL_CLASS =
  "mt-1 block w-full rounded-panel border border-rule bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

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
  const [state, formAction, pending] = useActionState<
    SpouseFormState,
    FormData
  >(action, emptySpouseFormState);

  const headingRef = useRef<HTMLDivElement>(null);

  /**
   * Escape backs out, exactly as Cancel does (`YEO-83`).
   *
   * This form replaces the detail panel in the canvas render, and until this
   * ticket it had no Escape at all — so opening it turned a key that had just
   * worked into one that silently did nothing, on a surface that looks like
   * the panel it replaced. Registering on the shared stack is the whole of the
   * fix: no listener of its own, and no way for this and the panel to both
   * answer, since the panel is not mounted while this is.
   *
   * No `returnFocus`: backing out remounts the panel, which puts focus on its
   * own heading. Naming somewhere here would be a second opinion about where
   * focus goes, arriving in the same commit as the first.
   */
  /*
    `underneath` for the reason `PersonPanel` gives: this form stands in the
    record's slot at `z-10`, and the add-person panel is `z-20` and wider, so
    when both are up this one is the invisible half. See `withSurface` in
    `lib/surface-stack.ts`.
  */
  useDismissableSurface({ onDismiss: onCancel, underneath: true });

  /**
   * And focus moves into the form when it opens, the way the panel moves it
   * into the record — so every surface on this canvas behaves alike. Without
   * it a keyboard user presses the button that opens this and is left on an
   * element that has just been unmounted.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const [mode, setMode] = useState<PartnerMode>("existing");
  const [selected, setSelected] = useState<PartnerCandidate | null>(null);
  const [partner, setPartner] = useState<IndividualFormValues>(
    emptyIndividualFormValues,
  );
  const [union, setUnion] = useState<UnionFormValues>(emptyUnionFormValues);

  const setPartnerField = useCallback(
    (field: IndividualFormField, value: string) => {
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
      /*
        `fixed` from the site header down, the same as every other panel in
        this slot — see `components/PersonPanel.tsx`, which this one replaces
        rather than covers. `absolute` resolved against `FamilyTree`'s canvas
        wrapper, which starts below the tree page's own header, so the form was
        short by an `<h1>` and two lines of counts and left a band of empty
        paper beside them.
      */
      className="fixed inset-x-0 bottom-0 z-10 flex max-h-[75%] flex-col border-t border-rule bg-panel sm:inset-x-auto sm:top-(--header-height) sm:right-0 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
        {/*
          `tabIndex={-1}` rather than a heading that is naturally focusable:
          somewhere to put focus that reads out what this form is, not
          somewhere to tab to. The same treatment `PersonPanel` gives its own
          header.
        */}
        <div ref={headingRef} tabIndex={-1} className="min-w-0">
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

        {/*
          The same five controls the edit form renders, from the same
          component. Splitting them out is what keeps "the kind is a field
          rather than a default" written once — see
          `components/UnionFieldset.tsx`.
        */}
        <UnionFieldset
          values={union}
          onChange={setUnionField}
          fieldErrors={state.unionErrors}
          disabled={pending}
          controlClassName={CONTROL_CLASS}
        />

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
  onChangeField: (field: IndividualFormField, value: string) => void;
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
