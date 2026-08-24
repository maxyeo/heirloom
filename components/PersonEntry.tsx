"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";

import { FormSelect } from "@/components/FormSelect";
import type { EntryLink } from "@/lib/entry-link";
import {
  type EntryLinkState,
  idleEntryLinkState,
  type PersonEntryActions,
  type PersonEntryFormAction,
} from "@/lib/entry-link-state";

/**
 * The seam between the tree and the wiki, on the panel (E2-T2, `YEO-25`).
 *
 * `individuals.page_id` has existed since the first migration and has always
 * been null, because nothing could set it. This is the control that fills it
 * in: an entry to open when there is one, an invitation to write when there is
 * not, and a way back out that leaves the entry where it is.
 *
 * ## Why it is not in `components/PersonPanel.tsx`
 *
 * The panel is a read-only record — its own header says so — and every write
 * the canvas has grown since has arrived as something composed into it rather
 * than as a form the panel learned to render. E3-T3, E3-T7 and E3-T8 all sit
 * in its `footer` slot for that reason; this one sits in its `entryLink` slot,
 * higher up, because an entry is not an edit to the record but the other half
 * of the product.
 *
 * ## Why "write about this person" is a form and not a link
 *
 * Because it writes. A link to `/wiki/new?title=Rose+Hale` would leave the
 * author retyping a name the row already holds, and would leave the entry
 * unlinked afterwards — the two halves this ticket exists to join. Posting the
 * person's id instead lets `createEntryForPerson` title the entry from the
 * row, create it through E1-T8's code so its history starts correctly, and set
 * `page_id` in the same transaction. The author lands in the editor with the
 * title already right.
 *
 * ## Why the actions arrive as props
 *
 * `app/tree/actions.ts` reaches Auth.js and `@/db`, and `npm test` runs with
 * no `AUTH_*` and no `DATABASE_URL` (docs/testing.md) — so a Client Component
 * that imports it cannot be mounted, and neither can the canvas that renders
 * it. See `PersonEntryActions`.
 */
export function PersonEntry({
  personId,
  personName,
  entry,
  options,
  actions,
}: {
  /** The person whose panel this is. Every form posts it as a reference. */
  personId: string;
  /** Their name, for the sentence shown when nobody has written about them. */
  personName: string;
  /** Their entry, or null when `page_id` is unset. See `findEntry`. */
  entry: EntryLink | null;
  /**
   * The entries no one is linked to, for the "link an existing entry" picker.
   *
   * Filtered by `unlinkedEntries` rather than here: the write refuses an entry
   * somebody else already claims, and this list is the courtesy that keeps the
   * refused option off the menu — the same shape the tree's own pickers use
   * for the children `lib/save-child.ts` would reject.
   */
  options: readonly EntryLink[];
  /**
   * The three doors onto `page_id`, or nothing at all.
   *
   * Optional, so a canvas without them still *shows* the entry a person has —
   * which is the read half of this ticket, and the half that has to keep
   * working in `npm test`.
   */
  actions?: PersonEntryActions;
}) {
  return (
    <section>
      <h3>Entry</h3>

      {entry ? (
        <>
          <p>
            <Link
              href={`/wiki/${encodeURIComponent(entry.slug)}`}
              className="text-link hover:underline"
            >
              {entry.title}
            </Link>
          </p>
          {actions ? (
            <UnlinkEntry action={actions.unlink} personId={personId} />
          ) : null}
        </>
      ) : (
        <>
          {/*
            "Nobody has written about them yet" rather than an omitted section,
            for the reason `Section` in the panel gives about relatives: an
            absent heading reads as "this panel does not show entries", and
            what is true is that there is not one.
          */}
          <p className="text-caption text-ink-muted">
            No entry yet for {personName}.
          </p>
          {actions ? (
            <>
              <CreateEntry action={actions.create} personId={personId} />
              {options.length > 0 ? (
                <LinkEntry
                  action={actions.link}
                  personId={personId}
                  options={options}
                />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Matches the selects on the tree's own forms; see `AddChildForm`. */
const CONTROL_CLASS =
  "mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Each of the three controls is its own component, and that is not decoration:
 * `useActionState` is one hook per form, and hooks cannot be called
 * conditionally. Rendering *components* conditionally is the shape React asks
 * for when only one of several forms is on screen at a time.
 */
function CreateEntry({
  action,
  personId,
}: {
  action: PersonEntryFormAction;
  personId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    idleEntryLinkState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="personId" value={personId} />
      <button
        type="submit"
        disabled={pending}
        className="mt-1 text-note text-link hover:underline disabled:opacity-40"
      >
        Write about this person
      </button>
      <Failure state={state} />
    </form>
  );
}

function LinkEntry({
  action,
  personId,
  options,
}: {
  action: PersonEntryFormAction;
  personId: string;
  options: readonly EntryLink[];
}) {
  const [state, formAction, pending] = useActionState(
    action,
    idleEntryLinkState,
  );
  const selectId = useId();

  /**
   * Controlled, and through `FormSelect` rather than a bare `<select>`.
   * E3-T2's lesson was that inputs in a form with an action must be
   * controlled, because React resets the form on every submission before the
   * action runs — and `FormSelect`'s header documents the sharper version for
   * selects, whose DOM default React does not keep in step. Without it a
   * refused link would silently revert the chosen entry to "Choose an entry"
   * while the author was reading why their choice was refused.
   */
  const [pageId, setPageId] = useState("");

  return (
    <form action={formAction} className="mt-2">
      <input type="hidden" name="personId" value={personId} />
      <label htmlFor={selectId} className="block text-note text-ink-muted">
        Or point them at an entry that already exists
      </label>
      <FormSelect
        id={selectId}
        name="pageId"
        required
        disabled={pending}
        value={pageId}
        onChange={(event) => setPageId(event.target.value)}
        className={CONTROL_CLASS}
      >
        <option value="" disabled>
          Choose an entry
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.title}
          </option>
        ))}
      </FormSelect>
      <button
        type="submit"
        disabled={pending}
        className="mt-1 rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash disabled:opacity-40"
      >
        Link this entry
      </button>
      <Failure state={state} />
    </form>
  );
}

function UnlinkEntry({
  action,
  personId,
}: {
  action: PersonEntryFormAction;
  personId: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    idleEntryLinkState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="personId" value={personId} />
      <button
        type="submit"
        disabled={pending}
        className="mt-1 text-note text-link hover:underline disabled:opacity-40"
      >
        Unlink this entry
      </button>
      {/*
        Said next to the button rather than behind a confirmation, because it
        is the whole point of the operation: `page_id` is `on delete set null`
        precisely so that an entry can outlive the link to it. Nothing is
        deleted, and the picker above can put it back.
      */}
      <p className="text-note text-ink-muted">
        The entry itself is kept, and can be linked again.
      </p>
      <Failure state={state} />
    </form>
  );
}

/**
 * `role="alert"`, as `PersonRemoval` and `UnionOrder` use for the same job:
 * this appears after a press the author is watching for, and it is the only
 * thing on screen that changed — a refused link leaves the panel exactly as it
 * was.
 *
 * There is nothing to render for a success. A link that was written
 * revalidates `/tree`, so the panel re-renders with the entry on it before
 * anyone reads a message about it, and a creation ends in a redirect into the
 * editor.
 */
function Failure({ state }: { state: EntryLinkState }) {
  if (state.status !== "failed") return null;

  return (
    <p role="alert" className="mt-1 text-caption">
      {state.error}
    </p>
  );
}
