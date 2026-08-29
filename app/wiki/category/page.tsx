import type { Metadata } from "next";
import Link from "next/link";

import { listCategories } from "@/lib/categories";
import { requireSession } from "@/lib/session";
import { categoryPath } from "@/lib/wiki-paths";

/**
 * Every category there is (E11-T8, `YEO-78`), at `/wiki/category`.
 *
 * ## Why this exists when the ticket did not ask for it
 *
 * Because without it the address 404s, and it is an address readers will
 * type. The footer bar at the foot of every filed entry teaches the shape
 * `/wiki/category/<something>`, and trimming the last segment of a URL to see
 * "what else is here" is the oldest navigation habit the web has. A 404 there
 * would be this feature's most findable dead end.
 *
 * It also gives the label on the bar somewhere to point, which is what
 * Wikipedia does with its own "Categories:" — and it is where the picker's
 * inline creations become visible to somebody who was not the author.
 *
 * ## What it deliberately is not
 *
 * Not a sidebar item. `lib/site-nav.ts` holds the five places the shell
 * offers — the four off the mockup E11-T2 was built from, plus "New entry",
 * which the mockup does not draw — pinned by `lib/site-nav.test.ts`, and
 * giving categories a sixth is a change to the skin rather than to this
 * feature. Categories are reached from the entries that use them, which is
 * the same way Wikipedia reaches them.
 *
 * Reads a session cookie and the `categories` table, so there is nothing to
 * prerender — stated explicitly, the way every other database-backed route
 * here does, rather than left to be inferred from the first request-time API
 * this happens to touch.
 */
export const dynamic = "force-dynamic";

/**
 * Static, unlike the sibling `[slug]` route's `generateMetadata`: this title is
 * the same on every request, so there is no reason to make Next call a
 * function — and no reason for that function to open a second, unguarded door
 * onto the data, which is the risk the `[slug]` route documents.
 * `robots: noindex` is inherited from the root layout.
 */
export const metadata: Metadata = {
  title: "All categories",
};

export default async function CategoryIndexPage() {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  await requireSession();

  const categories = await listCategories();

  return (
    // The same column as every other page under `/wiki`.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/* Serif, and carrying its own bottom rule, from globals.css. */}
      <h1>All categories</h1>

      {categories.length === 0 ? (
        /**
         * The state this install starts in, and stays in until somebody files
         * something — so it gets an explanation of what a category is *for*
         * rather than "0 results". There is no "create one" link, because
         * there is no such page: a category is created by filing an entry
         * under it, which happens in the editor.
         */
        <div className="wiki-body">
          <p>
            No categories yet. A category is a heading entries can be filed
            under — &ldquo;Emigrated to Canada&rdquo;, &ldquo;Buried at St
            Mary&rsquo;s&rdquo; — and it gathers people the family tree does not
            connect.
          </p>
          <p>
            You make one by filing an entry under it: open an entry, choose{" "}
            <strong>Edit</strong>, and type a name into the categories field at
            the foot of the editor.
          </p>
        </div>
      ) : (
        <>
          {/* The count and the reading of the list, in the tagline position —
              the same shape the entry index uses. */}
          <p className="text-caption text-ink-muted">
            {categories.length === 1
              ? "1 category"
              : `${categories.length} categories`}
            , alphabetically.
          </p>

          {/* Chrome rather than prose, so it stays outside `.wiki-body`.
              `role="list"` restores the semantics Tailwind preflight's
              `list-style: none` costs under Safari/VoiceOver — see the same
              note on the entry index. */}
          <ul role="list" className="mt-4">
            {categories.map((category) => (
              <li
                key={category.slug}
                className="border-b border-rule-soft py-1.5"
              >
                <Link href={categoryPath(category.slug)}>{category.name}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
