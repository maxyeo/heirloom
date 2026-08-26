/**
 * The bar at the foot of an *old* revision saying what the entry was filed
 * under at the time (`YEO-106`).
 *
 * ## Why this is not `ArticleCategories`
 *
 * Because that component links, and these must not. Its own docblock says why
 * its links are safe — "each one is a row that was read from `categories` a
 * moment ago, so every address it points at answers by construction" — and a
 * revision is precisely the case where that stops being true. A revision holds
 * category *names*, not ids, exactly so that retiring a category cannot edit
 * history (`db/schema.ts`); the price of that is that a name in an old
 * revision may name a category that no longer exists, and `/wiki/category/…`
 * would 404. Linking anyway would produce the one thing `lib/red-links.ts`
 * exists to keep out of furniture nobody authored: a dead link the reader is
 * invited to click.
 *
 * Passing a `link` flag into `ArticleCategories` instead was the alternative,
 * and it is worse for the same reason the two components look alike: the shape
 * is shared, the decision is not. One component holding both answers would put
 * the question "can these addresses be trusted" at every call site, and it is
 * a question about *which table the rows came from* — settled here, once, by
 * which component the route imports.
 *
 * ## Why it renders at all when the filing is empty
 *
 * It does not — `null`, like the article bar, and for the same reason: most
 * entries are filed under nothing and a strip of empty furniture at the foot
 * of every revision of them would be the most visible thing this change added.
 *
 * ## Why it is a Server Component
 *
 * No state and no event handler: it takes strings and returns markup, so it
 * stays out of the browser bundle. Its test mounts it anyway, because "renders
 * nothing, or renders a bar" is a question about a document.
 */
export interface RevisionCategoriesProps {
  /**
   * The names the entry was filed under at this revision, as
   * `revisions.categories` stores them.
   *
   * Sorted for display by the caller rather than here, because "alphabetical"
   * is a question about language and `lib/category-name.ts` owns the answer —
   * the column's own order is slug order, which is canonical for storage and
   * not meant for a reader. See `compareCategoriesBySlug`.
   */
  categories: readonly string[];
}

export function RevisionCategories({ categories }: RevisionCategoriesProps) {
  if (categories.length === 0) return null;

  return (
    /**
     * The article bar's classes minus its `clear-both`, which that component
     * needs because it sits under a floating infobox and this one does not:
     * the revision route renders no infobox at all.
     */
    <nav
      // A landmark, named — a reader jumping by landmark gets "Categories at
      // this revision" rather than a second unlabelled region, and the name
      // says *when* rather than just what, which is the whole point of the
      // page it sits on.
      aria-labelledby="revision-categories-label"
      className="mt-8 rounded-panel border border-rule-soft bg-panel px-3 py-2 text-caption"
    >
      <span id="revision-categories-label" className="font-medium">
        {/* Wikipedia's own singular, which reads as written English rather
            than as a template that could not be bothered. */}
        {categories.length === 1 ? "Category" : "Categories"} at this
        revision:{" "}
      </span>

      {/* `inline` so the label and the list sit on one line and wrap together
          as one paragraph would, which is what makes this a bar rather than a
          heading above a list. */}
      <ul className="inline">
        {categories.map((name, index) => (
          <li
            // The name is the identity here: `revisions.categories` is
            // de-duplicated by slug before it is written
            // (`normaliseEntryCategories`), so two entries in this list cannot
            // be the same category — and unlike the article bar there is no
            // slug to key on.
            key={name}
            className="inline"
          >
            {index === 0 ? null : (
              // Decoration: a screen reader is already told this is a list of
              // three items and does not need "pipe" read out between each.
              <span aria-hidden="true" className="text-ink-muted">
                {" | "}
              </span>
            )}
            {name}
          </li>
        ))}
      </ul>
    </nav>
  );
}
