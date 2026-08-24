/**
 * What a confirmation dialogue renders while it waits, and after the button is
 * pressed (E3-T8, `YEO-36`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * The same reason `lib/individual-form-state.ts` is not: a `"use server"`
 * module may only export async functions, so the state type and its
 * constructors cannot live beside the actions that return them.
 *
 * ## Why it is smaller than `IndividualFormState`
 *
 * A person form has three things to say, because it carries the author's
 * input and can refuse it field by field. A removal carries no input at all —
 * only a reference to a row, which is either there or is not (see
 * `lib/remove-from-tree.ts`). So there are no field errors to render and no
 * saved id to hand on to a caller: there are three states, and the dialogue
 * shows one of them.
 */

/**
 * The outcome of one removal, shaped for `useActionState`.
 *
 * A discriminated union rather than the nullable-members shape the person
 * form uses, because unlike a form these three are genuinely exclusive — a
 * dialogue is never showing a failure and a success at once, since the thing
 * either went or it did not.
 *
 * `removed` is deliberately still a state rather than a `redirect`. The
 * action revalidates `/tree`, which re-renders the page and takes the panel
 * and this dialogue down with it, so in practice nothing renders `removed` at
 * all — but "the operation succeeded" having somewhere to *be* is what keeps
 * a dialogue that is somehow still mounted from looking untouched.
 */
export type RemovalState =
  | { status: "idle" }
  | { status: "removed" }
  | { status: "failed"; error: string };

/**
 * The state a confirmation starts in, for `useActionState`'s initial value.
 *
 * Frozen, and shared, for the reason `emptyIndividualFormState` is: React
 * holds onto this object for the life of the component, and a mutable default
 * would leak one dialogue's state into the next one that opened.
 */
export const idleRemovalState: RemovalState = Object.freeze({ status: "idle" });

/** The state for a removal that happened. */
export const removedState: RemovalState = Object.freeze({ status: "removed" });

/** The state for a removal that found nothing to remove. */
export function failedRemovalState(message: string): RemovalState {
  return { status: "failed", error: message };
}
