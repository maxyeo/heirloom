import {
  fieldErrorsFrom,
  type IndividualFieldErrors,
  type ValidationIssue,
} from "@/lib/individual-input";

/**
 * What a person form renders while it waits, and after a submission (E3-T1,
 * `YEO-29`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * A `"use server"` module may only export async functions — every other export
 * would be a value React has no way to send to the client. So the state type,
 * its empty value, and the two constructors below cannot live beside the
 * actions that return them, even though that is where they read most
 * naturally.
 *
 * The split turns out to be worth having anyway: E3-T2 and E3-T3's form
 * components need the initial state for `useActionState` and the field-error
 * shape for rendering, and importing those from here costs them nothing,
 * whereas importing them from the actions module would pull the action
 * references into a component that may only want the type.
 */

/**
 * The outcome of one submission, shaped for `useActionState`.
 *
 * Three members, because a person form has three distinct things to say:
 *
 * - `savedId` — the person written by the last successful submission. Present
 *   rather than the action issuing a `redirect`, because *where to go next* is
 *   the form's decision: E3-T2 adds a person and may want to stay put and add
 *   another, E3-T3 edits one from a detail panel and wants to return to it,
 *   and E3-T4 creates a partner mid-flow and needs the id to build the union
 *   with. An action that redirected would take that choice away from all three.
 * - `fieldErrors` — a message per input, which is how a validation failure is
 *   actually rendered: beside the field that is wrong.
 * - `error` — one sentence for a failure belonging to no single field, such as
 *   the person having been deleted in another tab.
 *
 * A successful submission and a refused one are the same type rather than a
 * discriminated union, because a form renders both at once: the id from the
 * last save can sit on screen while the next attempt shows an error.
 */
export type IndividualFormState = {
  /** The id written by the last successful submission, or null. */
  savedId: string | null;
  /** A sentence to show, or null when there is nothing to say. */
  error: string | null;
  /** Per-field messages, keyed by the input's `name`. Empty when all is well. */
  fieldErrors: IndividualFieldErrors;
};

/**
 * The state a person form starts in, for `useActionState`'s initial value.
 *
 * Frozen, because `useActionState` holds onto this object for the life of the
 * component and a shared mutable default would leak one form's state into the
 * next one that mounted. Exported so E3-T2 and E3-T3 do not each write their
 * own empty literal and disagree about it the day a member is added.
 */
export const emptyIndividualFormState: IndividualFormState = Object.freeze({
  savedId: null,
  error: null,
  fieldErrors: {},
});

/** The state for a submission that was written. */
export function savedFormState(id: string): IndividualFormState {
  return { savedId: id, error: null, fieldErrors: {} };
}

/**
 * The state for a submission that was refused over its fields.
 *
 * `savedId` goes back to null on a refusal: it names what the *last
 * submission* wrote, and this one wrote nothing. Leaving a stale id there
 * would let a form that navigates on `savedId` navigate away from the errors
 * it was supposed to be showing.
 */
export function invalidFormState(
  issues: readonly ValidationIssue[],
): IndividualFormState {
  return { savedId: null, error: null, fieldErrors: fieldErrorsFrom(issues) };
}

/** The state for a failure that belongs to no single field. */
export function failedFormState(message: string): IndividualFormState {
  return { savedId: null, error: message, fieldErrors: {} };
}
