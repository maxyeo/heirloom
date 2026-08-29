import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import type { WorkStore } from "next/dist/server/app-render/work-async-storage.external";

import {
  categoryCachePath,
  categoryPath,
  entryCachePath,
  entryPath,
} from "@/lib/wiki-paths";

/**
 * What `revalidatePath` actually matches, asked of the runtime rather than of
 * anybody's memory (`YEO-131`).
 *
 * ## The question
 *
 * `YEO-128` centralised every `/wiki` **href** in `lib/wiki-paths.ts` and
 * exempted `revalidatePath` by callee, without arguing that the exemption was
 * right. Nine calls in `app/wiki/actions.ts` went on interpolating the slug
 * raw. Next's reference says the function "operates on the route file
 * structure, not the URL visible to users" and then says nothing at all about
 * encoding, so the question of whether those nine were correct, wrong, or
 * undefined was genuinely open — and the two candidate answers ("leave them
 * raw", "run them through `entryPath`") are not the only two.
 *
 * ## Why this is a test and not a citation
 *
 * Because the answer turns out to be neither of them, and a comment asserting
 * that would be a comment nobody can check. The rule is
 * `decodeURIComponent`-then-re-escape-the-delimiters, which is not a rule
 * anyone would guess, is not written down in the published docs, and is not
 * stable across major versions by any promise Next has made. So the test runs
 * **both halves of the real mechanism** and asserts they meet:
 *
 *   - the **invalidating** half is the actual `revalidatePath` from
 *     `next/cache`, run inside a work store so its tags can be read back off
 *     `pendingRevalidatedTags`;
 *   - the **rendering** half is Next's own `interpolateDynamicPath` →
 *     `decodePathParams` → `getImplicitTags`, in the order and with the
 *     arguments `server/route-modules/route-module.js` and
 *     `server/app-render/app-render.js` use.
 *
 * Nothing here re-implements either side, so this cannot pass by agreeing with
 * a mistake of its own. If Next changes how it canonicalises a cache key, this
 * file goes red on the upgrade — which is the only place that finding is cheap.
 * `AGENTS.md` is explicit that this Next differs from what a reader (or a
 * model) remembers, and this is the shape of check that warning asks for.
 *
 * ## The cost, stated plainly
 *
 * These are deep imports into `next/dist`, which is not a supported entry
 * point. `test/route-inventory.ts` already reaches into
 * `next/dist/experimental/testing/server` for the same reason: the property is
 * about Next's behaviour, and there is no public surface that exposes it. The
 * package is pinned to an exact version (`next: "16.3.2"`, no caret), so the
 * import paths cannot move underneath this without a deliberate bump — and on
 * that bump, a module-not-found here is the intended alarm rather than a
 * flake to route around.
 */

/**
 * Next reads `globalThis.AsyncLocalStorage` once, when
 * `server/app-render/work-async-storage-instance.js` is evaluated, and falls
 * back to a stub that throws on `run`. Node exposes the class from
 * `node:async_hooks` but does not put it on `globalThis`, so the assignment has
 * to happen *before* that module loads — which is why every import below is
 * dynamic and this line is not inside a `beforeAll`.
 *
 * `@/test/route-inventory` is in that list for the same reason and not by
 * oversight: it imports `next/dist/experimental/testing/server`, which reaches
 * the same instance module, and a static import of it is hoisted above this
 * assignment and makes the stub the one that gets built.
 */
(
  globalThis as unknown as { AsyncLocalStorage?: typeof AsyncLocalStorage }
).AsyncLocalStorage ??= AsyncLocalStorage;

const { revalidatePath } = await import("next/cache");
const { workAsyncStorage } =
  await import("next/dist/server/app-render/work-async-storage.external");
const { getImplicitTags } = await import("next/dist/server/lib/implicit-tags");
const { decodePathParams } =
  await import("next/dist/server/lib/router-utils/decode-path-params");
const { interpolateDynamicPath } =
  await import("next/dist/server/server-utils");
