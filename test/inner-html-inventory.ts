import { readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { read, repoRoot } from "@/test/route-inventory";

/**
 * Every `dangerouslySetInnerHTML` in the source tree, as a list of call sites
 * (`YEO-96`).
 *
 * `lib/sanitize-html.call-sites.test.ts` is the reason this exists, and the
 * reason it is a syntax tree rather than a regex is the same reason
 * `test/route-inventory.ts` gives for the auth boundary: this repository
 * explains itself in long docblocks, and several of them name the API in
 * prose. `lib/sanitize-html.ts`'s own `@example` block renders a `<div>` in a
 * fenced code sample. The tripwire's previous incarnation counted those, and
 * had to buy them off with whole-file exemptions — which is precisely the
 * granularity `YEO-96` was filed about.
 *
 * ## What counts as a call site
 *
 * Two shapes, because React reaches the sink by two and the substring scan
 * this replaced caught both:
 *
 * - a JSX attribute — `<div dangerouslySetInnerHTML={{ __html: html }} />`;
 * - a property of that name in an **object literal**, which is the same sink
 *   the long way round: `React.createElement("div", { … })`, or a props
 *   object assembled first and then spread into an element.
 *
 * The second shape earns its branch precisely because nothing in this
 * repository writes it today. Swapping "coarse detection of every shape" for
 * "precise detection of one shape" would be a narrowing bought with
 * granularity, and the failure this file exists to prevent is stored XSS —
 * the wrong side on which to economise. A comment is neither shape and a
 * string literal is neither, which is the whole reason for reading a tree
 * rather than the text.
 *
 * ## What it still cannot see
 *
 * It is a tripwire, not a proof, and the limits are worth stating rather than
 * implying. A computed or assembled key — `{ ["dangerously" + rest]: v }` —
 * walks past it. So does any file outside the directories the test hands to
 * `sourceFiles`, or carrying an extension outside `SOURCE_EXTENSIONS`. That
 * footprint is deliberately `test/route-inventory.ts`'s, so the two tripwires
 * cover the same ground, and it is the guard's pre-existing shape rather than
 * anything `YEO-96` narrowed.
 *
 * What it does not do is pass quietly over something it half-understands: a
 * marker comment it cannot parse throws, naming the file and line. A tripwire
 * that ignores a call site it could not classify is a tripwire that reports
 * green on the one call site nobody looked at.
 *
 * The functions here find and describe call sites. They assert nothing — the
 * assertions, and the argument about what "exempt" may mean, live in the test.
 */

/** The attribute that puts a string into the DOM as markup. */
export const INNER_HTML_ATTRIBUTE = "dangerouslySetInnerHTML";

/**
 * The comment that narrows an exemption to one call site.
 *
 * Written at the call site — `/* sanitize-html-exempt: some-id *\/` on the
 * line above it, inside the element's own tag (or above the property, for an
 * object literal) — so it moves with the call site it is about. A line number
 * in a test file would rot on the next edit above it; a comment cannot,
 * because it is not anchored to a position, it is attached to a node.
 *
 * The marker on its own exempts nothing. `lib/sanitize-html.call-sites.test.ts`
 * holds the register of ids that are allowed, with the reason each one exists,
 * and a marker naming an id that is not in it fails the suite. Making that an
 * edit somebody has to justify is the whole point — a self-service exemption
 * written at the call site would be worth less than the comment it replaced.
 */
const MARKER = "sanitize-html-exempt";

/**
 * Whether a comment is *claiming* an exemption at all.
 *
 * Bounded at both ends, so prose that merely discusses the mechanism — "a
 * sanitize-html-exemption would be wrong here" — is not mistaken for a
 * malformed claim and does not throw at somebody who wrote a sentence.
 */
const MARKER_MENTION = new RegExp(`\\b${MARKER}\\b`);

/**
 * `sanitize-html-exempt: some-id`, anywhere in a comment.
 *
 * Ids are lowercase and hyphenated so that a marker reads as an identifier
 * rather than as the start of a sentence, and so the register in
 * `lib/sanitize-html.call-sites.test.ts` can be matched against it exactly.
 */
const MARKER_PATTERN = new RegExp(`\\b${MARKER}\\s*:\\s*([a-z0-9][a-z0-9-]*)`);

export type InnerHtmlCallSite = {
  /** Repo-relative, with the platform's separator. */
  file: string;
  /** 1-based, for a failure message somebody has to act on. */
  line: number;
  /** The exemption this call site claims, or `null` for the ordinary case. */
  marker: string | null;
};

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Every source file under `dirs`, repo-relative. */
export function sourceFiles(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
      .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
      .map((entry) => join(dir, entry)),
  );
}

