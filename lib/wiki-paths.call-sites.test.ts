import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  read,
  routeFiles,
  sourceFiles,
  wikiPathExpressions,
} from "@/test/route-inventory";

/**
 * No module assembles a `/wiki/…` address by hand (`YEO-128`).
 *
 * `lib/wiki-paths.ts` is where the encoding argument lives and `entryPath` and
 * `categoryPath` are where it is applied; this is the tripwire that keeps them
 * the only place. It is the shape `lib/sanitize-html.call-sites.test.ts` and
 * `lib/pages.call-sites.test.ts` already use, for the reason all three share:
 * a rule stated in a comment is a rule applied by whoever read the comment.
 *
 * ## Why the rule is "not by hand" and not "with encodeURIComponent"
 *
 * The bug was eight hrefs on the history routes interpolating the slug raw.
 * The obvious guard is therefore "every interpolated slug is encoded" — and it
 * would have been the wrong one. Nine hrefs in the same directory *were*
 * encoded, correctly, by hand, and that guard would have passed all nine and
 * left the helper optional. Optional-helper-applied-by-hand is exactly the
 * arrangement that produced the eight: `restore/page.tsx` encoded in two
 * places and not in two others, twenty lines apart, and nothing about that
 * file looked wrong.
 *
 * So what is forbidden here is building the address at all. There is then
 * nothing to remember and nothing to review, which is the whole of the
 * argument — the same one `docs/architecture.md` makes for `LIVE_PAGES`
 * against a `deleted_at` predicate typed out twelve times.
 *
 * ## What counts as building one
 *
 * `wikiPathExpressions` in `test/route-inventory.ts` decides, off the syntax
 * tree, and its docblock carries both spellings it knows and both blind spots
 * it has. Reading the tree rather than the text is what lets this file, which
 * is full of the shape it forbids, not be a call site — and lets the several
 * docblocks under `app/wiki/` that quote a `/wiki/…` address in prose stay
 * prose.
 *
 * ## The `revalidatePath` exemption that used to be here (`YEO-131`)
 *
 * `YEO-128` waved `revalidatePath` through by callee, on the grounds that it
 * "operates on the route file structure, not the URL visible to users" and
 * that nothing it takes is a link a reader can follow. That left nine calls in
 * `app/wiki/actions.ts` interpolating the slug raw with no argument written
 * beside them, which is what `YEO-131` was opened to settle.
 *
 * It settled the other way. `revalidatePath` does match a canonicalised form
 * of the pathname, and a raw `#`, `?` or `/` in a slug misses it — the entry
 * goes on serving stale content after an edit, silently. The nine now go
 * through `entryCachePath` and `categoryCachePath`, which encode by Next's
 * rule rather than by `encodeURIComponent`'s (`lib/wiki-paths.ts` carries the
 * reading of the runtime, `lib/wiki-paths.cache-tags.test.ts` holds Next to
 * it), and nothing under `/wiki` assembles a path of either kind by hand any
 * more.
 *
 * So the exemption is **gone** rather than annotated. The `revalidatePath`
 * calls that remain as literals are route *patterns* — `"/wiki/[slug]"` with a
 * `"page"` type — which have no substitution in them and were never findings
 * here. An exemption is a licence, and the argument for keeping this one had
 * become "there is nothing it lets through", which is the argument for
 * deleting it. `WikiPathExpression.callee` stays on the type; the next rule
 * that needs to tell one call from another will want it, and
 * `test/route-inventory.wiki-paths.test.ts` still covers it.
 *
 * ## Where it looks
 *
 * `SOURCE_DIRS` — `app`, `components` and `lib`. An href is not only rendered
 * from a route: `components/RecentChangesList.tsx` renders one, and
 * `lib/entry-search.ts` returns one for a component to render, so a scan of
 * `app/` alone would have a hole in the two directions the app actually links
 * from.
 *
 * Test files are excluded by rule rather than by an exemption each, on
 * `lib/pages.call-sites.test.ts`'s reasoning: a fixture in a test is *meant*
 * to contain the shape being scanned for, and `lib/wiki-paths.test.ts` builds
 * a raw address on purpose to show what goes wrong with it.
 *
 * `lib/wiki-paths.ts` itself is not exempt and does not need to be. It builds
 * its addresses from `ENTRY_PATH_PREFIX` and `CATEGORY_PATH_PREFIX`, which are
 * named constants rather than inline literals, so nothing there is an address
 * assembled at a call site. That is not a way around the rule — it is the
 * rule: one place holds the prefix, and everywhere else asks that place.
 */

