"use client";

import { useEffect, useRef, type RefObject } from "react";

import {
  isTopmost,
  nextTrapIndex,
  topmost,
  withSurface,
  withoutSurface,
} from "@/lib/surface-stack";

/**
 * The one place that decides which surface is topmost (`YEO-83`).
 *
 * ## The problem it replaces
 *
 * The canvas has several overlapping surfaces open at once — the detail panel,
 * the add-person panel over it, an edit or removal dialogue over that — and
 * every one of them used to attach its own `document` keydown listener and
 * close itself on Escape. A listener per surface means one keystroke answered
 * by all of them: pressing Escape over the add-person panel closed the record
 * behind it as well, which is the symptom E3-T2 (`YEO-30`) recorded and which
 * `components/ModalDialog.tsx` then patched from its own side with a
 * capture-phase `stopPropagation`. That fix worked for exactly the pair of
 * surfaces somebody had noticed, in exactly one direction, and quietly did
 * nothing for the panels that never had an Escape handler at all.
 *
 * So there is now one registry and **one** listener. A surface says it is
 * dismissable; the listener asks the registry which one is on top and calls
 * only that one's `onDismiss`. Nothing calls `stopPropagation`, because with a
 * single listener there is nobody left to stop — which is the point of the
 * ticket rather than an omission from it.
 *
 * ## Why module-level state rather than a React context
 *
 * `components/sidebar-state.ts` is the precedent: state that lives outside
 * React because the thing it describes lives outside React. Here that thing is
 * a `document` listener, and `document` is already the scope it acts on.
 *
 * A provider would also not reach far enough. `components/AddPersonPanel.tsx`
 * renders in the tree page's *header*, outside `FamilyTree` entirely, so a
 * context around the canvas would not contain it and a context around the
 * whole route would have to be threaded through a Server Component layout to
 * cover surfaces that are not on the canvas at all. The stack is a property of
 * the page, not of any one subtree.
 *
 * ## Order is the whole mechanism
 *
 * Surfaces are pushed on mount and removed on unmount, newest last, and the
 * newest is topmost. Nothing sorts, nothing consults a z-index, and — this is
 * the fragile part — **nothing may re-register**. A surface that re-registered
 * would jump to the top of the stack, so a background panel would start
 * answering Escapes meant for the dialogue over it. That is why the effect
 * below has an empty dependency array and reads its callbacks out of a ref
 * assigned during render: a caller passing a fresh inline `onDismiss` on every
 * render is ordinary React, and it must not reorder anything.
 *
 * React runs mount effects innermost-first, so two surfaces that first appear
 * in the *same* commit would register child before parent. No pair here does:
 * a dialogue is always opened by a press, which is a commit later than the
 * panel it opens over.
 *
 * The one place mount order is not the answer is `underneath`, and it is a
 * position chosen once at registration rather than a re-ordering: a person's
 * record can open *below* the add-person panel already covering it. See
 * `withSurface` in `lib/surface-stack.ts`.
 */

/**
 * What a surface has to say about itself.
 *
 * Every field but `onDismiss` is optional, and the defaults describe the
 * commonest surface on this canvas: a side panel that closes on Escape, does
 * not trap Tab, and leaves focus wherever the browser put it.
 */
export interface DismissableSurfaceOptions {
  /** Escape was pressed and this surface was the one on top. */
  onDismiss: () => void;
  /**
   * Whether Tab is confined to this surface. True for anything rendering
   * `aria-modal="true"`, and false for the panels, which are part of the page
   * and deliberately tabbable past.
   */
  modal?: boolean;
  /** The element Tab is confined to. Required when `modal` is true. */
  surfaceRef?: RefObject<HTMLElement | null>;
  /**
   * Whether this surface is drawn *below* anything already open, and so
   * should not take the Escape aimed at it.
   *
   * The one caller is `components/PersonPanel.tsx`, whose record can open
   * underneath the add-person panel covering it. See `withSurface` in
   * `lib/surface-stack.ts` for why that pair is the exception and why
   * "underneath everything" is the honest way to say it.
   */
  underneath?: boolean;
  /**
   * Where focus goes when this surface leaves — the node that opened the
   * panel, the button that opened the dialogue.
   *
   * A getter rather than an element, and called at cleanup rather than
   * resolved at mount, for two reasons. It closes over whatever the surface's
   * final render knew, which is how the canvas can name the node for the
   * person whose panel this *was*; and the element it names may not exist yet
   * when the surface mounts, which is the ordinary state of a deep link that
   * opens a panel over a canvas that has not drawn its nodes.
   */
  returnFocus?: () => HTMLElement | null;
}

/** A surface as the registry holds it: an id, and the latest thing it said. */
interface RegisteredSurface {
  id: number;
  options: RefObject<DismissableSurfaceOptions>;
}

