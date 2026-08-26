import { readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_doesMiddlewareMatch } from "next/dist/experimental/testing/server";
import ts from "typescript";

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
 * The source tree, as far as every tripwire in this repository is concerned
 * (`YEO-100`).
 *
 * Routes only ever come from `app/`, but an action module does not have to:
 * the directive is legal in any module, and `components/AddPersonPanel.tsx`
 * already discusses client components importing one. Scanning only `app/`
 * would make a future `lib/…-actions.ts` invisible to the checks below — the
 * "list nobody remembers to extend" failure this file exists to remove.
 *
 * `lib/sanitize-html.call-sites.test.ts` needs the same three directories, for
 * the same reason and to no lesser extent: a `dangerouslySetInnerHTML` is a
 * stored-XSS sink wherever it is written. Until `YEO-100` it kept its own copy
 * of this list and a comment in each file asked the reader to believe the two
 * agreed. They did, but nothing said so — widening one and forgetting the
 * other would have left a directory guarded against unauthenticated routes and
 * not against unsanitised markup, or the reverse, with both suites green. It
 * is exported and imported rather than repeated so that the drift is not
 * possible rather than merely unlikely.
 *
 * ## The half that is shared and the half that is not (`YEO-102`)
 *
 * Four scanners in this repository walk the source tree, not two:
 * `app/globals.test.ts` looks for a hex colour declared outside
 * `globals.css`, and `lib/storage.call-sites.test.ts` looks for a `@vercel/*`
 * import outside `lib/storage.ts`. `YEO-100` gave the first two one directory
 * list and a guard against a third being written; the other two already were
 * the third and fourth, and `globals`' copy was character-for-character this
 * one — the same "two right values nothing obliges to stay equal" the
 * paragraph above is about.
 *
 * The footprint has two dimensions and they do not have the same answer.
 *
 * **Directories** are common to all four. An unguarded route, a stored-XSS
 * sink, a stray hex and a vendor import are each as wrong under `components/`
 * as under `app/`, so "where is the source" has one answer and it is this
 * list.
 *
 * **Extensions** legitimately differ, and for reasons stronger than taste:
 * `globals` also reads `.css`, because the stylesheet it polices is one;
 * `storage.call-sites` reads the whole JavaScript family, because
 * `eslint.config.mjs` importing a storage vendor would falsify the
 * portability claim exactly as thoroughly as `app/layout.tsx` doing it.
 *
 * That second one is why the dimensions are not collapsed into a single
 * enumerator taking an extension set. `.js` is precisely what `sourceFiles`
 * *refuses* — see `UNSCANNED_EXTENSIONS` — so the one caller whose whole job
 * is scanning what `sourceFiles` will not read cannot be served by widening
 * `sourceFiles`, only by deleting a throw that three other callers need. So
 * `filesUnder` is the shared walk, `sourceFiles` is `filesUnder` plus the
 * refusal, and each scanner names its own extensions beside its own argument
 * for them. This is the one place that trade-off is written down; a caller
 * that re-argues it has probably talked itself into widening the wrong thing.
 */
export const SOURCE_DIRS = ["app", "components", "lib"];

/**
 * The top-level directories that hold code no tripwire has a question to ask
 * of (`YEO-102`).
 *
 * Kept beside `SOURCE_DIRS` rather than inside the test that used to hold it,
 * because "which directories are out of scope, and why" is the other half of
 * "which directories are in scope": a new top-level directory has to land in
 * one list or the other, and keeping the two in different files is how the
 * second answer stops matching the first.
 *
 * - `db` — schema, migrations and scripts. Nothing here renders or answers a
 *   request, so neither tripwire has a question to ask of it.
 * - `test` — the tripwires themselves, and the helpers they are built from. A
 *   fixture in here is *meant* to contain the shapes being scanned for —
 *   `test/inner-html-inventory.test.ts` is full of them — so scanning this
 *   directory would turn every fixture into a call site to be justified.
 *
 * Out of scope for the tripwires is not out of scope for everything, which is
 * the distinction `CODE_DIRS` keeps: `lib/storage.call-sites.test.ts` cares
 * very much what `db/backup.ts` imports.
 */
