"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { FormSelect } from "@/components/FormSelect";
import {
  emptyIndividualFormValues,
  IndividualFieldset,
  type IndividualFormField,
  type IndividualFormValues,
} from "@/components/IndividualFieldset";
import { PartnerPicker } from "@/components/PartnerPicker";
import { useDismissableSurface } from "@/components/surface-stack";
import {
  type AddChildFormAction,
  type ChildFormState,
  emptyChildFormState,
} from "@/lib/child-form-state";
import {
  CHILD_FIELD_PREFIX,
  CHILD_RELATIONS,
  type ChildMode,
  type ChildRelation,
} from "@/lib/child-input";
import type { GraphPerson } from "@/lib/family-graph";
import { type PartnerCandidate, splitTypedName } from "@/lib/partner-search";
import type { SpouseLink } from "@/lib/person-detail";

/**
 * Recording a birth into a union (E3-T5, `YEO-33`).
 *
 * ## Why the union is a field and not an inference
 *
 * A child belongs to a union, not to a person, so "whose child is this" is
 * only half answered by the panel the flow was opened from. A twice-married
 * parent has two possible answers and the difference is the whole of
 * half-siblings: eight children by Walter and two by Thomas is a different
 * family from ten children. The form therefore asks, and — when there is more
 * than one union — refuses to choose for you. With exactly one it names the
 * union rather than offering a select of one, because a control with a single
 * option is a question nobody is being asked.
 *
 * With *no* union there is nothing to add a child to, and the form says so
 * rather than inventing one. That is not a gap: `unions` is where parenthood
 * is recorded, and E3-T4's add-spouse flow can record a union whose partner is
 * deliberately unknown — which is exactly the single-parent case, entered
 * through the one flow that owns union rows instead of a second one hidden
 * inside this form.
 *
 * ## Why the relation is here and not on the person
 *
 * `union_children.relation` describes how this child came into *this* family.
 * A boy adopted by his stepfather is biological to one union and adopted into
 * another; as a column on `individuals` that is a contradiction, and as a
 * field on the link it is two ordinary rows. The select is a real field with
 * no hidden default for the reason the add-spouse form gives about `type`: the
 * column's default is `biological`, and a tree quietly full of biological
 * links nobody asserted looks fine until somebody exports it.
 *
 * ## Why nothing here mentions half-siblings
 *
 * Because there is nothing to say. Recording a second child into a second
 * union is the same submission as the first, and `lib/person-detail.ts` reads
 * the half-sibling relationship back out of the two rows without either of
 * them being marked. No option, no checkbox, no stored relationship type.
 *
 * ## Why every input is controlled
 *
 * React calls `requestFormReset` on *every* submission through a form action,
 * before the action has run and without waiting to see what it says. For a
 * form whose job is to come back and report which field is wrong, that is the
 * worst possible default. The selects are the half that being controlled does
 * not fix — a reset reverts a `<select>` to its *first option* — which for
 * this form would mean a refused submission silently recording an adopted
 * child as biological. `FormSelect` is what keeps the DOM default in step; see
 * its header.
 *
 * ## Why the action arrives as a prop
 *
 * Importing `addChildAction` reaches Auth.js and `@/db`, and `npm test` runs
 * with no `AUTH_*` and no `DATABASE_URL` at all (docs/testing.md) — so a
 * component that imports it cannot be mounted in jsdom, and neither can
 * anything that renders it. `app/tree/page.tsx` hands it down instead.
 */

const RELATION_LABELS: Record<ChildRelation, string> = {
  biological: "Biological",
  adopted: "Adopted",
  step: "Step",
  foster: "Foster",
};

const CONTROL_CLASS =
  "mt-1 block w-full rounded-panel border border-rule bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

const LINK_CLASS = "text-note text-link hover:underline";

export interface AddChildFormProps {
  /** Where a submission goes. `addChildAction`, from `app/tree/page.tsx`. */
  action: AddChildFormAction;
  /** The person whose panel this was opened from. */
  person: { id: string; name: string };
  /**
   * The unions this person belongs to, as `derivePersonDetail` already
   * derived them — which is where the choice of family comes from, and where
   * the other parent's name comes from for each option.
   */
  unions: readonly SpouseLink[];
  /** Everyone on the tree, for the picker to search. */
  people: readonly GraphPerson[];
  /** The child was written; the caller closes the form and shows the result. */
  onSaved: () => void;
  /** The author backed out. Nothing was written. */
  onCancel: () => void;
}

