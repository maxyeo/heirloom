"use client";

import { useEffect, useRef } from "react";

/**
 * Which of the tree's two side panels gives way to the other.
 *
 * ## The problem
 *
 * `/tree` can put two panels in the same right-hand column: the add-person
 * panel (`components/AddPersonPanel.tsx`, opened from the page header) and a
 * person's record (`components/PersonPanel.tsx`, opened by selecting a node).
 * They are the same shape in the same place, and one is simply drawn over the
 * other — `z-20` against `z-10` — so an author who opens one while the other
 * is open is looking at a panel with another panel's edge behind it and no way
 * to tell which of the two the next Escape is for.
 *
 * Neither of them can see the other. `AddPersonPanel` renders in the tree
 * page's *header* and the record renders inside `FamilyTree`, so they are two
 * subtrees of a Server Component with no common Client Component above them —
 * the same reach problem `components/surface-stack.ts` describes at length and
 * answers the same way. Module-level state, because what it describes (which
 * panel is on the page) is a property of the page rather than of any subtree.
 *
 * ## The rule
 *
 * Opening one panel closes the other, with one exception in one direction:
 *
 * - **A node was selected** — a click, Enter on a focused node, a relative's
 *   link inside a record. The add-person panel closes *if nothing has been
 *   typed into it*. Closing that panel is a discard, by the deliberate design
 *   `AddPersonPanel` documents (the form unmounts and its values go with it),
 *   and a discard is not something a click on a node elsewhere has any right
 *   to perform. So a half-entered person survives, and the author gets the
 *   two-panel stack they have implicitly asked for.
 * - **The add-person panel was opened** — the record closes, unconditionally.
 *   There is nothing to lose: the record is a reading of a row, not a draft,
 *   and it reopens with one click on the node that is still on the canvas.
 *
 * ## Why this is not the surface stack
 *
 * `components/surface-stack.ts` answers "which surface is Escape for", which
 * is a question about the *topmost* surface and deliberately leaves everything
 * underneath open — that is the whole of `YEO-83`, and closing a panel out
 * from under another one from inside that listener would undo it. This module
 * answers a different question, asked by a press rather than by a keystroke:
 * which panel does *this* one replace. The two coexist; a panel that both
 * registers here and calls `useDismissableSurface` is saying both things.
 */

/**
 * A panel, as this module holds it: how to close it, and — for the panel that
 * holds a draft — how to ask whether closing it would throw anything away.
 */
interface TreePanel {
  close: () => void;
  /**
   * Whether the panel holds nothing the author typed, and so can be closed
   * without asking. Absent for a panel that is never a draft.
   */
  isBlank?: () => boolean;
}

let addPersonPanel: TreePanel | null = null;
let personRecordPanel: TreePanel | null = null;

/**
 * Register a panel for as long as it is mounted.
 *
 * The callbacks are read out of a ref rather than captured, for the reason
 * `useDismissableSurface` gives: a caller passing a fresh inline `close` on
 * every render is ordinary React, and the effect below must not re-run on it.
 * Unlike the surface stack, re-running would be harmless here — there is no
 * order to disturb — but reading the *latest* `isBlank` is not optional, since
 * a form that was blank when it mounted is exactly the one this has to notice
 * has since been typed into.
 */
function useTreePanel(
  slot: "add-person" | "person-record",
  panel: TreePanel,
): void {
  const panelRef = useRef(panel);

  useEffect(() => {
    panelRef.current = panel;
  });

  useEffect(() => {
    const entry: TreePanel = {
      close: () => panelRef.current.close(),
      isBlank: () => panelRef.current.isBlank?.() ?? true,
    };

    if (slot === "add-person") addPersonPanel = entry;
    else personRecordPanel = entry;

    return () => {
      /**
       * By identity rather than by setting the slot to null outright. A panel
       * that closes *because the other one opened* unmounts a commit after
       * that other panel registered, and on the add-person slot the two can be
       * the same slot: closing a blank form and opening a new one in the same
       * interaction would otherwise have the departing form's cleanup wipe the
       * arriving form's registration.
       */
      if (slot === "add-person") {
        if (addPersonPanel === entry) addPersonPanel = null;
      } else if (personRecordPanel === entry) {
        personRecordPanel = null;
      }
    };
  }, [slot]);
}

/** Declare the add-person panel open, and say whether it holds a draft. */
export function useAddPersonPanel(panel: Required<TreePanel>): void {
  useTreePanel("add-person", panel);
}

/** Declare a person's record panel open. */
export function usePersonRecordPanel(close: () => void): void {
  useTreePanel("person-record", { close });
}

/**
 * A person was selected on the canvas: take the add-person panel off the
 * column, unless somebody has started filling it in.
 *
 * Safe to call for a selection that changed for any other reason — a deep link
 * arriving, the graph re-seeding after a save — because with no add-person
 * panel open there is nothing to close.
 */
export function personSelectedOnCanvas(): void {
  if (addPersonPanel === null) return;
  if (addPersonPanel.isBlank?.() === false) return;
  addPersonPanel.close();
}

/** The add-person panel is opening: take the record off the column. */
export function addPersonPanelOpening(): void {
  personRecordPanel?.close();
}
