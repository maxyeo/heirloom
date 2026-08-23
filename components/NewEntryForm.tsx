"use client";

import { useActionState, useId } from "react";

import { createPageAction, type NewEntryFormState } from "@/app/wiki/actions";

/**
 * The whole of starting an entry (E1-T8, `YEO-22`): one field.
 *
 * ## What is deliberately not here
 *
 * No address field, no preview of the address, and no mention of the word
 * "slug". The ticket is explicit about it, and the reasoning is worth keeping
 * next to the code: the author of this wiki is a family member writing about
 * their grandmother, and every field on this form is a question they have to
 * answer before they are allowed to start writing. The URL is derivable, so
 * it is derived — and when it needs disambiguating, that happens silently in
 * `lib/create-page.ts` rather than as a question nobody can answer well.
 *
 * There is no body field either. The body is what the editor is for, and this
 * form's job ends the moment the entry exists and the author is standing in
 * it.
 *
 * ## Why a Client Component
 *
 * `useActionState` gives two things a plain server-rendered form cannot: the
 * refusal message without a round trip through a query string, and `pending`
 * — which disables the button while the action runs. That second one is not
 * polish. Creation is not idempotent: a double-clicked button without it
 * makes two entries, the second one silently living at `rose-hall-2`, and the
 * author has no way to tell.
 *
 * Taking `FormData` rather than a typed argument is what keeps the form
 * working before the JavaScript has loaded: `action` on a `<form>` is a real
 * POST, and the `redirect` the action ends in is a 303 the browser follows on
 * its own. What that path does not get is the pending state or the refusal
 * message — which is why `required` is on the input as well, so the one
 * refusal the author can actually cause is caught by the browser first.
 */
export function NewEntryForm() {
  const titleId = useId();
  const errorId = useId();

  const [state, formAction, pending] = useActionState<
    NewEntryFormState,
    FormData
  >(createPageAction, { error: null });

  return (
    <form action={formAction} className="mt-6">
      <label htmlFor={titleId} className="block text-caption text-ink-muted">
        Title
      </label>

      <input
        id={titleId}
        name="title"
        type="text"
        // The only field, on a page the author navigated to in order to fill
        // it in. Anywhere else this would be presumptuous.
        autoFocus
        required
        autoComplete="off"
        placeholder="Rose Hall"
        aria-invalid={state.error !== null}
        aria-describedby={state.error === null ? undefined : errorId}
        className="mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink"
      />

      <p className="mt-2 text-note text-ink-muted">
        The name of a person, a place, or anything else worth a page of its own.
        It can be changed later.
      </p>

      {state.error === null ? null : (
        <p id={errorId} role="alert" className="mt-2 text-note text-ink">
          {state.error}
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-panel disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
        >
          {/* The label changes rather than a spinner appearing: it says what
              is happening in the same place the author is already looking. */}
          {pending ? "Starting…" : "Start writing"}
        </button>
      </div>
    </form>
  );
}
