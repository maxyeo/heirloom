/**
 * What the union sequence editor renders while it waits, and after a move
 * (E3-T7, `YEO-35`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * The same reason `lib/removal-state.ts` and `lib/spouse-form-state.ts` are
 * not: a `"use server"` module may only export async functions, so the state
 * type, its shared idle value and its constructors cannot live beside the
 * action that returns them.
 *
 * ## Why it is shaped like `RemovalState` rather than `SpouseFormState`
 *
 * Because a reorder carries no author input. Every field it sends is a
 * reference — which person, which unions, which button — so there is no field
 * to hang a message under and nothing to preserve across a refusal. Three
 * states is the whole vocabulary, and the control shows one of them.
 *
 * There is no `saved` id to hand back either. The order is not a row: what a
 * successful move produces is a different `/tree`, which the action
 * revalidates, and the panel re-renders from the new graph. So `moved` says
 * only that something happened.
 */

/**
 * The outcome of one move, shaped for `useActionState`.
 *
 * A discriminated union rather than the nullable-members shape the person form
 * uses, for the reason `RemovalState` gives: these are genuinely exclusive.
 * The order either changed or it did not, and a control is never showing a
 * failure and a success at once.
 *
 * `moved` is still a state rather than a `redirect`, and in practice almost
 * nothing renders it: the action revalidates `/tree`, so the panel re-renders
 * with the unions in their new places before anyone reads a message about it.
 * What it earns is the negative — a control that has come back `moved` is one
 * whose buttons can be trusted again.
 */
export type UnionOrderState =
  | { status: "idle" }
  | { status: "moved" }
  | { status: "failed"; error: string };

/**
 * The state the editor starts in, for `useActionState`'s initial value.
 *
 * Frozen, and shared, for the reason `idleRemovalState` is: React holds onto
 * this object for the life of the component, and a mutable default would leak
 * one panel's state into the next one that opened.
 */
export const idleUnionOrderState: UnionOrderState = Object.freeze({
  status: "idle",
});

/** The state for a move that was written. */
export const movedUnionOrderState: UnionOrderState = Object.freeze({
  status: "moved",
});

/** The state for a move that found nothing to move, or was refused. */
export function failedUnionOrderState(message: string): UnionOrderState {
  return { status: "failed", error: message };
}

/**
 * The shape of the action the editor submits to.
 *
 * Declared here rather than inferred from `reorderUnionsAction`, so that
 * `components/UnionOrder.tsx` can take the action as a prop instead of
 * importing it. `app/tree/actions.ts` reaches `@/lib/session` and therefore
 * Auth.js, so a Client Component that imports it cannot be mounted by
 * `npm test` — which runs with no `AUTH_*` and no `DATABASE_URL` at all
 * (docs/testing.md), and the canvas renders this control. Handing a server
 * action down from a Server Component is the framework's own pattern for it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`), and the
 * one `AddSpouseFormAction` already set here.
 */
export type ReorderUnionsFormAction = (
  previous: UnionOrderState,
  form: FormData,
) => Promise<UnionOrderState>;