export const NON_APPLICATION_DIRS = ["db", "test"];

/**
 * Every top-level directory holding code, application or not.
 *
 * Derived rather than written out, so the two halves cannot fail to add up. A
 * scanner whose subject is "anything this repository builds or runs" — today
 * `lib/storage.call-sites.test.ts` — takes this and picks up a new directory
 * the moment somebody categorises it, with no edit of its own that nobody
 * would have thought to make.
 */
export const CODE_DIRS = [...SOURCE_DIRS, ...NON_APPLICATION_DIRS];

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
 *
 * The `.js` and `.jsx` spellings match nothing, and never did — they are
 * filtered out by `SOURCE_EXTENSIONS` long before this set is consulted. What
 * `YEO-100` changed is that the fact is now enforced rather than true by
 * omission: `sourceFiles` refuses to enumerate a directory holding one at all,
 * so it cannot quietly stop being true. They stay because this set answers
 * "what filename makes a directory routable", which is Next's question and has
 * Next's answer; the extension footprint is a separate question with a
 * separate answer, and collapsing the two would leave a reader who widened
 * `SOURCE_EXTENSIONS` having to rediscover this list.
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

/**
 * What the scanners below can parse.
 *
 * `.mts` and `.cts` are in because both are TypeScript,
 * `ts.createSourceFile` reads them, and every check in this file and in
 * `test/inner-html-inventory.ts` is as true of one as of a `.ts`. None exists
 * under these directories today; if one arrives it is scanned, which is the
 * answer that needed no decision.
 *
 * They are spelled out rather than left to the suffix match, which is a fix
 * rather than a preference (`YEO-102`). This list is tested with `endsWith`,
 * and `"x.mts".endsWith(".ts")` is false — so the docblock here claimed a
 * coverage the code did not have, and an `.mts` under `app/` was enumerated
 * by nothing and refused by nothing: exactly the fails-green blind spot
 * `UNSCANNED_EXTENSIONS` exists to make impossible. Nothing changes today,
 * because there is no such file; what changes is that the comment is now
 * true.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * What they cannot parse but a bundler would still build.
 *
 * The other half of `SOURCE_DIRS` — the footprint has two dimensions, and
 * `YEO-100` was filed because only one of them was written down. A `.js` file
 * under `app/` is a route Next serves and `routeFiles` never sees; a `.jsx`
 * under `components/` can render `dangerouslySetInnerHTML` and
 * `lib/sanitize-html.call-sites.test.ts` will not find it. Both suites stay
 * green, because a file that is not enumerated cannot fail an assertion.
 *
 * There are none today, and `sourceFiles` throws rather than skipping so that
 * this stays a fact rather than a habit. That is deliberately not an
 * assertion in one test file: an assertion guards the suite that runs it, and
 * the blind spot belongs to every caller of `sourceFiles`. Refusing the whole
 * directory turns all of them red at once, which is the bargain the rest of
 * this module strikes everywhere else — throw on what is not understood
 * rather than pass over it.
 *
 * The JavaScript family and nothing else, because that is the whole of the
 * gap: `.mts` and `.cts` are named by `SOURCE_EXTENSIONS` and parse
 * correctly, so refusing them would trade real coverage for a decision nobody
 * needs to make.
 */
const UNSCANNED_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

/**
 * The entries in `entries` that a bundler would treat as source and the
 * scanners here cannot read.
 *
 * Split out from `sourceFiles` so `test/route-inventory.footprint.test.ts` can
 * drive it with literals. The branch it guards is unreachable from the real
 * tree — that being the property it exists to hold — so without a fixture it
 * would be code no run had ever executed, which is exactly the state the
 * `YEO-96` review found the marker branches in.
 */
