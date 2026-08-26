import Link from "next/link";

import { RecentChanges } from "@/app/recent-changes";
import { SiteChrome } from "@/app/site-chrome";
import { ArticleHeading } from "@/components/ArticleHeading";
import { requireSession } from "@/lib/session";
import { siteName } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function Home() {
  /*
    The only access boundary there is — no RLS underneath, one database role
    for everyone. See `lib/session.ts`.

    This call used to be defence in depth and nothing more. The page reached
    no database and named nobody, so `proxy.ts` turning an anonymous visitor
    away at the edge was already enough; the guard was here because "the proxy
    is the only thing standing in front of this route" is a sentence that
    should not be true of any route (docs/architecture.md: a route with
    nothing underneath it has nothing to fail safe). The matcher is one
    negative lookahead whose exemptions are prefixes rather than whole
    segments — `app/auth-boundary.test.ts` shows what that lets through.

    E8-T4 made it load-bearing. `<RecentChanges />` below reads `pages`,
    `individuals` and `gedcom_imports`, so this page now puts family names and
    signed-in email addresses on screen. The guard protects content rather
    than a principle — which is the argument for having written it before
    there was any content to protect, since nobody had to remember to add it
    on the commit that brought the data.
  */
  await requireSession();

  const title = siteName();

  return (
    /*
      The shell is applied here rather than in a layout because this page shares
      the root layout with `/signin`, which must not get chrome — see
      `app/site-chrome.tsx`. `/wiki` and `/tree` are segments of their own and
      get `layout.tsx` files instead.

      "Signed in as …" and the sign-out button used to live on this page. Both
      are in the header's account menu now, on every page rather than only on
      this one.
    */
    <SiteChrome>
      {/* `max-w-content` is Vector 2022's measure — see globals.css. The shell
          gives this column the region beside the sidebar; the centring and the
          measure stay with the page, which is what lets `/tree` be a full-bleed
          canvas inside the same shell. */}
      <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
        <ArticleHeading title={title} />

        {/*
          The home page is a heading and then a stack of sections, and this is
          the seam. Every section below is one self-contained component that
          fetches whatever it needs and renders its own `<h2>`, so adding
          another one is an import at the top of this file and a line here —
          no query threaded down from the route, no props to widen, and no
          section that has to know what another section reads.

          Browse stays first because it is navigation rather than content: it
          is how a reader reaches an entry whose address they do not know, and
          it must not move down the page as the page grows. New sections go
          *after* `<RecentChanges />`, in the order they should be read.

          E8-T5's "On this day" (`YEO-59`) is the next one, and it should be
          exactly this shape — an `app/on-this-day.tsx` awaiting its own `lib/`
          read and handing the rows to a plain synchronous component under
          `components/` that a test can mount. `app/recent-changes.tsx` says
          why the awaiting half lives in `app/` rather than beside the markup.
        */}
        <div className="wiki-body">
          <h2>Browse</h2>
          <ul>
            {/* First, and deliberately so. Until search exists (E8) the index
                is the only way to reach an entry whose address you do not
                already know, which is what makes it the fallback navigation
                rather than a page of its own. */}
            <li>
              <Link href="/wiki">All entries</Link> — everything written so far,
              alphabetically
            </li>
            <li>
              <Link href="/tree">Family tree</Link> — everyone, and how they
              connect
            </li>
          </ul>
        </div>

        <RecentChanges />
      </main>
    </SiteChrome>
  );
}
