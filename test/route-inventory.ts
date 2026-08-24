import { readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { tryToParsePath } from "next/dist/lib/try-to-parse-path";

/**
 * The App Router, read off the filesystem (E10-T2, `YEO-66`).
 *
 * `app/auth-boundary.test.ts` is the reason this exists. That test has to
 * assert something about *every* route, including the ones that do not exist
 * yet, which rules out a list in a test file: a list only ever covers the
 * routes somebody remembered to add to it, which is the same failure mode as
 * remembering to call `requireSession()`. So the routes are enumerated from
 * the directory tree that Next itself routes from, and a new route is in the
 * test the moment the file exists.
 *
 * The functions here find and describe routes. They assert nothing — the
 * assertions, and the reasoning about what "guarded" means, live in the test.
 *
 * Everything below throws rather than skipping when it meets something it
 * does not understand. A boundary test that quietly ignores a file it could
 * not classify is a boundary test that reports green on the one route nobody
 * looked at.
 */

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Where the App Router lives, relative to the repository root. */
const APP_DIR = "app";

/**
 * Filenames that make a directory answerable at a URL.
 *
 * `layout.tsx` is deliberately absent, and the omission is the interesting
 * one. A layout is not a boundary: Next does not re-run it on every
 * navigation to a page beneath it, so a `requireSession()` there would be a
 * guard that sometimes does not run — worse than no guard, because it looks
 * like one. `not-found.tsx`, `error.tsx` and friends are absent for a
 * simpler reason: nothing routes to them directly; they render only after a
 * page has already run.
 */
const ROUTE_FILENAMES = new Set([
  "page.tsx",
  "page.ts",
  "page.jsx",
  "page.js",
  "route.ts",
  "route.tsx",
  "route.js",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * What a dynamic segment is filled in with when a route is turned into a
 * concrete URL to test the proxy matcher against.
 *
 * Deliberately boring. `app/auth-boundary.test.ts` supplies hostile values of
 * its own where the point is that the segment's *content* can change whether
 * the matcher exempts the URL.
 */
export const SAMPLE_SEGMENT = "sample";

export type RouteKind = "page" | "handler";

export type RouteFile = {
  /** Repo-relative, with the platform's separator: `app/wiki/[slug]/page.tsx`. */
  file: string;
  /** `page.tsx` renders; `route.ts` answers a request itself. */
  kind: RouteKind;
  /** The URL pattern, as Next writes it: `/wiki/[slug]`. */
  route: string;
};

/** Every file under `app/` with one of `SOURCE_EXTENSIONS`, repo-relative. */
export function appSourceFiles(): string[] {
  return readdirSync(join(repoRoot, APP_DIR), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
    .map((entry) => join(APP_DIR, entry));
}

/** Read a repo-relative path. */
export function read(file: string): string {
  return readFileSync(join(repoRoot, file), "utf8");
}

/**
 * Turn the directory segments of a route file into the route Next serves it
 * at, applying the App Router's naming conventions.
 *
 * Throws on any segment shape not handled here. Parallel routes (`@slot`) and
 * intercepting routes (`(.)`) are the ones worth naming: both change which
 * file actually answers a request, so a boundary test that guessed at them
 * would be guessing about the very thing it is checking. None exist in this
 * repository today; the day one does, this fails and someone has to decide
 * what it means rather than inheriting a wrong answer.
 */
function routeFromSegments(segments: string[]): string {
  const parts: string[] = [];

  for (const segment of segments) {
    // Route groups organise files without appearing in the URL.
    if (/^\(.+\)$/.test(segment)) {
      if (/^\(\.+\)/.test(segment)) {
        throw new Error(
          `Intercepting route segment is not handled: ${segment}`,
        );
      }
      continue;
    }
    // Private folders are not routable at all.
    if (segment.startsWith("_")) {
      throw new Error(`Private folder is not routable: ${segment}`);
    }
    if (segment.startsWith("@")) {
      throw new Error(`Parallel route segment is not handled: ${segment}`);
    }
    if (
      /^\[\[\.\.\..+\]\]$/.test(segment) ||
      /^\[(\.\.\.)?.+\]$/.test(segment)
    ) {
      parts.push(segment);
      continue;
    }
    if (/[[\]()@]/.test(segment)) {
      throw new Error(`Unrecognised route segment: ${segment}`);
    }
    parts.push(segment);
  }

  return `/${parts.join("/")}`;
}

/**
 * Every route the App Router serves, found by walking `app/`.
 *
 * Files under a private (`_`-prefixed) folder are skipped before
 * `routeFromSegments` sees them, since Next does not route to them at all.
 */
export function routeFiles(): RouteFile[] {
  const routes = appSourceFiles()
    .filter((file) => ROUTE_FILENAMES.has(file.split(sep).at(-1) ?? ""))
    .filter((file) => !file.split(sep).some((s) => s.startsWith("_")))
    .map((file) => {
      const segments = file.split(sep).slice(1, -1);
      const kind: RouteKind = (file.split(sep).at(-1) ?? "").startsWith("route")
        ? "handler"
        : "page";
      return { file, kind, route: routeFromSegments(segments) };
    });

  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * A concrete URL for a route pattern, so it can be handed to the proxy
 * matcher — which matches pathnames, not patterns.
 *
 * A catch-all stands in for one or more segments; one is enough to establish
 * whether the matcher exempts the shape.
 *
 * @param route a route pattern from `routeFiles`
 * @param sample what to substitute for each dynamic segment
 */
export function pathnameFor(
  route: string,
  sample: string = SAMPLE_SEGMENT,
): string {
  const filled = route
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith("[") ? sample : segment));

  return filled.length === 0 ? "/" : `/${filled.join("/")}`;
}

/**
 * Whether a file's *module* is a server-action module — `"use server"` as the
 * first thing in the file, which makes every export a POST endpoint.
 *
 * Leading comments and blank lines are skipped, because a directive is still
 * a module directive with a licence header above it.
 */
function hasModuleDirective(source: string): boolean {
  const withoutLeadingComments = source.replace(
    /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*/,
    "",
  );
  return /^\s*["']use server["']/.test(withoutLeadingComments);
}

/**
 * A directive is a statement standing on its own line.
 *
 * Matching the bare characters `use server` anywhere in the file instead
 * would flag every docblock that discusses server actions — of which this
 * repository has several, including the test that calls this function.
 */
const DIRECTIVE_LINE = /^[ \t]*["']use server["'];?[ \t]*$/m;

/**
 * Every module-level `"use server"` file under `app/`, repo-relative.
 *
 * These are the ones a test can import and call, because their actions are
 * module exports.
 */
export function serverActionModules(): string[] {
  return appSourceFiles()
    .filter((file) => hasModuleDirective(read(file)))
    .sort();
}

/**
 * Files that use `"use server"` somewhere *other* than the top of the module
 * — an action declared inside a component or a closure.
 *
 * An inline action is a real POST endpoint with no importable name, so
 * `app/auth-boundary.test.ts` cannot call it and prove it rejects an
 * anonymous caller. Rather than let that be an invisible gap, the test treats
 * every such file as something to be justified.
 */
export function inlineServerActionFiles(): string[] {
  return appSourceFiles()
    .filter((file) => {
      const source = read(file);
      return DIRECTIVE_LINE.test(source) && !hasModuleDirective(source);
    })
    .sort();
}

/**
 * The `matcher` patterns as `proxy.ts` actually declares them.
 *
 * Read out of the source text rather than imported, for a reason that is not
 * a preference: `proxy.ts` re-exports Auth.js's `auth`, so importing it loads
 * next-auth, which does not load outside the Next.js runtime. Next has the
 * same constraint from the other side — it reads this value statically at
 * build time and documents that "matcher values need to be constants ...
 * dynamic values such as variables will be ignored" — which is also why the
 * patterns cannot simply be moved into a shared module and imported by both.
 *
 * String literals are extracted and run through `JSON.parse`, so the
 * backslashes in the pattern are unescaped exactly once and exactly the way
 * the compiler unescapes them.
 */
export function proxyMatchers(): string[] {
  const source = read("proxy.ts");
  const block = /matcher:\s*(\[[\s\S]*?\])/.exec(source);
  if (!block) {
    throw new Error(
      "Could not find a `matcher: [...]` array in proxy.ts. If the config " +
        "moved or changed shape, update route-inventory.ts — do not delete " +
        "the assertions that depend on it.",
    );
  }

  const literals = block[1].match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  return literals.map((literal) => JSON.parse(literal) as string);
}

/**
 * Whether the proxy runs on a pathname — which, for this app, means whether
 * the pathname is protected at the edge.
 *
 * The pattern is compiled with `tryToParsePath`, the same path-to-regexp call
 * Next's own `getMiddlewareMatchers` makes, so the semantics of the negative
 * lookahead are Next's rather than a reimplementation of them.
 *
 * Next additionally wraps the compiled source in optional groups for
 * transport forms (`/_next/data/...`, `.rsc`). Those are omitted here because
 * they are optional groups on an anchored pattern: they can only *widen* what
 * matches, so a pathname this reports as protected is protected under the
 * real thing too. `has`/`missing` conditions are likewise absent — a matcher
 * written as a bare string cannot carry them.
 */
export function proxyProtects(pathname: string): boolean {
  return proxyMatchers().some((source) => {
    const { regexStr } = tryToParsePath(source);
    if (!regexStr) {
      throw new Error(`proxy.ts matcher is not a parseable path: ${source}`);
    }
    return new RegExp(regexStr).test(pathname);
  });
}

/** `app/wiki/[slug]/page.tsx` reads the same on Windows as it does here. */
export function posixPath(file: string): string {
  return file.split(sep).join(posix.sep);
}
