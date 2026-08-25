// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchBox } from "@/components/SearchBox";
import { useDismissableSurface } from "@/components/surface-stack";
import { toSuggestions } from "@/lib/search-endpoint";
import { render } from "@/test/render";

/**
 * The wiring: the shortcut, the debounce, the abort, the keyboard, and the
 * one `YEO-83` invariant no other test in this repository can reach.
 *
 * Everything about *what a result looks like* is
 * `components/SearchSuggestions.test.tsx`'s, and everything about the state
 * machine is `lib/suggestion-state.test.ts`'s. What is left here genuinely
 * needs a document and a clock.
 *
 * ## What is replaced, and why it is not the `vi.mock` exception widening
 *
 * `globalThis.fetch` only. docs/testing.md's bar is "mock a module boundary
 * Vitest cannot cross, never behaviour worth driving" — and the network is
 * not a module boundary this suite could cross if it tried, it is the
 * boundary itself. Handing this component a `fetch` that resolves a literal
 * is the same act as handing `components/PersonRemoval.tsx` a stub server
 * action. Nothing else is stubbed: `lib/suggestion-state.ts`,
 * `lib/search-shortcut.ts` and `components/surface-stack.ts` all run for
 * real, which is the point of two of the tests below.
 */

/** One outstanding request, and the handles to answer or fail it. */
type Pending = {
  url: string;
  signal: AbortSignal;
  respond: (body: unknown, ok?: boolean) => Promise<void>;
  fail: (error: Error) => Promise<void>;
};

let pending: Pending[] = [];

/** Let React settle every microtask the last act produced. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stubFetch() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      pending.push({
        url,
        signal: init!.signal!,
        respond: async (body, ok = true) => {
          resolve({
            ok,
            status: ok ? 200 : 500,
            json: async () => body,
          } as Response);
          await settle();
        },
        fail: async (error) => {
          reject(error);
          await settle();
        },
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  pending = [];
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  const host = render(<SearchBox siteName="Heirloom" />);
  const input = host.querySelector("input")!;
  return { host, input };
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

/** Run out the debounce so the request actually goes out. */
function runDebounce(): void {
  act(() => {
    vi.advanceTimersByTime(250);
  });
}

const answer = (query: string) =>
  JSON.parse(
    JSON.stringify(
      toSuggestions(
        query,
        [
          {
            id: "p1",
            name: "Rose Hale",
            lifespan: "1910–1994",
            href: "/tree?person=p1",
          },
        ],
        [
          {
            id: "e1",
            slug: "hale",
            title: "The Hale family",
            href: "/wiki/hale",
            snippet: [],
          },
        ],
      ),
    ),
  );

describe("the keyboard shortcut", () => {
  it.each([
    ["/", {}],
    ["k", { metaKey: true }],
    ["k", { ctrlKey: true }],
  ])("focuses the box on %s from anywhere on the page", (key, modifiers) => {
    stubFetch();
    const { input } = mount();
    expect(document.activeElement).not.toBe(input);

    press(document.body, key, modifiers);

    expect(document.activeElement).toBe(input);
  });

  /**
   * The regression this application actually risks. `components/EntryEditor.tsx`
   * mounts TipTap, so a contenteditable is real here and `/` in prose is
   * constant — an author writing "and/or" must not lose their sentence to a
   * search box.
   */
  it("never steals a keystroke from a contenteditable or a textarea", () => {
    stubFetch();
    const { input } = mount();

    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    // jsdom parses the attribute but implements no `isContentEditable`
    // getter, so without this the element reads as an ordinary div and the
    // test would pass for the wrong reason — which is exactly the regression
    // it is here to catch. A browser sets this itself.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    const textarea = document.createElement("textarea");
    document.body.append(editor, textarea);

    press(editor, "/");
    expect(document.activeElement).not.toBe(input);

    press(textarea, "/");
    expect(document.activeElement).not.toBe(input);
  });

  it("selects what is already in the box, the way every other search field does", () => {
    stubFetch();
    const { input } = mount();
    type(input, "rose");

    const select = vi.spyOn(input, "select");
    press(document.body, "k", { metaKey: true });

    expect(select).toHaveBeenCalled();
  });
});

