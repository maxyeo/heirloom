import {
  fieldErrorsFrom,
  type IndividualFieldErrors,
  type ValidationIssue,
} from "@/lib/individual-input";
import {
  type UnionFieldErrors,
  unionFieldErrorsFrom,
  type UnionValidationIssue,
} from "@/lib/union-input";

/**
 * What the add-spouse form renders while it waits, and after a submission
 * (E3-T4, `YEO-32`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * A `"use server"` module may only export async functions — every other export
 * would be a value React has no way to send to the client. So the state type,
 * its empty value, and the constructors below cannot live beside the action
 * that returns them, even though that is where they read most naturally. This
 * is the same split `lib/individual-form-state.ts` made for E3-T1's person
 * actions, and it is followed here rather than reinvented.
 *
 * ## Why the two error maps are separate
 *
 * One submission of this form validates two records: the union, and — in
 * `new` mode — the partner being created with it. Both have a `notes` field,
 * and `individuals` and `unions` also both have dates and their qualifiers.
 * A single map keyed by field name could not say which record a message
 * belonged to, and the form would hang "The notes are too long" under
 * whichever input it happened to reach first.
 */

/**
 * The outcome of one submission, shaped for `useActionState`.
 *
 * - `savedUnionId` — the union written by the last successful submission.
 *   Present rather than the action issuing a `redirect`, because *where to go
 *   next* is the form's decision: the tree stays where it is and the panel
 *   closes back to the person who now has a spouse. It is also what the form
 *   watches to know it succeeded, since a server action's return value is the
 *   only signal it gets.
 * - `unionErrors` / `partnerErrors` — a message per input, which is how a
 *   validation failure is actually rendered: beside the field that is wrong.
 * - `error` — one sentence for a failure belonging to no single field, such as
 *   the person having been deleted in another tab.
 *
 * A successful submission and a refused one are the same type rather than a
 * discriminated union, matching `IndividualFormState`: a form renders both at
 * once, and the id from the last save can sit on screen while the next
 * attempt shows an error.
 */
export type SpouseFormState = {
  /** The union written by the last successful submission, or null. */
  savedUnionId: string | null;
  /** A sentence to show, or null when there is nothing to say. */
  error: string | null;
  /** Per-field messages for the union. Empty when all is well. */
  unionErrors: UnionFieldErrors;
  /** Per-field messages for a partner being created inline. */
  partnerErrors: IndividualFieldErrors;
};

/**
 * The state the add-spouse form starts in, for `useActionState`'s initial
 * value.
 *
 * Frozen, because `useActionState` holds onto this object for the life of the
 * component and a shared mutable default would leak one form's state into the
 * next one that mounted.
 */
export const emptySpouseFormState: SpouseFormState = Object.freeze({
  savedUnionId: null,
  error: null,
  unionErrors: {},
  partnerErrors: {},
});

/** The state for a submission that was written. */
export function spouseSavedState(unionId: string): SpouseFormState {
  return {
    savedUnionId: unionId,
    error: null,
    unionErrors: {},
    partnerErrors: {},
  };
}

/**
 * The state for a submission that was refused over its fields.
 *
 * `savedUnionId` goes back to null on a refusal: it names what the *last
 * submission* wrote, and this one wrote nothing. Leaving a stale id there
 * would let a form that closes on `savedUnionId` close over the errors it was
 * supposed to be showing.
 */
export function spouseInvalidState(
  unionIssues: readonly UnionValidationIssue[],
  partnerIssues: readonly ValidationIssue[],
): SpouseFormState {
  return {
    savedUnionId: null,
    error: null,
    unionErrors: unionFieldErrorsFrom(unionIssues),
    partnerErrors: fieldErrorsFrom(partnerIssues),
  };
}

/** The state for a failure that belongs to no single field. */
export function spouseFailedState(message: string): SpouseFormState {
  return {
    savedUnionId: null,
    error: message,
    unionErrors: {},
    partnerErrors: {},
  };
}

/**
 * The shape of the action the add-spouse form submits to.
 *
 * Declared here rather than inferred from `addSpouseAction`, so that
 * `components/AddSpouseForm.tsx` can take the action as a prop instead of
 * importing it. That is not indirection for its own sake: `app/tree/actions.ts`
 * reaches `@/lib/session` and therefore Auth.js, so a component that imports it
 * cannot be mounted by `npm test` — which runs with no `AUTH_*` and no
 * `DATABASE_URL` at all (docs/testing.md). That is not hypothetical: the canvas
 * renders this form, so importing the action inside it took the whole of
 * `components/FamilyTree.test.tsx` down with it.
 *
 * Passing a server action from a Server Component into a Client Component is
 * the framework's own pattern for this
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`), so the
 * only file that names the action is `app/tree/page.tsx` — which is a Server
 * Component and was going to reach the database regardless.
 */
export type AddSpouseFormAction = (
  previous: SpouseFormState,
  form: FormData,
) => Promise<SpouseFormState>;
