import Link from "next/link";

import { SiteChrome } from "@/app/site-chrome";
import { ArticleHeading } from "@/components/ArticleHeading";
import { siteName } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function Home() {
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
      </main>
    </SiteChrome>
  );
}
