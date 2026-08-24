// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_ATTRIBUTE,
  SIDEBAR_PINNED_QUERY,
  SIDEBAR_STORAGE_KEY,
  resolveSidebarState,
  sidebarBootScript,
} from "@/lib/sidebar-preference";

/**
 * `sidebarBootScript` is a second copy of `resolveSidebarState`, written as a
 * string, because it has to run before the page paints and before any module
 * has loaded. These are the tests that keep the copy honest: the script is
 * executed for real, against a stubbed `matchMedia` and jsdom's own
 * `localStorage`, and its answer is compared with the function's on every
 * combination of inputs.
 *
 * It lives apart from `lib/sidebar-preference.test.ts` because it is the only
 * half that needs a document, and docs/testing.md would rather the pure half
 * kept running in plain Node.
 */
describe("sidebarBootScript", () => {
  function runBootScript(pinned: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === SIDEBAR_PINNED_QUERY ? pinned : false,
      })),
    );
    new Function(sidebarBootScript)();
    return document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.removeAttribute(SIDEBAR_ATTRIBUTE);
  });

  const cases: Array<[string | null, boolean]> = [
    [null, true],
    [null, false],
    ["open", true],
    ["open", false],
    ["closed", true],
    ["closed", false],
  ];

  it.each(cases)(
    "agrees with resolveSidebarState (stored %s, pinned %s)",
    (stored, pinned) => {
      if (stored === null) window.localStorage.removeItem(SIDEBAR_STORAGE_KEY);
      else window.localStorage.setItem(SIDEBAR_STORAGE_KEY, stored);

      expect(runBootScript(pinned)).toBe(resolveSidebarState(stored, pinned));
    },
  );

  it("sets the attribute even where matchMedia does not exist", () => {
    // Not hypothetical: it is jsdom's own state without the stub, and it is
    // what a very old browser does. The script must still answer, because an
    // unset attribute leaves the stylesheet's fallback in charge and the
    // hamburger reading state off an element that has none.
    vi.stubGlobal("matchMedia", undefined);
    new Function(sidebarBootScript)();

    expect(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE)).toBe(
      "closed",
    );
  });

  it("still answers when localStorage throws", () => {
    // Site data blocked. The getter throws on access rather than returning
    // null, and an exception here would abort the script before the attribute
    // is set.
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const storage = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("The operation is insecure.");
      },
    });

    try {
      new Function(sidebarBootScript)();
      expect(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE)).toBe(
        "open",
      );
    } finally {
      if (storage) Object.defineProperty(window, "localStorage", storage);
    }
  });
});