export function AddChildForm({
  action,
  person,
  unions,
  people,
  onSaved,
  onCancel,
}: AddChildFormProps) {
  const [state, formAction, pending] = useActionState<ChildFormState, FormData>(
    action,
    emptyChildFormState,
  );

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
  useDismissableSurface({ onDismiss: onCancel });

  /**
   * And focus moves into the form when it opens, the way the panel moves it
   * into the record — so every surface on this canvas behaves alike. Without
   * it a keyboard user presses the button that opens this and is left on an
   * element that has just been unmounted.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  /**
   * Pre-selected only when there is exactly one union, which is the case the
   * ticket says needs no asking. With two or more the field starts empty and
   * the author has to answer — anything else would attach a child to whichever
   * marriage happened to sort first.
   */
  const [unionId, setUnionId] = useState(
    unions.length === 1 ? unions[0].unionId : "",
  );
  // Held as a plain string, like every other control in these forms: the
  // value comes back off a DOM event, and narrowing it here would be a cast
  // over an assumption the server is the one that gets to check.
  const [relation, setRelation] = useState<string>("biological");
  const [mode, setMode] = useState<ChildMode>("existing");
  const [selected, setSelected] = useState<PartnerCandidate | null>(null);
  const [child, setChild] = useState<IndividualFormValues>(
    emptyIndividualFormValues,
  );

  const setChildField = useCallback(
    (field: IndividualFormField, value: string) => {
      setChild((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  /**
   * The link exists, so this form has nothing left to show. Watching the
   * returned state rather than calling back from a submit handler, because the
   * action's answer is the only thing that knows whether the write landed — a
   * submission that came back with field errors must not close the form over
   * the messages it was supposed to be showing.
   */
  useEffect(() => {
    if (state.savedChildId !== null) onSaved();
  }, [state.savedChildId, onSaved]);

  /**
   * "They are not on the tree yet" — carrying what was typed into the name
   * fields, so the author does not type it twice. See `splitTypedName`.
   */
  const createNew = useCallback((query: string) => {
    setChild({ ...emptyIndividualFormValues, ...splitTypedName(query) });
    setSelected(null);
    setMode("new");
  }, []);

  const chosenUnion = unions.find((union) => union.unionId === unionId) ?? null;

  /**
   * Nobody is their own parent, and nobody is their own sibling's parent
   * either — so the two people this union already names are not offered. The
   * server refuses the same thing from a hand-made POST; this is only what
   * keeps the list honest.
   */
  const excludeIds = [person.id, chosenUnion?.person?.id].filter(
    (id): id is string => id !== undefined,
  );

  const unionFieldId = useId();
  const relationFieldId = useId();

  return (
    <aside
      aria-label={`Add a child for ${person.name}`}
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[75%] flex-col border-t border-rule bg-panel sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
        {/*
          `tabIndex={-1}` rather than a heading that is naturally focusable:
          somewhere to put focus that reads out what this form is, not
          somewhere to tab to. The same treatment `PersonPanel` gives its own
          header.
        */}
        <div ref={headingRef} tabIndex={-1} className="min-w-0">
          <h2 className="truncate border-0 pb-0 text-h2">Add a child</h2>
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

      {unions.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-caption">
          <p>
            A child belongs to a family rather than to one person, and{" "}
            {person.name} has none recorded yet.
          </p>
          <p className="mt-2 text-ink-muted">
            {/*
              Not a dead end, and deliberately not a second way to create a
              union. Add-spouse can record a partner as unknown, which is the
              single-parent case — and it stays the one flow that owns `unions`
              rows.
            */}
            Add a spouse first. If the other parent is not known, record the
            partner as unrecorded and the child can be added to that family.
          </p>
        </div>
      ) : (
        <form
          action={formAction}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-caption"
        >
          <input type="hidden" name="childMode" value={mode} />
          <input type="hidden" name="childId" value={selected?.id ?? ""} />

          <section>
            <h3>The family</h3>
            {unions.length === 1 ? (
              <>
                {/*
                  One union is not a question. The value is still posted — as a
                  hidden field rather than a select of one — and named on
                  screen, because "which family" is what the row records and an
                  author should be able to see it before they save.
                */}
                <input type="hidden" name="unionId" value={unions[0].unionId} />
                <p className="text-caption">{unionLabel(unions[0])}</p>
              </>
            ) : (
              <>
                <label
                  htmlFor={unionFieldId}
                  className="block text-caption text-ink-muted"
                >
                  Which family
                </label>
                <FormSelect
                  id={unionFieldId}
                  name="unionId"
                  disabled={pending}
                  value={unionId}
                  onChange={(event) => setUnionId(event.target.value)}
                  aria-invalid={state.linkErrors.unionId !== undefined}
                  className={CONTROL_CLASS}
                >
                  {/*
                    An empty first option rather than a pre-selected union.
                    With more than one marriage the answer decides which
                    children are half-siblings of which, and guessing it is
                    the one mistake this form exists to prevent.
                  */}
                  <option value="">Choose a family…</option>
                  {unions.map((union) => (
                    <option key={union.unionId} value={union.unionId}>
                      {unionLabel(union)}
                    </option>
                  ))}
                </FormSelect>
              </>
            )}
            <FieldError message={state.linkErrors.unionId} />
          </section>

          <Child
            mode={mode}
            people={people}
            excludeIds={excludeIds}
            selected={selected}
            values={child}
            onChangeField={setChildField}
            childErrors={state.childErrors}
            pickerError={state.linkErrors.childId}
            disabled={pending}
            onSelect={setSelected}
            onClear={() => setSelected(null)}
            onCreateNew={createNew}
            onSearchAgain={() => setMode("existing")}
          />

          <div className="mt-3">
            <label
              htmlFor={relationFieldId}
              className="block text-caption text-ink-muted"
            >
              How they joined this family
            </label>
            <FormSelect
              id={relationFieldId}
              name="relation"
              disabled={pending}
              value={relation}
              onChange={(event) => setRelation(event.target.value)}
              className={CONTROL_CLASS}
            >
              {CHILD_RELATIONS.map((value) => (
                <option key={value} value={value}>
                  {RELATION_LABELS[value]}
                </option>
              ))}
            </FormSelect>
            {/*
              Said here rather than in a tooltip, because it is the one thing
              about this form that is easy to get wrong: the answer describes
              the link, so the same person can be biological to one family and
              adopted into another.
            */}
            <p className="mt-1 text-note text-ink-muted">
              Recorded against this family, not against the person.
            </p>
            <FieldError message={state.linkErrors.relation} />
          </div>

          <FormError message={state.error} />

          <div className="mt-4 flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-paper disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
            >
              {/*
                Disabled while in flight, and that is not polish: adding a
                child is not idempotent, so a double-clicked button with a new
                person in it would invent a second copy of that child.
              */}
              {pending ? "Saving…" : "Add child"}
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}

/**
 * How one union reads in the list of families to add a child to.
 *
 * The other partner's name is the whole label, because that is what
 * distinguishes one of a person's families from another — and it is what makes
 * the half-sibling grouping legible at the moment it is being created rather
 * than only afterwards in the panel. The span is appended when it is recorded,
 * for the case of two unions with the same partner.
 */
function unionLabel(union: SpouseLink): string {
  // Both partner columns are nullable so that an unrecorded parent never has
  // to be invented as a placeholder person; a union with one partner is a
  // perfectly good family to record a child into.
  const partner = union.person
    ? `with ${union.person.name}`
    : "with an unrecorded partner";
  const span = union.start ?? union.end ?? null;
  return span === null ? partner : `${partner} (${span})`;
}

/**
 * The child half of the form, in whichever of its two states the picker has
 * been left in.
 *
 * Split out for the reason `AddSpouseForm`'s `Partner` is: a search and a
 * person record are genuinely different forms, and interleaving them into the
 * main body with conditionals made it impossible to see which inputs are
 * posted when.
 *
 * The picker itself is E3-T4's, reused rather than reimplemented — "search the
 * tree or add them inline" is the same control whether the person being named
 * is a spouse or a child, and a second copy would be a second place for the
 * ranking rules to drift.
 */
function Child({
  mode,
  people,
  excludeIds,
  selected,
  values,
  onChangeField,
  childErrors,
  pickerError,
  disabled,
  onSelect,
  onClear,
  onCreateNew,
  onSearchAgain,
}: {
  mode: ChildMode;
  people: readonly GraphPerson[];
  excludeIds: readonly string[];
  selected: PartnerCandidate | null;
  values: IndividualFormValues;
  onChangeField: (field: IndividualFormField, value: string) => void;
  childErrors: ChildFormState["childErrors"];
  pickerError: string | undefined;
  disabled: boolean;
  onSelect: (candidate: PartnerCandidate) => void;
  onClear: () => void;
  onCreateNew: (query: string) => void;
  onSearchAgain: () => void;
}) {
  const searchId = useId();
  const errorId = useId();

  if (mode === "new") {
    return (
      <section>
        <h3>The child — a new person</h3>
        {/*
          E3-T2's fieldset, whole. `namePrefix` is what keeps the child's
          `notes` out of the same `FormData` slot as anything else in this
          submission; `addChildInputFromFormData` strips it off again.
        */}
        <IndividualFieldset
          values={values}
          namePrefix={CHILD_FIELD_PREFIX}
          onChange={onChangeField}
          fieldErrors={childErrors}
          disabled={disabled}
          autoFocusFirstField
        />
        <button
          type="button"
          onClick={onSearchAgain}
          className={`mt-3 ${LINK_CLASS}`}
        >
          Search the tree instead
        </button>
      </section>
    );
  }

  return (
    <section className="mt-3">
      <h3>The child</h3>
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
    </section>
  );
}

/**
 * A failure belonging to no single input: the union removed in another tab,
 * the person deleted, or a link that is already recorded.
 */
function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
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