export function unscannedSources(entries: readonly string[]): string[] {
  return entries.filter((entry) =>
    UNSCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext)),
  );
}

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

/** Everything below `dir`, recursively, as the OS spells it. */
function entriesUnder(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), {
    recursive: true,
    encoding: "utf8",
  });
}

/**
 * Every file under `dirs` with one of `extensions`, repo-relative.
 *
 * The one walk of the tree in this repository (`YEO-102`), and deliberately
 * the *only* thing it is: it takes an extension set and asks nothing about
 * it, because the four scanners' extension sets legitimately differ — see
 * `SOURCE_DIRS` for that argument in full.
 *
 * Callers that parse what they find want `sourceFiles` instead, which is this
 * plus the refusal. This one enumerates whatever it is asked for, which is
 * only safe for a caller whose extension set is a *superset* of what it can
 * read: `lib/storage.call-sites.test.ts` greps text for a package name and so
 * has no file it can be handed and fail to understand.
 */
export function filesUnder(
  dirs: readonly string[],
  extensions: readonly string[],
): string[] {
  return dirs.flatMap((dir) =>
    entriesUnder(dir)
      .filter((entry) => extensions.some((ext) => entry.endsWith(ext)))
      .map((entry) => join(dir, entry)),
  );
}

/**
 * Top-level modules with one of `extensions` — `auth.ts`, `proxy.ts`,
 * `next.config.ts`, `eslint.config.mjs`.
 *
 * The repository root is not in `CODE_DIRS` and should not be: it is not a
 * directory of application code, it is where the configuration lives, and
 * walking it recursively would descend into `node_modules` and `.next`. But a
 * seam that holds inside `app/` and `lib/` and not in `next.config.ts` is not
 * a seam, so a scanner asking about imports rather than about routes wants
 * these too.
 *
 * Non-recursive, and never refuses: JavaScript at the root is
 * `eslint.config.mjs` doing its job, not a route nobody can parse.
 *
 * `isFile()` is asked of the directory entry rather than of a `statSync`,
 * which means a symlink at the root is not followed and so is not returned.
 * There are none today. If one ever stands in for a config file, this is the
 * line that would quietly stop scanning it.
 */
export function rootFiles(extensions: readonly string[]): string[] {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => extensions.some((ext) => name.endsWith(ext)));
}

/**
 * Every file in this repository that could hold a scanner, repo-relative.
 *
 * The subject of `test/route-inventory.footprint.test.ts`' anti-copy guard,
 * and deliberately the widest footprint here: a guard that asks "who else
 * walks the tree" has to be able to see everyone, including a walker in a
 * directory the tripwires have no question for and one written in a language
 * they refuse to parse.
 *
 * Both extension lists, then, rather than `SOURCE_EXTENSIONS` alone — and no
 * refusal, because refusing here would mean the guard could not run in the
 * one situation where an unreadable file had just appeared. `filesUnder`'s
 * caveat is satisfied: the guard parses rather than executes, and
 * `ts.createSourceFile` reads every spelling in both lists.
 */
export function repositorySources(): string[] {
  const extensions = [...SOURCE_EXTENSIONS, ...UNSCANNED_EXTENSIONS];

  return [...filesUnder(CODE_DIRS, extensions), ...rootFiles(extensions)];
}

/**
 * Every source file under `dirs`, repo-relative.
 *
 * The one enumerator, shared by both tripwires (`YEO-100`). Throws on a file
 * it would have to skip — see `UNSCANNED_EXTENSIONS` for why that is a throw
 * and not a filter.
 *
 * The extension set is not a parameter, and that is the point rather than an
 * omission (`YEO-102`). Making it one would mean a caller could pass `.js`,
 * and the throw below — which exists so a route tripwire cannot silently skip
 * a file it cannot parse — would have to become optional to let them. A
 * caller that genuinely needs a wider net wants `filesUnder`, which promises
 * nothing about being able to read what it returns.
 */
