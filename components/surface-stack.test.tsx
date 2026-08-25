// @vitest-environment jsdom
import { act, useRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { useDismissableSurface } from "@/components/surface-stack";
import { render, rerender, unmount } from "@/test/render";

/**
 * The wiring half of `YEO-83`. The arithmetic — which entry is topmost, where
 * Tab goes next — is `lib/surface-stack.test.ts`, in plain Node.
 *
 * What is left needs a document because it *is* the document: one listener
 * shared by every surface on the page, attached while the stack is non-empty
 * and gone when it empties, and focus handed back to whatever opened the
 * surface that just left. The components below are the smallest thing that can
 * register — no panel, no dialogue — so that a failure here points at the
 * mechanism rather than at whichever component was standing in for it.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** A surface with nothing in it but its registration. */
function Surface({
  onDismiss,
  returnFocus,
}: {
  onDismiss: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  useDismissableSurface({ onDismiss, returnFocus });
  return null;
}

/** A surface that claims `aria-modal="true"`'s promise, and its three buttons. */
function ModalSurface({
  onDismiss = () => {},
  buttons = ["first", "middle", "last"],
}: {
  onDismiss?: () => void;
  buttons?: readonly string[];
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useDismissableSurface({ onDismiss, modal: true, surfaceRef });

  return (
    <div ref={surfaceRef}>
      {/* Not tabbable, and focus lands here when a dialogue opens — the case
          the trap this replaces handled and the only one it handled. */}
      <h2 tabIndex={-1}>A dialogue</h2>
      {buttons.map((label) => (
        <button key={label} type="button">
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The shape `ModalSurface` above does not have, and the real dialogues do:
 * a hidden input rendered before any visible control — `EditPersonForm`'s
 * `<input type="hidden" name="id">`, `PersonRemoval`'s `RemovalForm` sends one
 * per reference — and fields that go `disabled` mid-submission, the way
 * `IndividualFieldset` disables every one of its own while `pending`.
 * `FOCUSABLE_SELECTOR` matching either is how a Tab from the heading can find
 * `focusable[0]`, call `.focus()` on it, and land nowhere: both are a no-op to
 * focus, and `event.preventDefault()` has already told the browser not to do
 * what it would otherwise have done.
 */
function ModalSurfaceWithHiddenField({
  onDismiss = () => {},
  disableFields = false,
}: {
  onDismiss?: () => void;
  disableFields?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useDismissableSurface({ onDismiss, modal: true, surfaceRef });

  return (
    <div ref={surfaceRef}>
      <h2 tabIndex={-1}>A dialogue</h2>
      <input type="hidden" name="id" value="thomas" />
      <input type="text" name="name" disabled={disableFields} />
      <button type="button" disabled={disableFields}>
        save
      </button>
    </div>
  );
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

/** Tab, as an event the listener can answer and the test can inspect. */
function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

function buttonLabelled(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no button reading "${label}"`);
  return found;
}

/** A button on the page but outside every surface: an opener, or the canvas. */
function outsideButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "behind the backdrop";
  document.body.appendChild(button);
  return button;
}

describe("Escape and the topmost surface", () => {
  it("dismisses the surface on top and nothing else", () => {
    // The bug the ticket opens with: one keystroke answered by every open
    // surface, so dismissing the add-person panel also closed the record
    // behind it.
    const panel = vi.fn();
    const over = vi.fn();
    render(<Surface onDismiss={panel} />);
    render(<Surface onDismiss={over} />);

    pressEscape();

    expect(over).toHaveBeenCalledTimes(1);
    expect(panel).not.toHaveBeenCalled();
  });

  it("dismisses the one below on the next Escape", () => {
    const panel = vi.fn();
    const over = vi.fn();
    render(<Surface onDismiss={panel} />);
    const top = render(<Surface onDismiss={over} />);

    pressEscape();
    unmount(top);
    pressEscape();

    expect(over).toHaveBeenCalledTimes(1);
    expect(panel).toHaveBeenCalledTimes(1);
  });

  it("hands topmost-ness back when the surface above unmounts", () => {
    const panel = vi.fn();
    render(<Surface onDismiss={panel} />);
    const top = render(<Surface onDismiss={() => {}} />);

    unmount(top);
    pressEscape();

    expect(panel).toHaveBeenCalledTimes(1);
  });

  it("leaves other keys alone", () => {
    const onDismiss = vi.fn();
    render(<Surface onDismiss={onDismiss} />);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("takes the listener away with the last surface", () => {
    // A leaked listener would keep dismissing a surface nobody can see — and
    // because there is only one of them now, it would do it for every surface
    // that ever registered.
    const onDismiss = vi.fn();
    const host = render(<Surface onDismiss={onDismiss} />);
    unmount(host);

    pressEscape();

    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("re-rendering a surface", () => {
  it("does not reorder the stack", () => {
    // Callers pass fresh inline closures on every render, which is ordinary
    // React. Registration order is the whole mechanism, so a re-register here
    // would silently promote the panel underneath to topmost.
    const panel = vi.fn();
    const over = vi.fn();
    const bottom = render(<Surface onDismiss={panel} />);
    render(<Surface onDismiss={over} />);

    rerender(bottom, <Surface onDismiss={panel} />);
    pressEscape();

    expect(over).toHaveBeenCalledTimes(1);
    expect(panel).not.toHaveBeenCalled();
  });

  it("dismisses with the callback from the latest render", () => {
    // Not the one captured when it registered: `EditPersonForm`'s `onDismiss`
    // changes meaning the moment the form becomes dirty, and one keystroke
    // answered by the previous render's opinion is the discard prompt not
    // appearing.
    const first = vi.fn();
    const second = vi.fn();
    const host = render(<Surface onDismiss={first} />);

    rerender(host, <Surface onDismiss={second} />);
    pressEscape();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe("the focus trap", () => {
  it("wraps forward off the last element", () => {
    const host = render(<ModalSurface />);
    act(() => buttonLabelled(host, "last").focus());

    const event = pressTab();

    expect(document.activeElement).toBe(buttonLabelled(host, "first"));
    expect(event.defaultPrevented).toBe(true);
  });

  it("wraps backward off the first element", () => {
    const host = render(<ModalSurface />);
    act(() => buttonLabelled(host, "first").focus());

    pressTab(true);

    expect(document.activeElement).toBe(buttonLabelled(host, "last"));
  });

  it("pulls focus back in from outside the surface", () => {
    // The whole of AC 3. Focus on the button that opened the dialogue used to
    // tab straight out into the panel behind the backdrop, which made
    // `aria-modal="true"` a claim the component did not keep.
    const host = render(<ModalSurface />);
    const opener = outsideButton();
    act(() => opener.focus());

    pressTab();

    expect(document.activeElement).toBe(buttonLabelled(host, "first"));
  });

  it("pulls focus in at the other end going backwards", () => {
    const host = render(<ModalSurface />);
    const opener = outsideButton();
    act(() => opener.focus());

    pressTab(true);

    expect(document.activeElement).toBe(buttonLabelled(host, "last"));
  });

  it("pulls focus in from the dialogue's own heading", () => {
    // Where focus is parked when a dialogue opens: focusable, but not in the
    // tab order, so neither wrap branch would fire without this.
    const host = render(<ModalSurface />);
    const heading = host.querySelector("h2");
    act(() => heading?.focus());

    pressTab();

    expect(document.activeElement).toBe(buttonLabelled(host, "first"));
  });

  it("leaves the browser to it in the middle of the surface", () => {
    const host = render(<ModalSurface />);
    act(() => buttonLabelled(host, "middle").focus());

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(buttonLabelled(host, "middle"));
  });

  it("does nothing for a surface with nothing focusable in it", () => {
    const host = render(<ModalSurface buttons={[]} />);
    const heading = host.querySelector("h2");
    act(() => heading?.focus());

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
  });

  it("skips a hidden input at the front of the surface", () => {
    // The bug itself: `focusable[0]` used to be the hidden `id` field every
    // real dialogue renders first, `.focus()` on it is a no-op, and Tab from
    // the heading — where focus opens — went nowhere at all.
    const host = render(<ModalSurfaceWithHiddenField />);
    const heading = host.querySelector("h2");
    act(() => heading?.focus());

    const event = pressTab();

    expect(document.activeElement).toBe(
      host.querySelector("input[type='text']"),
    );
    expect(document.activeElement).not.toBe(heading);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not swallow Tab when every field is disabled mid-submission", () => {
    // `IndividualFieldset` sets `disabled={pending}` on every one of its
    // fields, which is the same class of bug as the hidden input: a disabled
    // control is still matched by an unqualified selector and still a no-op
    // to `.focus()`. With nothing genuinely focusable, `nextTrapIndex`'s own
    // doc comment says Tab must fall through to the browser rather than be
    // swallowed.
    const host = render(<ModalSurfaceWithHiddenField disableFields />);
    const heading = host.querySelector("h2");
    act(() => heading?.focus());

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(heading);
  });

  it("leaves Tab alone when the topmost surface is not modal", () => {
    // The panels are part of the page and are deliberately tabbable past. Only
    // something claiming `aria-modal="true"` gets the trap.
    render(<ModalSurface />);
    render(<Surface onDismiss={() => {}} />);
    const opener = outsideButton();
    act(() => opener.focus());

    const event = pressTab();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe("returning focus", () => {
  it("puts focus back on whatever opened the surface", () => {
    const opener = outsideButton();
    const host = render(
      <Surface onDismiss={() => {}} returnFocus={() => opener} />,
    );

    unmount(host);

    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus alone when something else has already claimed it", () => {
    // The guard `FamilyTree` documented when this lived there: focus on
    // `<body>` is the case worth rescuing, and anywhere else means the reader
    // has moved on.
    const opener = outsideButton();
    const elsewhere = outsideButton();
    const host = render(
      <Surface onDismiss={() => {}} returnFocus={() => opener} />,
    );
    act(() => elsewhere.focus());

    unmount(host);

    expect(document.activeElement).toBe(elsewhere);
  });

  it("does not chase an element that has gone with the surface", () => {
    const gone = outsideButton();
    const host = render(
      <Surface onDismiss={() => {}} returnFocus={() => gone} />,
    );
    gone.remove();

    expect(() => unmount(host)).not.toThrow();
  });

  it("does nothing for a surface that named nowhere to go", () => {
    const host = render(<Surface onDismiss={() => {}} />);

    expect(() => unmount(host)).not.toThrow();
  });

  it("stays out of it when the surface was not the one on top", () => {
    // A panel deleted out from under an open dialogue. The dialogue is still
    // holding focus, and the panel's opener is not where the reader is.
    const opener = outsideButton();
    const bottom = render(
      <Surface onDismiss={() => {}} returnFocus={() => opener} />,
    );
    const top = render(<ModalSurface />);
    act(() => buttonLabelled(top, "first").focus());

    unmount(bottom);

    expect(document.activeElement).toBe(buttonLabelled(top, "first"));
  });
});
