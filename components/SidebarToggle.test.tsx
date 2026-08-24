// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarToggle } from "@/components/SidebarToggle";
import {
  SIDEBAR_ATTRIBUTE,
  SIDEBAR_STORAGE_KEY,
} from "@/lib/sidebar-preference";
import { render } from "@/test/render";

/**
 * The hamburger is the whole of the sidebar's interactivity, and what it does
 * is not a decision that could have been a function: it writes to the document
 * element, it writes to storage, and it has to keep `aria-expanded` truthful
 * while doing both. So this is one of the files that earns a DOM.
 *
 * `matchMedia` is stubbed per test because jsdom does not implement it and
 * because the width is the input that changes the answer — the wide-screen
 * preference is remembered, the narrow-screen one is not.
 */
function stubViewport(pinned: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: pinned })),
  );
}

/** Whatever the boot script would have done, done here instead. */
function startAt(state: "open" | "closed") {
  document.documentElement.setAttribute(SIDEBAR_ATTRIBUTE, state);
}

function toggleIn(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector("button");
  if (!button) throw new Error("no toggle rendered");
  return button;
}

beforeEach(() => {
  stubViewport(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.removeAttribute(SIDEBAR_ATTRIBUTE);
});

describe("SidebarToggle", () => {
  it("reports the state the page opened in", () => {
    startAt("closed");
    const button = toggleIn(render(<SidebarToggle controls="site-sidebar" />));

    expect(button.getAttribute("aria-expanded")).toBe("false");
    // The relationship is announced rather than inferred from the button
    // happening to sit next to the nav.
    expect(button.getAttribute("aria-controls")).toBe("site-sidebar");
  });

  it("opens a closed sidebar and says so", () => {
    startAt("closed");
    const button = toggleIn(render(<SidebarToggle controls="site-sidebar" />));

    act(() => button.click());

    expect(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE)).toBe(
      "open",
    );
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes an open sidebar", () => {
    startAt("open");
    const button = toggleIn(render(<SidebarToggle controls="site-sidebar" />));

    act(() => button.click());

    expect(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE)).toBe(
      "closed",
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("remembers the choice for the next page load", () => {
    startAt("open");
    const button = toggleIn(render(<SidebarToggle controls="site-sidebar" />));

    act(() => button.click());

    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("closed");
  });

  it("does not remember opening the drawer on a phone", () => {
    // Otherwise a viewer who peeked at the navigation on their phone gets the
    // drawer over the article on every load afterwards — and, worse, carries
    // that into their desktop preference, which is the same key.
    stubViewport(false);
    startAt("closed");
    const button = toggleIn(render(<SidebarToggle controls="site-sidebar" />));

    act(() => button.click());

    expect(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE)).toBe(
      "open",
    );
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("keeps every toggle on the page in step", () => {
    // There is one hamburger today and a scrim that writes the same state, so
    // the store has to notify subscribers rather than only mutate the DOM.
    startAt("open");
    const host = render(
      <>
        <SidebarToggle controls="site-sidebar" />
        <SidebarToggle controls="site-sidebar" />
      </>,
    );
    const [first, second] = [...host.querySelectorAll("button")];

    act(() => first.click());

    expect(second.getAttribute("aria-expanded")).toBe("false");
  });
});
