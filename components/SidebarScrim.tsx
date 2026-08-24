"use client";

import { setSidebarState } from "@/components/sidebar-state";

/**
 * The dim behind the sidebar when it is a drawer.
 *
 * It exists so a tap anywhere on the article closes the drawer, which is what
 * every drawer on a phone does and what the article underneath would otherwise
 * silently swallow. `app/globals.css` shows it only while
 * `data-sidebar="open"` and only below the pinned breakpoint, so on a wide
 * screen this element is present and never painted.
 *
 * `aria-hidden` with `tabIndex={-1}`: the hamburger is the accessible control
 * and stays visible above the drawer, so announcing a second unlabelled way to
 * close it would be noise. Removing it from the tab order first is what keeps
 * that from being a focusable-but-hidden element.
 */
export function SidebarScrim() {
  return (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      onClick={() => setSidebarState("closed")}
      className="site-scrim bg-ink/30"
    />
  );
}
