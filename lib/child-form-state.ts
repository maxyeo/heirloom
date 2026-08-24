import {
  type ChildFieldErrors,
  childFieldErrorsFrom,
  type ChildValidationIssue,
} from "@/lib/child-input";
import {
  fieldErrorsFrom,
  type IndividualFieldErrors,
  type ValidationIssue,
} from "@/lib/individual-input";

/**
 * What the add-child form renders while it waits, and after a submission
 * (E3-T5, `YEO-33`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * A `"use server"` module may only export async functions — every other export
 * would be a value React has no way to send to the client. So the state type,
 * its empty value, and the constructors below cannot live beside the action
 * that returns them. This is the same split `lib/individual-form-state.ts` and
 * `lib/spouse-form-state.ts` already made, and it is followed here rather than
 * reinvented.
 *
 * ## Why the two error maps are separate
 *
 * One submission of this form validates two records: the child↔union link,
 * and — in `new` mode — the child being created with it. Both a link and a
 * person can fault, and `notes` belongs only to the person, but a single map
 * keyed by field name would still let `childId` mean either "the person you
 * picked" or a column on a person. Keeping them apart is what lets the form
 * hang each message under the control it belongs to.
 */

/**
 * The outcome of one submission, shaped for `useActionState`.
 *
 * - `savedChildId` — the child written by the last successful submission.
 *   Present rather than the action issuing a `redirect`, because *where to go
 *   next* is the form's decision: the tree stays where it is and the panel
 *   closes back to the parent who now has a child. It is also what the form
 *   watches to know it succeeded, since a server action's return value is the
 *   only signal it gets.
 * - `linkErrors` / `childErrors` — a message per control, which is how a
 *   validation failure is actually rendered: beside the field that is wrong.
 * - `error` — one sentence for a failure belonging to no single field, such as
 *   the union having been deleted in another tab.
 *
 * A successful submission and a refused one are the same type rather than a
 * discriminated union, matching `SpouseFormState`: a form renders both at
 * once, and the id from the last save can sit on screen while the next attempt
 * shows an error.
 */
export type ChildFormState = {
  /** The child written by the last successful submission, or null. */
  savedChildId: string | null;
  /** A sentence to show, or null when there is nothing to say. */
  error: string | null;
  /** Per-field messages for the child↔union link. Empty when all is well. */
  linkErrors: ChildFieldErrors;
  /** Per-field messages for a child being created inline. */
  childErrors: IndividualFieldErrors;
};

/**
 * The state the add-child form starts in, for `useActionState`'s initial
 * value.
 *
 * Frozen, because `useActionState` holds onto this object for the life of the
 * component and a shared mutable default would leak one form's state into the
 * next one that mounted.
 */
export const emptyChildFormState: ChildFormState = Object.freeze({
  savedChildId: null,
  error: null,
  linkErrors: {},
  childErrors: {},
});

/** The state for a submission that was written. */
export function childSavedState(childId: string): ChildFormState {
  return {
    savedChildId: childId,
    error: null,
    linkErrors: {},
    childErrors: {},
  };
}

/**
 * The state for a submission that was refused over its fields.
 *
 * `savedChildId` goes back to null on a refusal: it names what the *last
 * submission* wrote, and this one wrote nothing. Leaving a stale id there
 * would let a form that closes on `savedChildId` close over the errors it was
 * supposed to be showing.
 */
export function childInvalidState(
  linkIssues: readonly ChildValidationIssue[],
  childIssues: readonly ValidationIssue[],
): ChildFormState {
  return {
    savedChildId: null,
    error: null,
    linkErrors: childFieldErrorsFrom(linkIssues),
    childErrors: fieldErrorsFrom(childIssues),
  };
}

/** The state for a failure that belongs to no single field. */
export function childFailedState(message: string): ChildFormState {
  return {
    savedChildId: null,
    error: message,
    linkErrors: {},
    childErrors: {},
  };
}

/**
 * The shape of the action the add-child form submits to.
 *
 * Declared here rather than inferred from `addChildAction`, so that
 * `components/AddChildForm.tsx` can take the action as a prop instead of
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
export type AddChildFormAction = (
  previous: ChildFormState,
  form: FormData,
) => Promise<ChildFormState>;
