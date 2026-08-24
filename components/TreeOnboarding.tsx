"use client";

import {
  AddPersonPanel,
  type IndividualFormAction,
} from "@/components/AddPersonPanel";

/**
 * What the canvas says before there is a family on it (E3-T9, `YEO-37`).
 *
 * ## Why this is a feature and not decoration
 *
 * `docs/architecture.md` makes "deployable by somebody else" an explicit
 * property of this repository — nothing personal is in the code, only in the
 * configuration. The first screen of a fresh deployment is therefore a screen
 * a stranger sees, and what it currently shows is a blank viewport with a
 * minimap of nothing in it. That undoes the property: a canvas with no
 * affordance on it does not say "add somebody", it says "this is broken".
 *
 * ## Two states, two shapes
 *
 * An empty database has nothing to draw, so `TreeEmptyState` replaces the
 * canvas outright — a pan-and-zoom surface over nothing is furniture around
 * an absence. Once there is at least one person there *is* something to draw
 * and the canvas stays; `TreeStartHint` sits over it in the corner and gets
 * out of the way the moment a union exists.
 *
 * Which of the two applies is `lib/tree-onboarding.ts`'s decision, not this
 * file's. Everything here is words and boxes.
 *
 * ## What the copy is careful about
 *
 * It teaches the data model in one sentence — *children belong to a marriage
 * rather than to a person* — because that is the single thing about this
 * application that cannot be guessed from the interface, and the third
 * acceptance criterion is that the path from an empty database to a family of
 * three is walkable **without documentation**. Somebody who does not know it
 * will hunt for "add a child" on a person and not find it.
 *
 * It also names only affordances that exist. The add-child flow is a separate
 * ticket, so the steps below stop at the marriage and explain why the marriage
 * comes first, rather than pointing at a button that is not there yet.
 */

export interface TreeEmptyStateProps {
  /**
   * Where the invitation's own "Add the first person" submits, handed down
   * from `app/tree/page.tsx`.
   *
   * Optional for the reason every other action prop on this canvas is: a
   * Client Component that *imports* a `"use server"` module drags `@/db` and
   * Auth.js in behind it and cannot be mounted under `npm test`'s deliberately
   * empty environment (docs/testing.md). Without it the invitation still says
   * what to do — the header's own "Add person" button is unaffected — it
   * simply has no button of its own.
   */
  action?: IndividualFormAction;
}

/** Stage `no-people`: the whole canvas, replaced by an invitation. */
export function TreeEmptyState({ action }: TreeEmptyStateProps) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-content rounded-panel border border-rule bg-paper px-6 py-5">
        <h2 className="mt-0 border-0 pb-0 text-h2">
          Nobody is on the tree yet
        </h2>
        <p className="mt-2 text-ink-muted">
          A tree grows outwards from one person. Start with somebody you can
          name with confidence — yourself, or the oldest relative you know of —
          and everybody else hangs off them.
        </p>

        <p className="mt-4 font-medium">Getting to a first family of three</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-ink-muted">
          <li>
            Add the first person. Only a first name is required; everything else
            can be filled in later, or left unknown.
          </li>
          <li>Select their card on the canvas to open their record.</li>
          <li>
            Use “Add a spouse” in that record to say who they married. Children
            belong to a marriage rather than to a person, which is why the
            marriage comes first.
          </li>
        </ol>

        {action ? (
          <div className="mt-5">
            {/*
              The same panel the page header opens, under a label that suits
              a first run. Reusing it rather than growing a second form is
              what keeps "add a person" one flow with one set of validation
              messages, however the author reached it.
            */}
            <AddPersonPanel action={action} label="Add the first person" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface TreeStartHintProps {
  /**
   * The one person on the tree, when there is exactly one to name, and null
   * when there are several. See `treeOnboarding`.
   */
  person: string | null;
}

/**
 * Stage `unconnected`: people on the canvas, nothing joining them.
 *
 * A one-person tree is not empty, so it gets no invitation of its own — but a
 * single card alone in a viewport is the state this ticket calls "looks
 * broken", and what makes it look broken is that nothing on screen suggests a
 * next move. This is that next move, in the one corner React Flow's own
 * chrome leaves free: the controls sit bottom-left and the minimap
 * bottom-right.
 *
 * Not dismissible, because it dismisses itself — recording one union is
 * exactly the thing it asks for, and `treeOnboarding` stops returning this
 * stage the moment there is one.
 */
export function TreeStartHint({ person }: TreeStartHintProps) {
  const lead =
    person === null ? "Nobody is connected yet." : `Just ${person} so far.`;

  // Assembled rather than interleaved with JSX text: the two halves differ
  // only in their opening clause, and JSX's whitespace trimming around an
  // expression is not something a sentence should depend on.
  const next =
    person === null
      ? "Select a card to open that person’s record"
      : `Select ${person}’s card to open their record`;

  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 max-w-xs rounded-panel border border-rule bg-panel px-3 py-2 shadow-sm">
      <p className="font-medium">{lead}</p>
      <p className="mt-1 text-caption text-ink-muted">
        {`${next}, then use “Add a spouse”. Children belong to a marriage rather than to a person, so the marriage comes first.`}
      </p>
    </div>
  );
}
