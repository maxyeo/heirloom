"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  restoreRevisionAction,
  type RestoreFormState,
} from "@/app/wiki/actions";
import { entryPath } from "@/lib/wiki-paths";

/**
 * The confirmation half of one-click restore (E1-T7, `YEO-21`): two hidden
 * references, a button that does it, and a way out.
 *
 * ## Why the confirmation is a page and not a `confirm()`
 *
 * The ticket asks for a restore button "with confirmation", and the reflex
 * answer — `window.confirm` in an `onClick` — fails the two tests this repo
 * already applies to every other form. It does nothing at all before the
 * JavaScript has loaded, on a form whose submit is a real POST either way; and
 * it puts the explanation in a modal that cannot say anything useful, when
 * what a reader actually needs to know is *which* version they are about to
 * bring back and what it will do to the history. So the confirmation is the
 * route this component sits on: it names the version, states the consequence
 * in a sentence, and offers exactly two ways forward.
 *
 * ## Why a Client Component
 *
 * `useActionState` gives the two things a plain server-rendered form cannot:
 * the refusal message without a round trip through a query string, and
 * `pending` — which disables the button while the action runs. The second is
 * not polish here. A restore is not free to repeat: two submissions of the
 * same restore land as one real revision and one `unchanged` refusal (the
 * `FOR UPDATE` lock in `lib/restore-revision.ts` guarantees it), and the
 * reader would be shown the refusal, which reads as though their restore
 * failed when it succeeded.
 *
 * Taking `FormData` rather than a typed argument is what keeps this working
 * with JavaScript off: `action` on a `<form>` is an ordinary POST, and the
 * `redirect` the action ends in is a 303 the browser follows by itself. What
 * that path loses is the pending state and the refusal message, neither of
 * which is load-bearing for correctness — the guards are all on the server.
 */
export interface RestoreRevisionFormProps {
  /** Which entry. Sent to the action, and the target of "Cancel". */
  slug: string;
  /** Which revision to copy forward. A reference; never the content. */
  revisionId: string;
}

export function RestoreRevisionForm({
  slug,
  revisionId,
}: RestoreRevisionFormProps) {
  const [state, formAction, pending] = useActionState<
    RestoreFormState,
    FormData
  >(restoreRevisionAction, { error: null });

  return (
    <form action={formAction}>
      {/*
        References, not content. What gets written is read from the database
        inside the transaction, so nothing here decides what the entry will
        say — which is why these being visible in the rendered HTML, and
        editable by anyone determined to, costs nothing: `restoreRevision`
        checks that the revision belongs to this entry, and `requireSession`
        checks that the poster is signed in.
      */}
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="revisionId" value={revisionId} />

      {state.error === null ? null : (
        <p role="alert" className="mb-4 text-note text-ink">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-panel disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
        >
          {/* The label changes rather than a spinner appearing, as the editor's
              save button does: it says what is happening where the reader is
              already looking. */}
          {pending ? "Restoring…" : "Restore this version"}
        </button>

        {/*
          A link rather than a button, unlike the editor's Cancel: there is no
          unsaved work here to decide about, so leaving is just navigation
          back to the version being looked at.
        */}
        <Link
          href={entryPath(slug, "history", revisionId)}
          className="text-note"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
