/**
 * Where everything under `/wiki` lives, as one function per address shape
 * (`YEO-128`).
 *
 * ## The rule this file exists to hold
 *
 * `pages.slug` and `categories.slug` are `text` columns with a unique
 * constraint and no format check — deliberately, and `YEO-132` is where that
 * was decided rather than merely observed; the argument is on `pages.slug` in
 * `db/schema.ts`. Nothing in the schema stops a slug holding
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
 * ## Two address shapes, not one
 *
 * `entryPath` and `categoryPath` build an **href** — a URL a reader follows.
 * `entryCachePath` and `categoryCachePath` build the **cache path** that
 * `revalidatePath` matches, which Next canonicalises by a different rule, so
 * for some slugs the two are not the same string. `YEO-131` is where that was
 * established, out of the runtime rather than out of memory; `cachePathOf`
 * carries the finding and the citations, and the table showing which
 * characters each spelling gets wrong.
 *
 * The names are near-twins on purpose. The mistake worth making impossible is
 * reaching for the href builder at a `revalidatePath`, and a reader who has
 * seen both names once will notice which one is under their cursor.
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
 * ## `YEO-132` settled that this stays true, and made it load-bearing
 *
 * The section above used to be an argument with an obvious rejoinder: *then
 * constrain the column*. `YEO-132` took that seriously, audited the deployed
 * database — 5 entry rows, 0 category rows, every one already conforming, and
 * an import ledger that has never run — and then found the constraint cannot
 * be written. PostgreSQL has no `\p{L}`; its nearest class, `[[:alnum:]]`,
 * refuses `½-acre-farm` and `henry-ⅷ`, which `slugFromTitle` mints from
 * ordinary titles, and how much else it refuses depends on the locale and ICU
 * build of the server evaluating it. The measurement is on `pages.slug`, and
 * `db/slug-format.db.test.ts` re-derives it against a real Postgres on every
 * CI run.
 *
 * So the columns stay permissive, and the consequence lands here. **These
 * four builders are not defence in depth. They are the defence.** There is no
 * second line behind them and there is not going to be one, so nothing in
 * this file is to be relaxed on the grounds that a slug "cannot" hold a `#`:
 * that guarantee lives in exactly one function, and this file is what holds
 * when a future writer does not route through it.
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

/**
 * The delimiters Next re-escapes when it canonicalises a concrete pathname,
 * and the percent-sequences that already spell one.
 *
 * A copy of the character class in Next's own
 * `shared/lib/router/utils/escape-path-delimiters` — `[/#?]`, plus `%2f`,
 * `%23`, `%3f` and `%5c` case-insensitively — reproduced rather than imported
 * for the reason the module docblock gives: nothing here imports, so this file
 * stays loadable from a Client Component. `lib/wiki-paths.cache-tags.test.ts`
 * is what keeps the copy honest; it runs the real Next functions against these
 * and fails if the rule moves.
 *
 * Note what is *not* here: a space, a literal backslash, `[`, `]`, `&`, `=`,
 * `+`, `:`, `@`, `%` on its own, and every non-ASCII character. Next leaves
 * all of those decoded in the cache key, which is exactly why
 * `encodeURIComponent` is the wrong function for this job.
 */
