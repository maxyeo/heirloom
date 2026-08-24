"use client";

import { useActionState, useEffect, useId, useMemo, useState } from "react";

import { FormSelect } from "@/components/FormSelect";
import { PartnerPicker } from "@/components/PartnerPicker";
import { descendantsOrSelf } from "@/lib/ancestry";
import { CHILD_RELATIONS, type ChildRelation } from "@/lib/child-input";
import type { FamilyGraph } from "@/lib/family-graph";
import { parentOptions } from "@/lib/parent-options";
import {
  emptyParentsFormState,
  type ParentsFormState,
  type SetParentsFormAction,
} from "@/lib/parents-form-state";
import type { ParentFamilyMode } from "@/lib/parents-input";
import type { PartnerCandidate } from "@/lib/partner-search";

/**
 * Connecting somebody who was added on their own (E3-T6, `YEO-34`).
 *
 * ## Why this is the other end of add-child, and not a duplicate of it
 *
 * `AddChildForm` starts from a parent and asks who the child is; this starts
 * from the child and asks who the family is. The row written is the same
 * `union_children` row, and the same `attachChild` writes it — but the
 * questions are not the same questions, and the ticket's case ("I added them
 * standalone and now want to connect them") is one add-child cannot ask,
 * because the author is looking at the person who needs parents rather than at
 * a parent who needs children.
 *
 * ## Why the list is filtered rather than validated
 *
 * A picker that offers a family and then refuses it teaches an author nothing
 * except that the form is unreliable. `lib/parent-options.ts` leaves out the
 * families that could only come back as a refusal — the ones already recording
 * this person, and the ones standing at or below them in the tree. That last
 * one is the cycle guard's client-side half, and it is *only* the client-side
 * half: `lib/save-child.ts` re-checks inside the transaction against a fresh
 * read, because this list was computed from a graph the browser loaded some
 * time ago.
 *
 * ## Why the family can be created here
 *
 * Because requiring the marriage first would ask the author to assert
 * something they may not know. Two people can be somebody's parents without
 * anybody recording — or knowing — whether they married, so naming them
 * creates a union of type `unknown` and nothing more. Either of them may be
 * left unrecorded, which is the ticket's "one known parent and one unknown":
 * both partner columns are nullable precisely so that no placeholder person
 * has to be invented (docs/architecture.md).
 *
 * Note what this does *not* do: create a person. The parents are searched for,
 * never typed in. A fourth door onto `individuals` alongside E3-T2's form and
 * the inline halves of add-spouse and add-child would be a fourth place for
 * the rules about a person to drift, and "connect the people I already added"
 * is the whole premise of the flow.
 *
 * ## Why moving is a field rather than a second flow
 *
 * "Moving a child between unions is possible without deleting and re-adding
 * them" is an acceptance criterion, and a delete followed by an add is not a
 * move — it is two writes with a moment in between where the person has no
 * parents at all. So the family they are leaving is a field on this form, and
 * `lib/set-parents.ts` performs both halves in one transaction.
 *
 * ## Why every input is controlled
 *
 * React calls `requestFormReset` on *every* submission through a form action,
 * before the action has run and without waiting to see what it says. For a
 * form whose job is to come back and report which field is wrong, that is the
 * worst possible default. The selects are the half that being controlled does
 * not fix — a reset reverts a `<select>` to its *first option*, which here
 * would silently change which family the author chose. `FormSelect` is what
 * keeps the DOM default in step; see its header.
 *
 * ## Why the action arrives as a prop
 *
 * Importing `setParentsAction` reaches Auth.js and `@/db`, and `npm test` runs
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
  "mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

const LINK_CLASS = "text-note text-link hover:underline";

export interface SetParentsFormProps {
  /** Where a submission goes. `setParentsAction`, from `app/tree/page.tsx`. */
  action: SetParentsFormAction;
  /** The person whose parents are being set. */
  person: { id: string; name: string };
  /**
   * The whole tree. Needed rather than one person's derived detail, because
   * every family on the canvas is a possible answer here — and because the
   * cycle filter is a walk over the graph rather than a fact about one record.
   */
  graph: FamilyGraph;
  /** The link was written; the caller closes the form and shows the result. */
  onSaved: () => void;
  /** The author backed out. Nothing was written. */
  onCancel: () => void;
}

