"use client";

import { useEffect, useId, useRef } from "react";

import { useDismissableSurface } from "@/components/surface-stack";

/**
 * A modal dialogue over the tree canvas: a backdrop, a titled surface, and the
 * three keyboard behaviours `aria-modal="true"` promises.
 *
 * ## Where it came from
 *
 * E3-T8 (`YEO-36`) wrote this as `RemovalDialog`, private to
 * `components/PersonRemoval.tsx`, because it was the only dialogue on the
 * canvas. E3-T3's edit form is the second, and it wants the same three
 * things for the same reasons — a second hand-written copy of them is how two
 * dialogues end up disagreeing about which one Escape closes. So it moved here
 * whole; the removal confirmation is unchanged and still renders exactly this
 * markup.
 *
 * What deliberately did *not* move is any opinion about what dismissing means.
 * `onClose` is the caller's: the removal dialogue can be dismissed by a stray
 * click on the backdrop because everything it can do is behind a further
 * button press, whereas the edit form routes the very same click through its
 * unsaved-changes check first. This component only reports the four exits.
 *
 * ## Why the overlay is `fixed`
 *
 * Both callers render from inside the detail panel — which is itself
 * positioned and scrolls its own content — so an absolutely positioned overlay
 * would be clipped to a 320px column. Nothing between here and the viewport
 * sets a transform, so `fixed` means the viewport.
 *
 * ## Escape and Tab, and where they are decided now
 *
 * This dialogue registers itself on the shared surface stack (`YEO-83`) and
 * declares itself modal. Two things follow, and neither is this file's
 * arithmetic any more: Escape reaches `onClose` only while this is the
 * *topmost* surface, and Tab is genuinely confined to `surfaceRef`.
 *
 * What that replaced is worth recording, because it is the one-off this ticket
 * generalised. Both dialogues here open from inside `components/PersonPanel.tsx`,
 * which used to run a `document` Escape listener of its own — so an Escape
 * meant for the dialogue closed the record behind it too, and the author lost
 * the page they were reading while dismissing a confirmation. The fix was a
 * capture-phase listener here plus `stopPropagation`, which is to say: this
 * component reached out and silenced a specific other component. It worked for
 * that pair, in that direction, and did nothing for the three canvas forms
 * that had no Escape at all. There is one listener now, and nothing to stop.
 *
 * The focus trap went the same way, and it was the more serious of the two.
 * `aria-modal="true"` below tells assistive tech that everything outside is
 * inert; the hand-written trap wrapped at the two ends of the tab order and
 * pulled focus in off the heading, but focus sitting on the button *behind*
 * the backdrop — where a click leaves it — tabbed straight out into the panel
 * underneath. `nextTrapIndex` in `lib/surface-stack.ts` is that missing branch,
 * with a test on it.
 */
export interface ModalDialogProps {
  /**
   * The heading, which is also the accessible name and the thing focus lands
   * on. A dialogue that changes stage changes its title, and the effect below
   * re-announces it.
   */
  title: string;
  /** Escape, the backdrop, or whatever the body offers. The caller decides. */
  onClose: () => void;
  /**
   * Where focus goes when the dialogue leaves — the button it was opened from
   * (`YEO-83`).
   *
   * The caller's, for the same reason `onClose` is: this component knows the
   * four exits and nothing about what is behind it. Both callers hold a
   * `triggerRef` and pass `() => triggerRef.current`, and passing it *here*
   * rather than focusing the trigger inside their own `onClose` is what makes
   * the restore cover every exit — including a save that completes and closes
   * the dialogue without anything going through a dismissal at all.
   */
  returnFocus?: () => HTMLElement | null;
  children: React.ReactNode;
}

export function ModalDialog({
  title,
  onClose,
  returnFocus,
  children,
}: ModalDialogProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /**
   * Generated rather than a fixed string, which is what `RemovalDialog` used
   * when it was the only dialogue in the app. Two of these can now be mounted
   * — not on purpose, but a duplicate `id` is a silent way for one dialogue's
   * `aria-labelledby` to resolve to the other one's heading.
   */
  const titleId = useId();

  /**
   * Escape and Tab, both answered by the one listener the page has. `modal`
   * is what turns the trap on; `surfaceRef` is what it confines Tab to, read
   * afresh on every Tab because a dialogue's contents change under it — a
   * removal choice swaps the whole body, an edit form's Cancel is replaced by
   * a discard prompt, and a submitting form disables its own buttons.
   */
  useDismissableSurface({
    onDismiss: onClose,
    modal: true,
    surfaceRef,
    returnFocus,
  });

  /**
   * Focus lands on the heading, which reads out what this dialogue is before
   * anything else. `tabIndex={-1}` for the same reason the panel's header has
   * it: somewhere to put focus, not somewhere to tab to.
   *
   * Keyed on the title so it fires again when a dialogue moves between stages.
   * The heading is the only thing that says which stage this is, and without
   * the re-focus a screen-reader user picks a removal and is told nothing at
   * all about what replaced it.
   */
  useEffect(() => {
    headingRef.current?.focus();
  }, [title]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      // A click on the backdrop is an exit like any other, reported through
      // `onClose`. Whether it is safe to take at face value is the caller's
      // question, not this component's.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-panel border border-rule bg-panel p-4 shadow-lg"
      >
        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="border-0 pb-2 text-h2"
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
