"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { setSidebarState } from "@/components/sidebar-state";
import { activeSectionId } from "@/lib/active-section";
import {
  ARTICLE_CONTENTS_SLOT_ID,
  nestHeadings,
  type OutlineHeading,
  type OutlineNode,
} from "@/lib/article-outline";
import { SIDEBAR_PINNED_QUERY } from "@/lib/sidebar-preference";

/**
 * The contents panel in the left margin (E11-T3, `YEO-73`) — Vector 2022's
 * "Contents", under the shell's "Navigation".
 *
 * ## Why a portal
 *
 * The panel belongs in the sidebar, and the sidebar is rendered by
 * `components/AppShell.tsx`, which `app/wiki/layout.tsx` mounts *above* every
 * route under `/wiki`. The headings, meanwhile, come from one entry's body,
 * which only `app/wiki/[slug]/page.tsx` has. React data flows down, so a page
 * cannot hand a value to the layout that renders it.
 *
 * Next's answer to that shape is a parallel route — a `@contents` slot beside
 * `children`. It was tried and rejected: a slot only re-renders for a path it
 * matches, and on a client-side navigation to any path it does *not* match it
 * keeps showing whatever it last rendered. `/wiki` and `/wiki/[slug]/edit`
 * would each need their own `page.tsx` in the slot returning `null`, and every
 * route a later ticket adds under `/wiki` would need one too or would inherit
 * the previous entry's contents panel. That is a trap laid for someone else.
 *
 * So the shell leaves an empty element with a known id where the panel goes
 * (`ARTICLE_CONTENTS_SLOT_ID`, in `SiteSidebar`'s `children` — the seam E11-T2
 * documented), the article route renders this component with the headings it
 * already has, and this component puts its output in that element. The
 * headings are still computed on the server, from `bodyHtml`, by
 * `lib/article-outline.ts`; only the placing happens in the browser.
 *
 * The cost is that the panel appears on hydration rather than in the first
 * paint. It costs the reader nothing else: it is in the sidebar, below the
 * navigation, so nothing it does moves the article. The alternative was a
 * routing trap.
 *
 * ## Why it is a Client Component at all
 *
 * Two of the acceptance criteria are behaviour rather than markup — following
 * the scroll position, and collapsing on a narrow screen — so this would have
 * needed `"use client"` regardless of how it got into the sidebar.
 */

/** The panel's landmark heading, and the list the disclosure button controls. */
const HEADING_ID = `${ARTICLE_CONTENTS_SLOT_ID}-heading`;
const LIST_ID = `${ARTICLE_CONTENTS_SLOT_ID}-list`;

/**
 * Whether the sidebar is currently a pinned column rather than a drawer.
 *
 * The same media query the stylesheet and the boot script use, read through
 * `useSyncExternalStore` for the same reason `components/sidebar-state.ts`
 * does: it is state that lives outside React and has to be read during render,
 * and this is the hook that reads it without a hydration mismatch.
 *
 * Both functions are declared at module scope because `useSyncExternalStore`
 * re-subscribes whenever `subscribe` changes identity, and one defined inside
 * the component changes identity on every render.
 */
function subscribePinned(onStoreChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};

  const query = window.matchMedia(SIDEBAR_PINNED_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function getPinnedSnapshot(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(SIDEBAR_PINNED_QUERY).matches
  );
}

/**
 * What a render without a browser would see. Unreachable in practice — the
 * portal only mounts after an effect has run — but `useSyncExternalStore`
 * requires it, and `true` is the same answer `components/sidebar-state.ts`
 * gives: it matches the stylesheet's own no-JavaScript fallback.
 */
function getPinnedServerSnapshot(): boolean {
  return true;
}

/**
 * The element in the sidebar this panel is rendered into.
 *
 * Read through `useSyncExternalStore` rather than found in an effect that
 * calls `setState`: the element is not React's state, it belongs to the shell,
 * and reading it into React state would be a render that exists only to
 * announce something that was already true. `subscribe` does nothing because
 * `components/AppShell.tsx` renders the element once and never replaces it,
 * and the server snapshot is `null` because there is no document to look in —
 * which is also what makes the portal land after hydration rather than during
 * it. See the header of this file.
 */
function subscribeSlot(): () => void {
  return () => {};
}

function getSlotSnapshot(): HTMLElement | null {
  return document.getElementById(ARTICLE_CONTENTS_SLOT_ID);
}

function getSlotServerSnapshot(): null {
  return null;
}

/**
 * Where each heading is right now, and therefore which section is current.
 *
 * The offset is read back off the heading's own `scroll-margin-top` rather
 * than out of `--header-height` directly. The stylesheet sets that property
 * from the token (`app/globals.css`), so this gets the resolved pixel value
 * of the very number the browser will use when it scrolls to the anchor —
 * which is what keeps "the highlighted section" and "the section a click
 * lands on" from being two different answers. A JavaScript constant would be
 * a third place for `3rem` to be written down.
 */
function currentSectionId(ids: readonly string[]): string | null {
  const elements = ids
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => element !== null);

  if (elements.length === 0) return null;

  const offset = Number.parseFloat(
    window.getComputedStyle(elements[0]).scrollMarginTop,
  );
  const page = document.documentElement;

  return activeSectionId(
    elements.map((element) => ({
      id: element.id,
      top: element.getBoundingClientRect().top,
    })),
    {
      offset: Number.isFinite(offset) ? offset : 0,
      // A pixel of slack, because a page zoomed to a fractional ratio never
      // quite reaches its own `scrollHeight`.
      atEnd: window.innerHeight + window.scrollY >= page.scrollHeight - 1,
    },
  );
}

