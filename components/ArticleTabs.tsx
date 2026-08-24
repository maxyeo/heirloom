"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { articleTabsForPath, type ArticleTab } from "@/lib/article-tabs";

/**
 * The Article / Read / Edit / View history row above an entry (E11-T7).
 *
 * ## What it does not decide
 *
 * Which tab is current, and whether there is an article here at all. That is
 * `lib/article-tabs.ts`, which is a function of the path and is tested without
 * a document — docs/testing.md's "prefer no DOM". This file renders what it
 * returns, and takes the path as a **prop** rather than calling `usePathname`
 * itself, for the reason that document gives twice: a Client Component a test
 * may want to mount should take what it needs, not import it.
 * `components/RoutedArticleTabs.tsx` is the handful of lines that know about
 * routing, exactly as `components/DeepLinkedFamilyTree.tsx` is for the canvas.
 *
 * ## The tab treatment
 *
 * Vector 2022's, in E11-T1 tokens and nothing else. A hairline under the whole
 * row (`border-rule-soft`), unselected tabs as plain links, and the selected
 * one in `ink` under a 2px `link`-blue underline that sits *on* the row's
 * hairline rather than above it — that is what `-mb-px` is doing, and it is
 * the difference between a tab that is attached to the page below it and a
 * word with a line under it.
 *
 * ## Narrow screens
 *
 * The row splits the way Wikipedia's does: the namespace on the left, the
 * views on the right. Below `sm` the *view* group collapses into an overflow
 * menu whose trigger is the view you are currently on, so the row still
 * answers "where am I" in one glance and costs one tap to answer "where else
 * can I go". The namespace tab stays put — it is one short word, and it is the
 * anchor the menu would otherwise be hiding.
 *
 * `<details>` rather than a scripted popover, matching `AccountMenu`: it opens
 * with no JavaScript and it needs no state in React. The shell's reviewer
 * found the gap that leaves — **current browsers do not close a `<details>` on
 * Escape** — so the two dismissals a menu is expected to have are added below,
 * and they are enhancements rather than the mechanism: with scripting off the
 * menu still opens and the summary still closes it.
 */

/** So the overflow trigger and its menu are related by more than adjacency. */
const MENU_ID = "article-views-menu";

/**
 * Shared by all four tabs. `items-end` on the row plus `-mb-px` here is what
 * lands the 2px underline on the row's own hairline.
 *
 * No `display` utility, deliberately: the summary below needs `flex` for its
 * chevron and the others need `block`, and two display utilities on one
 * element are decided by Tailwind's own ordering rather than by the order they
 * are written in — which is a coin toss dressed up as a class list.
 */
const TAB_BASE = "-mb-px border-b-2 px-1 pb-1.5 text-caption";

/** Not selected: a plain link, in the one blue the palette has. */
const TAB_IDLE = "border-transparent text-link";

/**
 * Selected. `text-ink` beats the `a { color: … }` in `@layer base` because
 * utilities are a later layer, which is the same way `SiteHeader` darkens the
 * wordmark.
 */
const TAB_CURRENT = "border-link font-medium text-ink";

function tabClass(current: boolean): string {
  return `${TAB_BASE} ${current ? TAB_CURRENT : TAB_IDLE}`;
}

/**
 * One view tab as a link.
 *
 * `aria-current="page"` only where the tab points at the page you are on, so
 * the announcement matches the styling. The namespace tab below is not a link
 * and does not get one — it is always selected, and "current page" said about
 * something that is not a destination is noise.
 */
function ViewTabLink({
  tab,
  className,
}: {
  tab: ArticleTab;
  className: string;
}) {
  // Every `"view"` tab has an href; the type allows `null` only for the
  // namespace tab, which is rendered separately.
  if (tab.href === null) return null;

  return (
    <Link
      href={tab.href}
      aria-current={tab.current ? "page" : undefined}
      className={className}
    >
      {tab.label}
    </Link>
  );
}