/**
 * The tab order, as `ModalDialog` has always read it — with one correction.
 *
 * Both `EditPersonForm` and `PersonRemoval`'s `RemovalForm` render a
 * `<input type="hidden">` as the first child inside the dialogue, ahead of
 * any real control: the record's id, a union's id, the reference the server
 * action needs and nothing an author ever sees. An unqualified `input` here
 * matches it, `.focus()` on a hidden input is a no-op, and
 * `event.preventDefault()` has already told the browser not to do what it
 * would have done natively — so a Tab from the heading, where focus opens,
 * landed nowhere at all. `IndividualFieldset` disables every field mid-save
 * (`disabled={pending}`), which is the identical failure for a different
 * reason: `button:not([disabled])` already excluded a disabled button, and a
 * disabled `input`/`select`/`textarea` is exactly as inert.
 *
 * Excluding both is what makes `nextTrapIndex`'s own doc comment true rather
 * than aspirational: it names "a dialogue mid-submission can disable every
 * button it has" as why `length === 0` must not swallow Tab, but a disabled
 * field was still being counted into `length` here, so that branch could
 * never fire for these forms.
 */
const FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

let stack: RegisteredSurface[] = [];

/** Ids are never reused, so a cleanup can only ever remove its own surface. */
let nextSurfaceId = 1;

/**
 * The single listener. Attached when the first surface registers and removed
 * when the last one leaves, so a page with nothing open — every page but this
 * one, most of the time — carries no listener at all.
 */
function onDocumentKeyDown(event: KeyboardEvent): void {
  const surface = topmost(stack);
  if (surface === null) return;
  const options = surface.options.current;

  if (event.key === "Escape") {
    options.onDismiss();
    return;
  }

  if (event.key !== "Tab" || options.modal !== true) return;

  /**
   * Read on every Tab rather than cached when the surface opened, for the
   * reason the trap this replaces gave: a dialogue's contents change under it.
   * Picking a removal swaps the whole body, an edit form's Cancel is replaced
   * by a discard prompt, and a submitting form disables its own buttons.
   */
  const focusable = [
    ...(options.surfaceRef?.current?.querySelectorAll<HTMLElement>(
      FOCUSABLE_SELECTOR,
    ) ?? []),
  ];

  // `-1` for focus anywhere outside the surface — including on its own
  // heading, which is focusable but not tabbable. See `nextTrapIndex`.
  const active = document.activeElement;
  const index = nextTrapIndex(
    focusable.length,
    focusable.findIndex((element) => element === active),
    event.shiftKey,
  );
  if (index === null) return;

  event.preventDefault();
  focusable[index].focus();
}

/**
 * Put focus back where the surface came from, if nobody else has claimed it.
 *
 * The guard is what keeps this from being a focus thief, and it is the one
 * `FamilyTree` documented when this lived there: when a surface unmounts the
 * browser drops focus on `<body>`, which is the case worth rescuing; anywhere
 * else means the reader has already moved on and nothing here has any business
 * pulling them back. `isConnected` covers the other half — a getter that names
 * an element which has itself just been removed.
 */
function restoreFocus(
  returnFocus: (() => HTMLElement | null) | undefined,
): void {
  if (returnFocus === undefined) return;

  const active = document.activeElement;
  if (active !== null && active !== document.body) return;

  const target = returnFocus();
  if (target === null || !target.isConnected) return;
  target.focus();
}

/**
 * Declare this component a dismissable surface for as long as it is mounted.
 *
 * The component says what dismissing means and, if it is modal, what Tab is
 * confined to. Whether *this* Escape is for it is not its decision — that is
 * the whole of the ticket.
 */
export function useDismissableSurface(
  options: DismissableSurfaceOptions,
): void {
  /**
   * The latest thing this surface said, kept where the listener can read it.
   *
   * The registration effect below therefore has an **empty** dependency array
   * and never re-registers: a caller passing a fresh inline `onDismiss` on
   * every render is ordinary React, and re-registering would move a background
   * panel to the top of the stack. See "Order is the whole mechanism" above.
   *
   * Updated in an effect of its own rather than during render, which is what
   * `react-hooks/refs` requires — and the value wanted here is the last
   * *committed* one in any case: a keystroke is answered after the commit that
   * changed what `onDismiss` means, not during it. No dependency array, so it
   * runs after every render; the one it must not be attached to is the
   * registration below.
   */
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  });

  /**
   * Push on mount, remove on unmount, and nothing in between — the empty
   * dependency array is load-bearing rather than an optimisation. Re-running
   * this would take the surface off the stack and put it back on top.
   *
   * React runs a component's effects in declaration order, so the ref above is
   * already assigned by the time anything can press a key against this.
   */
  useEffect(() => {
    const id = nextSurfaceId++;
    /*
      Read off the ref, which was assigned during this component's own render
      and so is already the current one. It is read *once*, here: where a
      surface sits is settled when it opens, and a surface that moved would be
      the re-registration the note above forbids.
    */
    stack = withSurface(
      stack,
      { id, options: optionsRef },
      optionsRef.current.underneath,
    );
    if (stack.length === 1) {
      document.addEventListener("keydown", onDocumentKeyDown);
    }

    return () => {
      const wasTopmost = isTopmost(stack, id);
      stack = withoutSurface(stack, id);
      if (stack.length === 0) {
        document.removeEventListener("keydown", onDocumentKeyDown);
      }

      // Only the surface that was on top gets to say where focus lands. One
      // that was underneath something else was not holding it in the first
      // place, and a panel deleted out from under an open dialogue must not
      // yank focus off it.
      if (wasTopmost) restoreFocus(optionsRef.current.returnFocus);
    };
  }, []);
}
