/**
 * What the panel's entry control renders while it waits, and after a refusal
 * (E2-T2, `YEO-25`).
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * The same reason `lib/union-order-state.ts` and `lib/removal-state.ts` are
 * not: a `"use server"` module may only export async functions, so the state
 * type, its shared idle value and its constructors cannot live beside the
 * actions that return them.
 *
 * ## Why it is shaped like `UnionOrderState`
 *
 * Because linking carries no author input either. Every field these three
 * actions send is a reference — which person, which entry — so there is no
 * field to hang a message under and nothing to preserve across a refusal.
 * Three states is the whole vocabulary, and the control shows one of them.
 *
 * There is no id to hand back, for the same reason the reorder has none: what
 * a successful link produces is a different `/tree`, which the action
 * revalidates, and the panel re-renders with the link on it. So `changed` says
 * only that something happened.
 *
 * Creating an entry has no success state at all, because it ends in a
 * `redirect` into the editor — which throws. The only state that action ever
 * returns to the panel is one in which the author is still looking at it.
 */

/**
 * The outcome of one link, unlink, or creation, shaped for `useActionState`.
 *
 * A discriminated union rather than nullable members, for the reason
 * `RemovalState` gives: these are genuinely exclusive. The link either changed
 * or it did not, and a control is never showing a failure and a success at
 * once.
 */
export type EntryLinkState =
  | { status: "idle" }
  | { status: "changed" }
  | { status: "failed"; error: string };

/**
 * The state the control starts in, for `useActionState`'s initial value.
 *
 * Frozen, and shared, for the reason `idleUnionOrderState` is: React holds
 * onto this object for the life of the component, and a mutable default would
 * leak one panel's state into the next one that opened.
 */
export const idleEntryLinkState: EntryLinkState = Object.freeze({
  status: "idle",
});

/** The state for a link that was written, or cleared. */
export const changedEntryLinkState: EntryLinkState = Object.freeze({
  status: "changed",
});

/** The state for a link that was refused, or found nothing to change. */
export function failedEntryLinkState(message: string): EntryLinkState {
  return { status: "failed", error: message };
}

/**
 * The shape of the actions the control submits to.
 *
 * Declared here rather than inferred from `app/tree/actions.ts`, so that
 * `components/PersonEntry.tsx` can take them as props instead of importing
 * them. That module reaches `@/lib/session` and therefore Auth.js, so a Client
 * Component that imports it cannot be mounted by `npm test` — which runs with
 * no `AUTH_*` and no `DATABASE_URL` at all (docs/testing.md), and the canvas
 * renders this control. Handing a server action down from a Server Component
 * is the framework's own pattern for it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`), and the
 * one `AddSpouseFormAction` already set here.
 */
export type PersonEntryFormAction = (
  previous: EntryLinkState,
  form: FormData,
) => Promise<EntryLinkState>;

/**
 * The three doors onto `individuals.page_id`, handed down together.
 *
 * One prop rather than three, because they are one feature and always arrive
 * from the same place: a canvas that can start an entry can also link and
 * unlink one, and a canvas given none of them shows the entry it has as a
 * plain link and offers nothing further. Separate endpoints underneath, so
 * that a form cannot post its way from one meaning to another by leaving a
 * field out — the same reason `removePersonAction` and `detachPartnerAction`
 * are two actions rather than one with a mode.
 */
export type PersonEntryActions = {
  /** Start an entry pre-titled with the person's name (E1-T8 underneath). */
  create: PersonEntryFormAction;
  /** Point the person at an entry that already exists. */
  link: PersonEntryFormAction;
  /** Clear the link. The entry keeps its address and its history. */
  unlink: PersonEntryFormAction;
};
