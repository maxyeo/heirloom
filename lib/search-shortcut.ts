/**
 * Whether a keystroke means "open search", and what to call the chord on
 * screen (E8-T3, `YEO-57`).
 *
 * The ticket asks that search be "reachable by keyboard shortcut from
 * anywhere". The wiring for that is four lines of `document.addEventListener`
 * in `components/SearchBox.tsx`; the *decision* is five conditions, and every
 * one of them is a bug somebody has shipped. So it lives here, over
 * structural parameter types rather than real DOM ones, which is how
 * `lib/search-shortcut.test.ts` asserts the whole table against object
 * literals in plain Node — the same move `StackedSurface` in
 * `lib/surface-stack.ts` makes, and for the same stated reason.
 *
 * ## Why this is not in `components/surface-stack.ts`
 *
 * That module owns "one registry and one listener deciding which **open**
 * surface a keystroke is for". An open-shortcut is the opposite question:
 * there is no surface yet, so there is nothing to be topmost, and adding one
 * would need a "surface that is not on the stack" — which is exactly the
 * ordering invariant its own docblock calls "the fragile part". Its listener
 * is also attached only while the stack is non-empty and removed when it
 * empties, and an open-shortcut is needed precisely when nothing is open.
 *
 * There is one search box in this application and there will be one. A
 * registry for a set of size one is ceremony. What would change the answer:
 * the day a second global chord exists, this becomes a registry, and
 * `components/surface-stack.ts` is the shape it should take.
 */

/**
 * As much of a keyboard event as the decision needs.
 *
 * Structural, so a test hands it a literal. A real `KeyboardEvent` satisfies
 * it; nothing here can reach for a property a test would have to fake a whole
 * DOM to provide.
 */
export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Mid-IME-composition. Optional because a synthetic event may omit it. */
  isComposing?: boolean;
  /** Something upstream already claimed this keystroke. */
  defaultPrevented?: boolean;
}

/**
 * As much of the event's target as the decision needs: enough to tell typing
 * furniture from the rest of the page.
 */
export interface ShortcutTarget {
  tagName: string;
  isContentEditable: boolean;
  getAttribute(name: string): string | null;
}

/** The chord, in the form `aria-keyshortcuts` wants it. */
export const SEARCH_KEY_SHORTCUTS = "Meta+K Control+K";

/** Elements that own every printable key the moment they have focus. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Whether the keystroke landed somewhere that is already collecting text.
 *
 * **This application has a real contenteditable.** `components/EntryEditor.tsx`
 * mounts TipTap, and `/` in prose is constant — an author writing "and/or"
 * who loses their sentence to a search box will not report it, they will stop
 * trusting the editor. `isContentEditable` is the check that covers it, and
 * `role="textbox"` covers a widget that collects text without being either.
 *
 * `lib/editor-extensions.ts` binds no `Mod-K` of its own today, so ⌘K is not
 * currently being taken from the editor — but the exclusion covers it anyway,
 * because TipTap's Link extension is one config change away from wanting it.
 */
function isTypingTarget(target: ShortcutTarget | null): boolean {
  if (target === null) return false;
  if (TYPING_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return target.getAttribute("role") === "textbox";
}

/**
 * Whether this keystroke should open search.
 *
 * Two chords, and both earn their place. **⌘K / Ctrl+K** is what everything
 * written in the last decade binds. **Bare `/`** is what MediaWiki's Vector
 * 2022 skin binds, and docs/product.md is explicit that the borrowing of
 * Wikipedia's interface is "not 'inspired by'" — a reader who knows
 * Wikipedia's keyboard already knows this one. They cost the same single
 * listener.
 *
 * @param event the keystroke
 * @param target where it landed — `null` for nothing focused
 * @returns true only for a chord this application means to claim
 */
export function opensSearch(
  event: ShortcutKeyEvent,
  target: ShortcutTarget | null,
): boolean {
  // Something upstream already handled it. Claiming it a second time is how
  // one keystroke comes to mean two things.
  if (event.defaultPrevented === true) return false;

  /**
   * A keystroke inside an IME composition is not a chord — it is a character
   * being assembled. `/` is a live composition character in several input
   * methods, so this is not hypothetical.
   */
  if (event.isComposing === true) return false;

  if (isTypingTarget(target)) return false;

  if (event.key === "/") {
    /**
     * Shift is allowed and the others are not. On several keyboard layouts
     * `/` *is* a shifted key, and `event.key` has already resolved the layout
     * — rejecting Shift here would make the shortcut unreachable for those
     * readers. `Ctrl+/` and `⌘/` belong to the browser and the OS.
     */
    return !event.metaKey && !event.ctrlKey && !event.altKey;
  }

  if (event.key === "k" || event.key === "K") {
    // Exactly one of the two platform modifiers, and neither of the others.
    // `K` as well as `k` because Caps Lock is not a modifier anybody means.
    if (event.altKey || event.shiftKey) return false;
    return event.metaKey !== event.ctrlKey;
  }

  return false;
}

/**
 * Whether this is a platform whose users expect ⌘ rather than Ctrl.
 *
 * Read from strings rather than from `navigator`, so the awkward cases are
 * assertable. `userAgent` is consulted as well as `platform` because
 * `navigator.userAgentData?.platform` reports `"macOS"` where the legacy
 * `navigator.platform` reports `"MacIntel"`, and iOS reports neither
 * consistently across browsers.
 */
export function isApplePlatform(platform: string, userAgent: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(`${platform} ${userAgent}`);
}

/**
 * What to print in the `<kbd>` beside the box, or `null` to print nothing.
 *
 * `null` for a touch device, and that case is the reason this is a function
 * rather than a ternary. **An iPad reports `navigator.platform ===
 * "MacIntel"`** and has no ⌘ key at all unless somebody has attached a
 * keyboard. Promising a chord a device may not have is worse than promising
 * nothing: the shortcut still works for anyone who does have the keyboard,
 * and the hint is only ever a hint.
 *
 * `maxTouchPoints > 1` rather than `> 0`, because some trackpads and pen
 * digitisers report exactly one.
 *
 * @param platform `navigator.userAgentData?.platform ?? navigator.platform`
 * @param userAgent `navigator.userAgent`
 * @param maxTouchPoints `navigator.maxTouchPoints`
 */
export function keyboardHint(
  platform: string,
  userAgent: string,
  maxTouchPoints: number,
): string | null {
  if (maxTouchPoints > 1) return null;
  return isApplePlatform(platform, userAgent) ? "⌘K" : "Ctrl K";
}
