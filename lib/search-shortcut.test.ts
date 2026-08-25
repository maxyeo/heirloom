import { describe, expect, it } from "vitest";

import {
  SEARCH_KEY_SHORTCUTS,
  isApplePlatform,
  keyboardHint,
  opensSearch,
  type ShortcutKeyEvent,
  type ShortcutTarget,
} from "@/lib/search-shortcut";

/**
 * The open-shortcut decision (E8-T3, `YEO-57`), in plain Node.
 *
 * Structural parameter types are what make this possible — see
 * `lib/search-shortcut.ts`'s docblock — so every case below is an object
 * literal rather than a synthesised DOM event.
 */

function key(
  overrides: Partial<ShortcutKeyEvent> & { key: string },
): ShortcutKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function target(overrides: Partial<ShortcutTarget> = {}): ShortcutTarget {
  return {
    tagName: "DIV",
    isContentEditable: false,
    getAttribute: () => null,
    ...overrides,
  };
}

describe("which chords open search", () => {
  it.each([
    ["bare /", key({ key: "/" })],
    // `/` is a shifted key on several layouts, and `event.key` has already
    // resolved the layout — rejecting Shift would make it unreachable there.
    ["shifted /", key({ key: "/", shiftKey: true })],
    ["⌘K", key({ key: "k", metaKey: true })],
    ["Ctrl+K", key({ key: "k", ctrlKey: true })],
    ["⌘K with caps lock on", key({ key: "K", metaKey: true })],
  ])("opens on %s", (_label, event) => {
    expect(opensSearch(event, target())).toBe(true);
  });

  it.each([
    ["⌘/", key({ key: "/", metaKey: true })],
    ["Ctrl+/", key({ key: "/", ctrlKey: true })],
    ["Alt+/", key({ key: "/", altKey: true })],
    ["bare k", key({ key: "k" })],
    ["⌘⇧K", key({ key: "k", metaKey: true, shiftKey: true })],
    ["⌥⌘K", key({ key: "k", metaKey: true, altKey: true })],
    ["⌘⌃K", key({ key: "k", metaKey: true, ctrlKey: true })],
    ["j", key({ key: "j", metaKey: true })],
    ["Escape", key({ key: "Escape" })],
    ["Enter", key({ key: "Enter" })],
  ])("stays out of the way of %s", (_label, event) => {
    expect(opensSearch(event, target())).toBe(false);
  });
});

describe("where the keystroke landed", () => {
  it.each([
    ["an input", target({ tagName: "INPUT" })],
    ["a textarea", target({ tagName: "TEXTAREA" })],
    ["a select", target({ tagName: "SELECT" })],
    // The case that matters most here: `components/EntryEditor.tsx` mounts
    // TipTap, so a contenteditable is real in this app and `/` in prose is
    // constant. An author writing "and/or" must not lose their sentence.
    ["a TipTap contenteditable", target({ isContentEditable: true })],
    [
      "a role=textbox widget",
      target({ getAttribute: (name) => (name === "role" ? "textbox" : null) }),
    ],
  ])("never steals a keystroke from %s", (_label, where) => {
    expect(opensSearch(key({ key: "/" }), where)).toBe(false);
    expect(opensSearch(key({ key: "k", metaKey: true }), where)).toBe(false);
  });

  it.each([
    ["ordinary page furniture", target()],
    ["a link", target({ tagName: "A" })],
    ["a button", target({ tagName: "BUTTON" })],
    ["nothing focused", null],
  ])("fires from %s", (_label, where) => {
    expect(opensSearch(key({ key: "/" }), where)).toBe(true);
  });
});

describe("keystrokes that are not chords", () => {
  it("ignores a keystroke mid-IME-composition", () => {
    // `/` is a live composition character in several input methods, so this
    // is a real sequence rather than a hypothetical one.
    expect(opensSearch(key({ key: "/", isComposing: true }), target())).toBe(
      false,
    );
  });

  it("ignores a keystroke something upstream already claimed", () => {
    expect(
      opensSearch(key({ key: "/", defaultPrevented: true }), target()),
    ).toBe(false);
  });
});

describe("what to print beside the box", () => {
  it("names the platform's own modifier", () => {
    expect(keyboardHint("MacIntel", "Mozilla/5.0 (Macintosh)", 0)).toBe("⌘K");
    expect(keyboardHint("macOS", "Mozilla/5.0 (Macintosh)", 0)).toBe("⌘K");
    expect(keyboardHint("Win32", "Mozilla/5.0 (Windows NT 10.0)", 0)).toBe(
      "Ctrl K",
    );
    expect(keyboardHint("Linux x86_64", "Mozilla/5.0 (X11; Linux)", 0)).toBe(
      "Ctrl K",
    );
  });

  /**
   * The case this is a function for. An iPad reports `MacIntel` and has no ⌘
   * key at all unless somebody attached a keyboard — promising a chord the
   * device may not have is worse than promising nothing, since the shortcut
   * still works for anyone who does have one.
   */
  it("promises nothing on a touch device that claims to be a Mac", () => {
    expect(keyboardHint("MacIntel", "Mozilla/5.0 (Macintosh)", 5)).toBeNull();
    expect(
      keyboardHint("Win32", "Mozilla/5.0 (Windows NT 10.0)", 10),
    ).toBeNull();
  });

  it("counts one touch point as a trackpad rather than a screen", () => {
    expect(keyboardHint("Win32", "Mozilla/5.0 (Windows NT 10.0)", 1)).toBe(
      "Ctrl K",
    );
  });

  it("recognises the Apple platforms by either string", () => {
    expect(
      isApplePlatform("", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"),
    ).toBe(true);
    expect(isApplePlatform("iPad", "")).toBe(true);
    expect(isApplePlatform("Win32", "Mozilla/5.0 (Windows NT 10.0)")).toBe(
      false,
    );
  });

  it("spells the chord the way aria-keyshortcuts wants it", () => {
    expect(SEARCH_KEY_SHORTCUTS).toBe("Meta+K Control+K");
  });
});