const { default: escapePathDelimiters } =
  await import("next/dist/shared/lib/router/utils/escape-path-delimiters");
const { removeTrailingSlash } =
  await import("next/dist/shared/lib/router/utils/remove-trailing-slash");
const { getNamedRouteRegex } =
  await import("next/dist/shared/lib/router/utils/route-regex");
const { routeFiles } = await import("@/test/route-inventory");

/**
 * The tags `revalidatePath` marks stale, read off a work store.
 *
 * `revalidate()` in `server/web/spec-extension/revalidate.js` needs three
 * things from the store and writes to a fourth: it throws unless
 * `incrementalCache` is set, names `route` only in its error messages, reads
 * `cacheLifeProfiles` only when given a profile (`revalidatePath` never is),
 * and appends to `pendingRevalidatedTags`. A `WorkStore` has some forty other
 * fields, none of which this path touches, so the double is those four and the
 * cast says so.
 *
 * There is no work *unit* store, which is what a Server Action outside a
 * render looks like — exactly the position `app/wiki/actions.ts` calls from.
 */
function tagsWhenRevalidating(
  path: string,
  type?: "page" | "layout",
): string[] {
  const store = {
    incrementalCache: {},
    route: "/wiki/[slug]",
  } as unknown as WorkStore;

  workAsyncStorage.run(store, () => revalidatePath(path, type));

  return (store.pendingRevalidatedTags ?? []).map(({ tag }) => tag);
}

/**
 * The implicit tags a rendered page carries, for one concrete set of params.
 *
 * The three lines before `getImplicitTags` are `route-module.js`'s, in its
 * order: interpolate the params into the route (which `encodeURIComponent`s
 * each one), then decode — under its own comment, "we decode for cache
 * key/manifest usage encoded is for URL building" — then drop a trailing
 * slash. `app-render.js` reads the result back out of the request metadata as
 * `resolvedPathname` and hands it here.
 *
 * @param route a route pattern, e.g. `/wiki/[slug]/history`
 * @param params the dynamic segments, decoded, as a request would resolve them
 */
async function tagsWhenRendering(
  route: string,
  params: Record<string, string>,
): Promise<string[]> {
  const regex = getNamedRouteRegex(route, { prefixRouteKeys: false });
  const interpolated = interpolateDynamicPath(route, params, regex);
  const resolvedPathname = removeTrailingSlash(decodePathParams(interpolated));

  const { tags } = await getImplicitTags(
    `${route}/page`,
    resolvedPathname,
    null,
  );

  return tags;
}

/** Whether `path`, handed to `revalidatePath`, would clear that rendered page. */
async function invalidates(
  path: string,
  route: string,
  params: Record<string, string>,
): Promise<boolean> {
  const rendered = new Set(await tagsWhenRendering(route, params));

  return tagsWhenRevalidating(path).some((tag) => rendered.has(tag));
}

/**
 * The slugs, one per way a character can differ between a URL and a cache key.
 *
 * `lib/wiki-paths.test.ts` carries the same three characters through the route
 * *patterns*; these are the same three asked a different question. The space
 * is here because it is the one that breaks in the opposite direction from the
 * rest — the direction the ticket's own proposed fix would have introduced.
 */
const SLUGS = [
  "rose-hall",
  "rose hall",
  "rose#hall",
  "rose?hall",
  "rose/hall",
  "北京",
  "rose hall#the-fire?year/1897",
];

/** A revision id, shaped as `revisions.id` is. */
const REVISION_ID = "9f8c1b64-1f2e-4a3b-8d5c-0e1a2b3c4d5e";

/** Every route pattern the app actually serves. */
const ROUTES = new Set(routeFiles().map(({ route }) => route));

/**
 * The routes `app/wiki/actions.ts` clears by name, with the arguments that
 * build each address and the params a request would resolve to.
 */
