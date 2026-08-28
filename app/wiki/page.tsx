import type { Metadata } from "next";
import Link from "next/link";

import { formatUpdatedAt } from "@/lib/page-index";
import { listPages } from "@/lib/pages";
import { requireSession } from "@/lib/session";

/**
 * Reads a session cookie and the `pages` table, so there is nothing to
 * prerender. Stated explicitly, the way the other database-backed routes do,
 * rather than left to be inferred from the first request-time API this
 * happens to touch.
 */
export const dynamic = "force-dynamic";

/**
 * Static, unlike the sibling read route's `generateMetadata`: this title is
 * the same on every request, so there is no reason to make Next call a
 * function — and no reason for that function to open a second, unguarded door
 * onto the data, which is the risk `app/wiki/[slug]/page.tsx` documents.
 * `robots: noindex` is inherited from the root layout.
 */
export const metadata: Metadata = {
  title: "All entries",
};

export default async function WikiIndexPage() {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  await requireSession();

  const entries = await listPages();

  return (
    // The same column as the read route: `max-w-content` is Vector 2022's 46em
    // measure, and the padding is the mobile half of it.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/* Serif, and carrying its own bottom rule, from globals.css. */}
      <h1>All entries</h1>

      {entries.length === 0 ? (
        /**
         * A wiki with no entries is the state this install actually starts in,
         * so it gets a first-run invitation rather than "0 results". The link
         * goes to the create-page flow (E1-T8), addressed by path rather than
         * by importing anything from it — it was a sibling ticket when this
         * was written, and there is still nothing worth importing.
         *
         * `lib/site-nav.ts` now offers "New entry" from the sidebar too, so on
         * a wide screen this page shows two doors to the same form. Kept
         * anyway, because the sidebar is not a reliable second door: below
         * 55rem `globals.css` gives it `display: none` until the hamburger
         * opens it, and a reader who has closed it sees nothing at any width.
         * The one screen whose entire job is to ask for a first entry should
         * not be asking from inside a drawer.
         */
        <div className="wiki-body">
          <p>
            There are no entries yet. A family wiki starts the way every other
            one does — with somebody writing the first page.
          </p>
          <p>
            <Link href="/wiki/new">Create the first entry</Link>
          </p>
        </div>
      ) : (
        <>
          {/* The count and the reading of the list, in the tagline position —
              the same shape as the tree route's "N people · M unions". */}
          <p className="text-caption text-ink-muted">
            {entries.length === 1 ? "1 entry" : `${entries.length} entries`},
            alphabetically, with the date each last changed.
          </p>

          {/* Chrome, not prose, so it stays outside `.wiki-body` and keeps
              Tailwind preflight's stripped list markers. The rule under each
              row is what separates one entry from the next instead. */}
          {/* `role="list"` restores what the styling takes away. Preflight
              sets `list-style: none`, and Safari/VoiceOver drops a list's
              implicit semantics when it sees that — so without this a screen
              reader announces a run of links rather than "list, 24 items".
              Spelled out here and not on the app's other bullet lists because
              this is the one whose entire job is being a browsable list. */}
          <ul role="list" className="mt-4">
            {entries.map((entry) => (
              <li
                key={entry.slug}
                className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-rule-soft py-1.5"
              >
                {/* `encodeURIComponent` rather than interpolating the slug
                    raw: the column is `text`, so nothing in the schema stops a
                    slug holding a `?`, a `#` or a space, and any of those
                    would silently truncate or re-point the href. It encodes
                    `/` too, which is correct — a slug is one path segment. */}
                <Link href={`/wiki/${encodeURIComponent(entry.slug)}`}>
                  {entry.title}
                </Link>

                <time
                  // The machine-readable half: the exact instant, where
                  // `formatUpdatedAt` deliberately renders only the UTC date.
                  dateTime={entry.updatedAt.toISOString()}
                  className="text-note text-ink-muted"
                >
                  {/* Sighted readers get the column position and the tagline
                      above to tell them what this date is. A screen reader
                      gets neither, and would otherwise read a title followed
                      by a bare date, so the label is said out loud for it. */}
                  <span className="sr-only">Last changed </span>
                  {formatUpdatedAt(entry.updatedAt)}
                </time>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
