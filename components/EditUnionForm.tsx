"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ModalDialog } from "@/components/ModalDialog";
import {
  UnionFieldset,
  type UnionFormField,
  type UnionFormValues,
  unionFormValuesFrom,
} from "@/components/UnionFieldset";
import type { GraphUnion } from "@/lib/family-graph";
import {
  emptyUnionEditState,
  type UpdateUnionFormAction,
} from "@/lib/union-edit-state";

/**
 * Correcting a union that is already recorded.
 *
 * ## What this closes
 *
 * Everything the add-spouse form asks for was writable and none of it was
 * changeable. A marriage year typed as 1921 instead of 1912 could only be
 * fixed by detaching the partner and adding them again — which deletes the
 * `unions` row, and with it every child link hanging off it. So the cheapest
 * mistake in the whole flow had the most destructive repair, and the dates
 * were the fields most likely to need one: they are read off a parish register
 * or half-remembered, and E4-T2 exists precisely because they arrive uncertain.
 *
 * The five fields here are the five the add-spouse form offers. What is *not*
 * offered is as deliberate:
 *
 * - **Who is in the union.** A different partner is a different union, and
 *   swapping one would silently move the children to a family they were not
 *   born into. `detachPartner` (E3-T8) does that on purpose, with a
 *   confirmation naming what it takes.
 * - **The order.** `UnionOrder` (E3-T7) restates one person's whole list at
 *   once, which is what keeps the numbers coherent between siblings.
 *
 * Both are refused by the *server* rather than merely absent from the markup —
 * `updateUnion` reads them from the stored row and writes them back — so this
 * file's field list is a UI decision resting on a guarantee rather than being
 * one.
 *
 * ## The same fieldset, prefilled
 *
 * `components/UnionFieldset.tsx`, unchanged, with `values` seeded from the
 * stored row instead of from `emptyUnionFormValues`. Nothing about what a
 * union *is* — that the kind is a field rather than a default, that a date is
 * one text box that reads "about 1912", how long the notes may be — is
 * restated here, which is the whole reason that component was split out of the
 * add-spouse form.
 *
 * The seeding is `unionFormValuesFrom`, which lives beside the type it
 * produces and renders each date back into the phrasing `DateField` parses.
 * Note what it does *not* do: it does not decide what a cleared field means.
 * `validateUnion` collapses blank text to `null` for every caller including
 * GEDCOM import, so emptying the end date here writes a null without this file
 * containing a rule about it.
 *
 * ## The unsaved-changes warning
 *
 * The same four exits `EditPersonForm` guards, guarded the same way, because
 * this is the same kind of surface and an author who loses a correction here
 * loses it just as completely:
 *
 * - **Cancel**, **Escape** and **the backdrop** arrive at `requestClose`,
 *   which shows the discard prompt instead of closing when there is something
 *   to lose. Escape reaching here *and stopping here* is what `ModalDialog`'s
 *   registration on the shared surface stack buys (`YEO-83`) — the dialogue is
 *   the topmost surface, so the detail panel underneath is not asked.
 * - **Leaving the page** is the browser's own navigation, and `beforeunload`
 *   is the only hook there is. Registered only while the form is dirty,
 *   because a page that always asks is a page whose warning nobody reads.
 *
 * ## Why the action arrives as a prop
 *
 * Importing `updateUnionAction` reaches Auth.js and `@/db`, and `npm test`
 * runs with no `AUTH_*` and no `DATABASE_URL` at all (docs/testing.md), so a
 * component that imports it cannot be mounted in jsdom — and neither can
 * anything that renders it, the whole canvas included. `app/tree/page.tsx`
 * hands it down instead, which is the framework's own pattern and the one
 * every other form on this canvas settled on.
 */

/**
 * The input styling, matching the dialogue `EditPersonForm` opens rather than
 * the side panel `AddSpouseForm` fills — the two surfaces are different widths
 * and each form owns its own class list, which is why `UnionFieldset` takes
 * one rather than holding an opinion.
 */
const CONTROL_CLASS =
  "mt-1 block w-full rounded-panel border border-rule bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