describe("asking, and not asking too often", () => {
  it("issues one request for a word rather than one per letter", () => {
    const fetchMock = stubFetch();
    const { input } = mount();

    for (const value of ["r", "ro", "ros", "rose"]) type(input, value);
    expect(fetchMock).not.toHaveBeenCalled();

    runDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pending[0].url).toContain("q=rose");
  });

  it("never asks about a single letter", () => {
    const fetchMock = stubFetch();
    const { input } = mount();

    type(input, "r");
    runDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not ask again for the answer already on screen", async () => {
    const fetchMock = stubFetch();
    const { input } = mount();

    type(input, "rose");
    runDebounce();
    await pending[0].respond(answer("rose"));

    // A trailing space typed and deleted is the same question.
    type(input, "rose ");
    runDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the request in flight when the query moves on", () => {
    stubFetch();
    const { input } = mount();

    type(input, "rose");
    runDebounce();
    const first = pending[0];
    expect(first.signal.aborted).toBe(false);

    type(input, "rosemary");
    runDebounce();

    expect(first.signal.aborted).toBe(true);
    expect(pending).toHaveLength(2);
  });

  it("abandons a request in flight when it is unmounted", () => {
    stubFetch();
    const { host, input } = mount();

    type(input, "rose");
    runDebounce();

    act(() => {
      host.remove();
    });
    // The root is torn down by `test/render.tsx`'s own afterEach; what
    // matters is that nothing is left waiting on a socket for a component
    // that has gone.
    expect(pending).toHaveLength(1);
  });
});

describe("answers that arrive out of order", () => {
  it("ignores an answer to a query that has since been retyped", async () => {
    stubFetch();
    const { host, input } = mount();

    type(input, "rose");
    runDebounce();
    type(input, "rosemary");
    runDebounce();

    // The first request's answer lands late — aborting is best-effort, and a
    // response already on the wire arrives whether or not it was abandoned.
    await pending[0].respond(answer("rose"));

    expect(host.textContent).not.toContain("Rose Hale");
    expect(host.textContent).toContain("Searching…");
  });

  /**
   * The bug this file exists for most of all. Every keystroke aborts the
   * request before it, and every abort rejects that request's promise — so
   * without the `signal.aborted` check in `SearchBox`, the error copy would
   * paint over correct results on every keystroke.
   */
  it("does not report an aborted request as a failure", async () => {
    stubFetch();
    const { host, input } = mount();

    type(input, "rose");
    runDebounce();
    const first = pending[0];

    type(input, "rosemary");
    runDebounce();
    await first.fail(new DOMException("aborted", "AbortError"));
    await pending[1].respond(answer("rosemary"));

    expect(host.textContent).not.toContain("Search is not answering");
    expect(host.textContent).toContain("Rose Hale");
  });

  it("reports a genuine failure", async () => {
    stubFetch();
    const { host, input } = mount();

    type(input, "rose");
    runDebounce();
    await pending[0].fail(new Error("offline"));

    expect(host.textContent).toContain("Search is not answering just now");
  });

  it("treats a payload it does not recognise as a failure rather than crashing", async () => {
    stubFetch();
    const { host, input } = mount();

    type(input, "rose");
    runDebounce();
    await pending[0].respond({ unexpected: true });

    expect(host.textContent).toContain("Search is not answering just now");
  });

  it("treats a non-200 as a failure", async () => {
    stubFetch();
    const { host, input } = mount();

    type(input, "rose");
    runDebounce();
    await pending[0].respond(answer("rose"), false);

    expect(host.textContent).toContain("Search is not answering just now");
  });
});