export function sourceFiles(dirs: readonly string[] = SOURCE_DIRS): string[] {
  for (const dir of dirs) {
    const unreadable = unscannedSources(entriesUnder(dir));
    if (unreadable.length > 0) {
      throw new Error(
        `${dir} contains ${unreadable.length} file(s) no tripwire in this ` +
          `repository can read: ${unreadable.sort().join(", ")}. Everything ` +
          `here is parsed as ${SOURCE_EXTENSIONS.join(" or ")}, so a route ` +
          `in one of these is invisible to app/auth-boundary.test.ts and a ` +
          `dangerouslySetInnerHTML in one is invisible to ` +
          `lib/sanitize-html.call-sites.test.ts. Rename it to TypeScript, or ` +
          `widen SOURCE_EXTENSIONS having checked that every scanner still ` +
          `understands it — do not delete this check.`,
      );
    }
  }

  return filesUnder(dirs, SOURCE_EXTENSIONS);
}

/**
 * Top-level directories holding TypeScript that are in neither `SOURCE_DIRS`
 * nor `NON_APPLICATION_DIRS`.
 *
 * The direction `SOURCE_DIRS` cannot check about itself. Walking the shared
 * list can only find a directory that has gone missing *from* the tree; this
 * walks the tree instead, so a new top-level directory of TypeScript is an
 * error until somebody decides which side of the line it is on. Shared and
 * complete are different properties, and only one of them is established by
 * having one list.
 *
 * Dotted directories and `node_modules` are skipped: neither is code anyone
 * in this repository wrote.
 */
export function uncategorisedCodeDirs(): string[] {
  const holdsTypeScript = (dir: string): boolean =>
    entriesUnder(dir).some((entry) => /\.[mc]?tsx?$/.test(entry));

  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .filter((name) => !CODE_DIRS.includes(name))
    .filter(holdsTypeScript);
}

/**
 * The calls that enumerate a directory.
 *
 * Matched by name only — `readdirSync(…)` and `fs.readdirSync(…)` both count,
 * and nothing here resolves what the name is bound to. That is the right
 * strictness for a tripwire: the cost of a false positive is one line in
 * `NOT_A_SOURCE_FOOTPRINT` explaining what the file is really walking, and
 * the cost of a false negative is the thing `YEO-102` was filed about.
 *
 * The async spellings and `globSync` are in the set although nothing uses
 * them, because "which fs call did they reach for" is not a decision anyone
 * should have to get right for the guard to hold.
 */
const WALK_CALLS = new Set([
  "readdirSync",
  "readdir",
  "opendirSync",
  "opendir",
  "globSync",
  "glob",
]);

export type FootprintUsage = {
  /** Walk calls the file makes itself, by name and in source order. */
  walks: string[];
  /**
   * Array literals whose every element is a string and at least one of which
   * names a directory in `CODE_DIRS` — a second answer to "where is the
   * source".
   */
  directoryLists: string[][];
};

/**
 * The two ways a file can hold a source footprint of its own.
 *
 * Read from the syntax tree rather than the source text, which is a change
 * from the guard `YEO-100` wrote (`YEO-102`). A text search for `readdirSync`
 * cannot tell the call from `lib/storage.ts`'s docblock explaining that "S3's
 * `ListObjectsV2`, GCS, R2, Azure and `readdir` all take a prefix", nor from
 * the guard's own assertion naming it. Both would have had to be exempted,
 * and an exemption for a file that never walked anything is an exemption
 * nobody can later tell from a real one.
 *
 * `directoryLists` is as literal as `WALK_CALLS` is, and for the same
 * reasons: it wants an array whose every element is a plain string, so
 * `[APP_DIR, "components", "lib"]` — one identifier among the literals —
 * reads as no list at all, and a footprint spelled as object keys or built by
 * a `.map` reads as none either. So does a walk reached through a renamed
 * binding, `const { readdirSync: walk } = …`. Each of those is a copy made on
 * purpose by somebody who would have had to work at it; the copy this exists
 * to catch is the one made without noticing, which is the shape both of
 * `YEO-102`'s offenders had.
 *
 * What it also does not look for is a scanner that gives up on walking and
 * writes out `["app/page.tsx", …]` instead. That was tried and removed: naming
 * individual files with a reason beside each is a pattern every one of these
 * suites legitimately uses — `app/auth-boundary.test.ts` justifies its inline
 * action files that way and `lib/storage.call-sites.test.ts`' `ALLOWED` is the
 * same shape — so the check found four honest lists and no dishonest one. A
 * frozen list of filenames is caught instead by the vacuity assertion every
 * one of these suites already carries: it stops growing, and the count stops
 * matching the tree.
 *
 * @param file repo-relative
 */