const CACHE_PATH_DELIMITERS = /[/#?]|%(?:2f|23|3f|5c)/gi;

/**
 * One segment, in the form Next stores it in a cache tag.
 *
 * @param segment a slug or literal segment, as stored — not pre-encoded
 */
function cacheSegment(segment: string): string {
  return segment.replace(CACHE_PATH_DELIMITERS, (delimiter) =>
    encodeURIComponent(delimiter),
  );
}

/**
 * A cache path, from a prefix and the segments below it.
 *
 * ## Why this is not `pathOf`
 *
 * `revalidatePath` does not take a URL. It takes the string Next uses to build
 * an *implicit cache tag*, and the two are canonicalised differently — so the
 * address a reader follows and the address that invalidates it are, for some
 * slugs, not the same string. That is the question `YEO-131` was opened to
 * settle, and the answer is neither of the two on offer.
 *
 * ## What the runtime actually does (Next 16.3.2, read, not remembered)
 *
 * Both sides of the match are in `node_modules`:
 *
 *   - **Invalidating.** `server/web/spec-extension/revalidate.js` builds
 *     `` `${NEXT_CACHE_IMPLICIT_TAG_ID}${encodeHeaderSafe(removeTrailingSlash(path))}` ``
 *     — the argument, near enough verbatim. `encodeHeaderSafe`
 *     (`server/lib/encode-header-safe.js`) only escapes what will not survive
 *     an HTTP header, i.e. anything outside `\t\x20-\x7e`; `#`, `?`, `/` and a
 *     space all pass through byte-for-byte.
 *   - **Rendering.** `server/route-modules/route-module.js` resolves the
 *     request to `interpolateDynamicPath` (which `encodeURIComponent`s each
 *     param) and then hands it to `decodePathParams`, under the comment "we
 *     decode for cache key/manifest usage encoded is for URL building".
 *     `decodePathParams` decodes each segment and re-escapes the *path
 *     delimiters* only. `server/lib/implicit-tags.js` tags the result.
 *
 * So the cache key is the pathname **decoded, except for `/`, `#`, `?` and
 * `\`**. Which makes both obvious answers wrong, in opposite directions:
 *
 * | slug          | cache tag Next writes  | `` `/wiki/${slug}` `` | `entryPath(slug)` |
 * | ------------- | ---------------------- | --------------------- | ----------------- |
 * | `rose-hall`   | `/wiki/rose-hall`      | matches               | matches           |
 * | `rose hall`   | `/wiki/rose hall`      | matches               | **`%20`, misses** |
 * | `rose#hall`   | `/wiki/rose%23hall`    | **misses**            | matches           |
 * | `rose?hall`   | `/wiki/rose%3Fhall`    | **misses**            | matches           |
 * | `rose/hall`   | `/wiki/rose%2Fhall`    | **misses**            | matches           |
 * | `北京`        | `/wiki/%E5%8C%97…`     | matches               | matches           |
 *
 * The nine raw calls `YEO-131` was filed about were therefore genuinely wrong
 * for a `#`, a `?` or a `/` — a retire or an edit would leave the page serving
 * stale content, silently, which is the failure the ticket suspected. But the
 * fix it proposed, routing them through `entryPath`, would have broken a slug
 * containing a space, and with it every other character `encodeURIComponent`
 * escapes and Next does not. Over printable ASCII that is twenty-one
 * characters — the space, and
 *
 * ```text
 * " $ % & + , : ; < = > @ [ \ ] ^ ` { | }
 * ```
 *
 * Swapping three silent misses for twenty-one is not a fix, and "leave them
 * raw" is not one either.
 *
 * That list is not typed out from memory, and an earlier draft of this
 * docblock got it wrong by omitting `[`, `]` and the backslash.
 * `lib/wiki-paths.cache-tags.test.ts` derives the same set from Next's own
 * `escapePathDelimiters` and asserts it character for character, so the
 * paragraph above is checked rather than believed.
 *
 * ## Why a helper rather than a comment
 *
 * The same argument the module docblock makes about hrefs, and it is stronger
 * here rather than weaker: this rule is *less* guessable than
 * `encodeURIComponent`, so leaving it to each author to remember is leaving it
 * to nobody. One function, one place, and
 * `lib/wiki-paths.cache-tags.test.ts` binds it to what the runtime does rather
 * than to what this docblock claims.
 *
 * ## What this is not for
 *
 * Route *patterns*. `revalidatePath("/wiki/[slug]", "page")` names a route
 * file and takes no slug, so there is nothing to canonicalise and nothing here
 * to call; `app/wiki/actions.ts` passes those as the literals they are.
 */
function cachePathOf(prefix: string, segments: readonly string[]): string {
  return prefix + segments.map(cacheSegment).join("/");
}

/**
 * The address of an entry, or of a page below it, as `revalidatePath` matches
 * it.
 *
 * The cache-invalidation twin of `entryPath`, and deliberately a separate
 * function rather than a flag on that one: a reader who sees `entryPath` in an
 * `href` and `entryCachePath` in a `revalidatePath` can tell at a glance that
 * the two are answering different questions. See `cachePathOf` for what the
 * difference is and why it exists.
 *
 * ```ts
 * entryCachePath("rose hall");                    // /wiki/rose hall
 * entryCachePath("rose#hall");                    // /wiki/rose%23hall
 * entryCachePath("rose-hall", "history");         // /wiki/rose-hall/history
 * ```
 *
 * @param slug the entry's `pages.slug`, as stored — not pre-encoded
 * @param below the route segments beneath it, in order
 * @returns the path to hand `revalidatePath`, with no `type` argument
 */
export function entryCachePath(
  slug: string,
  ...below: readonly string[]
): string {
  return cachePathOf(ENTRY_PATH_PREFIX, [slug, ...below]);
}

/**
 * The address of one category's listing, as `revalidatePath` matches it.
 *
 * Separate from `entryCachePath` for the reason `categoryPath` is separate
 * from `entryPath`: a category is not an entry, and the spelling should not
 * suggest it is.
 *
 * @param slug the category's `categories.slug`, as stored — not pre-encoded
 * @returns the path to hand `revalidatePath`, with no `type` argument
 */
export function categoryCachePath(slug: string): string {
  return cachePathOf(CATEGORY_PATH_PREFIX, [slug]);
}
