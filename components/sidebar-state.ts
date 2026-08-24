"use client";

import { useSyncExternalStore } from "react";

import {
  SIDEBAR_ATTRIBUTE,
  SIDEBAR_PINNED_QUERY,
  SIDEBAR_STORAGE_KEY,
  type SidebarState,
} from "@/lib/sidebar-preference";

/**
 * The sidebar's open/closed state, read from and written to the DOM.
 *
 * The store is the `data-sidebar` attribute on `<html>` — see the header of
 * `lib/sidebar-preference.ts` for why the state lives there rather than in
 * React. This module is the read and write end of it, shared by the two
 * controls that touch it: the header's hamburger and the drawer's scrim.
 *
 * `useSyncExternalStore` is the hook for exactly this shape — state that lives
 * outside React and has to be read during render. It is also what keeps
 * hydration quiet: React renders `getServerSnapshot()` on the server and again
 * on the client's hydration pass, then re-reads the live snapshot, so the
 * attribute the inline boot script set before paint cannot produce a hydration
 * mismatch on the button's `aria-expanded`.
 */

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): SidebarState {
  return document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE) === "open"
    ? "open"
    : "closed";
}

/**
 * What the server renders, and what hydration starts from.
 *
 * "open" rather than "closed" because it matches the stylesheet's own no-JS
 * fallback on the wide screens most first visits arrive on, which keeps the
 * button's label honest for the one frame before the client snapshot lands.
 */
function getServerSnapshot(): SidebarState {
  return "open";
}

export function useSidebarState(): SidebarState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Whether the sidebar is currently a pinned column rather than a drawer. */
function isPinnedViewport(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(SIDEBAR_PINNED_QUERY).matches
  );
}

export function setSidebarState(next: SidebarState): void {
  document.documentElement.setAttribute(SIDEBAR_ATTRIBUTE, next);

  // Only the wide-screen choice is remembered; opening the drawer on a phone
  // is a one-off. See `resolveSidebarState`.
  if (isPinnedViewport()) {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next);
    } catch {
      // Site data blocked, or a full quota. The sidebar still opens and closes
      // for this page load; it just will not be remembered for the next one,
      // and that is not worth an error boundary.
    }
  }

  for (const listener of listeners) listener();
}