const BY_NAME = [
  {
    route: "/wiki/[slug]",
    path: (slug: string) => entryCachePath(slug),
    href: (slug: string) => entryPath(slug),
    params: (slug: string) => ({ slug }),
  },
  {
    route: "/wiki/[slug]/history",
    path: (slug: string) => entryCachePath(slug, "history"),
    href: (slug: string) => entryPath(slug, "history"),
    params: (slug: string) => ({ slug }),
  },
  {
    route: "/wiki/[slug]/history/[revisionId]",
    path: (slug: string) => entryCachePath(slug, "history", REVISION_ID),
    href: (slug: string) => entryPath(slug, "history", REVISION_ID),
    params: (slug: string) => ({ slug, revisionId: REVISION_ID }),
  },
  {
    route: "/wiki/category/[slug]",
    path: (slug: string) => categoryCachePath(slug),
    href: (slug: string) => categoryPath(slug),
    params: (slug: string) => ({ slug }),
  },
] as const;

describe("what revalidatePath matches", () => {
  it("takes the pathname decoded, with only the path delimiters escaped", () => {
    // The answer `YEO-131` was opened to get, written out as the tag Next
    // writes for a rendered `/wiki/[slug]`. `#`, `?` and `/` come back
    // percent-encoded because `decodePathParams` re-escapes exactly those;
    // the space does not, because it is not a path delimiter; the non-Latin
    // slug does, because `encodeHeaderSafe` will not put a raw multibyte
    // character into an HTTP header.
    const tagged = async (slug: string) =>
      (await tagsWhenRendering("/wiki/[slug]", { slug })).filter((tag) =>
        tag.startsWith("_N_T_/wiki/rose"),
      );

    return Promise.all([
      expect(tagged("rose hall")).resolves.toEqual(["_N_T_/wiki/rose hall"]),
      expect(tagged("rose#hall")).resolves.toEqual(["_N_T_/wiki/rose%23hall"]),
      expect(tagged("rose?hall")).resolves.toEqual(["_N_T_/wiki/rose%3Fhall"]),
      expect(tagged("rose/hall")).resolves.toEqual(["_N_T_/wiki/rose%2Fhall"]),
    ]);
  });

  it("is not the URL the reader follows", async () => {
    // The whole finding in one assertion. If these two agreed there would be
    // no second builder in `lib/wiki-paths.ts` and no reason for this file.
    expect(entryPath("rose hall")).toBe("/wiki/rose%20hall");
    expect(entryCachePath("rose hall")).toBe("/wiki/rose hall");

    expect(
      await invalidates("/wiki/rose hall", "/wiki/[slug]", {
        slug: "rose hall",
      }),
    ).toBe(true);
    expect(
      await invalidates("/wiki/rose%20hall", "/wiki/[slug]", {
        slug: "rose hall",
      }),
    ).toBe(false);
  });
});

describe("entryCachePath and categoryCachePath", () => {
  it("build the addresses these routes are served at", () => {
    // The vacuity guard. A route renamed out from under this list would
    // otherwise leave every case below asserting something about an address
    // nobody answers at.
    for (const { route } of BY_NAME) {
      expect(ROUTES).toContain(route);
    }
  });

  for (const slug of SLUGS) {
    for (const { route, path, params } of BY_NAME) {
      it(`clears ${route} for ${JSON.stringify(slug)}`, async () => {
        expect(await invalidates(path(slug), route, params(slug))).toBe(true);
      });
    }
  }

  it("agrees with Next's own escaping rule", () => {
    // `lib/wiki-paths.ts` copies the delimiter class rather than importing it,
    // so that it stays free of imports and loadable from a Client Component.
    // This is what keeps the copy from drifting: the same characters, decided
    // by Next's function and by ours, have to come out the same.
    for (const slug of [...SLUGS, "a%23b", "a%2Fb", "100%", "a\\b", "a&b=c"]) {
      expect(entryCachePath(slug)).toBe(
        `/wiki/${escapePathDelimiters(slug, true)}`,
      );
    }
  });
});

