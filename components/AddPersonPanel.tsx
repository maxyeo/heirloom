"use client";

import {
  useActionState,
  useCallback,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  IndividualFieldset,
  emptyIndividualFormValues,
  type IndividualFormField,
  type IndividualFormValues,
} from "@/components/IndividualFieldset";
import { useDismissableSurface } from "@/components/surface-stack";
import {
  emptyIndividualFormState,
  type IndividualFormState,
} from "@/lib/individual-form-state";

/**
 * Adding somebody to the family (E3-T2, `YEO-30`).
 *
 * ## A panel on the tree, not a page of its own
 *
 * "Tree redraws on save with no layout interaction required" is the criterion
 * that decides the shape. A `/tree/new` route would satisfy it only by
 * navigating away and back, and the author would lose their place on the
 * canvas every time they added a person — which, in the sitting where somebody
 * enters a branch of their family, is a dozen times in a row. Staying on
 * `/tree` also makes the redraw free rather than something to arrange: a
 * server action that calls `revalidatePath` has Next.js re-render the current
 * route and send the new RSC payload back in the action's own response, so
 * `page.tsx` re-queries the graph, `FamilyTree` re-seeds from the new layout,
 * and the new person appears without anybody touching the viewport.
 *
 * ## Why the action is a prop
 *
 * `createIndividualAction` is handed down from `app/tree/page.tsx` rather than
 * imported here. Two reasons, and the first is the one that matters: importing
 * a `"use server"` module into a Client Component drags `@/db`, `next-auth`
 * and their environment requirements into anything that loads this file —
 * including a jsdom test, which then cannot run under `npm test`'s
 * deliberately empty environment (see docs/testing.md). Passing a server
 * function as a prop is the ordinary way across that boundary and leaves the
 * form testable with a stub.
 *
 * The second is that E3-T4 creates a person inline while building a union, and
 * will want these fields submitted somewhere else.
 */
export type IndividualFormAction = (
  state: IndividualFormState,
  form: FormData,
) => Promise<IndividualFormState>;

export interface AddPersonPanelProps {
  /** Where a submission goes. `createIndividualAction`, in the tree header. */
  action: IndividualFormAction;
  /**
   * What the opening button says.
   *
   * The header wants the standing label; E3-T9's empty state opens the same
   * panel as "Add the first person", because on a tree with nobody on it that
   * is the whole instruction. A label rather than a second component, so that
   * adding somebody stays one flow with one set of validation messages
   * however the author reached it.
   */
  label?: string;
}

/**
 * The button, and the panel it opens.
 *
 * The form is mounted only while the panel is open, which is what makes
 * closing it a discard: the values, the last submission's errors and the
 * "added" confirmation all live in `AddPersonForm`'s state and go with it.
 * That is the honest behaviour for a panel whose other exit is a save — a
 * half-typed person kept alive invisibly behind a closed panel is a draft
 * nobody asked for and nothing shows.
 */
export function AddPersonPanel({
  action,
  label = "Add person",
}: AddPersonPanelProps) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  /** Named so the button can point at what it expands. */
  const panelId = useId();

  /**
   * Closing is only "stop rendering the form": focus is the form's own to hand
   * back (`YEO-83`).
   *
   * It used to be done here, which covers exactly the exits that are routed
   * through this callback — today Escape and the Close button — and silently
   * would not cover a third. `FamilyTree` had the same shape and the bug that
   * goes with it: the ways out that never touch the owner's own handler. So
   * `openerRef` goes down to the form instead, and the shared stack puts focus
   * on it when the form unmounts, however that happened.
   *
   * The reason focus goes back at all is the one `FamilyTree` gives for the
   * node: the button is the only thing that was focusable in this corner, and
   * losing focus to `<body>` leaves a keyboard user at the top of the
   * document.
   */
  const close = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls={panelId}
        className="shrink-0 rounded-panel border border-rule px-3 py-1.5 font-medium transition hover:bg-panel"
      >
        {label}
      </button>

      {open ? (
        <AddPersonForm
          action={action}
          onClose={close}
          panelId={panelId}
          openerRef={openerRef}
        />
      ) : null}
    </>
  );
}

