import { slugFromTitle } from "@/lib/entry-slug";

/**
 * What a category name *is* (E11-T8, `YEO-78`), as plain functions over plain
 * strings.
 *
 * Kept apart from `lib/categories.ts` for the reason `lib/page-index.ts` is
 * kept apart from `lib/pages.ts`: that module imports `@/db`, so a comparator
 * or a normaliser defined there would drag postgres.js into a suite CI runs
 * with no `DATABASE_URL` (docs/testing.md names that exact trap). Everything
 * here is a pure function of a string, so all of it is checked by `npm test`
 * — which is the suite that gates the `check` job — and all of it is reachable
 * from the picker, which is a Client Component and must not touch the
 * database at all.
 *
 * The single rule underneath every function below: **a category is identified
 * by its slug, not by its name.** The name is display text an author typed;
 * the slug is what `categories.slug` holds, what `/wiki/category/[slug]`
 * addresses, and what decides whether two typed names mean one category.
 */

/**
 * The longest category name stored, in code points rather than UTF-16 units
 * so the cap means the same thing in every script.
 *
 * Not an arbitrary round number: `slugFromTitle` truncates the slug at
 * `MAX_SLUG_LENGTH` (80 code points), and the slug is the identity. Two names
 * that differ only past that point are already *the same category* — so a name
 * longer than the slug it derives to carries no distinguishing information,
 * only bar width. The extra twenty points are headroom for the punctuation and
 * spacing the slug collapses away, so an ordinary long name ("Emigrated to
 * Canada before the First World War") is never touched.
 *
 * Enforced by truncation rather than refusal, and that is a deliberate choice
 * about where the error surface is. The picker has no error line — it is a
 * field beside a Save button, and a name too long to store is not a mistake an
 * author can be told about after the fact in a way that helps. The field caps
 * what can be typed; this caps what a direct POST can store; and neither has
 * to invent a failure state for a label.
 */
export const MAX_CATEGORY_NAME_LENGTH = 100;

/**
 * How many categories one entry may carry.
 *
 * A bound rather than a policy. The footer bar is one line of furniture at the
 * foot of an article, and an entry filed under two hundred headings is not a
 * navigational aid — but the honest reason for the number is that
 * `savePageAction` is a POST anybody signed in can issue with any array in it,
 * and an unbounded list is an unbounded write inside the save transaction.
 *
 * Fifty is far past anything a family wiki produces (Wikipedia's own articles
 * average a handful), so the cap only ever bites a caller that is not the
 * picker. Excess names are dropped rather than refused, for the reason the
 * length cap gives above.
 */
export const MAX_CATEGORIES_PER_ENTRY = 50;

/**
 * The collator, built once — constructing an `Intl.Collator` is the expensive
 * part and comparing with it is not.
 *
 * Pinned to `en`, and `numeric` so a digit run compares as a number, exactly
 * as `lib/page-index.ts` does and for the same two reasons: a runtime default
 * would resolve out of the host's environment, so the same categories could
 * order one way on a laptop and another way in a serverless function; and
 * `ORDER BY name` in SQL would answer out of the *database's* collation, which
 * is not this application's to choose (a local `createdb` on macOS is
 * `C`-collated, Supabase's is `en_US.UTF-8`, and the two disagree about every
 * capital and every accent).
 */
const collator = new Intl.Collator("en", { numeric: true });

/**
 * A category as everything that renders one needs it: the label, and the
 * address it links to.
 *
 * Declared *here* rather than in `lib/categories.ts`, and that is the point.
 * That module imports `@/db`, so a component importing this type from it would
 * drag postgres.js into the browser bundle and into every suite that mounts
 * the component — the exact trap `lib/page-index.ts` documents for
 * `TitledEntry`, and the reason `docs/testing.md` insists on `import type` for
 * `FamilyGraph`. `CategoryPicker` and `ArticleCategories` both import it from
 * here; `lib/categories.ts` returns it, so there is still one shape.
 *
 * No `id`. The bar, the picker and both listing pages link by slug and none of
 * them writes, so the primary key would be a value in an RSC payload that
 * nothing on the other side can do anything with.
 */