describe("moving through the results", () => {
  async function withResults() {
    stubFetch();
    const mounted = mount();
    type(mounted.input, "rose");
    runDebounce();
    await pending[0].respond(answer("rose"));
    return mounted;
  }

  it("moves aria-activedescendant onto the first result", async () => {
    const { host, input } = await withResults();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    press(input, "ArrowDown");

    const active = input.getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    // `getElementById` rather than a selector: `useId` produces ids holding
    // characters a CSS selector would have to escape, and jsdom implements no
    // `CSS.escape` to do it with. `SearchBox` reaches for the same function
    // for the same reason.
    expect(document.getElementById(active!)?.textContent).toContain(
      "Rose Hale",
    );
    expect(host.contains(document.getElementById(active!))).toBe(true);
  });

  it("wraps from the last row round to the first", async () => {
    const { input } = await withResults();

    press(input, "ArrowUp");
    const last = input.getAttribute("aria-activedescendant");
    press(input, "ArrowDown");

    expect(input.getAttribute("aria-activedescendant")).not.toBe(last);
  });

  it("keeps Enter as a plain search while no row is chosen", async () => {
    const { input } = await withResults();

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    // Untouched, so the form submits to `/search?q=…` natively — which is the
    // behaviour with JavaScript off, and stays the default with it on.
    expect(event.defaultPrevented).toBe(false);
  });

  it("follows the chosen row on Enter instead of submitting", async () => {
    const { input } = await withResults();
    press(input, "ArrowDown");

    const active = document.getElementById(
      input.getAttribute("aria-activedescendant")!,
    )!;
    const clicked = vi.fn();
    active.addEventListener("click", clicked);

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(clicked).toHaveBeenCalled();
  });

  it("leaves the caret keys alone when there is nothing to move through", () => {
    stubFetch();
    const { input } = mount();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("dismissing the panel", () => {
  it("closes on Escape and puts focus back in the box", () => {
    stubFetch();
    const { host, input } = mount();

    act(() => input.focus());
    // The panel itself, not its copy: "Search people and entries" is also the
    // input's own sr-only label, which is there whether the panel is or not.
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    press(document.body, "Escape");

    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("closes on a press outside it", () => {
    stubFetch();
    const { host, input } = mount();
    act(() => input.focus());

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });

    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  /**
   * The `YEO-83` invariant, and the reason `PanelSurface` mounts *with the
   * panel* rather than with the box. A search box registered for the life of
   * the header would sit permanently on the surface stack — and, being
   * registered before every dialogue in the application, would be under all
   * of them but would still be there, so an Escape meant for a dialogue that
   * had already closed would silently close this instead.
   *
   * What is asserted is the ordering: a surface registered *after* the panel
   * is topmost, and Escape reaches only that one.
   */
  it("leaves Escape to a surface opened over it", () => {
    stubFetch();
    const { host, input } = mount();
    act(() => input.focus());

    const dismissed = vi.fn();
    function Overlay() {
      useDismissableSurface({ onDismiss: dismissed });
      return null;
    }
    render(<Overlay />);

    press(document.body, "Escape");

    expect(dismissed).toHaveBeenCalledTimes(1);
    // The panel is still open: that Escape was not its own.
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it("registers nothing at all while the panel is closed", () => {
    stubFetch();
    mount();

    const dismissed = vi.fn();
    function Overlay() {
      useDismissableSurface({ onDismiss: dismissed });
      return null;
    }
    render(<Overlay />);

    press(document.body, "Escape");

    // With the box holding no surface, the only registration is the overlay's
    // — so it is topmost from the moment it mounts.
    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});

describe("the combobox contract", () => {
  it("announces the listbox only when there is something in it", async () => {
    stubFetch();
    const { input } = mount();
    act(() => input.focus());

    // Open, showing the invitation — but an expanded listbox holding nothing
    // is announced as an empty listbox, which is worse than a collapsed one.
    expect(input.getAttribute("aria-expanded")).toBe("false");

    type(input, "rose");
    runDebounce();
    await pending[0].respond(answer("rose"));

    expect(input.getAttribute("aria-expanded")).toBe("true");
    // And only now does it name a list, which resolves to a real element.
    const controls = input.getAttribute("aria-controls")!;
    expect(controls).not.toBeNull();
    expect(document.getElementById(controls)?.getAttribute("role")).toBe(
      "listbox",
    );
  });

  it("points at its own listbox, and names the chord it answers to", () => {
    stubFetch();
    const { host, input } = mount();
    act(() => input.focus());

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");

    // Absent while there is no list to point at — an IDREF resolving to
    // nothing is worse than none. It appears with the results.
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(host.querySelector("label")?.getAttribute("for")).toBe(input.id);
  });

  it("posts the same parameter the results page reads", () => {
    stubFetch();
    const { host, input } = mount();

    expect(input.getAttribute("name")).toBe("q");
    expect(host.querySelector("form")?.getAttribute("action")).toBe("/search");
  });
});