export interface AddPersonFormProps {
  action: IndividualFormAction;
  onClose: () => void;
  /** The id the opening button's `aria-controls` points at. */
  panelId?: string;
  /**
   * The button this panel was opened from, for focus to go back to when it
   * closes (`YEO-83`).
   *
   * Named explicitly rather than captured from `document.activeElement` when
   * the panel mounts, because a button is not reliably focused by being
   * pressed: jsdom's `element.click()` moves no focus at all, and Safari does
   * not focus a button on click either. Both would leave this reading whatever
   * was focused before — which is the sort of thing that works everywhere it
   * is tested and nowhere it is used.
   *
   * Optional, so the form can be mounted on its own; without it, closing
   * leaves focus wherever the browser put it.
   */
  openerRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The panel itself: ten fields, a save, and what came back from the last one.
 *
 * Deliberately nothing about relationships. A person can be created standalone
 * and connecting them is E3-T6, which is not a limitation to apologise for on
 * this form — an unattached person is a perfectly ordinary state for a
 * genealogical record that arrived from a census index before anybody worked
 * out whose child they were.
 */
export function AddPersonForm({
  action,
  onClose,
  panelId,
  openerRef,
}: AddPersonFormProps) {
  const [state, formAction, pending] = useActionState(
    action,
    emptyIndividualFormState,
  );

  const [values, setValues] = useState<IndividualFormValues>(
    emptyIndividualFormValues,
  );

  const setField = useCallback((field: IndividualFormField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  }, []);

  /**
   * The person the last successful submission wrote, remembered by id.
   *
   * Comparing against `state.savedId` during render is how the form knows a
   * save has *just happened* — `useActionState` reports the outcome, not the
   * transition to it, so an effect would fire again on every unrelated
   * re-render. Adjusting state during render rather than in an effect is
   * React's own answer to "derive from a prop that changed", and the same
   * pattern `FamilyTree` uses to re-seed from a new layout: the component
   * re-renders before anything is committed, so the stale values are never
   * painted.
   *
   * The name is captured here rather than read back from `savedId`, because
   * clearing the fields is the very next thing that happens.
   */
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  if (state.savedId !== null && state.savedId !== saved?.id) {
    setSaved({ id: state.savedId, name: describePerson(values) });
    setValues(emptyIndividualFormValues);
  }

  /**
   * The confirmation belongs to the *latest* submission, not to the last one
   * that worked.
   *
   * `saved` is deliberately never cleared — it is what keys the fieldset, and
   * resetting it on a refusal would remount the fields and move the cursor
   * mid-correction. So the question "is there something to confirm" is asked
   * of `state` instead, which `useActionState` replaces on every result:
   * `savedId` is null for a refusal, so adding Rose, then getting the next
   * person's death date wrong, shows the error on its own rather than beside
   * a stale "Added Rose."
   */
  const confirmation = state.savedId === null ? null : saved;

  /**
   * Escape closes, from wherever focus is inside the panel — the same
   * dismissal `PersonPanel` gives the detail view, so the two panels on this
   * canvas behave alike. Since `YEO-83` that likeness is literal: both
   * register on the one stack in `components/surface-stack.ts`, which is what
   * makes an Escape over this panel close *this* panel and leave the record
   * behind it open. Before that, both listened and both closed.
   */
  useDismissableSurface({
    onDismiss: onClose,
    returnFocus: () => openerRef?.current ?? null,
  });

  return (
    <aside
      id={panelId}
      aria-label="Add a person"
      className="fixed inset-x-0 bottom-0 z-20 flex max-h-[85%] flex-col border-t border-rule bg-panel sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-96 sm:border-t-0 sm:border-l"
    >
      <div className="flex items-start justify-between gap-2 border-b border-rule-soft px-4 py-3">
        <h2 className="border-0 pb-0 text-h2">Add a person</h2>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash"
        >
          Close
        </button>
      </div>

      <form
        action={formAction}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        <p className="mb-4 text-caption text-ink-muted">
          Only a first name is needed. Everything else can be filled in later,
          or left unknown — most of it usually is.
        </p>

        <IndividualFieldset
          /**
           * Remounting after each save is what puts the cursor back in the
           * first field, ready for the next person. The fieldset focuses on
           * mount, and a save is the only other moment where "start typing
           * here" is certainly the right thing to say; keying on the saved id
           * says exactly that without a second prop for it.
           */
          key={saved?.id ?? "new"}
          values={values}
          onChange={setField}
          fieldErrors={state.fieldErrors}
          disabled={pending}
          autoFocusFirstField
        />

        {state.error === null ? null : (
          <p role="alert" className="mt-4 text-note text-ink">
            {state.error}
          </p>
        )}

        {confirmation === null ? null : (
          /**
           * `role="status"` rather than `alert`: a save that worked is worth
           * announcing but not worth interrupting, and the author is already
           * typing the next person by the time it is read out.
           */
          <p role="status" className="mt-4 text-caption text-ink-muted">
            Added {confirmation.name}. They are on the tree — add another, or
            close this panel.
          </p>
        )}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-panel disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
          >
            {/* The label says what is happening, in the place the author is
                already looking — as on the new-entry form. */}
            {pending ? "Adding…" : "Add person"}
          </button>
        </div>
      </form>
    </aside>
  );
}

/**
 * What to call the person who was just saved.
 *
 * Assembled from what was typed rather than from the record, because the
 * action deliberately returns an id and not a row — and a name read back from
 * the server would be the same two strings after a round trip. The fallback is
 * unreachable in practice (a save with no first name is refused) and exists so
 * the sentence never reads "Added .".
 */
function describePerson(values: IndividualFormValues): string {
  const name = [values.givenName, values.surname]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");

  return name === "" ? "this person" : name;
}
