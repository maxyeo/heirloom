"use client";

import { useActionState } from "react";

import {
  restoreEntryAction,
  type RestoreEntryFormState,
} from "@/app/wiki/actions";

/**
 * The Restore button on a tombstone (E1-T10, `YEO-122`).
 *
 * ## Why there is no confirmation in front of this one
 *
 * Every other destructive-looking button in this application sits behind a
 * page that explains itself — `CategoryRemoval`, `RestoreRevisionForm`,
 * `EntryRetirement`. This one does not, and the asymmetry is the point of the
 * whole feature rather than an omission.
 *
 * A confirmation guards an operation whose consequences are hard to see or
 * hard to reverse. Restoring an entry has neither property: it puts the entry
 * back at the address it never left, with the history it never lost, and if it
 * was pressed by mistake the entry can be retired again through the
 * confirmation that is still there. Asking somebody to confirm an undo is
 * asking them to confirm a decision they have already made twice.
 *
 * And the tombstone *is* the explanation. The reader is standing on a page
 * that says what happened, who did it and when; there is no second screen with
 * anything to add.
 *
 * The direction that matters: retiring is the deliberate act and restoring is
 * the cheap one. A wiki where both cost the same is one where nobody retires
 * anything, and the entry created by mistake stays in the index forever —
 * which is the state E1-T10 exists to end.
 *
 * ## Why a Client Component
 *
 * `useActionState` for `pending`, which is not polish here: a restore is not
 * free to repeat. Two submissions land as one real restore and one
 * `not-retired` refusal — the `FOR UPDATE` lock in `lib/retire-page.ts`
 * guarantees exactly that — and the reader would be shown the refusal, which
 * reads as though their restore had failed when it succeeded.
 *
 * Taking `FormData` keeps it working with JavaScript off, as every other form
 * here does: `action` on a `<form>` is an ordinary POST, and the `redirect`
 * the action ends in is a 303 the browser follows by itself.
 */
export interface EntryRestorationProps {
  /** Which entry. A reference the reader is standing on and may name. */
  slug: string;
}

export function EntryRestoration({ slug }: EntryRestorationProps) {
  const [state, formAction, pending] = useActionState<
    RestoreEntryFormState,
    FormData
  >(restoreEntryAction, { error: null });

  return (
    <form action={formAction} className="mt-4">
      {/*
        A reference, not content. Visible and editable by anyone determined to,
        and costing nothing for the reason `CategoryRemoval` gives: the action
        requires a session, and every signed-in member may already restore
        every retired entry.
      */}
      <input type="hidden" name="slug" value={slug} />

      {state.error === null ? null : (
        <p role="alert" className="mb-2 text-note text-ink">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-panel disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
      >
        {pending ? "Restoring…" : "Restore this entry"}
      </button>
    </form>
  );
}
