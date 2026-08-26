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
 */
export const SOURCE_DIRS = ["app", "components", "lib"];

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
 * The `.js` and `.jsx` spellings can no longer match anything, since
 * `sourceFiles` refuses to enumerate a directory containing one at all
 * (`YEO-100`). They stay because this set answers "what filename makes a
 * directory routable", which is Next's question and has Next's answer; the
 * extension footprint is a separate question with a separate answer, and
 * collapsing the two would leave a reader who widened `SOURCE_EXTENSIONS`
 * having to rediscover this list.
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
 * Matched as suffixes, which also admits `.mts` and `.cts`. That is left
 * alone rather than tightened: both are TypeScript, `ts.createSourceFile`
 * reads them, and every check in this file and in
 * `test/inner-html-inventory.ts` is as true of one as of a `.ts`. None exists
 * here today; if one arrives it is scanned, which is the answer that needed no
 * decision.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

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
 * gap: `.mts` and `.cts` are already caught by `SOURCE_EXTENSIONS`' suffix
 * match and parse correctly, so refusing them would trade real coverage for a
 * decision nobody needs to make.
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

/**
 * Every source file under `dirs`, repo-relative.
 *
 * The one enumerator, shared by both tripwires (`YEO-100`). Throws on a file
 * it would have to skip — see `UNSCANNED_EXTENSIONS` for why that is a throw
 * and not a filter.
 */
export function sourceFiles(dirs: readonly string[] = SOURCE_DIRS): string[] {
  return dirs.flatMap((dir) => {
    const entries = readdirSync(join(repoRoot, dir), {
      recursive: true,
      encoding: "utf8",
    });

    const unreadable = unscannedSources(entries);
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

    return entries
      .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
      .map((entry) => join(dir, entry));
  });
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
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
