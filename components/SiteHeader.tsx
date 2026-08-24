import Link from "next/link";

import { AccountMenu } from "@/components/AccountMenu";
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
        The search slot. **E8-T3** replaces this element with the real search
        box; it is here now so that the header's proportions are the ones the
        shell was designed with rather than something that shifts when search
        lands.

        Inert and `aria-hidden`: a box that looks like search and does nothing
        is a worse promise to a screen reader than one that is not announced at
        all. It is not focusable, so nothing lands on it by tabbing either.
      */}
      <div
        aria-hidden="true"
        className="min-w-0 flex-1 truncate rounded-panel border border-rule-soft px-2 py-1 text-caption text-ink-muted sm:max-w-96"
      >
        Search {name}
      </div>

      <AccountMenu
        name={viewerName}
        email={viewerEmail}
        signOutAction={signOutAction}
      />
    </header>
  );
}
