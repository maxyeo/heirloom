"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { IndividualFormAction } from "@/components/AddPersonPanel";
import {
  IndividualFieldset,
  individualFormValuesFrom,
  type IndividualFormValues,
} from "@/components/IndividualFieldset";
import { ModalDialog } from "@/components/ModalDialog";
import type { GraphPerson } from "@/lib/family-graph";
import { emptyIndividualFormState } from "@/lib/individual-form-state";
import type { IndividualField } from "@/lib/individual-input";
import { formatPersonName } from "@/lib/person-format";

/**
 * Correcting somebody already on the tree (E3-T3, `YEO-31`).
 *
 * ## The same ten fields, prefilled
 *
 * "Same component as E3-T2" is the first acceptance criterion, and it is met
 * literally: this renders `components/IndividualFieldset.tsx`, unchanged, with
 * `values` seeded from the person's record instead of from
 * `emptyIndividualFormValues`. Nothing about what a person *is* — which field
 * is required, how long a surname may be, that a date carries a qualifier — is
 * restated here, which is the whole reason that component was split out of the
 * add-person panel in the first place.
 *
 * The seeding is `individualFormValuesFrom`, which lives beside the type it
 * produces. Note what it does *not* do: it does not decide what a cleared
 * field means. `validateIndividual` collapses blank text to `null` for every
 * caller including GEDCOM import, so emptying the birth place here writes a
 * null rather than an empty string without this file containing a rule about
 * it — and `components/EditPersonForm.test.tsx` asserts the round trip through
 * a real submission rather than trusting the two halves to agree.
 *
 * ## Why the write goes through `updateIndividualAction` untouched
 *
 * The action already existed (E3-T1) and already reads the hidden `id`,
 * looks the row up, and reports `not-found` for a person deleted in another
 * tab. So the form's whole contribution to the write is one hidden field. The
 * `unchanged` case matters here more than anywhere: `updateIndividual`
 * compares against the values that would actually be *written*, so an author
 * who opens this, changes nothing and presses save gets a clean close and no
 * cache thrown away.
 *
 * ## The unsaved-changes warning
 *
 * The third criterion, and it needs saying what "navigate away" means for a
 * form that lives on a canvas rather than at a URL. There are exactly four
 * ways out of this dialogue and it guards all of them:
 *
 * - **Cancel**, **Escape** and **the backdrop** all arrive at `requestClose`,
 *   which shows the discard prompt instead of closing when there is something
 *   to lose. Escape reaching here at all is what `ModalDialog`'s capture-phase
 *   listener buys — without it the keystroke would also close the detail panel
 *   underneath.
 * - **Leaving the page** — a reload, the back button, a typed URL — is the
 *   browser's own navigation, and `beforeunload` is the only hook there is.
 *   Registered only while the form is dirty, because a page that always asks
 *   is a page whose warning nobody reads.
 *
 * A *client-side* navigation is the one kind that neither of those catches,
 * and it cannot happen here: `/tree` renders no `<Link>`, and the backdrop
 * covers the canvas so nothing behind it is clickable while this is open. If a
 * link is ever added to the tree header, `<Link onNavigate>` — which takes a
 * `preventDefault()` — is where this check belongs (see
 * `node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md`).
 *
 * ## Why it is opened from the panel's footer
 *
 * `components/PersonPanel.tsx` is deliberately a read-only record and says so
 * in its own header; E3-T8 already had this problem and solved it with a
 * `footer` slot rather than by teaching the panel a new form. The edit
 * affordance goes in the same slot, so the panel gains an edit route without
 * gaining a line of code — which also keeps this ticket's diff off a file two
 * sibling tickets are editing at the same time.
 *
 * ## Why the action arrives as a prop
 *
 * Importing `updateIndividualAction` reaches Auth.js and `@/db`, and `npm
 * test` runs with no `AUTH_*` and no `DATABASE_URL` at all (docs/testing.md),
 * so a component that imports it cannot be mounted in jsdom — and neither can
 * anything that renders it, the whole canvas included. `app/tree/page.tsx`
 * hands it down instead, which is the framework's own pattern and the one
 * `AddPersonPanel` and `AddSpouseForm` both settled on.
 */

export interface EditPersonProps {
  /**
   * The person as they are stored, not as the detail panel describes them.
   *
   * `PersonDetail` is formatted for reading — "about 12 March 1890", a name
   * already joined — and a form prefilled from it would put prose in a date
   * input. This is the row.
   */
  person: GraphPerson;
  /** Where a submission goes. `updateIndividualAction`, from the tree page. */
  action: IndividualFormAction;
}

/**
 * The button, and the dialogue it opens.
 *
 * The form is mounted only while the dialogue is open, which is what makes
 * discarding a discard: the edits, the last submission's errors and the
 * prefill all go with it, and reopening starts again from the record. That is
 * the honest behaviour for a dialogue whose other exit is a save — a
 * half-corrected person kept alive invisibly behind a closed dialogue is a
 * draft nobody asked for and nothing shows.
 */
