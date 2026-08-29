import { describe, expect, it } from "vitest";

import {
  categoryCachePath,
  categoryPath,
  entryCachePath,
  entryPath,
} from "@/lib/wiki-paths";
import { routeFiles } from "@/test/route-inventory";

/**
 * `lib/wiki-paths.ts` builds every address under `/wiki`, and the reason it
 * exists is that eight hrefs on the history routes did not (`YEO-128`).
 *
 * ## The round trip is the assertion
 *
 * Checking that `entryPath` returns a string with `%20` in it would only
 * assert that `encodeURIComponent` was called, which is the thing that is not
 * in doubt. The claim worth cashing is the one the ticket makes: *a slug
 * containing `#`, `?` or a space reaches the right page*. So the tests below
 * take the address the whole way round —
 *
 *   slug -> `entryPath` -> a `URL` -> the route pattern -> the slug again
 *
 * — and every stage is done by something other than this repository. `URL` is
 * the platform's own parser, and it is the thing that actually decides whether
 * a `?` ended the path; the route patterns come from `routeFiles()`, which
 * walks the same `app/` tree Next routes from, so a test cannot pass by
 * matching a route somebody typed into it that does not exist.
 *
 * That last part matters more than it looks. The raw hrefs were wrong in the
 * direction of pointing *somewhere else that resolves*: `/wiki/a?b/history`
 * is a request for `/wiki/a` with a query string, and `/wiki/a#b/history` is a
 * request for `/wiki/a`. Both are live pages. A test that only checked "the
 * slug survives" and not "the path still has four segments" would pass on
 * exactly the bug this file was written about.
 */

/** Somewhere for `URL` to resolve a site-relative path against. */
const ORIGIN = "https://wiki.example";

/**
 * The three characters the ticket names, one slug each, plus one holding all
 * of them.
 *
 * A space, a `#` and a `?` are the three because they are the three that fail
 * differently: a space is not a legal URL character at all, `#` starts a
 * fragment and `?` starts a query, so each takes a different route to the
 * wrong page. `/` is in the fourth because `encodeURIComponent` escaping it is
 * a deliberate property rather than an incidental one — a slug is one path
 * segment, and an unescaped `/` would silently become two.
 */
const AWKWARD_SLUGS = [
  "rose hall",
  "rose#hall",
  "rose?hall",
  "rose hall#the-fire?year/1897",
];

/** A revision id, shaped as `revisions.id` is. */
const REVISION_ID = "9f8c1b64-1f2e-4a3b-8d5c-0e1a2b3c4d5e";

/**
 * The segments of a concrete pathname, decoded, or `null` if it does not
 * match the pattern.
 *
 * Deliberately strict about the *count*: a pattern of four segments matches a
 * path of four segments and nothing else. That is what makes a truncated href
 * fail here rather than quietly matching a shorter route.
 *
 * @param route a pattern from `routeFiles()`, e.g. `/wiki/[slug]/history`
 * @param pathname a concrete path, as `URL` reports it — still encoded
 * @returns the dynamic segments in order, decoded
 */
function match(route: string, pathname: string): string[] | null {
  const pattern = route.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (pattern.length !== actual.length) return null;

  const captured: string[] = [];
  for (const [index, segment] of pattern.entries()) {
    if (segment.startsWith("[")) {
      captured.push(decodeURIComponent(actual[index]));
      continue;
    }
    if (segment !== actual[index]) return null;
  }

  return captured;
}

/**
 * Assert that `path` is a request for `route` carrying `expected` in its
 * dynamic segments, and that it is *only* that.
 *
 * The empty `search` and `hash` are the half a decoded-segment check would
 * miss. `/wiki/rose?hall/history` has a perfectly good pathname; what is
 * wrong with it is everything after the `?`.
 */
function expectAddresses(
  path: string,
  route: string,
  expected: readonly string[],
): void {
  const url = new URL(path, ORIGIN);

  expect(url.search).toBe("");
  expect(url.hash).toBe("");
  expect(match(route, url.pathname)).toEqual([...expected]);
}

/** Every route pattern the app actually serves. */
const ROUTES = new Set(routeFiles().map(({ route }) => route));

describe("entryPath", () => {
  it("encodes the slug", () => {
    expect(entryPath("rose-hall")).toBe("/wiki/rose-hall");
    expect(entryPath("rose hall")).toBe("/wiki/rose%20hall");
    expect(entryPath("a?b")).toBe("/wiki/a%3Fb");
    expect(entryPath("a#b")).toBe("/wiki/a%23b");
  });

  it("encodes a slash, because a slug is one path segment", () => {
    // The property `app/wiki/page.tsx` used to spell out at its own `Link`.
    // Without it a slug of `a/b` addresses `/wiki/a/b`, which is a route that
    // exists and is not this entry.
    expect(entryPath("a/b")).toBe("/wiki/a%2Fb");
  });

  it("appends the segments below it", () => {
    expect(entryPath("rose-hall", "history")).toBe("/wiki/rose-hall/history");
    expect(entryPath("rose-hall", "history", REVISION_ID, "restore")).toBe(
      `/wiki/rose-hall/history/${REVISION_ID}/restore`,
    );
  });

  it("leaves a literal segment and a uuid alone", () => {
    // Encoding every segment is uniform rather than selective — see the
    // helper's own note on why there is deliberately no rule about which
    // argument is the dangerous one. This is what that costs: nothing.
    expect(entryPath("x", "history", REVISION_ID)).toContain(REVISION_ID);
    expect(entryPath("x", "history")).toContain("/history");
  });
});

