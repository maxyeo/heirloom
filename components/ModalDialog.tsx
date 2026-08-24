"use client";

import { useEffect, useId, useRef } from "react";

/**
 * A modal dialogue over the tree canvas: a backdrop, a titled surface, and the
 * three keyboard behaviours `aria-modal="true"` promises.
 *
 * ## Where it came from
 *
 * E3-T8 (`YEO-36`) wrote this as `RemovalDialog`, private to
 * `components/PersonRemoval.tsx`, because it was the only dialogue on the
 * canvas. E3-T3's edit form is the second, and it wants the same three
 * things for the same reasons — the Escape capture below is not a nicety but
 * a fix for a specific collision with `components/PersonPanel.tsx`, and a
 * second hand-written copy of it is how the two dialogues end up disagreeing
 * about which one Escape closes. So it moved here whole; the removal
 * confirmation is unchanged and still renders exactly this markup.
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
 * ## The Escape key, and why it is captured
 *
 * `components/PersonPanel.tsx` listens for Escape on `document` and closes the
 * panel. Both dialogues that use this are opened from inside that panel, so an
 * Escape meant for the dialogue would bubble to the same listener and close
 * both — the author would dismiss a confirmation and lose the record they were
 * reading in one keystroke.
 *
 * A capture-phase listener on `document` runs before any bubble-phase listener
 * on `document`, so stopping propagation here means the panel's handler never
 * sees the event. That is a deliberate coupling to a real behaviour of the
 * panel rather than a defensive flourish, and both dialogues' tests pin it —
 * it is exactly the kind of thing that would quietly stop working.
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
  children: React.ReactNode;
}

export function ModalDialog({ title, onClose, children }: ModalDialogProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /**
   * Generated rather than a fixed string, which is what `RemovalDialog` used
   * when it was the only dialogue in the app. Two of these can now be mounted
   * — not on purpose, but a duplicate `id` is a silent way for one dialogue's
   * `aria-labelledby` to resolve to the other one's heading.
   */
  const titleId = useId();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      /**
       * The focus trap, which `aria-modal="true"` below is otherwise a promise
       * this dialogue does not keep. Assistive tech reads that attribute as
       * "everything outside is inert"; a Tab that walks out to the panel
       * behind the backdrop makes it a lie, and on a confirmation for
       * something irreversible that is worth more than the fifteen lines it
       * costs.
       *
       * The order is read from the DOM on each Tab rather than cached, because
       * a dialogue's contents change under it — picking a removal swaps the
       * whole body, an edit form's Cancel is replaced by a discard prompt, and
       * a submitting form disables its own buttons.
       */
      const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrapping in either direction, and also pulling focus back in when it
      // is on the heading — which is not in the tab order, so neither branch
      // below would otherwise fire on the first Tab after the dialogue opens.
      if (
        event.shiftKey &&
        (active === first || active === headingRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

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
