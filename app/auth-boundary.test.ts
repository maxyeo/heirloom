import { describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "@/lib/session";
import {
  boundaryUsage,
  inlineServerActionFiles,
  pathnameFor,
  posixPath,
  proxyMatchers,
  proxyProtects,
  routeFiles,
  serverActionModules,
} from "@/test/route-inventory";

/**
 * The auth boundary (E10-T2, `YEO-66`).
 *
 * `docs/architecture.md`: *"a route handler that forgets `requireSession()`
 * has nothing underneath it to fail safe."* The app connects to Postgres as
 * one role rather than as the signed-in person, so there is no row-level
 * security beneath a missing guard — the guard is the whole of it.
 *
 * That makes the interesting question not "is this route guarded" but "is
 * every route guarded, including the ones that do not exist yet". A test
 * listing the routes it knows about answers the first and only looks like it
 * answers the second: such a list covers exactly the routes somebody
 * remembered to add to it, which is the same act of remembering that the
 * guard itself needs. It would have gone green on the day it mattered.
 *
 * So every route here is **enumerated from the filesystem** — the same
 * directory tree Next routes from (`test/route-inventory.ts`). Adding a route
 * puts it in this test whether or not anyone thinks about this test, and
 * adding an unguarded one turns it red.
 *
 * ## The four things checked
 *
 * 1. Every route file calls the boundary. Pages are `async` Server
 *    Components, which React and Vitest cannot render, so this one is read
 *    statically — but from the *syntax tree*, not the source text. This
 *    repository explains itself in long docblocks, several of which name
 *    `requireSession()` in prose, and `// await requireSession();` is exactly
 *    what a half-finished edit leaves behind. A regex counts both as a guard.
 *    The compiler's own scanner counts neither.
 * 2. Every server action really does reject an anonymous caller. These *can*
 *    be driven, so they are: each one is imported and called with no session
 *    in place, and has to throw `UnauthorizedError`.
 * 3. No action escapes (2) by being declared inline, where it would have no
 *    importable name to call.
 * 4. `proxy.ts`'s matcher does not exempt a private route.
 *
 * ## Why `@/auth` is the only thing mocked
 *
 * `docs/testing.md` sets the bar: mock a module boundary Vitest cannot cross,
 * never behaviour worth driving. `auth.ts` calls `NextAuth()` at import time,
 * and next-auth does not load outside the Next.js runtime — the import fails
 * outright. That is the whole reason, and it stops there.
 *
 * In particular `@/lib/session` is **not** mocked. It is the boundary under
 * test: `requireSession` runs for real, reads the real (absent) session, and
 * throws the real error. Stubbing it would leave this asserting that actions
 * call a function that a test told to throw.
 */

// An anonymous caller: the handshake never happened, so there is no session.
vi.mock("@/auth", () => ({ auth: async () => null }));

/**
 * The routes that must stay reachable logged out, and why.
 *
 * This is the only hand-written list in the file, and it is the safe polarity
 * of one. Forgetting to add a route here does not weaken anything — it turns
 * this test red. The list can only ever be used to *widen* what is public,
 * which is an edit that shows up in a diff and has to be argued for.
 */
const PUBLIC_ROUTES = new Map<string, string>([
  [
    "/signin",
    "The sign-in page. Requiring a session to reach the page that gives out " +
      "sessions is a locked door with the key inside.",
  ],
  [
    "/api/auth/[...nextauth]",
    "Auth.js's own endpoints: the OAuth redirect and callback that establish " +
      "a session in the first place.",
  ],
]);

/**
 * Files allowed to declare a `"use server"` action inline.
 *
 * Both entries are session *lifecycle* actions, which is the entire category:
 * the two operations that cannot require a session without contradicting
 * themselves. `app/signin/page.tsx` calls `signIn` — requiring a session to
 * get one is the locked door again. `app/site-chrome.tsx` calls `signOut`,
 * where a caller with no session is asking for a state they are already in.
 *
 * Neither reads or writes anything. Any *third* entry would be an action that
 * does, declared where the suite above cannot call it, and should be moved to
 * an `actions.ts` module rather than added here.
 */
const INLINE_ACTION_EXEMPT = new Set([
  "app/signin/page.tsx",
  "app/site-chrome.tsx",
]);

const routes = routeFiles();

describe("the route inventory", () => {
  /**
   * Everything below is of the form "every route ...", which is trivially
   * true of no routes. A renamed directory or a changed extension would
   * otherwise leave this whole file green and inert.
   */
  it("finds the routes that exist today", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it("recognises pages, dynamic segments and route handlers", () => {
    const byRoute = new Map(routes.map((r) => [r.route, r]));

    expect(byRoute.get("/")?.file).toBe(posixPath("app/page.tsx"));
    expect(byRoute.get("/wiki/[slug]")?.kind).toBe("page");
    expect(byRoute.get("/wiki/[slug]/history/[revisionId]")).toBeDefined();
    expect(byRoute.get("/api/auth/[...nextauth]")?.kind).toBe("handler");
  });

  it("does not treat layouts or not-found files as routes", () => {
    // Guarding a layout would be a guard that does not always run; see
    // test/route-inventory.ts.
    const files = routes.map((r) => posixPath(r.file));
    expect(files).not.toContain("app/layout.tsx");
    expect(files).not.toContain("app/wiki/[slug]/not-found.tsx");
  });

  it("keeps the public list honest — every entry names a real route", () => {
    // A stale exemption is an exemption nobody can see is stale.
    const all = new Set(routes.map((r) => r.route));
    for (const route of PUBLIC_ROUTES.keys()) {
      expect(all).toContain(route);
    }
  });
});

describe("every route demands a session", () => {
  const guarded = routes.filter((route) => !PUBLIC_ROUTES.has(route.route));

  it.each(guarded.map((route) => [route.route, route.file]))(
    "%s calls the boundary",
    (_route, file) => {
      const { imported, called } = boundaryUsage(file);

      /**
       * Both flavours count. `requireSession` throws, which is what a page
       * wants; `requireSessionOr401` returns a 401 `Response`, which is what
       * a route handler wants. What does not count is neither.
       *
       * The import is asserted as well as the call, and the pair is the
       * point: a call with no import is an unresolved name, and an import
       * with no call is the shape a guard looks like after somebody deleted
       * the line but not the line above it.
       *
       * This is still static, so it proves the guard is *present*, not that
       * it runs before everything else. That is the realistic failure — a new
       * page written by copying one that queries the database and dropping
       * the line that does not seem to do anything — and the actions below
       * are driven for real, which covers the other half.
       */
      expect(imported).toBe(true);
      expect(called.length).toBeGreaterThan(0);
    },
  );

  it("leaves the public routes public", () => {
    // The inverse, so an over-zealous guard on /signin is caught too: it
    // would lock everyone out of the only door in.
    for (const route of routes.filter((r) => PUBLIC_ROUTES.has(r.route))) {
      expect(boundaryUsage(route.file).called).toEqual([]);
    }
  });
});

describe("every server action rejects an anonymous caller", () => {
  const modules = serverActionModules();

  /**
   * Non-vacuity, not an inventory. `arrayContaining` rather than equality on
   * purpose: a new `actions.ts` should be *driven* by the suite below, not
   * reported here as a surprise. Requiring an edit to this line before a new
   * action module is allowed to exist would make this the hand-maintained
   * list the rest of the file is written to avoid.
   *
   * What it still catches is the enumeration silently finding nothing —
   * a renamed directory, a changed directive — which would leave every
   * assertion below iterating over an empty array.
   */
  it("finds the action modules", () => {
    expect(modules.map(posixPath)).toEqual(
      expect.arrayContaining(["app/tree/actions.ts", "app/wiki/actions.ts"]),
    );
  });

  it.each(modules)("%s", async (file) => {
    const imported: Record<string, unknown> = await import(
      /* @vite-ignore */ `@/${posixPath(file).replace(/\.tsx?$/, "")}`
    );

    const actions = Object.entries(imported).filter(
      ([, value]) => typeof value === "function",
    );

    // A `"use server"` module whose exports vanished would otherwise pass.
    expect(actions.length).toBeGreaterThan(0);

    for (const [name, action] of actions) {
      /**
       * Arguments are deliberately junk. Every one of these has to reach
       * `requireSession()` before it looks at anything a caller sent — an
       * action that validated its input first would be an action that can be
       * probed for what exists by someone with no session at all. `(previous,
       * formData)` covers the `useActionState` shape; the extra argument is
       * ignored by the actions that take a single object.
       */
      const call = () =>
        (action as (...args: unknown[]) => unknown)(null, new FormData());

      /**
       * `toBeInstanceOf` rather than a message match, and it is doing real
       * work: a `TypeError` from the junk arguments above would satisfy
       * "it threw" while proving the opposite of what is claimed here.
       */
      await expect(
        Promise.resolve().then(call),
        `${posixPath(file)} → ${name} must reject an anonymous caller`,
      ).rejects.toBeInstanceOf(UnauthorizedError);
    }
  });
});

describe("no action hides from the check above", () => {
  /**
   * An inline `"use server"` closure is as much a POST endpoint as an
   * exported one, but it has no name to import, so the suite above cannot
   * call it. Keeping actions at module scope is what keeps them checkable.
   */
  it("declares every action at module scope", () => {
    const inline = inlineServerActionFiles()
      .map(posixPath)
      .filter((file) => !INLINE_ACTION_EXEMPT.has(file));

    expect(inline).toEqual([]);
  });

  it("still sees the exempt files, so the exemptions are not stale", () => {
    // If sign-in or sign-out moves, its exemption should be deleted rather
    // than left covering nothing. `arrayContaining` again: a *new* inline
    // action is the assertion above's to report, and failing both would say
    // the same thing twice.
    expect(inlineServerActionFiles().map(posixPath)).toEqual(
      expect.arrayContaining([...INLINE_ACTION_EXEMPT]),
    );
  });
});

describe("the proxy matcher does not exempt a private route", () => {
  it("reads the patterns out of proxy.ts", () => {
    // Extraction failing open would make every assertion below meaningless.
    expect(proxyMatchers().length).toBeGreaterThan(0);
  });

  it.each(
    routes
      .filter((route) => !PUBLIC_ROUTES.has(route.route))
      .map((route) => [route.route]),
  )("runs on %s", (route) => {
    expect(proxyProtects(pathnameFor(route))).toBe(true);
  });

  it.each([...PUBLIC_ROUTES.keys()].map((route) => [route]))(
    "stays out of the way of %s",
    (route) => {
      expect(proxyProtects(pathnameFor(route))).toBe(false);
    },
  );

  /**
   * The exemptions are prefixes, not whole segments, and that is the trap
   * this whole describe block exists for. `/signin` is exempt — and so is
   * anything else beginning with those nine characters.
   *
   * Nothing is broken today, because no such route exists. The point is that
   * nobody would notice if one were added: it would be a perfectly ordinary
   * page that silently never met the proxy. The enumeration above is the
   * guard — a route named this way turns "runs on %s" red — and this test
   * records *why* that guard is not paranoia.
   */
  it("exempts more than the public routes themselves", () => {
    expect(proxyProtects("/signin")).toBe(false);
    expect(proxyProtects("/signin-help")).toBe(false);
    expect(proxyProtects("/api/authors")).toBe(false);
  });

  /**
   * The same trap from the other end, and this one is reachable now: the
   * `.svg` exemption is not anchored to the top level, so it applies to any
   * URL at all whose last segment ends in `.svg` — including a request to a
   * dynamic route.
   *
   * No entry can actually have such a slug (`lib/entry-slug.ts` turns every
   * run of non-alphanumerics into a hyphen, so a stored slug never contains a
   * dot), but anyone may *request* that URL, and the proxy will wave it
   * through to the page. What stops it is the page's own `requireSession()`
   * — which is exactly the defence in depth that architecture.md describes,
   * demonstrated rather than asserted.
   */
  it("waves through a dynamic route whose segment ends in .svg", () => {
    const entry = routes.find((route) => route.route === "/wiki/[slug]");
    expect(entry).toBeDefined();

    expect(proxyProtects(pathnameFor(entry!.route, "hostile.svg"))).toBe(false);
    // And the page catches what the proxy let past.
    expect(boundaryUsage(entry!.file).called).toContain("requireSession");
  });
});