/**
 * The other address shape (`YEO-131`).
 *
 * `entryCachePath` and `categoryCachePath` build what `revalidatePath` matches
 * — an implicit cache tag, canonicalised by decoding the pathname and
 * re-escaping only the path delimiters — which is not the same string as the
 * href for a slug holding a space, a `&`, a `+`, or any of the other
 * characters `encodeURIComponent` escapes and Next's cache key does not.
 *
 * These are the plain string assertions. The round trip that *establishes* the
 * rule lives in `lib/wiki-paths.cache-tags.test.ts` rather than here, because
 * it drives Next's own `revalidatePath` and `getImplicitTags` and has to set
 * `globalThis.AsyncLocalStorage` before either loads — which makes every
 * import in that file dynamic, and is not a constraint worth spreading to the
 * tests above.
 */
describe("entryCachePath and categoryCachePath", () => {
  it("escape the path delimiters and nothing else", () => {
    expect(entryCachePath("rose-hall")).toBe("/wiki/rose-hall");
    expect(entryCachePath("rose#hall")).toBe("/wiki/rose%23hall");
    expect(entryCachePath("rose?hall")).toBe("/wiki/rose%3Fhall");
    expect(entryCachePath("rose/hall")).toBe("/wiki/rose%2Fhall");
    expect(categoryCachePath("the fire?")).toBe("/wiki/category/the fire%3F");
  });

  it("leave a space, and everything else, decoded", () => {
    // The half that makes this a separate function rather than an alias for
    // `entryPath`. Next decodes the pathname to build the cache key, so an
    // encoded space in the argument matches nothing.
    expect(entryCachePath("rose hall")).toBe("/wiki/rose hall");
    expect(entryCachePath("rose&hall=1")).toBe("/wiki/rose&hall=1");
    expect(entryCachePath("北京")).toBe("/wiki/北京");

    expect(entryPath("rose hall")).not.toBe(entryCachePath("rose hall"));
  });

  it("re-escape a percent-sequence that already spells a delimiter", () => {
    // A slug holding the literal text `%23` would otherwise collide in the
    // cache key with a slug holding a `#`. Next escapes the `%`; so does this.
    expect(entryCachePath("a%23b")).toBe("/wiki/a%2523b");
    expect(entryCachePath("100%")).toBe("/wiki/100%");
  });

  it("append the segments below the entry", () => {
    expect(entryCachePath("rose hall", "history")).toBe(
      "/wiki/rose hall/history",
    );
    expect(entryCachePath("rose#hall", "history", REVISION_ID)).toBe(
      `/wiki/rose%23hall/history/${REVISION_ID}`,
    );
  });
});

describe("categoryPath", () => {
  it("encodes the slug", () => {
    expect(categoryPath("houses")).toBe("/wiki/category/houses");
    expect(categoryPath("the fire?")).toBe("/wiki/category/the%20fire%3F");
  });

  it("addresses the route that exists", () => {
    expect(ROUTES).toContain("/wiki/category/[slug]");
    expectAddresses(categoryPath("a b#c?d"), "/wiki/category/[slug]", [
      "a b#c?d",
    ]);
  });
});

describe("a slug with a #, a ? or a space, through the history routes", () => {
  /**
   * The four routes below `/wiki/[slug]/history`, and the arguments that
   * build each one.
   *
   * Every pattern is asserted to be a route the app serves before it is used,
   * so this list cannot drift into testing addresses nobody answers at.
   */
  const HISTORY_ROUTES = [
    {
      route: "/wiki/[slug]/history",
      below: ["history"],
      dynamic: (slug: string) => [slug],
    },
    {
      route: "/wiki/[slug]/history/compare",
      below: ["history", "compare"],
      dynamic: (slug: string) => [slug],
    },
    {
      route: "/wiki/[slug]/history/[revisionId]",
      below: ["history", REVISION_ID],
      dynamic: (slug: string) => [slug, REVISION_ID],
    },
    {
      route: "/wiki/[slug]/history/[revisionId]/restore",
      below: ["history", REVISION_ID, "restore"],
      dynamic: (slug: string) => [slug, REVISION_ID],
    },
  ] as const;

  it("covers every history route the app serves", () => {
    // The vacuity guard every scanner in this repository carries. A history
    // route added tomorrow is one this file does not exercise, and the way to
    // find that out should not be a reader noticing.
    const served = [...ROUTES].filter((route) =>
      route.startsWith("/wiki/[slug]/history"),
    );

    expect([...served].sort()).toEqual(
      HISTORY_ROUTES.map(({ route }) => route).sort(),
    );
  });

  for (const slug of AWKWARD_SLUGS) {
    for (const { route, below, dynamic } of HISTORY_ROUTES) {
      it(`round-trips ${JSON.stringify(slug)} through ${route}`, () => {
        expectAddresses(entryPath(slug, ...below), route, dynamic(slug));
      });
    }
  }

  it("is the thing a raw interpolation gets wrong", () => {
    // The failure this file exists about, written out so that the assertions
    // above are visibly not tautological. Each of these is what the eight
    // hrefs on the history routes produced before `YEO-128`, and none of them
    // is an error at the time — they are all requests for a page that exists.
    const slug = "rose?hall";
    const raw = `/wiki/${slug}/history`;

    const url = new URL(raw, ORIGIN);
    expect(url.pathname).toBe("/wiki/rose");
    expect(url.search).toBe("?hall/history");
    expect(match("/wiki/[slug]/history", url.pathname)).toBeNull();

    // And the same address built here reaches the history page instead.
    expectAddresses(entryPath(slug, "history"), "/wiki/[slug]/history", [slug]);
  });
});
