/**
 * Where everything under `/wiki` lives, as one function per address shape
 * (`YEO-128`).
 *
 * ## The rule this file exists to hold
 *
 * `pages.slug` and `categories.slug` are `text` columns with a unique
 * constraint and no format check. Nothing in the schema stops a slug holding
 * a `?`, a `#` or a space, and each of those breaks an interpolated href in
 * its own quiet way: `#` truncates the path and turns the rest into a
 * fragment, `?` turns it into a query string, and a space is not a character
 * a URL may carry unescaped at all. No error, no 404 — a link that goes
 * somewhere else.
 *
 * So every address is built with `encodeURIComponent`, which also encodes `/`
 * — correct, because a slug is one path segment. Non-Latin slugs are the
 * normal case here rather than a corner (`lib/entry-slug.ts`), and they
 * percent-encode and decode back losslessly.
 *
 * ## Why a module and not a fourth comment
 *
 * That paragraph used to be written out seven times — at `app/wiki/page.tsx`,
 * `app/wiki/category/page.tsx`, `app/wiki/category/[slug]/page.tsx`,
 * `components/ArticleCategories.tsx`, `components/RecentChangesList.tsx`,
 * `lib/entry-search.ts` and `entryHref` in `lib/entry-links.ts` — and
 * seventeen hrefs under
 * `app/wiki/[slug]/` hand-applied it: nine correctly and eight not. All eight
 * were on the history routes, several of them within twenty lines of an
 * encoded one in the same file, and no comment anywhere argued that those
 * particular links were exempt. They were not a decision, they were drift —
 * which is what a rule restated in prose and applied by hand decays into.
 *
 * A rule with one implementation cannot drift. `lib/live-pages.ts` is the
 * same move for `deleted_at` and makes the same argument
 * (docs/architecture.md, "Twelve readers, three right answers, and a
 * tripwire"): the guarantee has to come from the code that writes the query,
 * not from every author remembering the column exists.
 *
 * `lib/wiki-paths.call-sites.test.ts` is the tripwire that keeps it that way,
 * so a ninth raw href fails the suite rather than waiting for the next
 * reviewer to notice.
 *
 * ## Why the schema is the argument, not the write path
 *
 * `lib/create-page.ts` derives slugs by slugifying, so no live row is likely
 * to hold a `?` today. That is a property of one write path rather than of
 * the column, and §3 of `YEO-122` already refused that reasoning once for
 * `deleted_at`: a GEDCOM import stub, a hand-run `INSERT` or a future
 * slug-editing surface can each put one there, and none of them would think
 * to come looking here. Encoding costs nothing on a slug that needed none.
 *
 * ## Nothing is imported
 *
 * String arithmetic over plain values, no `@/db`, no React. That keeps this
 * importable from a Server Component, a Client Component and a `"use server"`
 * module alike, and keeps postgres.js out of the import graph of any suite
 * that mounts a caller (docs/testing.md).
 */

/**
 * The path every entry lives under.
 *
 * Exported because `entrySlugFromHref` in `lib/entry-links.ts` reads these
 * addresses back and has to agree with `entryPath` about the prefix, or a
 * link this module writes is a link that one cannot recognise. One constant
 * rather than two string literals is the same reason that file gave when it
 * owned the constant itself.
 */
export const ENTRY_PATH_PREFIX = "/wiki/";

/**
 * The path every category lives under.
 *
 * `category` is a reserved slug (`lib/entry-slug.ts`), which is what keeps
 * this from colliding with `ENTRY_PATH_PREFIX` — no entry can be addressed at
 * `/wiki/category`, so the two namespaces cannot overlap.
 */
const CATEGORY_PATH_PREFIX = "/wiki/category/";

/**
 * A path, from a prefix and the segments below it.
 *
 * **Every** segment is encoded, not just the slug. The literal ones
 * (`"history"`, `"edit"`, `"restore"`) and the uuid ones (`revisions.id`) come
 * back unchanged, so uniformity is free — and it is worth more than the
 * bytes it saves, because a helper with a rule about *which* argument is the
 * dangerous one is a helper with a rule to get wrong. There is nothing to get
 * wrong here.
 *
 * A consequence worth stating: a caller cannot smuggle a query string or a
 * fragment through as a segment, because `?` and `#` are exactly what this
 * escapes. Nothing under `/wiki` needs one today; a route that grows one
 * should take it as its own parameter rather than reaching around this.
 */
function pathOf(prefix: string, segments: readonly string[]): string {
  return prefix + segments.map(encodeURIComponent).join("/");
}

/**
 * The address of an entry, or of a page below it.
 *
 * Site-relative, always: no origin, no scheme, no host. `lib/entry-links.ts`
 * carries the argument for that at length — bodies are stored HTML that
 * outlives the domain they were written on, so an absolute href is a link
 * that breaks the day the wiki moves, and breaks silently.
 *
 * ```ts
 * entryPath("rose hall");                              // /wiki/rose%20hall
 * entryPath("rose-hall", "history");                   // /wiki/rose-hall/history
 * entryPath("rose-hall", "history", id, "restore");    // …/history/<id>/restore
 * ```
 *
 * @param slug the entry's `pages.slug`, as stored — not pre-encoded
 * @param below the route segments beneath it, in order
 * @returns a site-relative path, e.g. `/wiki/rose-hall/history`
 */
export function entryPath(slug: string, ...below: readonly string[]): string {
  return pathOf(ENTRY_PATH_PREFIX, [slug, ...below]);
}

/**
 * The address of one category's listing.
 *
 * Separate from `entryPath` rather than spelled `entryPath("category", slug)`,
 * which would produce the same string and say the wrong thing: `category` is
 * not an entry, and a reader who believed that spelling would go looking for
 * a `pages` row that does not exist.
 *
 * @param slug the category's `categories.slug`, as stored — not pre-encoded
 * @returns a site-relative path, e.g. `/wiki/category/houses`
 */
export function categoryPath(slug: string): string {
  return pathOf(CATEGORY_PATH_PREFIX, [slug]);
}