export type NamedCategory = {
  name: string;
  slug: string;
};

/**
 * Order two categories the way a reader expects to meet them — in the footer
 * bar, in the picker's list, and on the listing page.
 *
 * @param a a category
 * @param b another category
 * @returns negative if `a` sorts first, positive if `b` does, 0 if neither
 */
export function compareCategoriesByName(a: NamedCategory, b: NamedCategory) {
  const byName = collator.compare(a.name, b.name);
  if (byName !== 0) return byName;

  // `name` is not unique in the schema — only `slug` is — so breaking the tie
  // on the slug is what makes this order *total*, and a list that does not
  // quietly reshuffle between two requests reading the same rows.
  return collator.compare(a.slug, b.slug);
}

/**
 * Order two categories the way a *revision* records them (`YEO-106`) — by
 * slug, by code point, and by nothing else.
 *
 * The deliberate opposite of {@link compareCategoriesByName} above, and the
 * contrast is the argument for both. That comparator answers a question about
 * *language* ("which of these does a reader meet first"), so it uses a
 * collator, and its answers are a property of the ICU data the process happens
 * to hold. This one answers a question about *storage* ("which of these does
 * the row list first"), where an answer that can vary by host is not an answer
 * at all: `revisions.categories` is compared to another revision's array by
 * equality — by `savePage`'s no-op rule, by the diff, by a restore — so the
 * same set of categories has to serialise the same way on a laptop, in a
 * serverless function, and in a migration written last year.
 *
 * Comparing with `<` rather than `localeCompare` is what makes that true:
 * it is code-unit order, defined by the language rather than by a locale, and
 * the slug is the right key for it because the slug is the identity
 * (`categorySlug`). Two categories cannot share one, so this order is total
 * with no tie-break.
 *
 * ## The one boundary worth naming
 *
 * "The same order everywhere" is a claim about this comparator, not about
 * every way two slugs have ever been ordered. JavaScript's `<` compares UTF-16
 * *code units*, so a slug holding a character outside the Basic Multilingual
 * Plane sorts by its surrogate pair — which is a different answer from the
 * code-*point* order Postgres's `COLLATE "C"` gives, and
 * `drizzle/0012_revision_categories.sql` backfills with exactly that. The two
 * agree for every slug made of BMP characters, which is every slug this wiki
 * has.
 *
 * Nothing downstream can be broken by the difference, and it is worth being
 * precise about why: every filing written after that migration is ordered by
 * this function, so two snapshots the no-op rule compares are always ordered
 * the same way as each other. The only place the seam is visible is a diff
 * between a backfilled revision and the one saved after it, for an entry filed
 * under two categories whose slugs differ first in a supplementary-plane
 * character — where the diff would report a re-ordering nobody performed.
 * `restoreWouldChangeNothing` (`lib/restore-preview.ts`) sidesteps it entirely
 * by comparing filings as sets, which is what a filing is.
 *
 * @param a a category
 * @param b another category
 * @returns negative if `a` sorts first, positive if `b` does, 0 if neither
 */