export function footprintUsage(file: string): FootprintUsage {
  return footprintUsageOfSource(read(file), file);
}

/**
 * `footprintUsage`, against source text rather than a path.
 *
 * Exported so `test/route-inventory.footprint.test.ts` can drive both halves
 * with literals. The repository is expected to contain exactly one file that
 * trips either of them, so without fixtures the branches that *find*
 * something would be executed once each and the ones that find nothing would
 * carry the whole suite — the state `YEO-96` found the marker branches in.
 *
 * @param source the module's text
 * @param fileName only used to pick TS vs TSX parsing, and in diagnostics
 */
export function footprintUsageOfSource(
  source: string,
  fileName = "fixture.ts",
): FootprintUsage {
  const parsed = parseSource(source, fileName);

  const walks: string[] = [];
  const directoryLists: string[][] = [];

  // Never satisfied: every walk and every list is wanted, not just the first.
  some(parsed, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : null;
      if (callee && WALK_CALLS.has(callee)) walks.push(callee);
    }

    if (ts.isArrayLiteralExpression(node)) {
      // Every element a plain string, so `[join("app", "globals.css")]` — a
      // list of *files*, which every one of these scanners legitimately has —
      // is not mistaken for a list of directories.
      const strings = node.elements.filter(ts.isStringLiteral);
      if (
        strings.length === node.elements.length &&
        strings.some((element) => CODE_DIRS.includes(element.text))
      ) {
        directoryLists.push(strings.map((element) => element.text));
      }
    }

    return false;
  });

  return { walks, directoryLists };
}

/** Every file under `app/` with one of `SOURCE_EXTENSIONS`, repo-relative. */
export function appSourceFiles(): string[] {
  return sourceFiles([APP_DIR]);
}

/** Every file a `"use server"` module could be, repo-relative. */
export function actionSourceFiles(): string[] {
  return sourceFiles(SOURCE_DIRS);
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
 * Parse a source file the way the compiler does.
 *
 * Everything below reads the syntax tree rather than the source text, and the
 * reason is not tidiness. This repository documents itself in long docblocks,
 * several of which discuss `requireSession()` by name — `app/wiki/[slug]/
 * history/[revisionId]/restore/page.tsx` explains where its guard lives — and
 * a text search cannot tell that sentence from the call. It also cannot tell
 * a call from a commented-out one, which is the false green that matters:
 * `// await requireSession();` is exactly what a half-finished edit leaves
 * behind, and it would have satisfied a regex.
 *
 * `typescript` is already a devDependency, so the real scanner is free.
 */
function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    // `.jsx` as well as `.tsx`: nothing under `SOURCE_DIRS` can be one, but
    // `repositorySources` reaches directories where it could be, and a JSX
    // file parsed as plain TypeScript is a syntax-error tree the scanners
    // would find nothing in.
    /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function parse(file: string): ts.SourceFile {
  return parseSource(read(file), file);
}

/** Depth-first walk, stopping as soon as `visit` is satisfied. */
function some(node: ts.Node, visit: (node: ts.Node) => boolean): boolean {
  if (visit(node)) return true;
  return ts.forEachChild(node, (child) => some(child, visit)) ?? false;
}

/** `"use server"` — as a directive, which is a string on its own. */
function isUseServerDirective(node: ts.Node): boolean {
  return (
    ts.isExpressionStatement(node) &&
    ts.isStringLiteral(node.expression) &&
    node.expression.text === "use server"
  );
}

/**
 * Whether a file's *module* is a server-action module — `"use server"` in the
 * directive prologue, which makes every export a POST endpoint.
 */
function hasModuleDirective(source: ts.SourceFile): boolean {
  // The prologue is the run of bare string statements a module opens with; a
  // directive after the first real statement is not a directive at all.
  for (const statement of source.statements) {
    if (isUseServerDirective(statement)) return true;
    const isPrologue =
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression);
    if (!isPrologue) return false;
  }
  return false;
}

