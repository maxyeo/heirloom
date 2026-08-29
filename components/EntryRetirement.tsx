"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  retireEntryAction,
  type RetireEntryFormState,
} from "@/app/wiki/actions";
import {
  describeDeparture,
  describeIncomingLinks,
  describeWhatIsKept,
} from "@/lib/retirement-copy";
import type { RetirementPreview } from "@/lib/retirement-preview";
import { entryPath } from "@/lib/wiki-paths";

/**
 * The confirmation for retiring an entry (E1-T10, `YEO-122`) — the form on
 * `/wiki/[slug]/retire`.
 *
 * ## The copy is the safety mechanism
 *
 * The same claim `components/CategoryRemoval.tsx` makes, and here it can be
 * honest in a way the person-delete copy cannot. Deleting somebody from the
 * tree is irreversible and `lib/removal-preview.ts` has to spend its sentences
 * warning; retiring an entry destroys nothing at all, so the sentences can
 * spend themselves on being *specific* instead — which is what makes the
 * reassurance believable rather than a hedge.
 *
 * Every number below comes from `previewRetirement`, computed from the entries
 * actually in the database, and `retirePage` runs the same function again
 * inside the transaction that does the write. So the confirmation and the
 * result cannot disagree, which is the property `lib/removal-preview.ts`
 * established and this borrows whole.
 *
 * The consequence worth putting first is the one nobody guesses from a button:
 * **the entries that link here will show red links**. They are named rather
 * than counted, because a reader who can see *which* is a reader who can go
 * and fix the prose; a number only tells them there is something to find.
 *
 * ## Why the confirmation is a page rather than a `confirm()`
 *
 * `RestoreRevisionForm`'s argument, unchanged: `window.confirm` does nothing
 * before the JavaScript has loaded, on a form whose submit is a real POST
 * either way, and it puts the explanation in a box that cannot hold the one
 * thing worth saying — which here is five facts and a list of links.
 *
 * ## Why a page rather than a control at the foot of the article
 *
 * This is the one place it departs from `CategoryRemoval`, which does sit at
 * the foot of the thing it retires, and the reason is arithmetic rather than
 * taste. A category's listing page has already read its entries, so
 * `entryCount` is free. An entry's honest preview costs a read of every live
 * entry's body and hatnote (`lib/retire-page.ts`), and putting that at the
 * foot of `app/wiki/[slug]/page.tsx` would charge every article view for a
 * button almost nobody presses. So the *form and the `FormState` shape* are
 * `CategoryRemoval`'s; the *placement* is
 * `/wiki/[slug]/history/[revisionId]/restore`'s. A confirmation is a page, and
 * the page is where the facts are affordable.
 *
 * ## Why a Client Component
 *
 * `useActionState` gives the refusal without a round trip through a query
 * string, and `pending` — which disables the button while the action runs.
 * Taking `FormData` rather than a typed argument is what keeps it working with
 * JavaScript off: `action` on a `<form>` is an ordinary POST, and the
 * `redirect` the action ends in is a 303 the browser follows by itself.
 */
export interface EntryRetirementProps {
  /** What retiring this entry costs, from `previewRetirement`. */
  preview: RetirementPreview;
}

export function EntryRetirement({ preview }: EntryRetirementProps) {
  const [state, formAction, pending] = useActionState<
    RetireEntryFormState,
    FormData
  >(retireEntryAction, { error: null });

  return (
    <form action={formAction}>
      {/*
        A reference, not content. It is visible in the rendered HTML and
        editable by anyone determined to, and that costs nothing: the action
        requires a session, and every signed-in member may already retire every
        entry — `ALLOWED_EMAILS` is the entire membership model, and there is
        no per-entry ownership to check against (`lib/session.ts`).
      */}
      <input type="hidden" name="slug" value={preview.slug} />

      {/*
        The same panel language the historical-revision banner and the restore
        confirmation both use — `bg-wash`, `border-rule`, `rounded-panel` —
        because this is the same kind of thing: chrome about an entry rather
        than the entry itself.
      */}
      <div className="mb-6 rounded-panel border border-rule bg-wash px-4 py-3">
        {/*
          The sentences come from `lib/retirement-copy.ts` rather than being
          written here, and that is a decision rather than an extraction. The
          ticket says the copy *is* the safety mechanism: every clause is a
          claim about what the write does, and a claim that has to stay true
          wants an assertion. This component cannot carry one — it imports
          `retireEntryAction`, so mounting it drags a `"use server"` module and
          `@/db` into a suite with no `DATABASE_URL` (docs/testing.md) — so the
          wording lives where `lib/retirement-copy.test.ts` can check it at
          zero, one and many, and this file is left with the markup.
        */}
        <p>
          {/* The title is bold, so the copy module hands back the predicate and
              this supplies the subject — see `describeDeparture`. */}
          Retiring <strong>{preview.title}</strong> {describeDeparture(preview)}
        </p>

        <p className="mt-2">
          {describeIncomingLinks(preview)}
          {preview.incomingLinks.length === 0 ? null : (
            <>
              {" "}
              {/*
                Names rather than a count, and links rather than text: a reader
                who can see *which* entries is a reader who can go and fix the
                prose. `Link` so they are client navigations like every other
                entry link, and the address is encoded because a non-Latin
                title produces a non-Latin slug (`lib/entry-slug.ts`).
              */}
              {preview.incomingLinks.map((linked, index) => (
                <span key={linked.slug}>
                  {index > 0 ? ", " : null}
                  <Link href={entryPath(linked.slug)}>{linked.title}</Link>
                </span>
              ))}
              .
            </>
          )}
        </p>

        <p className="mt-2 text-caption text-ink-muted">
          {describeWhatIsKept(preview)}
        </p>
      </div>

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
              save button and both other confirmations do: it says what is
              happening where the reader is already looking. */}
          {pending ? "Retiring…" : "Retire this entry"}
        </button>

        {/*
          A link rather than a button, as the restore confirmation's Cancel is:
          there is no unsaved work here to decide about, so leaving is just
          navigation back to the entry.
        */}
        <Link href={entryPath(preview.slug)} className="text-note">
          Cancel
        </Link>
      </div>
    </form>
  );
}
