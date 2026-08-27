/**
 * Which surface is on top, and where Tab goes inside it (`YEO-83`).
 *
 * The tree canvas ends up with several dismissable surfaces open at once — the
 * detail panel, the add-person panel over it, an edit or removal dialogue over
 * that — and before this ticket each of them decided on its own what Escape
 * meant. Every one of them registered its own `document` listener, so a single
 * keystroke was answered by all of them at once; the fix that was in the tree
 * (a capture-phase `stopPropagation` in `components/ModalDialog.tsx`) worked
 * only for the one pair of surfaces somebody had noticed, and only for as long
 * as no third surface was added. `components/surface-stack.ts` replaces that
 * with a single registry and a single listener. This module is the half of it
 * that is arithmetic rather than wiring, so that the awkward cases can be
 * asserted in plain Node — docs/testing.md, "prefer no DOM".
 *
 * Two things live here, and neither knows what a DOM node or a callback is:
 *
 * - **The stack model.** Surfaces are held newest-last, so "topmost" is
 *   "registered most recently" and nothing has to be told about z-index. The
 *   entry type is structural — an `id` and whatever else the caller carries —
 *   which is what keeps this file free of anything that only exists in a
 *   browser.
 * - **The focus-trap arithmetic.** `nextTrapIndex` answers "given the surface's
 *   focusable elements and where focus currently is, where does this Tab go",
 *   and returns `null` for "the browser already gets this right".
 *
 * ## The case that made the trap worth extracting
 *
 * `ModalDialog` renders `aria-modal="true"`, which tells assistive tech that
 * everything outside the dialogue is inert. Its hand-written trap wrapped at
 * the two ends and pulled focus in from its own heading, and that is all — so
 * focus sitting on *anything else outside the surface*, which is the ordinary
 * state of affairs when the dialogue is opened by a click on a button behind
 * the backdrop, tabbed straight out into the panel underneath and kept going.
 * The attribute was a promise the component did not keep. `activeIndex === -1`
 * below is that case, and it is one branch of a function with a test rather
 * than four conditions spread through a keydown handler.
 */

/**
 * A registered surface, as far as this module is concerned: an identity, and
 * nothing else.
 *
 * Deliberately structural rather than an interface the registry has to
 * implement. `components/surface-stack.ts` stores a ref full of callbacks
 * alongside the id, and the helpers below carry that through untouched —
 * which is what lets the stack be reasoned about here and populated there.
 */
export interface StackedSurface {
  id: number;
}

/** The surface Escape is for, or `null` when nothing is open. */
export function topmost<T extends StackedSurface>(
  stack: readonly T[],
): T | null {
  return stack.length === 0 ? null : stack[stack.length - 1];
}

/**
 * Whether `id` is the surface on top.
 *
 * Asked at unmount rather than at keypress: a surface that was underneath
 * something else when it went away has no business saying where focus lands,
 * because the surface above it is still holding it.
 */
export function isTopmost(
  stack: readonly StackedSurface[],
  id: number,
): boolean {
  return topmost(stack)?.id === id;
}

/**
 * The stack with `surface` added, as a new array.
 *
 * `underneath` is for a surface that is *drawn* below one already open, and it
 * exists because the tree grew a pair where mount order and z-index disagree.
 * A person's record (`z-10`) can now open while the add-person panel (`z-20`)
 * is still up, holding a half-entered person nobody wants discarded — see
 * `components/tree-panels.ts`. Pushed on top in the ordinary way, the record
 * would answer an Escape aimed at the panel completely covering it, and
 * nothing on screen would change: the exact symptom `YEO-83` was written to
 * remove, arriving from the other direction.
 *
 * "Underneath everything" rather than "underneath that one panel" because it
 * is true of this surface in general. The record is the lowest thing this
 * canvas draws — every dialogue it opens, it opens over itself — so a record
 * that arrives while anything at all is up belongs at the bottom, and with an
 * empty stack the two positions are the same place.
 */
export function withSurface<T extends StackedSurface>(
  stack: readonly T[],
  surface: T,
  underneath = false,
): T[] {
  return underneath ? [surface, ...stack] : [...stack, surface];
}

/**
 * The stack with `id` gone, as a new array.
 *
 * By id rather than by position, because a surface does not necessarily leave
 * from the top: the detail panel can be taken out from under an open dialogue
 * by a delete in another tab. Filtering leaves the order of everything else
 * exactly as it was, which is the whole mechanism.
 */
export function withoutSurface<T extends StackedSurface>(
  stack: readonly T[],
  id: number,
): T[] {
  return stack.filter((surface) => surface.id !== id);
}

/**
 * Where Tab should put focus inside a modal surface, or `null` to let the
 * browser do what it was going to do.
 *
 * `length` is how many focusable elements the surface has, `activeIndex` is
 * where focus is among them — **`-1` for anywhere outside**, which includes the
 * surface's own heading, since that carries `tabIndex={-1}` and is not one of
 * them — and `shiftKey` is which way Tab is going.
 *
 * Returning `null` for the ordinary case is the point. A trap that moved focus
 * on every Tab would be re-implementing the browser's tab order out of a
 * `querySelectorAll`, which sorts by document position and knows nothing about
 * positive `tabindex` values or about what is visible. Inside the surface the
 * browser is already right; the only thing it gets wrong is the boundary.
 */
export function nextTrapIndex(
  length: number,
  activeIndex: number,
  shiftKey: boolean,
): number | null {
  // Nothing to trap into. A dialogue mid-submission can disable every button
  // it has, and swallowing Tab there would leave the keyboard with nowhere at
  // all to go.
  if (length === 0) return null;

  // Focus is outside the surface: on the element that opened it, on the
  // heading focus was parked on, or on whatever the reader clicked behind the
  // backdrop. This is the branch `aria-modal="true"` was lying about.
  if (activeIndex === -1) return shiftKey ? length - 1 : 0;

  if (shiftKey) return activeIndex === 0 ? length - 1 : null;
  return activeIndex === length - 1 ? 0 : null;
}