export interface EditUnionFormProps {
  /**
   * The union as it is stored, not as the detail panel describes it.
   *
   * `SpouseLink` is formatted for reading — "Married, 1933 – 1947, divorced" —
   * and a form prefilled from it would put a whole sentence in a date input.
   * This is the row.
   */
  union: GraphUnion;
  /**
   * How the dialogue names what is being corrected: "Rose and Walter", or
   * "Rose and an unrecorded partner". Built by the caller, which is the only
   * thing holding both people.
   */
  title: string;
  /** Where a submission goes. `updateUnionAction`, from the tree page. */
  action: UpdateUnionFormAction;
  /** Saved, or discarded. Either way the dialogue goes. */
  onClose: () => void;
  /** Passed through to `ModalDialog`: where focus lands when it goes. */
  returnFocus?: () => HTMLElement | null;
}

export function EditUnionForm({
  union,
  title,
  action,
  onClose,
  returnFocus,
}: EditUnionFormProps) {
  const [state, formAction, pending] = useActionState(
    action,
    emptyUnionEditState,
  );

  /**
   * The row as the form holds it — what "unchanged" is measured against.
   *
   * Recomputed when the union changes identity, which happens on every
   * revalidation of `/tree`, not only when this union moved. That is
   * deliberate: `values` is *not* re-seeded, so a correction in progress
   * survives somebody else's write landing in this tab, while `dirty` goes on
   * comparing against what is actually stored.
   */
  const initial = useMemo(() => unionFormValuesFrom(union), [union]);
  const [values, setValues] = useState<UnionFormValues>(initial);

  const setField = useCallback((field: UnionFormField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  }, []);

  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  const dirty = !sameValues(values, initial);

  /**
   * A failure with no input on screen to sit under.
   *
   * `error` is the union having been deleted or merged away in another tab.
   * The two partner messages folded in beside it belong to columns this form
   * deliberately does not render, and one of them is genuinely reachable: a
   * union whose partners have both become null fails "a union needs at least
   * one partner", against a field the author cannot see. A message with
   * nowhere to go is a message nobody ever sees.
   *
   * `sequence` is not folded in, because it cannot fire. Nothing reads it out
   * of the form and nothing supplies it as an anchor, so `validateUnion` finds
   * it unstated and has nothing to object to — see `UnionAnchors`.
   */
  const generalError =
    state.error ?? state.unionErrors.partnerAId ?? state.unionErrors.partnerBId;

  /**
   * The row was written, so this dialogue has nothing left to show.
   *
   * Watching the returned state rather than calling back from a submit
   * handler, because the action's answer is the only thing that knows whether
   * the write landed — a submission that came back with field errors must not
   * close the form over the messages it was supposed to be showing.
   *
   * `savedUnionId` comes back for `unchanged` as well as `updated`, which is
   * what makes pressing save on an untouched form close cleanly instead of
   * reporting a failure at nothing.
   */
  useEffect(() => {
    if (state.savedUnionId !== null) onClose();
  }, [state.savedUnionId, onClose]);

  /**
   * Leaving the page with unsaved edits.
   *
   * `preventDefault()` is the current spelling — `returnValue` is deprecated —
   * and the browser supplies its own wording; a page cannot choose it. The
   * listener exists only while there is something to lose, so the ordinary
   * path through this form never involves a prompt at all.
   */
  useEffect(() => {
    if (!dirty) return;

    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  /**
   * Every in-app exit: Cancel, Escape, and a click on the backdrop.
   *
   * A save in flight closes itself through the effect above, so an exit
   * arriving mid-submission is ignored rather than racing it — the alternative
   * is a dialogue that vanishes and then reports field errors nothing is
   * showing.
   */
  const requestClose = useCallback(() => {
    if (pending) return;
    if (dirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [dirty, pending, onClose]);

  /**
   * The prompt is the answer to a keystroke or a stray click as often as to a
   * button press, so focus moves to it. "Keep editing" rather than "Discard":
   * the safe one is where an absent-minded Enter should land.
   */
  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  return (
    <ModalDialog
      title={`Edit ${title}`}
      onClose={requestClose}
      returnFocus={returnFocus}
    >
      <form action={formAction}>
        {/*
          The one thing this form sends that the author did not type: a
          reference to the row being corrected, exactly as `EditPersonForm`
          sends a person's `id`. Whether it names a union that still exists is
          `updateUnion`'s question — the answer comes back as the `error`
          rendered below.
        */}
        <input type="hidden" name="unionId" value={union.id} />

        <p className="mb-4 text-caption text-ink-muted">
          {/*
            Said here because the two things this form does not do are the two
            an author looking for them would look here for first — and because
            both have a control of their own a few lines down the same panel.
          */}
          Emptying a date records it as unknown rather than as blank. Who is in
          this union, and the order it is shown in, are changed from the record
          itself.
        </p>

        <UnionFieldset
          values={values}
          onChange={setField}
          fieldErrors={state.unionErrors}
          disabled={pending}
          controlClassName={CONTROL_CLASS}
        />

        {generalError == null ? null : (
          <p role="alert" className="mt-4 text-note text-ink">
            {generalError}
          </p>
        )}

        {confirmingDiscard ? (
          <>
            <p role="alert" className="mt-6 text-note text-ink">
              Your changes to this union have not been saved yet.
            </p>
            {/*
              All three are disabled in flight, and the last one is why: a save
              submitted from this prompt leaves the prompt on screen, and
              "Discard them" calls `onClose` directly rather than through
              `requestClose` — it is the one exit that has already been
              answered for. Enabled mid-submission it would close the dialogue
              over a write that is still going, and the author would never see
              the field errors it came back with.
            */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                ref={keepEditingRef}
                type="button"
                disabled={pending}
                className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
                onClick={() => setConfirmingDiscard(false)}
              >
                Keep editing
              </button>
              <button
                type="submit"
                disabled={pending}
                className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
              >
                {pending ? "Saving…" : "Save them"}
              </button>
              <button
                type="button"
                disabled={pending}
                className="rounded-panel border border-rule px-3 py-1 text-note text-ink-muted hover:bg-wash disabled:cursor-not-allowed disabled:opacity-60"
                onClick={onClose}
              >
                Discard them
              </button>
            </div>
          </>
        ) : (
          <div className="mt-6 flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-paper disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
            >
              {/* The label says what is happening, in the place the author is
                  already looking — as on every other form on this canvas. */}
              {pending ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={requestClose}
              className="text-note text-link hover:underline disabled:text-ink-muted disabled:no-underline"
            >
              Cancel
            </button>
          </div>
        )}
      </form>
    </ModalDialog>
  );
}

/**
 * Every key of `UnionFormValues`, for the comparison below.
 *
 * Written as the keys of a `Record` rather than as a bare array so that it is
 * exhaustive *by construction*: the object literal cannot omit a field and
 * cannot invent one, both of which `satisfies` reports as type errors here. A
 * plain list would compile perfectly well while quietly no longer looking at a
 * field somebody added — and the symptom would be an edit form that let that
 * field's changes be discarded without a word.
 *
 * The same shape, and the same reasoning, as `FIELD_NAMES` in
 * `components/EditPersonForm.tsx`. The cast is `Object.keys` returning
 * `string[]`, a known gap in its signature; the literal is right above it, so
 * the narrower type is a fact rather than a hope.
 */
const FIELD_NAMES = Object.keys({
  type: true,
  startDate: true,
  endDate: true,
  endReason: true,
  notes: true,
} satisfies Record<UnionFormField, true>) as UnionFormField[];

/**
 * Whether the form still holds exactly what it was seeded with.
 *
 * A *text* comparison, and that is the honest one for a dirty check: it is
 * asking "would leaving now lose something the author typed", not "would the
 * row move". Retyping `1912` as `about 1912` is a change here even where
 * `updateUnion` might later find the record unchanged — the author did type
 * something, and a prompt they did not need beats silently discarding work
 * they did.
 */
function sameValues(a: UnionFormValues, b: UnionFormValues): boolean {
  return FIELD_NAMES.every((field) => a[field] === b[field]);
}