/** Whether this file is a test, and so entitled to contain the shape. */
function isTest(file: string): boolean {
  return file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

/**
 * file -> why it builds an address without the helper.
 *
 * One entry, and it is exempt because using the helper would be a *bug*
 * rather than because using it is merely unnecessary — the bar
 * `lib/pages.call-sites.test.ts` sets for its own two.
 */
const EXEMPT: Record<string, string> = {
  /**
   * **Must not encode**, and this is the one place in the repository where
   * that is true.
   *
   * `articleTabsForPath` takes the *pathname* — what `usePathname()` reports —
   * and builds the three tab hrefs from the segment it finds there. That
   * segment arrived out of a URL and is therefore already percent-encoded;
   * `lib/entry-slug.ts` keeps non-Latin slugs, so this is the ordinary case
   * rather than a corner. Running it through `entryPath` would encode it a
   * second time and point every tab at `/wiki/%25E5%258C%2597…`, which is a
   * 404 that looks like a typo.
   *
   * The file already knows this about itself: `decodeSegment` exists next door
   * precisely because the segment it holds is encoded.
   */
  [join("lib", "article-tabs.ts")]:
    "builds tab hrefs from an already-encoded pathname segment — encoding again would double-encode",
};

/** Every address built by hand, by file, with the tests filtered out. */
const built = sourceFiles()
  .filter((file) => !isTest(file))
  .map((file) => ({ file, expressions: wikiPathExpressions(file) }))
  .filter(({ expressions }) => expressions.length > 0);

describe("addresses under /wiki", () => {
  it("finds the modules that build one, so the assertions are not vacuous", () => {
    // Named rather than counted, on `lib/pages.route-decisions.test.ts`'s
    // reasoning: a hard total fails on every module added and teaches the next
    // person that the way past this file is to edit the number. These three
    // are the ends of the shape — a route, a component and a plain module —
    // and if any stops linking to an entry it has been rewritten.
    const callers = sourceFiles()
      .filter((file) => !isTest(file))
      .filter((file) => read(file).includes("@/lib/wiki-paths"));

    expect(callers).toContain(join("app", "wiki", "page.tsx"));
    expect(callers).toContain(join("components", "RecentChangesList.tsx"));
    expect(callers).toContain(join("lib", "entry-search.ts"));
    expect(callers.length).toBeGreaterThanOrEqual(15);
  });

  it("leaves none of them assembled at the call site", () => {
    const offenders = built
      .filter(({ file }) => !(file in EXEMPT))
      .flatMap(({ file, expressions }) =>
        expressions.map(({ text }) => `${file}: ${text}`),
      );

    // A line reaching this list interpolates a value into a `/wiki/…` path.
    // Where that value is a slug, `pages.slug` is a `text` column and a `#`, a
    // `?` or a space in it goes wrong with no error anywhere — which way
    // depends on what the path is *for*, and that is the whole of the choice
    // between the two builders:
    //
    //   - an **href** — a `Link`, a `redirect`, a `router.push`. Build it with
    //     `entryPath` or `categoryPath`. `/wiki/rose?hall/history` is a live
    //     request for `/wiki/rose`.
    //   - a **`revalidatePath` argument**. Build it with `entryCachePath` or
    //     `categoryCachePath` (`YEO-131`). An href would not match here: the
    //     cache key keeps a space decoded, so `entryPath` misses it.
    //
    // Both are in `@/lib/wiki-paths`, which argues the difference at length.
    expect(offenders).toEqual([]);
  });

  it("keeps every history route using the helper", () => {
    // The eight hrefs `YEO-128` was filed about were all on these four
    // routes, and the assertion above would go green again if somebody simply
    // deleted the links. This says they are still there and still built the
    // right way.
    const history = routeFiles().filter(({ route }) =>
      route.startsWith("/wiki/[slug]/history"),
    );

    expect(history.length).toBeGreaterThanOrEqual(4);

    const silent = history
      .filter(({ file }) => !read(file).includes("entryPath("))
      .map(({ file }) => file);

    expect(silent).toEqual([]);
  });
});

describe("the exemptions", () => {
  it("still match something", () => {
    // The direction `lib/pages.call-sites.test.ts` argues is not harmless: an
    // exemption that matches nothing is a licence sitting where the next
    // reader will assume it is load-bearing, and it widens silently as the
    // file it names changes underneath it.
    const stale = Object.keys(EXEMPT).filter(
      (file) => !built.some((entry) => entry.file === file),
    );

    expect(stale).toEqual([]);
  });

  it("carries a reason for each", () => {
    for (const reason of Object.values(EXEMPT)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
