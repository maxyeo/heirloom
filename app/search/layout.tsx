import { SiteChrome } from "@/app/site-chrome";

/**
 * The site shell around `/search`, which until now had none.
 *
 * This is a fix as much as an addition. `SiteChrome` is applied by
 * `app/wiki/layout.tsx`, `app/tree/layout.tsx` and inline by `app/page.tsx`
 * — and never over `/search`, which has been a bare `<main>` since E8-T2
 * (`YEO-56`) created it. So following the header's own search control landed
 * the reader on a page with no header, no sidebar, no account menu and no way
 * back except the browser's.
 *
 * E8-T3 (`YEO-57`) cannot leave that alone, because the ticket asks that
 * search be reachable by keyboard shortcut *from anywhere* — and the search
 * results page is the one place a reader is most likely to want to retype a
 * query. The shortcut lives in `components/SearchBox.tsx`, which lives in the
 * header, which until this file was not on this route.
 *
 * A layout rather than an inline `<SiteChrome>` in the page: `/search` is a
 * segment of its own, so a layout is the consistent choice. `app/page.tsx`
 * wraps inline only because it shares the root layout with `/signin`, which
 * must not have the shell.
 */
export const dynamic = "force-dynamic";

export default function SearchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SiteChrome>{children}</SiteChrome>;
}