export function compareCategoriesBySlug(a: NamedCategory, b: NamedCategory) {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Any run of whitespace, including the newlines a paste can carry in. */
const WHITESPACE = /\s+/gu;

/**
 * The name as it will be stored: trimmed, with internal whitespace collapsed.
 *
 * Collapsing rather than only trimming is what stops `"Whitfield  family"` and
 * `"Whitfield family"` from being two labels for one category. They already
 * derive to one slug — `slugFromTitle` collapses every run of non-alphanumeric
 * characters — so without this the *identity* would agree while the two names
 * raced to be the one displayed, and which one won would depend on which entry
 * was saved first.
 *
 * Truncation is by code point rather than by index, so the cut cannot land in
 * the middle of a surrogate pair and leave half a character in the bar.
 *
 * @param name whatever was typed
 * @returns the storable form, possibly empty
 */
export function normaliseCategoryName(name: string): string {
  const collapsed = name.replace(WHITESPACE, " ").trim();

  const points = [...collapsed];
  if (points.length <= MAX_CATEGORY_NAME_LENGTH) return collapsed;

  // Trimmed again: the cap can fall immediately after a space.
  return points.slice(0, MAX_CATEGORY_NAME_LENGTH).join("").trim();
}

/** Does this string hold anything a slug could be built out of? */
const SLUGGABLE = /[\p{L}\p{N}]/u;

/**
 * The address a category lives at, and the key two typed names are compared
 * on — or `null` for a name that cannot have one.
 *
 * `slugFromTitle` rather than a derivation of this module's own, deliberately.
 * It is the function that already decides how a human string becomes an
 * address in this application — accents fold on Latin letters and nowhere
 * else, apostrophes are spelling marks rather than word boundaries
 * (`St Mary's` → `st-marys`), and every Unicode script survives. A second
 * derivation here would be a second set of answers to those questions, and the
 * first one to drift would do it silently.
 *
 * ## Why the `null`, when `slugFromTitle` is total
 *
 * Because its totality was bought for a different flow. `slugFromTitle` never
 * fails — a title made entirely of emoji or punctuation returns
 * `FALLBACK_SLUG`, `"entry"` — and `lib/entry-slug.ts` says exactly why: the
 * author of an *entry* is given no slug field, so there is no error to show
 * them and creation must succeed on whatever they typed. Collision handling
 * then turns the second such title into `entry-2`.
 *
 * A category has neither half of that. Its slug is a de-duplication key, so
 * there is no collision handling to fall back on — every unsluggable name
 * would land on `entry` and become *the same category*, silently merging
 * "🙂" with "…" with "!!!". And the picker is a field with a list under it,
 * so there is somewhere to say no. Refusing is therefore both possible and
 * correct here, where it is neither in the flow the fallback was written for.
 *
 * @param name the name, normalised or not
 * @returns the slug, or `null` when the name holds no letter or digit
 */
export function categorySlug(name: string): string | null {
  if (!SLUGGABLE.test(name)) return null;
  return slugFromTitle(name);
}

/**
 * The category list an entry will actually be saved with.
 *
 * Applies every rule above in one pass, so there is exactly one answer to
 * "what did the author's picker just ask for": names are normalised, empty
 * ones are dropped, duplicates *by slug* collapse to the first spelling
 * offered, and the result is capped.
 *
 * By slug, not by name, because that is what the unique index enforces one
 * row away — a list holding both "Whitfield family" and "Whitfield Family"
 * would otherwise reach `setEntryCategories` as two categories, resolve to one
 * row, and try to insert the same `page_categories` row twice inside the save
 * transaction.
 *
 * Order is preserved rather than sorted. Sorting is a *display* decision and
 * belongs where the display is (`compareCategoriesByName`, applied on the way
 * out of the database); what this preserves is the author's own order, which
 * is what decides whose spelling of a duplicate survives.
 *
 * @param names the names as submitted, in the order they were offered
 * @returns the names to file the entry under, at most
 *   {@link MAX_CATEGORIES_PER_ENTRY} of them
 */
export function normaliseEntryCategories(
  names: readonly string[],
): NamedCategory[] {
  const bySlug = new Map<string, NamedCategory>();

  for (const raw of names) {
    const name = normaliseCategoryName(raw);
    if (name === "") continue;

    // A name with no letter or digit in it has no address to live at, and
    // there is no fallback that would not merge every such name into one
    // category — see `categorySlug`. Dropped rather than stored.
    const slug = categorySlug(name);
    if (slug === null) continue;
    if (bySlug.has(slug)) continue;

    bySlug.set(slug, { name, slug });
    if (bySlug.size === MAX_CATEGORIES_PER_ENTRY) break;
  }

  return [...bySlug.values()];
}