/**
 * Every module-level `"use server"` file under `app/`, repo-relative.
 *
 * These are the ones a test can import and call, because their actions are
 * module exports.
 */
export function serverActionModules(): string[] {
  return actionSourceFiles()
    .filter((file) => hasModuleDirective(parse(file)))
    .sort();
}

/**
 * Files that use `"use server"` somewhere *other* than the module prologue —
 * an action declared inside a component or a closure.
 *
 * An inline action is a real POST endpoint with no importable name, so
 * `app/auth-boundary.test.ts` cannot call it and prove it rejects an
 * anonymous caller. Rather than let that be an invisible gap, the test treats
 * every such file as something to be justified.
 */
export function inlineServerActionFiles(): string[] {
  return actionSourceFiles()
    .filter((file) => {
      const source = parse(file);
      if (hasModuleDirective(source)) return false;
      return some(source, (node) => {
        // A directive inside a function body, rather than at the top of the
        // file: `async () => { "use server"; ... }`.
        if (!ts.isBlock(node)) return false;
        return node.statements.some(isUseServerDirective);
      });
    })
    .sort();
}

/** The two shapes of the guard. Neither is optional; one of them is required. */
const BOUNDARY_CALLS = new Set(["requireSession", "requireSessionOr401"]);

/** Where the guard has to come from, so a local decoy cannot stand in for it. */
const BOUNDARY_MODULE = "@/lib/session";

export type BoundaryUsage = {
  /** Whether the file imports a guard from `@/lib/session`. */
  imported: boolean;
  /**
   * The guards actually *called*, by their canonical name and in source
   * order. A commented-out call is not a call.
   */
  called: string[];
  /**
   * Local declarations that reuse a guard's name.
   *
   * Always expected to be empty, and not a stylistic objection. Matching a
   * call by name cannot see scope, so a local `async function
   * requireSession() {}` *inside* the component shadows the import at every
   * call site below it while leaving both the import and the call looking
   * exactly right. Rather than resolve scopes — which means a whole
   * `ts.Program` and a type checker to answer one question — the name is
   * simply not available to be redeclared. There is no legitimate reason to
   * name a local binding after the auth boundary, so forbidding it costs
   * nothing and closes the hole outright.
   */
  shadowed: string[];
};

/**
 * How a route file uses the auth boundary.
 *
 * Three things have to line up, and no two of them are enough:
 *
 * - **The import**, so a bare call is not an unresolved name.
 * - **The call**, because an import with no call is what a guard leaves
 *   behind when somebody deletes the line but not the line above it.
 * - **No shadowing**, because the first two can both be satisfied by code
 *   that never reaches `@/lib/session` at runtime.
 *
 * Named and namespace imports are both understood, and an alias resolves to
 * the name it was imported under — `import { requireSession as guard }` is a
 * guard, and reporting it as unguarded would be a baffling failure.
 */
export function boundaryUsage(file: string): BoundaryUsage {
  return boundaryUsageOfSource(read(file), file);
}

