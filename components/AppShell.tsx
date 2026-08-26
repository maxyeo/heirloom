import { RoutedArticleTabs } from "@/components/RoutedArticleTabs";
import { SidebarScrim } from "@/components/SidebarScrim";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteSidebar } from "@/components/SiteSidebar";
import { SkipLink } from "@/components/SkipLink";
import { ARTICLE_CONTENTS_SLOT_ID } from "@/lib/article-outline";
import { sidebarBootScript } from "@/lib/sidebar-preference";

/**
 * The page furniture around an article: sticky header, collapsible left
 * sidebar, and the region the content column sits in. Vector 2022's shell,
 * assembled from the E11-T1 tokens — there is not a colour or a type size in
 * this file that `app/globals.css` did not already declare.
 *
 * ## What it does not own
 *
 * The content column's width. Every route already centres its own `<main>` at
 * `max-w-content`, which is what lets `/tree` be a full-bleed canvas in the
 * same shell as `/wiki/[slug]` without either of them fighting a wrapper. The
 * shell's job here is only to give that column somewhere to be: beside the
 * sidebar, and never narrower than the sidebar leaves it (`min-w-0`, without
 * which a long URL in an article widens the flex item and the whole page
 * scrolls sideways).
 *
 * ## Where the rest of E11 attaches
 *
 * Two tickets extend this shell rather than replace it, and both have a marked
 * seam below:
 *
 * - **E11-T3 (`YEO-73`)** — the pinned table of contents, into
 *   `SiteSidebar`'s `children`. Landed as an empty element the article route
 *   renders into; see the seam below.
 * - **E11-T7 (`YEO-77`)** — the Article / Read / Edit / View history tabs,
 *   into the top of the content region. Landed: `RoutedArticleTabs`.
 *
 * The session is passed in rather than read here: `components/` stays clear of
 * `@/auth` so its files can be mounted in a suite with no `AUTH_*`. The
 * server component that does the reading is `app/site-chrome.tsx`.
 */

/** The `<nav>` the header's hamburger points its `aria-controls` at. */
const SIDEBAR_ID = "site-sidebar";

/**
 * The content region, and so where "skip to content" lands (`YEO-108`).
 *
 * The shell cannot put this on a `<main>`: every route renders its own, which
 * is what lets `/tree` be a full-bleed canvas in the same shell as an article.
 * So the region the shell *does* own is the target, and it begins one element
 * above each route's `<main>` — with the article tab row, which belongs to the
 * article rather than to the chrome and is four stops rather than a repeated
 * block.
 *
 * Reserved in `RESERVED_HEADING_IDS` (`lib/article-outline.ts`), because this
 * one renders on article pages and an entry with a section called "Site
 * content" would otherwise mint a heading id that already exists above it.
 */
const CONTENT_ID = "site-content";

export function AppShell({
  viewerName,
  viewerEmail,
  signOutAction,
  children,
}: {
  viewerName: string | null;
  viewerEmail: string | null;
  signOutAction: () => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <>
      {/*
        First thing in the body, and synchronous, so `<html>` carries the
        viewer's sidebar preference before the sidebar itself is parsed. A
        collapsed sidebar that appears for one frame on every page load is the
        thing this avoids. See `lib/sidebar-preference.ts`.
      */}
      <script
        /* sanitize-html-exempt: sidebar-boot-script */
        dangerouslySetInnerHTML={{ __html: sidebarBootScript }}
      />

      {/*
        The first tab stop on every signed-in page (`YEO-108`), and so
        ahead of the header's hamburger, wordmark, search box and account menu
        and of the sidebar's four links. WCAG 2.4.1: the shell is the repeated
        block, and this is the way over it. Off-screen until it is focused —
        see `.skip-link` in `app/globals.css`.
      */}
      <SkipLink targetId={CONTENT_ID}>Skip to content</SkipLink>

      <SiteHeader
        sidebarId={SIDEBAR_ID}
        viewerName={viewerName}
        viewerEmail={viewerEmail}
        signOutAction={signOutAction}
      />

      {/* `items-start` so the sidebar's `position: sticky` has room to move
          inside a row it is not being stretched to fill. */}
      <div className="flex items-start">
        <SiteSidebar id={SIDEBAR_ID}>
          {/*
            E11-T3 (`YEO-73`) renders the article's contents list into this
            element rather than arriving here as a prop. The headings belong to
            one entry and only `app/wiki/[slug]/page.tsx` has them, so a prop
            would have to travel *up* from the page to the layout that renders
            this shell. `components/ArticleContents.tsx` records what was tried
            instead and why this is what is left. The seam is still the one
            E11-T2 marked, and the panel still lands under "Navigation".

            Empty on every other route, and on an entry with no headings —
            which is what "no headings shows no contents panel" asks for.
          */}
          <div id={ARTICLE_CONTENTS_SLOT_ID} />
        </SiteSidebar>

        {/* Present at every width; painted only while the sidebar is a drawer. */}
        <SidebarScrim />

        {/*
          `tabIndex={-1}` so the link above can put focus here rather than only
          scroll here. It adds no tab stop: a negative tabindex is reachable
          programmatically and skipped by Tab, so the order through this page
          is what it was.
        */}
        <div id={CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1">
          {/* E11-T7 (`YEO-77`): the article tab row, above the content column
              and below the header — which is where the mockup has it, and why
              this is a wrapper rather than `{children}` on its own.

              It renders nothing on a page that is not an article, so the shell
              does not have to know which of its routes have tabs; the path
              decides. See `lib/article-tabs.ts`. */}
          <RoutedArticleTabs />
          {children}
        </div>
      </div>
    </>
  );
}