export function EditPerson({ person, action }: EditPersonProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Focus goes back to the button the dialogue came from, which is the pattern
   * `components/PersonPanel.tsx` sets for itself. Without it a keyboard user
   * closes the form and lands on `<body>`, behind the very panel they were
   * reading, with no way back but tabbing in from the top of the document.
   *
   * The trigger is always mounted — it sits behind the backdrop rather than
   * being replaced by it — so there is nothing to wait for here.
   */
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <section className="border-t border-rule-soft pt-3">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash"
      >
        Edit details
      </button>

      {open ? (
        <EditPersonForm
          /**
           * A different person means a different record to correct, so the
           * form starts over rather than carrying one person's half-finished
           * edits onto another. In practice the panel closes this when the
           * selection moves, but the key is what makes that a property of the
           * component rather than of the canvas around it.
           */
          key={person.id}
          person={person}
          action={action}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

export interface EditPersonFormProps {
  person: GraphPerson;
  action: IndividualFormAction;
  /** Saved, or discarded. Either way the dialogue goes. */
  onClose: () => void;
}

export function EditPersonForm({
  person,
  action,
  onClose,
}: EditPersonFormProps) {
  const [state, formAction, pending] = useActionState(
    action,
    emptyIndividualFormState,
  );

  /**
   * The record as the form holds it — what "unchanged" is measured against.
   *
   * Recomputed when the person changes identity, which happens on every
   * revalidation of `/tree`, not only when this person moved. That is
   * deliberate: `values` is *not* re-seeded, so an edit in progress survives
   * somebody else's write landing in this tab, while `dirty` goes on comparing
   * against what is actually stored.
   */
  const initial = useMemo(() => individualFormValuesFrom(person), [person]);
  const [values, setValues] = useState<IndividualFormValues>(initial);

  const setField = useCallback((field: IndividualField, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  }, []);

  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  const dirty = !sameValues(values, initial);

  const name = formatPersonName(person.givenName, person.surname);

  /**
   * The record was written, so this dialogue has nothing left to show.
   *
   * Watching the returned state rather than calling back from a submit
   * handler, because the action's answer is the only thing that knows whether
   * the write landed — a submission that came back with field errors must not
   * close the form over the messages it was supposed to be showing.
   *
   * `savedId` comes back for `unchanged` as well as `updated`, which is what
   * makes pressing save on an untouched form close cleanly instead of
   * reporting a failure at nothing.
   */
  useEffect(() => {
    if (state.savedId !== null) onClose();
  }, [state.savedId, onClose]);

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
   * button press, so focus moves to it — otherwise an author who pressed
   * Escape is told, somewhere below the fold of a ten-field form, that
   * something needs deciding.
   *
   * "Keep editing" rather than "Discard": the safe one is where an
   * absent-minded Enter should land.
   */
  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  return (
    <ModalDialog title={`Edit ${name}`} onClose={requestClose}>
      <form action={formAction}>
        {/*
          The one thing this form sends that the author did not type: a
          reference to the row being corrected, exactly as
          `RestoreRevisionForm` sends a `revisionId`. Whether it names a person
          who still exists is `updateIndividual`'s question — the answer comes
          back as the `error` rendered below.
        */}
        <input type="hidden" name="id" value={person.id} />

        <p className="mb-4 text-caption text-ink-muted">
          Emptying a field records it as unknown rather than as blank. Only the
          first name has to stay filled in.
        </p>

        <IndividualFieldset
          values={values}
          onChange={setField}
          fieldErrors={state.fieldErrors}
          disabled={pending}
        />

        {state.error === null ? null : (
          <p role="alert" className="mt-4 text-note text-ink">
            {state.error}
          </p>
        )}

        {confirmingDiscard ? (
          <>
            <p role="alert" className="mt-6 text-note text-ink">
              Your changes to {name} have not been saved yet.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                ref={keepEditingRef}
                type="button"
                className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash"
                onClick={() => setConfirmingDiscard(false)}
              >
                Keep editing
              </button>
              <button
                type="submit"
                className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash"
              >
                Save them
              </button>
              <button
                type="button"
                className="rounded-panel border border-rule px-3 py-1 text-note text-ink-muted hover:bg-wash"
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
                  already looking — as on the add-person panel. */}
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
 * Every key of `IndividualFormValues`, for the comparison below.
 *
 * Written as the keys of a `Record` rather than as a bare array so that it is
 * exhaustive *by construction*: the object literal cannot omit a field and
 * cannot invent one, both of which `satisfies` reports as type errors here. A
 * plain list would compile perfectly well while quietly no longer looking at a
 * field somebody added — and the symptom would be an edit form that let that
 * field's changes be discarded without a word.
 *
 * The same shape, and the same reasoning, as `FIELD_NAMES` in
 * `lib/save-individual.ts`, which cannot be imported here because it reaches
 * `@/db`. The cast is `Object.keys` returning `string[]`, a known gap in its
 * signature; the literal is right above it, so the narrower type is a fact
 * rather than a hope.
 */
const FIELD_NAMES = Object.keys({
  givenName: true,
  surname: true,
  sex: true,
  birthDate: true,
  birthDateQualifier: true,
  birthPlace: true,
  deathDate: true,
  deathDateQualifier: true,
  deathPlace: true,
  notes: true,
} satisfies Record<IndividualField, true>) as IndividualField[];

/**
 * Whether two sets of form values would write the same row.
 *
 * Trimmed, because `validateIndividual` trims before writing and this question
 * is only ever asked in order to decide whether anything is at stake. An
 * author who added a trailing space to a surname has changed nothing, and
 * being asked to confirm a discard over it would teach them to click through
 * the prompt without reading it.
 *
 * It errs the other way in one place: a date qualifier moved while its date is
 * blank counts as a change here, and `validateIndividual` would normalise it
 * back to `exact` and write nothing. Over-warning costs a keystroke;
 * under-warning costs the edit.
 */
function sameValues(
  a: IndividualFormValues,
  b: IndividualFormValues,
): boolean {
  return FIELD_NAMES.every((field) => a[field].trim() === b[field].trim());
}
