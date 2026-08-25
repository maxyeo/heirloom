/**
 * What the merge confirmation renders while it waits, and after the button is
 * pressed (E3-T10, `YEO-82`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * The same reason `lib/removal-state.ts` is not: a `"use server"` module may
 * only export async functions, so the state type and its constructors cannot
 * live beside the action that returns them.
 *
 * ## Why it is not `RemovalState`
 *
 * The shape is nearly identical and the wording is not, which is the whole
 * argument. "Removed." under a dialogue that merged two families says the
 * wrong thing about an operation whose entire point is that nothing was lost,
 * and a shared type would have exactly one of the two dialogues telling the
 * truth. There are three states either way; three lines are cheaper than a
 * sentence that misreports what just happened.
 */

/**
 * The outcome of one merge, shaped for `useActionState`.
 *
 * `merged` is deliberately still a state rather than a `redirect`. The action
 * revalidates `/tree`, which re-renders the page and takes the panel and this
 * dialogue down with it, so in practice nothing renders it — but "it worked"
 * having somewhere to *be* keeps a dialogue that is somehow still mounted from
 * looking untouched.
 */
export type UnionMergeState =
  | { status: "idle" }
  | { status: "merged"; unionId: string }
  | { status: "failed"; error: string };

/**
 * The state a confirmation starts in, for `useActionState`'s initial value.
 *
 * Frozen, and shared, for the reason `idleRemovalState` is: React holds onto
 * this object for the life of the component, and a mutable default would leak
 * one dialogue's state into the next one that opened.
 */
export const idleUnionMergeState: UnionMergeState = Object.freeze({
  status: "idle",
});

/** The state for a merge that happened, naming the family that survived. */
export function mergedUnionState(unionId: string): UnionMergeState {
  return { status: "merged", unionId };
}

/** The state for a merge that found nothing to merge. */
export function failedUnionMergeState(message: string): UnionMergeState {
  return { status: "failed", error: message };
}
