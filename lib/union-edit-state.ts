import {
  type UnionFieldErrors,
  unionFieldErrorsFrom,
  type UnionValidationIssue,
} from "@/lib/union-input";

/**
 * What the edit-union form renders while it waits, and after a submission.
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * A `"use server"` module may only export async functions — every other export
 * would be a value React has no way to send to the client. So the state type,
 * its empty value, and the constructors below cannot live beside the action
 * that returns them, even though that is where they read most naturally. The
 * same split `lib/individual-form-state.ts` and `lib/spouse-form-state.ts`
 * already made, followed here rather than reinvented.
 *
 * ## Why it is not `SpouseFormState`
 *
 * That state carries two error maps because one add-spouse submission
 * validates two records — a union, and the partner being created inline with
 * it. A correction validates one. Reusing the wider type would leave a
 * `partnerErrors` field on every state this flow ever builds, permanently
 * empty, and would invite a form to render messages for a person it is not
 * editing. What the two flows genuinely share is `UnionFieldErrors`, and they
 * share it.
 */

/**
 * The outcome of one submission, shaped for `useActionState`.
 *
 * - `savedUnionId` — the union written by the last successful submission.
 *   Present rather than the action issuing a `redirect`, because *where to go
 *   next* is the form's decision: the tree stays where it is and the dialogue
 *   closes back to the record. It is also what the form watches to know it
 *   succeeded, since a server action's return value is the only signal it
 *   gets. It comes back for an unchanged submission too — see
 *   `unionUnchangedState`.
 * - `unionErrors` — a message per input, which is how a validation failure is
 *   actually rendered: beside the field that is wrong.
 * - `error` — one sentence for a failure belonging to no single field, such as
 *   the union having been deleted or merged away in another tab.
 */
export type UnionEditState = {
  /** The union written by the last successful submission, or null. */
  savedUnionId: string | null;
  /** A sentence to show, or null when there is nothing to say. */
  error: string | null;
  /** Per-field messages for the union. Empty when all is well. */
  unionErrors: UnionFieldErrors;
};

/**
 * The state the form starts in, for `useActionState`'s initial value.
 *
 * Frozen, because `useActionState` holds onto this object for the life of the
 * component and a shared mutable default would leak one form's state into the
 * next one that mounted.
 */
export const emptyUnionEditState: UnionEditState = Object.freeze({
  savedUnionId: null,
  error: null,
  unionErrors: {},
});

/** The state for a correction that was written. */
export function unionSavedState(unionId: string): UnionEditState {
  return { savedUnionId: unionId, error: null, unionErrors: {} };
}

/**
 * The state for a submission that changed nothing.
 *
 * Identical to a save, deliberately. An author who opens the form, thinks
 * better of it and presses save has not failed at anything, and the id coming
 * back is what lets a form that closes on `savedUnionId` close cleanly rather
 * than needing a case of its own. `updateUnion` compares against the values
 * that would actually be *written*, so this is reached by a genuine no-op
 * rather than by an author retyping the same date in different words.
 */
export const unionUnchangedState = unionSavedState;

/**
 * The state for a submission that was refused over its fields.
 *
 * `savedUnionId` goes back to null on a refusal: it names what the *last
 * submission* wrote, and this one wrote nothing. Leaving a stale id there
 * would let a form that closes on `savedUnionId` close over the errors it was
 * supposed to be showing.
 */
export function unionInvalidState(
  issues: readonly UnionValidationIssue[],
): UnionEditState {
  return {
    savedUnionId: null,
    error: null,
    unionErrors: unionFieldErrorsFrom(issues),
  };
}

/** The state for a failure that belongs to no single field. */
export function unionEditFailedState(message: string): UnionEditState {
  return { savedUnionId: null, error: message, unionErrors: {} };
}

/**
 * The shape of the action the edit-union form submits to.
 *
 * Declared here rather than inferred from `updateUnionAction`, so that
 * `components/EditUnionForm.tsx` can take the action as a prop instead of
 * importing it. That is not indirection for its own sake: `app/tree/actions.ts`
 * reaches `@/lib/session` and therefore Auth.js, so a component that imports it
 * cannot be mounted by `npm test` — which runs with no `AUTH_*` and no
 * `DATABASE_URL` at all (docs/testing.md). The canvas renders this form, so
 * importing the action inside it would take the whole of
 * `components/FamilyTree.test.tsx` down with it.
 *
 * Passing a server action from a Server Component into a Client Component is
 * the framework's own pattern for this
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`), so the
 * only file that names the action is `app/tree/page.tsx`.
 */
export type UpdateUnionFormAction = (
  previous: UnionEditState,
  form: FormData,
) => Promise<UnionEditState>;