export function SetParentsForm({
  action,
  person,
  graph,
  onSaved,
  onCancel,
}: SetParentsFormProps) {
  const [state, formAction, pending] = useActionState<
    ParentsFormState,
    FormData
  >(action, emptyParentsFormState);

  // One walk of the tree, and only when the graph or the person changes. The
  // panel behind this re-renders on every keystroke on the canvas; none of
  // that needs the families recomputed.
  const { available, current } = useMemo(
    () => parentOptions(graph, person.id),
    [graph, person.id],
  );

  /**
   * Nobody at or below this person may be named as their parent. The same rule
   * the family list is filtered by, applied to the two pickers — and the same
   * caveat: the server re-checks, because this is computed from a graph that
   * may be minutes old.
   */
  const excludeIds = useMemo(
    () => [...descendantsOrSelf(graph, person.id)],
    [graph, person.id],
  );

  /**
   * With no family on the tree that could hold them, naming the parents is the
   * only answer there is — so the form opens on it rather than on an empty
   * select and a dead end. This is the ordinary state of a young tree, where
   * the person was added moments ago and there is nothing to connect them to.
   */
  const [familyMode, setFamilyMode] = useState<ParentFamilyMode>(
    available.length === 0 ? "new" : "existing",
  );

  /**
   * Never pre-selected, even at one option. `AddChildForm` fills in a lone
   * union because that union is the person's own and naming it is a statement
   * of fact; this list is every family on the tree, and one of them happening
   * to be the only eligible one is not evidence that it is the right one.
   */
  const [unionId, setUnionId] = useState("");

  /**
   * Which family they are being taken out of. Blank — "leave what is already
   * recorded" — is the default even when there is exactly one, because adopted
   * into one family and born into another is a real record, and a form that
   * silently removed the first would be the destructive default in a flow
   * whose name says nothing about removing anything.
   */
  const [fromUnionId, setFromUnionId] = useState("");

  // Held as plain strings, like every other control in these forms: the value
  // comes back off a DOM event, and narrowing it here would be a cast over an
  // assumption the server is the one that gets to check.
  const [relation, setRelation] = useState<string>("biological");

  const [parentA, setParentA] = useState<PartnerCandidate | null>(null);
  const [parentB, setParentB] = useState<PartnerCandidate | null>(null);

  /**
   * The link exists, so this form has nothing left to show. Watching the
   * returned state rather than calling back from a submit handler, because the
   * action's answer is the only thing that knows whether the write landed — a
   * submission that came back with field errors must not close the form over
   * the messages it was supposed to be showing.
   */
  useEffect(() => {
    if (state.savedUnionId !== null) onSaved();
  }, [state.savedUnionId, onSaved]);

  const unionFieldId = useId();
  const fromFieldId = useId();
  const relationFieldId = useId();

  return (
    <aside
      aria-label={`Set parents for ${person.name}`}
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[75%] flex-col border-t border-rule bg-panel sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-2 border-b border-rule-soft px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate border-0 pb-0 text-h2">Set parents</h2>
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
        <input type="hidden" name="childId" value={person.id} />
        <input type="hidden" name="familyMode" value={familyMode} />
        {/*
          Posted in both modes and read only in `new`, which is what stops a
          submission from using one field to contradict another — the same rule
          `validateAddChild` applies to its own picker.
        */}
        <input type="hidden" name="parentAId" value={parentA?.id ?? ""} />
        <input type="hidden" name="parentBId" value={parentB?.id ?? ""} />

        <section>
          <h3>The family</h3>

          {familyMode === "existing" ? (
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
                aria-invalid={state.errors.unionId !== undefined}
                className={CONTROL_CLASS}
              >
                <option value="">Choose a family…</option>
                {available.map((option) => (
                  <option key={option.unionId} value={option.unionId}>
                    {option.label}
                  </option>
                ))}
              </FormSelect>
              <FieldError message={state.errors.unionId} />
              <button
                type="button"
                onClick={() => setFamilyMode("new")}
                className={`mt-2 ${LINK_CLASS}`}
              >
                Their parents are not recorded as a family yet
              </button>
            </>
          ) : (
            <>
              {/*
                Not a second way to create a person. Both parents are searched
                for among people already on the tree; either may be left
                unrecorded, which is the nullable partner column rather than a
                placeholder individual.
              */}
              <p className="text-note text-ink-muted">
                Name whichever parents are on the tree. Leave the other blank
                if they are not known — no placeholder person is created.
              </p>

              {/*
                Each slot also leaves out whoever the other one holds. The
                server refuses the same person twice — a union naming one
                person in both columns is not a family — but finding that out
                on submit is finding it out too late, and the two slots sit
                close enough together that picking the same name in both is an
                easy slip rather than an odd one.
              */}
              <ParentPicker
                title="One parent"
                people={graph.people}
                excludeIds={
                  parentB === null ? excludeIds : [...excludeIds, parentB.id]
                }
                selected={parentA}
                onSelect={setParentA}
                onClear={() => setParentA(null)}
                error={state.errors.parentAId}
              />
              <ParentPicker
                title="The other parent"
                people={graph.people}
                excludeIds={
                  parentA === null ? excludeIds : [...excludeIds, parentA.id]
                }
                selected={parentB}
                onSelect={setParentB}
                onClear={() => setParentB(null)}
                error={state.errors.parentBId}
              />

              {available.length === 0 ? null : (
                <button
                  type="button"
                  onClick={() => setFamilyMode("existing")}
                  className={`mt-3 ${LINK_CLASS}`}
                >
                  Choose a family on the tree instead
                </button>
              )}
            </>
          )}
        </section>

        {current.length === 0 ? null : (
          <section className="mt-3">
            <h3>Already recorded</h3>
            <label
              htmlFor={fromFieldId}
              className="block text-caption text-ink-muted"
            >
              {person.name} is already a child of{" "}
              {current.length === 1
                ? current[0].label
                : `${current.length} families`}
            </label>
            <FormSelect
              id={fromFieldId}
              name="fromUnionId"
              disabled={pending}
              value={fromUnionId}
              onChange={(event) => setFromUnionId(event.target.value)}
              aria-invalid={state.errors.fromUnionId !== undefined}
              className={CONTROL_CLASS}
            >
              {/*
                Keeping is first and is therefore the default, including on a
                reset. Being a child of two families is a real record — adopted
                into one, born into another — so removing one has to be asked
                for rather than assumed.
              */}
              <option value="">Leave that as it is</option>
              {current.map((option) => (
                <option key={option.unionId} value={option.unionId}>
                  Move them out of {option.label}
                </option>
              ))}
            </FormSelect>
            <p className="mt-1 text-note text-ink-muted">
              Moving happens in one step: nobody is deleted, and they are never
              without parents in between.
            </p>
            <FieldError message={state.errors.fromUnionId} />
          </section>
        )}

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
            about this form that is easy to get wrong: the answer describes the
            link, so the same person can be biological to one family and
            adopted into another.
          */}
          <p className="mt-1 text-note text-ink-muted">
            Recorded against this family, not against the person.
          </p>
          <FieldError message={state.errors.relation} />
        </div>

        <FormError message={state.error} />
        <FieldError message={state.errors.childId} />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-paper disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
          >
            {/*
              Disabled while in flight. Not polish: this write is not
              idempotent — a double-clicked button in `new` mode would create
              the same family twice and leave the second one holding the child.
            */}
            {pending ? "Saving…" : "Set parents"}
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * One of the two parent slots.
 *
 * E3-T4's picker, reused rather than reimplemented — "search the tree" is the
 * same control whether the person being named is a spouse, a child or a
 * parent, and a third copy would be a third place for the ranking rules to
 * drift. What is left out is its "add them as a new person" affordance; see
 * the note on this file about why this flow creates nobody.
 */
function ParentPicker({
  title,
  people,
  excludeIds,
  selected,
  onSelect,
  onClear,
  error,
}: {
  title: string;
  people: FamilyGraph["people"];
  excludeIds: readonly string[];
  selected: PartnerCandidate | null;
  onSelect: (candidate: PartnerCandidate) => void;
  onClear: () => void;
  error: string | undefined;
}) {
  const searchId = useId();
  const errorId = useId();

  return (
    <div className="mt-3">
      <label htmlFor={searchId} className="block text-caption text-ink-muted">
        {title}
      </label>
      <PartnerPicker
        people={people}
        excludeIds={excludeIds}
        selected={selected}
        onSelect={onSelect}
        onClear={onClear}
        inputId={searchId}
        invalid={error !== undefined}
        describedBy={error === undefined ? undefined : errorId}
      />
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="mt-1 text-note text-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A failure belonging to no single input: the family removed in another tab,
 * a person deleted, or a link that would make somebody their own ancestor.
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