/** Every `dangerouslySetInnerHTML` in `files`, in file and source order. */
export function innerHtmlCallSites(
  files: readonly string[],
): InnerHtmlCallSite[] {
  return files.flatMap((file) =>
    callSitesInSource(read(file), file).map((site) => ({ file, ...site })),
  );
}

/**
 * `innerHtmlCallSites`, against source text rather than a path.
 *
 * Exported for `test/inner-html-inventory.test.ts`. Most of what this has to
 * get right is not reachable from the real tree — no file in the repository
 * carries a malformed marker or claims an unregistered one — so without
 * fixtures those branches would be code that only a mutation run had ever
 * executed. They are also the branches whose job is to *avoid* a false green,
 * which is the kind of bug that gets an assertion deleted rather than fixed.
 */
export function callSitesInSource(
  source: string,
  fileName: string,
): Omit<InnerHtmlCallSite, "file">[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sites: Omit<InnerHtmlCallSite, "file">[] = [];

  const visit = (node: ts.Node): void => {
    if (isInnerHtmlSink(node)) {
      // `node.pos` is where the *trivia* before the node starts, which is the
      // line the marker comment is on rather than the line the call site is
      // on. `getStart` skips it.
      const line =
        ts.getLineAndCharacterOfPosition(parsed, node.getStart(parsed)).line +
        1;

      sites.push({
        line,
        marker: markerOn(source, node, `${fileName}:${line}`),
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);

  return sites;
}

/** A node that puts a string into the DOM as markup, in either shape. */
type InnerHtmlSink =
  ts.JsxAttribute | ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

/**
 * Whether `node` is one.
 *
 * The object-literal half accepts a quoted key as well as a bare one —
 * `{ "dangerouslySetInnerHTML": … }` renders exactly what the unquoted spelling
 * does, and a guard that could be stepped around with a pair of quotes would
 * not be worth reading a syntax tree for.
 */
function isInnerHtmlSink(node: ts.Node): node is InnerHtmlSink {
  if (ts.isJsxAttribute(node)) {
    return (
      ts.isIdentifier(node.name) && node.name.text === INNER_HTML_ATTRIBUTE
    );
  }

  if (ts.isShorthandPropertyAssignment(node)) {
    return node.name.text === INNER_HTML_ATTRIBUTE;
  }

  if (ts.isPropertyAssignment(node)) {
    return (
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === INNER_HTML_ATTRIBUTE
    );
  }

  return false;
}

/**
 * The exemption a call site claims, read from the comments attached to it.
 *
 * Only the node's own leading trivia counts — the comments between the
 * previous token and this one, which in practice means inside the element's
 * opening tag, or directly above the property in an object literal. A
 * `{/* … *\/}` above the element is a sibling node rather than trivia, and
 * deliberately does not count: an exemption that could be written anywhere
 * near a call site is an exemption that can end up attached to the wrong one
 * after somebody reorders two elements.
 */
function markerOn(
  source: string,
  node: InnerHtmlSink,
  where: string,
): string | null {
  const comments = (ts.getLeadingCommentRanges(source, node.pos) ?? []).map(
    (range) => source.slice(range.pos, range.end),
  );

  const claims = comments.filter((comment) => MARKER_MENTION.test(comment));
  if (claims.length === 0) return null;

  // Two markers on one attribute is not a call site claiming two exemptions,
  // it is an edit half-done — most likely a rename that left the old id
  // behind. Guessing which one is meant would let the stale one live forever.
  if (claims.length > 1) {
    throw new Error(
      `${where}: ${claims.length} \`${MARKER}\` comments on one ` +
        `${INNER_HTML_ATTRIBUTE}. A call site claims one exemption; ` +
        `delete the ones that no longer apply.`,
    );
  }

  const marker = MARKER_PATTERN.exec(claims[0]);

  // A comment that says `sanitize-html-exempt` without naming an id is the
  // failure this whole ticket is about, written smaller: it looks like an
  // exemption to a reader and is nothing to the guard. Returning `null` here
  // would be correct and useless — the call site would then be judged by
  // whether its *file* sanitises, which is the coarse answer being replaced.
  if (!marker) {
    throw new Error(
      `${where}: \`${MARKER}\` comment names no exemption. Write ` +
        `\`${MARKER}: some-id\`, and register that id in ` +
        `lib/sanitize-html.call-sites.test.ts with the reason it exists.`,
    );
  }

  return marker[1];
}
