"use client";

import { useActionState } from "react";

import {
  deleteCategoryAction,
  type DeleteCategoryFormState,
} from "@/app/wiki/actions";

/**
 * Retiring a category (E11-T8, `YEO-78`) — the control at the foot of a
 * category's own listing page.
 *
 * ## Why there is one at all
 *
 * Because the picker creates categories inline, and a surface that can only
 * create is one whose mistakes are permanent. "Emigranted to Canada" typed
 * once and unfiled a minute later would otherwise sit in the picker forever,
 * offered beside the real one every time somebody types the first letter of
 * it.
 *
 * ## Why the confirmation is the page rather than a `confirm()`
 *
 * The same argument `RestoreRevisionForm` makes. `window.confirm` does nothing
 * before JavaScript has loaded, on a form whose submit is a real POST either
 * way, and it puts the explanation in a box that cannot say the one thing
 * worth saying — which is *how many entries this touches*. The reader is
 * already standing on the list of them, with the count in the tagline above,
 * so the page is the confirmation and this is the button on it.
 *
 * ## What the sentence promises, and why it is true
 *
 * "The entries stay" is not reassurance; it is a property of the schema. There
 * is no foreign key running from `pages` to `categories`, so no statement this
 * button can issue is able to reach an entry — see the `on delete` argument on
 * `pageCategories` in `db/schema.ts`, and `lib/categories.db.test.ts`, which
 * files two entries under a category, deletes it, and checks both entries are
 * still there.
 *
 * ## Why a Client Component
 *
 * `useActionState` gives the refusal message without a round trip through a
 * query string, and `pending` — which disables the button while the action
 * runs. Taking `FormData` rather than a typed argument is what keeps it
 * working with JavaScript off: `action` on a `<form>` is an ordinary POST, and
 * the `redirect` the action ends in is a 303 the browser follows by itself.
 */
export interface CategoryRemovalProps {
  /** Which category. A reference the reader is standing on and may name. */
  slug: string;
  /** How many entries will lose a line from their footer bar. */
  entryCount: number;
}

export function CategoryRemoval({ slug, entryCount }: CategoryRemovalProps) {
  const [state, formAction, pending] = useActionState<
    DeleteCategoryFormState,
    FormData
  >(deleteCategoryAction, { error: null });

  return (
    <form action={formAction} className="mt-8 border-t border-rule-soft pt-4">
      {/*
        A reference, not content. It is visible in the rendered HTML and
        editable by anyone determined to, and that costs nothing: the action
        requires a session, and every signed-in person may already retire every
        category — `ALLOWED_EMAILS` is the entire membership model, and there
        is no per-category ownership to check against (`lib/session.ts`).
      */}
      <input type="hidden" name="slug" value={slug} />

      <p className="text-note text-ink-muted">
        {entryCount === 0
          ? "Retiring this category removes the heading. There is nothing filed under it."
          : entryCount === 1
            ? "Retiring this category removes the heading and takes it off the 1 entry filed under it. The entry itself stays."
            : `Retiring this category removes the heading and takes it off the ${entryCount} entries filed under it. The entries themselves stay.`}
      </p>

      {state.error === null ? null : (
        <p role="alert" className="mt-2 text-note text-ink">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-panel border border-rule px-3 py-1 text-note transition enabled:hover:bg-panel disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
      >
        {/* The label changes rather than a spinner appearing, as the editor's
            save button and the restore confirmation both do: it says what is
            happening where the reader is already looking. */}
        {pending ? "Retiring…" : "Retire this category"}
      </button>
    </form>
  );
}