/**
 * `boundaryUsage`, against source text rather than a path.
 *
 * Exported for `test/route-inventory.boundary-usage.test.ts`. The alias and
 * namespace-import branches above are not reachable from any file in this
 * repository — every route imports the guard plainly — so without fixtures
 * they would be code that only a mutation run has ever executed. A checker
 * the whole suite rests on should not have untested branches, least of all
 * the ones whose job is to *avoid* a false failure.
 *
 * @param source the module's text
 * @param fileName only used to pick TS vs TSX parsing, and in diagnostics
 */
export function boundaryUsageOfSource(
  source: string,
  fileName = "fixture.tsx",
): BoundaryUsage {
  const parsed = parseSource(source, fileName);

  /** Local name in this file → the guard it refers to. */
  const bound = new Map<string, string>();
  /** Local names bound to the whole module: `import * as session from …`. */
  const namespaces = new Set<string>();
  const shadowed: string[] = [];

  // ESM import declarations are always top level, so there is no need to walk
  // the tree for them.
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const isBoundary = statement.moduleSpecifier.text === BOUNDARY_MODULE;
    const clause = statement.importClause;
    if (!clause) continue;

    // A default import named after a guard is somebody else's module.
    if (clause.name && BOUNDARY_CALLS.has(clause.name.text) && !isBoundary) {
      shadowed.push(clause.name.text);
    }

    const named = clause.namedBindings;
    if (!named) continue;

    if (ts.isNamespaceImport(named)) {
      if (isBoundary) namespaces.add(named.name.text);
      continue;
    }

    for (const element of named.elements) {
      // `propertyName` is set only for `{ a as b }`, where it holds `a`.
      const canonical = (element.propertyName ?? element.name).text;
      if (isBoundary && BOUNDARY_CALLS.has(canonical)) {
        bound.set(element.name.text, canonical);
      } else if (BOUNDARY_CALLS.has(element.name.text)) {
        // The guard's name, imported from somewhere that is not the boundary.
        shadowed.push(element.name.text);
      }
    }
  }

  const called: string[] = [];

  // The visitor never short-circuits: every call is wanted, not just the
  // first, so `some` here is being used to walk the whole tree.
  some(parsed, (node) => {
    const declared = declaresBoundaryName(node);
    if (declared) shadowed.push(declared);

    if (ts.isCallExpression(node)) {
      // `requireSession()`
      if (ts.isIdentifier(node.expression)) {
        const canonical = bound.get(node.expression.text);
        if (canonical) called.push(canonical);
      }
      // `session.requireSession()`
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaces.has(node.expression.expression.text) &&
        BOUNDARY_CALLS.has(node.expression.name.text)
      ) {
        called.push(node.expression.name.text);
      }
    }

    return false;
  });

  return {
    imported: bound.size > 0 || namespaces.size > 0,
    called,
    shadowed,
  };
}

/**
 * The name a declaration binds, when that name is one of the guards'.
 *
 * Covers every form that can introduce a binding a later call would resolve
 * to ahead of the import: a function or class declaration, a `const`, a
 * parameter, and a destructured element.
 */
function declaresBoundaryName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name && BOUNDARY_CALLS.has(node.name.text)
      ? node.name.text
      : null;
  }

  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node)
  ) {
    return ts.isIdentifier(node.name) && BOUNDARY_CALLS.has(node.name.text)
      ? node.name.text
      : null;
  }

  return null;
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
 * `unstable_doesMiddlewareMatch` is Next's own testing helper for exactly
 * this question, and it takes the matcher config directly, so nothing here
 * reimplements or approximates the compilation. It is the reason `proxy.ts`
 * can be read as text and still answered about faithfully: the patterns are
 * extracted from the source, but what they *mean* is decided by Next.
 */
export function proxyProtects(pathname: string): boolean {
  return unstable_doesMiddlewareMatch({
    config: { matcher: proxyMatchers() },
    url: pathname,
  });
}

/** `app/wiki/[slug]/page.tsx` reads the same on Windows as it does here. */
export function posixPath(file: string): string {
  return file.split(sep).join(posix.sep);
}
