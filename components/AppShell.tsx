import { SidebarScrim } from "@/components/SidebarScrim";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteSidebar } from "@/components/SiteSidebar";
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
 *   `SiteSidebar`'s `children`.
 * - **E11-T7 (`YEO-77`)** — the Article / Read / Edit / View history tabs,
 *   into the top of the content region.
 *
 * The session is passed in rather than read here: `components/` stays clear of
 * `@/auth` so its files can be mounted in a suite with no `AUTH_*`. The
 * server component that does the reading is `app/site-chrome.tsx`.
 */

/** The `<nav>` the header's hamburger points its `aria-controls` at. */
const SIDEBAR_ID = "site-sidebar";

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
      <script dangerouslySetInnerHTML={{ __html: sidebarBootScript }} />

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
          {/* E11-T3 (`YEO-73`) renders the article's contents list here. */}
        </SiteSidebar>

        {/* Present at every width; painted only while the sidebar is a drawer. */}
        <SidebarScrim />

        <div className="min-w-0 flex-1">
          {/* E11-T7 (`YEO-77`) puts the article tab row here, above the
              content column and below the header — which is where the mockup
              has it, and why this is a wrapper rather than `{children}` on its
              own. */}
          {children}
        </div>
      </div>
    </>
  );
}
