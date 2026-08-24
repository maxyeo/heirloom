import {
  type ParentsFieldErrors,
  parentsFieldErrorsFrom,
  type ParentsValidationIssue,
} from "@/lib/parents-input";

/**
 * What the set-parents form renders while it waits, and after a submission
 * (E3-T6, `YEO-34`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * A `"use server"` module may only export async functions — every other export
 * would be a value React has no way to send to the client. So the state type,
 * its empty value, and the constructors below cannot live beside the action
 * that returns them. This is the same split `lib/individual-form-state.ts`,
 * `lib/spouse-form-state.ts` and `lib/child-form-state.ts` already made, and
 * it is followed here rather than reinvented.
 *
 * ## Why there is only one error map
 *
 * Unlike the add-child form, this one creates nobody. Its every field is a
 * *reference* — which child, which family, which two parents — so one map
 * keyed by field name can say what is wrong with each control without any
 * ambiguity about whose `notes` a message belongs to. That the flow never
 * creates a person is deliberate and is the reason the map stays simple; see
 * `lib/set-parents.ts`.
 */

/**
 * The outcome of one submission, shaped for `useActionState`.
 *
 * - `savedUnionId` — the family recorded by the last successful submission.
 *   Present rather than the action issuing a `redirect`, because *where to go
 *   next* is the form's decision: the tree stays where it is and the panel
 *   closes back to the person who now has parents. It is also what the form
 *   watches to know it succeeded, since a server action's return value is the
 *   only signal it gets.
 * - `errors` — a message per control, which is how a validation failure is
 *   actually rendered: beside the field that is wrong.
 * - `error` — one sentence for a failure belonging to no single field, such as
 *   the family having been deleted in another tab, or a link that would make
 *   somebody their own ancestor.
 *
 * A successful submission and a refused one are the same type rather than a
 * discriminated union, matching `ChildFormState`: a form renders both at once,
 * and the id from the last save can sit on screen while the next attempt shows
 * an error.
 */
export type ParentsFormState = {
  /** The family recorded by the last successful submission, or null. */
  savedUnionId: string | null;
  /** A sentence to show, or null when there is nothing to say. */
  error: string | null;
  /** Per-field messages. Empty when all is well. */
  errors: ParentsFieldErrors;
};

/**
 * The state the set-parents form starts in, for `useActionState`'s initial
 * value.
 *
 * Frozen, because `useActionState` holds onto this object for the life of the
 * component and a shared mutable default would leak one form's state into the
 * next one that mounted.
 */
export const emptyParentsFormState: ParentsFormState = Object.freeze({
  savedUnionId: null,
  error: null,
  errors: {},
});

/** The state for a submission that was written. */
export function parentsSavedState(unionId: string): ParentsFormState {
  return { savedUnionId: unionId, error: null, errors: {} };
}

/**
 * The state for a submission that was refused over its fields.
 *
 * `savedUnionId` goes back to null on a refusal: it names what the *last
 * submission* wrote, and this one wrote nothing. Leaving a stale id there
 * would let a form that closes on `savedUnionId` close over the errors it was
 * supposed to be showing.
 */
export function parentsInvalidState(
  issues: readonly ParentsValidationIssue[],
): ParentsFormState {
  return {
    savedUnionId: null,
    error: null,
    errors: parentsFieldErrorsFrom(issues),
  };
}

/** The state for a failure that belongs to no single field. */
export function parentsFailedState(message: string): ParentsFormState {
  return { savedUnionId: null, error: message, errors: {} };
}

/**
 * The shape of the action the set-parents form submits to.
 *
 * Declared here rather than inferred from `setParentsAction`, so that
 * `components/SetParentsForm.tsx` can take the action as a prop instead of
 * importing it. That is not indirection for its own sake: `app/tree/actions.ts`
 * reaches `@/lib/session` and therefore Auth.js, so a component that imports it
 * cannot be mounted by `npm test` — which runs with no `AUTH_*` and no
 * `DATABASE_URL` at all (docs/testing.md). The canvas renders this form, so
 * importing the action inside it would take `components/FamilyTree.test.tsx`
 * down with it, exactly as E3-T4 found.
 *
 * Passing a server action from a Server Component into a Client Component is
 * the framework's own pattern for this
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`), so the
 * only file that names the action is `app/tree/page.tsx`.
 */
export type SetParentsFormAction = (
  previous: ParentsFormState,
  form: FormData,
) => Promise<ParentsFormState>;