function useActiveSection(headings: readonly OutlineHeading[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  // Joined into a string so that the effect below depends on the ids
  // themselves rather than on the identity of the array holding them — the
  // article route builds a new array on every render, and a re-render should
  // not tear the scroll listener down and put an identical one back.
  const ids = headings.map((heading) => heading.id).join("\n");

  useEffect(() => {
    const list = ids.split("\n");
    let frame = 0;

    const measure = () => {
      frame = 0;
      setActive(currentSectionId(list));
    };

    // Scroll fires far faster than the screen refreshes, and every call reads
    // layout. Coalescing to one measurement per frame is what keeps a listener
    // that calls `getBoundingClientRect()` in a loop off the critical path.
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ids]);

  return active;
}

function ContentsItem({
  node,
  activeId,
  onNavigate,
}: {
  node: OutlineNode;
  activeId: string | null;
  onNavigate: () => void;
}) {
  const current = node.id === activeId;

  return (
    <li>
      {/*
        A plain fragment link, and deliberately not a scroll handler. The
        browser already knows how to reach an element by id, it honours the
        `scroll-margin-top` the stylesheet puts on article headings — which is
        the whole of "the heading is not hidden under the sticky header" — and
        it puts the section in the address bar so the reader can copy a link to
        it. A handler would have to reimplement all three.

        `encodeURIComponent` because a heading id is Unicode letters and digits
        (`lib/entry-slug.ts` keeps non-Latin scripts intact), and a raw one in
        an href is at the mercy of how the browser normalises it.
      */}
      <a
        href={`#${encodeURIComponent(node.id)}`}
        aria-current={current ? "true" : undefined}
        onClick={onNavigate}
        className={`block border-s-2 ps-2 hover:text-ink ${
          current
            ? "border-rule font-bold text-ink"
            : "border-transparent text-ink-muted"
        }`}
      >
        {node.text}
      </a>

      {node.children.length > 0 ? (
        <ul role="list" className="mt-1 flex flex-col gap-1 ps-3">
          {node.children.map((child) => (
            <ContentsItem
              key={child.id}
              node={child}
              activeId={activeId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ContentsPanel({ headings }: { headings: readonly OutlineHeading[] }) {
  const pinned = useSyncExternalStore(
    subscribePinned,
    getPinnedSnapshot,
    getPinnedServerSnapshot,
  );
  const [expanded, setExpanded] = useState(false);
  const activeId = useActiveSection(headings);

  // Wide, the panel is the pinned column the ticket asks for and there is
  // nothing to collapse. Narrow, it is a dropdown that starts shut: the
  // sidebar is a drawer over the article at that width, and a drawer that
  // opens onto forty section links has buried its own navigation.
  const open = pinned || expanded;

  const onNavigate = () => {
    // Following a link from inside the drawer should leave the reader looking
    // at the section, not at the drawer they tapped through.
    if (!pinned) setSidebarState("closed");
  };

  return (
    <section aria-labelledby={HEADING_ID}>
      {/* The rule and the serif that globals.css gives an h2 belong to article
          sections. This is furniture, labelled the way `SiteSidebar` labels
          its own group. */}
      <h2
        id={HEADING_ID}
        className="mb-1.5 border-b-0 pb-0 font-sans text-note font-normal text-ink-muted"
      >
        {pinned ? (
          "Contents"
        ) : (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={LIST_ID}
            onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
            className="flex w-full items-center justify-between gap-2 text-inherit"
          >
            Contents
            {/* Drawn rather than iconographed, for the reason
                `SidebarToggle` gives: the shell has no icon set. */}
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        )}
      </h2>

      {/*
        `hidden` carries the semantics, and the class carries the display —
        because Tailwind's `[hidden]` preflight rule sits in the base layer and
        would lose to a `flex` utility from the utilities layer. A list that is
        `hidden` and still `display: flex` is the kind of bug that only shows
        up on a phone.

        `role="list"` restores what preflight's marker-stripping takes away,
        the same way `SiteSidebar` and `app/wiki/page.tsx` already do.
      */}
      <ul
        id={LIST_ID}
        role="list"
        hidden={!open}
        className={open ? "flex flex-col gap-1" : undefined}
      >
        {nestHeadings(headings).map((node) => (
          <ContentsItem
            key={node.id}
            node={node}
            activeId={activeId}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The article's contents, rendered into the shell's sidebar.
 *
 * Renders nothing at all when the entry has no headings to list, which is the
 * acceptance criterion: no empty panel, and no column reserved for one. The
 * article's own width is unaffected either way — `app/wiki/[slug]/page.tsx`
 * centres its own measure, and the sidebar is a fixed column beside it.
 *
 * @param headings every heading in the body, from `readArticleOutline`
 */
export function ArticleContents({
  headings,
}: {
  headings: readonly OutlineHeading[];
}) {
  const slot = useSyncExternalStore(
    subscribeSlot,
    getSlotSnapshot,
    getSlotServerSnapshot,
  );

  // A heading with no text still gets an id — E11-T4 (`YEO-74`) hangs an
  // `[edit]` link off every heading, empty or not — but there is nothing to
  // label a contents entry with, and a blank row is worse than no row.
  const labelled = headings.filter((heading) => heading.text !== "");

  if (slot === null || labelled.length === 0) return null;

  return createPortal(<ContentsPanel headings={labelled} />, slot);
}