export function ArticleTabs({ pathname }: { pathname: string }) {
  const menuRef = useRef<HTMLDetailsElement>(null);

  /**
   * Escape closes the overflow menu and puts focus back on the trigger.
   *
   * On the document rather than on the `<details>`, so it works from wherever
   * focus is when the menu is open — including the trigger itself, which is
   * where it is if the menu was opened by keyboard. Reading `.open` off the
   * element rather than mirroring it into React state is what keeps this
   * component stateless: `<details>` already holds that bit, and a second copy
   * of it could only ever disagree.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      const menu = menuRef.current;
      if (!menu?.open) return;

      menu.open = false;
      menu.querySelector("summary")?.focus();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * A press anywhere else closes it — the other half of what `<details>` does
   * not do for itself, and the thing `AccountMenu` notes as its own trade.
   *
   * `pointerdown` rather than `click`: it fires before focus moves, so a press
   * on a link elsewhere on the page closes the menu and still follows the
   * link. No focus is moved here, because the press already decided where
   * focus should go.
   */
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const menu = menuRef.current;
      if (!menu?.open) return;
      if (event.target instanceof Node && menu.contains(event.target)) return;

      menu.open = false;
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  /**
   * Arriving somewhere new closes it.
   *
   * The row is rendered by the shell, which survives a navigation between
   * views of the same entry — so without this, tapping "Edit" in the menu
   * would leave the menu hanging open over the editor. It also covers Back and
   * Forward, which a click handler on each item would not.
   */
  useEffect(() => {
    const menu = menuRef.current;
    if (menu) menu.open = false;
  }, [pathname]);

  const row = articleTabsForPath(pathname);
  /*
    Every other page the shell wraps — the front page, `/tree`, the entry
    index, the create form. Nothing renders, not an empty row.

    The three effects above run on those pages too, because the rules of hooks
    put them before this return. That is two document listeners on a page with
    no menu, and they are deliberately left there: both bail on the first line
    when the ref is empty, and the alternative — moving them into a child that
    only mounts on an article — buys nothing measurable in exchange for a
    component whose dismissal logic lives somewhere other than the component
    that is dismissed.
  */
  if (!row) return null;

  const namespaceTab = row.tabs.find((tab) => tab.group === "namespace");
  const viewTabs = row.tabs.filter((tab) => tab.group === "view");

  return (
    // The measure and the padding match what every route gives its own
    // `<main>`, so the row lines up with the prose beneath it rather than with
    // the shell around it. See docs/design-tokens.md — the shell does not own
    // the content column, so anything sitting above it has to opt into the
    // same column by hand.
    <nav
      aria-label="Article"
      className="mx-auto flex max-w-content items-end justify-between gap-3 border-b border-rule-soft px-4 pt-6 sm:px-6 sm:pt-8"
    >
      {namespaceTab ? (
        /*
          A `<span>`, not a link. With no Talk namespace to come back from,
          the only address this could point at is "Read", immediately to its
          right — see the header of `lib/article-tabs.ts`. It is styled as the
          selected tab because it is one: this is the article namespace, and
          it is the only one there is.
        */
        <span className={`${tabClass(namespaceTab.current)} block`}>
          {namespaceTab.label}
        </span>
      ) : null}

      {/* Wide: the three views as a row. Below `sm` this is `display: none`,
          which takes it out of the accessibility tree along with the pixels,
          so the two arrangements are never announced at once. */}
      <ul role="list" className="hidden items-end gap-4 sm:flex">
        {viewTabs.map((tab) => (
          <li key={tab.id}>
            <ViewTabLink
              tab={tab}
              className={`${tabClass(tab.current)} block`}
            />
          </li>
        ))}
      </ul>

      {/* Narrow: the same three, behind the one you are on. */}
      <details ref={menuRef} className="relative sm:hidden">
        <summary
          aria-controls={MENU_ID}
          className={`${tabClass(true)} flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden`}
        >
          {row.currentView.label}
          {/* The visible word is the view you are on, which is what the row
              has to say first. The rest of the name is announced only, so the
              control still explains what it discloses — and it keeps the
              visible text as a prefix of the accessible name, which is what
              lets a voice-control user say what they can see.

              The leading space is inside the string rather than between the
              elements: accessible-name computation concatenates these two text
              nodes with nothing between them, so without it the control is
              announced as "Readand other views". */}
          <span className="sr-only">{" and other views"}</span>
          <span aria-hidden="true">▾</span>
        </summary>

        {/*
          `z-20` puts the menu over the article and under the sidebar's scrim
          (`z-30`), so opening the navigation drawer dims this rather than
          leaving it floating brightly over a dimmed page.
        */}
        <ul
          id={MENU_ID}
          role="list"
          className="absolute right-0 z-20 mt-1 w-44 rounded-panel border border-rule-soft bg-paper py-1"
        >
          {viewTabs.map((tab) => (
            <li key={tab.id}>
              <ViewTabLink
                tab={tab}
                className={`block px-3 py-1.5 text-caption ${
                  tab.current ? "font-medium text-ink" : "text-link"
                } hover:bg-panel`}
              />
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}
