import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { CategoryRemoval } from "@/components/CategoryRemoval";
import { getCategoryBySlug, listEntriesInCategory } from "@/lib/categories";
import { requireSession } from "@/lib/session";

/**
 * Everything filed under one category (E11-T8, `YEO-78`), at
 * `/wiki/category/[slug]`.
 *
 * The second axis of navigation this ticket exists to add: the tree answers
 * "who is related to whom" and search answers "where does this word appear",
 * and neither answers "everyone who emigrated". This page is that answer.
 *
 * Structurally a copy of the entry read route two directories away, and
 * deliberately so: the same `force-dynamic`, the same session-inside-the-
 * loader rule, the same written-out prop type, the same `notFound()` on a slug
 * no row holds.
 */
export const dynamic = "force-dynamic";

/**
 * Written out rather than using the generated
 * `PageProps<"/wiki/category/[slug]">` helper, for the reason the entry route
 * gives: Next only generates it during `next dev`, `next build` or
 * `next typegen`, and CI runs `npm run typecheck` on a fresh checkout *before*
 * `npm run build` — so at that point `.next/types` does not exist and the
 * global is not defined.
 */
type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * The category and its entries, loaded once per request.
 *
 * Next calls into this module twice for a single render — once for
 * `generateMetadata`, once for the page — and React's `cache` collapses that
 * into one session check and one pair of queries.
 *
 * `requireSession()` lives *inside* the loader rather than at the two call
 * sites, exactly as on the entry route and for exactly the reason stated
 * there: `lib/session.ts` is the only access boundary there is, and
 * `generateMetadata` is a second door onto the same rows. Guarding only the
 * page would leak a category's name — which is authored text about a family —
 * into the `<title>` of a response nobody had to sign in for.
 *
 * Both queries are here rather than one in each caller, so the page and the
 * metadata cannot disagree about whether the category exists.
 */
const loadCategory = cache(async (slug: string) => {
  await requireSession();

  const category = await getCategoryBySlug(slug);
  if (!category) return null;

  // Awaited after the category rather than beside it: this read is keyed by
  // `category.id`, so there is no query to start until the slug has resolved.
  return { category, entries: await listEntriesInCategory(category.id) };
});

export async function generateMetadata({
  params,
}: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const found = await loadCategory(slug);

  // Prefixed the way MediaWiki names its own category pages, so a tab holding
  // one is distinguishable at a glance from a tab holding the entry of the
  // same name. `robots: noindex` is inherited from the root layout, and Next
  // adds its own on a 404 response.
  return { title: found ? `Category: ${found.category.name}` : "Not found" };
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params;
  const found = await loadCategory(slug);

  /**
   * A category with no row, not a category with no entries. `notFound()`
   * throws, which stops the render, hands off to this segment's
   * `not-found.tsx` and — crucially — sets the response status to 404 rather
   * than serving a 200 with nothing in it.
   *
   * The empty *category* is a different state and is rendered below rather
   * than 404'd: it exists, somebody named it, and "nothing is filed here yet"
   * is a true and useful thing to say. Collapsing the two would make a
   * category the last entry was unfiled from indistinguishable from a typo in
   * the address.
   */
  if (!found) notFound();

  const { category, entries } = found;

  return (
    // The same column as the entry read route and the index: `max-w-content`
    // is Vector 2022's 46em measure, and the padding is the mobile half of it.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/* Serif, and carrying its own bottom rule, from globals.css. The
          "Category:" prefix is MediaWiki's and says what kind of page this is
          — without it the heading is indistinguishable from an entry's. */}
      <h1>Category: {category.name}</h1>

      {entries.length === 0 ? (
        <div className="wiki-body">
          <p>
            No entries are filed under this category. It stays here until
            somebody retires it, so a heading that was worth naming does not
            vanish the moment its last entry moves.
          </p>
          <p>
            <Link href="/wiki/category">See every category</Link>
          </p>
        </div>
      ) : (
        <>
          {/* The count and the reading of the list, in the tagline position —
              the same shape the entry index and the tree route both use. */}
          <p className="text-caption text-ink-muted">
            {entries.length === 1 ? "1 entry" : `${entries.length} entries`},
            alphabetically.
          </p>

          {/* Chrome, not prose, so it stays outside `.wiki-body` and keeps
              Tailwind preflight's stripped list markers — the rule under each
              row separates one entry from the next instead. `role="list"`
              restores what the styling takes away: preflight sets
              `list-style: none`, and Safari/VoiceOver drops a list's implicit
              semantics when it sees that, which matters here because being a
              browsable list is this page's entire job. */}
          <ul role="list" className="mt-4">
            {entries.map((entry) => (
              <li key={entry.slug} className="border-b border-rule-soft py-1.5">
                {/* `encodeURIComponent` rather than interpolating the slug
                    raw, as the entry index does: the column is `text`, so
                    nothing in the schema stops a slug holding a `?`, a `#` or
                    a space, and any of those would silently truncate or
                    re-point the href. */}
                <Link href={`/wiki/${encodeURIComponent(entry.slug)}`}>
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-6 text-note text-ink-muted">
        <Link href="/wiki/category">All categories</Link>
      </p>

      {/*
        Retiring the category (E11-T8). Last on the page and behind a rule,
        because it is the one control here that changes anything — and the
        sentence above it says what that change is, which is the whole
        confirmation. See `components/CategoryRemoval.tsx`.
      */}
      <CategoryRemoval slug={category.slug} entryCount={entries.length} />
    </main>
  );
}