describe("the two answers that were on offer, and why neither is right", () => {
  /** The nine call sites as they stood: the slug interpolated raw. */
  const raw = (slug: string) => `/wiki/${slug}`;

  it("leaves a raw slug missing on a #, a ? or a /", async () => {
    // The bug `YEO-131` suspected, confirmed. A retire or an edit of one of
    // these entries marked a tag nothing carries, so the route went on
    // serving the payload it had — no error, no warning, just stale.
    for (const slug of ["rose#hall", "rose?hall", "rose/hall"]) {
      expect(await invalidates(raw(slug), "/wiki/[slug]", { slug })).toBe(
        false,
      );
    }
  });

  it("names every character an encoded slug would miss on", () => {
    // The count `lib/wiki-paths.ts` claims, derived rather than typed. A
    // character is a miss exactly when `encodeURIComponent` escapes it and
    // Next's cache-key rule does not, so this asks both functions and reads
    // the answer off.
    //
    // It is here because an earlier draft of that docblock listed eighteen
    // characters and omitted `[`, `]` and the backslash. A prose list of
    // twenty-one punctuation marks is not something a reader will re-derive,
    // which makes it exactly the kind of claim that should be executable.
    const printableAscii = Array.from({ length: 0x7f - 0x20 }, (_, i) =>
      String.fromCharCode(0x20 + i),
    );

    const missed = printableAscii.filter(
      (char) =>
        encodeURIComponent(char) !== char &&
        escapePathDelimiters(char, true) === char,
    );

    expect(missed.join("")).toBe(' "$%&+,:;<=>@[\\]^`{|}');
    expect(missed).toHaveLength(21);

    // And the other direction is empty: there is no character Next escapes
    // that `encodeURIComponent` leaves alone. `entryPath` is strictly *more*
    // escaping than the cache key wants, never less — which is why the raw
    // spelling and the encoded one fail on disjoint sets.
    const opposite = printableAscii.filter(
      (char) =>
        encodeURIComponent(char) === char &&
        escapePathDelimiters(char, true) !== char,
    );

    expect(opposite).toEqual([]);
  });

  it("leaves an encoded slug missing on a space", async () => {
    // And the fix the ticket proposed, refuted. Routing the nine through
    // `entryPath` would have closed three characters and opened twenty-one —
    // the set the test above pins.
    for (const slug of ["rose hall", "rose&hall", "rose+hall", "rose[hall]"]) {
      expect(await invalidates(entryPath(slug), "/wiki/[slug]", { slug })).toBe(
        false,
      );
      expect(
        await invalidates(entryCachePath(slug), "/wiki/[slug]", { slug }),
      ).toBe(true);
    }
  });

  it("is invisible on the slugs this wiki normally makes", async () => {
    // Why it survived review twice. `lib/create-page.ts` slugifies, so the
    // ordinary slug — and, because `lib/entry-slug.ts` keeps non-Latin
    // titles, the ordinary *non-Latin* slug — matches under all three
    // spellings. Nothing about the raw calls looked wrong, and nothing about
    // them would have gone wrong in testing.
    for (const slug of ["rose-hall", "北京"]) {
      for (const path of [raw(slug), entryPath(slug), entryCachePath(slug)]) {
        expect(await invalidates(path, "/wiki/[slug]", { slug })).toBe(true);
      }
    }
  });
});

describe("the pattern calls, which take no slug", () => {
  it("clears every entry at once, whatever the slug holds", async () => {
    // `revalidatePath("/wiki/[slug]", "page")` names the route *file*, so
    // there is nothing in it to canonicalise — which is why those calls in
    // `app/wiki/actions.ts` are string literals and not helper calls, and why
    // the helpers deliberately do not take a `type`.
    const rendered = new Set(
      await tagsWhenRendering("/wiki/[slug]", { slug: "rose hall#the-fire" }),
    );

    expect(tagsWhenRevalidating("/wiki/[slug]", "page")).toEqual([
      "_N_T_/wiki/[slug]/page",
    ]);
    expect(rendered).toContain("_N_T_/wiki/[slug]/page");
  });
});
