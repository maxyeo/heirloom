import Link from "next/link";

import type { NamedCategory } from "@/lib/category-name";

/**
 * The bar at the foot of an article saying what it belongs to (E11-T8,
 * `YEO-78`).
 *
 * MediaWiki's `.catlinks` box, which is one of the few pieces of Wikipedia
 * furniture a reader will look for by shape rather than by reading it: a
 * bordered strip under the last paragraph, the word "Categories", a colon, and
 * the headings separated by pipes.
 *
 * ## Nothing at all for an entry with no categories
 *
 * Not an empty box, not a box saying "Uncategorised" — the element does not
 * exist. That is the ticket's own acceptance criterion, and it is the right
 * one: most entries in a young wiki have no categories, and a strip of empty
 * furniture at the foot of every one of them would be the most visible thing
 * this feature added. Returning `null` also means no margin, so the article
 * ends where its prose ends.
 *
 * ## Why the links are never red
 *
 * `lib/red-links.ts` resolves the links an *author* typed, which can name an
 * entry that does not exist. These are not authored: each one is a row that
 * was read from `categories` a moment ago, so every address it points at
 * answers by construction. There is nothing to resolve and no second query to
 * make.
 *
 * ## Why it is a Server Component
 *
 * There is no state and no event handler here. It takes rows and returns
 * markup, so it stays out of the browser bundle entirely — and its test
 * mounts it with `@/test/render` anyway, because the decision worth asserting
 * (render nothing, or render a bar) is one a DOM can be asked about directly.
 */
export interface ArticleCategoriesProps {
  /**
   * What this entry is filed under, already in the order it should be read —
   * `readEntryCategories` sorts, because "alphabetical" is a question about
   * language and `lib/category-name.ts` owns the answer.
   */
  categories: readonly NamedCategory[];
}

export function ArticleCategories({ categories }: ArticleCategoriesProps) {
  if (categories.length === 0) return null;

  return (
    /**
     * `clear-both` on the bar itself, not only on the `<article>` around it.
     * The infobox floats (E11-T5), and the clearfix the article carries is an
     * `::after` pseudo-element — which comes *after* this bar in the box
     * order. Without this, a short entry about a person with a long family
     * renders its category strip wrapped around the still-floating box rather
     * than beneath it.
     */
    <nav
      // Named, because it is a landmark: a reader jumping by landmark gets
      // "Categories" rather than a second unlabelled navigation region beside
      // the sidebar's.
      aria-labelledby="article-categories-label"
      className="mt-8 clear-both rounded-panel border border-rule bg-panel px-3 py-2 text-caption"
    >
      <span id="article-categories-label" className="font-medium">
        {/* Wikipedia's own singular, which reads as written English rather
            than as a template that could not be bothered. */}
        {categories.length === 1 ? "Category" : "Categories"}:{" "}
      </span>

      {/* `inline` so the label and the list sit on one line and wrap together
          as one paragraph would, which is what makes this a bar rather than a
          heading above a list. */}
      <ul className="inline">
        {categories.map((category, index) => (
          <li key={category.slug} className="inline">
            {index === 0 ? null : (
              // The separator is decoration: a screen reader is already told
              // this is a list of three items and does not need "pipe" read
              // out between each of them.
              <span aria-hidden="true" className="text-ink-muted">
                {" | "}
              </span>
            )}
            {/* `encodeURIComponent` rather than interpolating the slug raw,
                as the entry index does: the column is `text`, so nothing in
                the schema stops a slug holding a `?`, a `#` or a space, and
                any of those would silently truncate or re-point the href. It
                encodes `/` too, which is correct — a slug is one segment. */}
            <Link href={`/wiki/category/${encodeURIComponent(category.slug)}`}>
              {category.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
