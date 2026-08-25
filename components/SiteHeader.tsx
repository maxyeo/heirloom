import Link from "next/link";

import { AccountMenu } from "@/components/AccountMenu";
import { SearchBox } from "@/components/SearchBox";
import { SidebarToggle } from "@/components/SidebarToggle";
import { siteName } from "@/lib/site";

/**
 * The sticky top bar: hamburger, wordmark, search slot, account menu — the
 * four things the E11 reference mockup puts in that order.
 *
 * It is `sticky`, not `fixed`, so it occupies a row of the page rather than
 * floating over one. That is what makes `--header-height` the only number the
 * rest of the shell needs in order to know where the viewport starts, and it
 * is why nothing below has to be padded down past an invisible bar.
 *
 * One `--header-height` (3rem) tall on every screen. The ticket asks that the
 * header not eat the viewport on a phone, and the way to honour that is not to
 * hide it below a breakpoint but to keep it short enough that hiding it never
 * comes up: 48px of a 667px screen is 7%, and it buys a hamburger and a way
 * out on every page.
 */
export function SiteHeader({
  sidebarId,
  viewerName,
  viewerEmail,
  signOutAction,
}: {
  sidebarId: string;
  viewerName: string | null;
  viewerEmail: string | null;
  signOutAction: () => Promise<void>;
}) {
  const name = siteName();

  return (
    <header className="sticky top-0 z-40 flex h-(--header-height) items-center gap-2 border-b border-wash bg-paper px-2 sm:gap-3 sm:px-3">
      <SidebarToggle controls={sidebarId} />

      {/* Serif over sans, the way the masthead of a Wikipedia page is set. The
          hover underline that globals.css gives every link would run under both
          lines of a stacked wordmark, so it is turned off here. */}
      <Link
        href="/"
        className="flex shrink-0 flex-col leading-tight text-ink hover:no-underline"
      >
        <span className="font-serif text-h3">{name}</span>
        <span className="hidden text-note text-ink-muted sm:block">
          the family wiki
        </span>
      </Link>

      {/*
        The search slot, and the end of a three-step arc worth recording
        because each step was right at the time.

        It was an inert `aria-hidden` box while `/search` did not exist, on
        the reasoning that a control which looks like search and does nothing
        is a worse promise than one that is not announced at all. E8-T2
        (`YEO-56`) built the page, so the same reasoning pointed the other way
        and it became a link. E8-T3 (`YEO-57`) built the endpoint behind it
        (`app/api/search/route.ts`), so it is now the real box: one input over
        both people and entries, suggestions grouped underneath, ⌘K or `/`
        from anywhere.

        Nothing was given up in the exchange. `SearchBox` is a `next/form`
        wrapped around a real `<input name="q">`, so with JavaScript off — or
        in the moment before hydration — typing and pressing Enter still lands
        on `/search?q=…`, which is exactly what the link did. The proportions
        are the ones the shell was designed with either way: `SearchBox` owns
        the same `min-w-0 flex-1 sm:max-w-96` this slot always had.

        `SiteHeader` itself stays a Server Component; `SearchBox` is the
        client boundary, the same arrangement `RoutedArticleTabs` uses.
      */}
      <SearchBox siteName={name} />

      <AccountMenu
        name={viewerName}
        email={viewerEmail}
        signOutAction={signOutAction}
      />
    </header>
  );
}
