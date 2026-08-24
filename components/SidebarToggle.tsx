"use client";

import { setSidebarState, useSidebarState } from "@/components/sidebar-state";

/**
 * The header's hamburger — the one control for the left sidebar, on every
 * screen width. Wide, it pins and unpins the column; narrow, it opens and
 * closes the drawer over the article. Vector 2022 uses one button for both and
 * so does this: the viewer is not being asked to hold two models.
 *
 * It reads its own state rather than being handed it, because the state is an
 * attribute on `<html>` that an inline script sets before React exists. See
 * `components/sidebar-state.ts`.
 */
export function SidebarToggle({ controls }: { controls: string }) {
  const open = useSidebarState() === "open";

  return (
    <button
      type="button"
      // `aria-controls` points at the `<nav>` the drawer is, so the
      // relationship is announced rather than inferred from adjacency.
      aria-controls={controls}
      aria-expanded={open}
      // The bars carry no text, so the button's whole name is this. It says
      // what pressing it does, not what it currently is — `aria-expanded`
      // already carries the state, and repeating it in the name is how a
      // screen reader ends up saying "collapsed, collapsed".
      aria-label="Navigation menu"
      onClick={() => setSidebarState(open ? "closed" : "open")}
      // 2.25rem square: comfortably past the 24px minimum target size and
      // still inside the 3rem header.
      className="flex size-9 shrink-0 flex-col items-center justify-center gap-1 rounded-panel hover:bg-panel"
    >
      {/* Three bars, drawn rather than iconographed — the shell has no icon
          set and one hamburger does not justify one. */}
      <span aria-hidden="true" className="block h-0.5 w-4 bg-ink-muted" />
      <span aria-hidden="true" className="block h-0.5 w-4 bg-ink-muted" />
      <span aria-hidden="true" className="block h-0.5 w-4 bg-ink-muted" />
    </button>
  );
}
