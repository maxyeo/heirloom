import ts from "typescript";

import { read } from "@/test/route-inventory";

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
 * ## What it still cannot see (`YEO-100`)
 *
 * It is a tripwire, not a proof, and the limits are worth stating rather than
 * implying. `YEO-96` stated them; `YEO-100` was filed because stating a limit
 * is not the same as deciding about it, and a docblock full of conceded
 * weaknesses is the same "sentence as the weakest possible enforcement"
 * argument that `YEO-96` itself was filed on, one level up. Each of the four
 * now ends somewhere a reader can find the conclusion:
 *
 * - **An assembled key** — `{ ["dangerously" + rest]: v }` — still walks past,
 *   now as a declined proposal with the reasoning at `isInnerHtmlSink`. A
 *   computed key that is spelled out in full no longer does.
 * - **A key that is not a sink at all** — the price of matching every object
 *   literal — has an answer at `isInnerHtmlSink` for when it first bites.
 * - **The extension footprint** is no longer a list to be trusted:
 *   `test/route-inventory.ts` refuses to enumerate a directory holding a file
 *   it cannot parse, so the blind spot cannot open quietly.
 * - **The directory footprint** is `SOURCE_DIRS` in `test/route-inventory.ts`,
 *   imported rather than copied, so this tripwire and the auth boundary cover
 *   the same ground by construction rather than by both being remembered.
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
 *
 * ## An object literal that never reaches React (`YEO-100`)
 *
 * Nothing here asks whether the object could reach React, so
 * `const featureCounters = { dangerouslySetInnerHTML: 0 };` in a module that
 * renders nothing is a call site, and would demand a marker comment and a
 * registered id — with a written justification — for an integer.
 *
 * That is the deliberate price of matching every object literal rather than a
 * defect in it. Narrowing to "the shapes we are sure reach React" is exactly
 * what the `YEO-96` review caught as a false green, and the failure being
 * guarded is stored XSS, which is the wrong side on which to economise. What
 * `YEO-100` settles is not the matcher but what happens the first time this
 * bites something real, because deciding that under pressure in a pull request
 * about something else is how a whole-file exemption gets reinvented.
 *
 * **It takes the ordinary marker.** `sanitize-html-exempt: some-id`, in
 * `lib/sanitize-html.call-sites.test.ts`'s register like any other, with "this
 * object is not props, it is a counter" as the reason. There is deliberately
 * no second `sanitize-html-not-a-sink` vocabulary.
 *
 * Partly because a counter-marker would be a second register at the same cost
 * as the first, and a reader at a call site would have to know which of two
 * words applied to them. But mainly because of what the two words ask for. A
 * `not-a-sink` marker is a claim that the *matcher* is wrong, and the mistake
 * it invites — labelling something that is props as not-props — fails open,
 * and fails open silently, since the register would then hold an entry saying
 * the guard need not apply and no assertion could contradict it. The mistake
 * `sanitize-html-exempt` invites is a reviewer disagreeing with a written
 * safety argument, which is a conversation rather than a hole. Both cost one
 * line; only one of them asks the writer to justify safety rather than
 * classification, and safety is what the register is read for.
 *
 * It is also already partly self-correcting: the register asserts each id
 * matches exactly one call site, so an entry left behind when the counter is
 * deleted fails loudly rather than quietly widening to cover whatever is added
 * next to it.
 *
 * ## Computed keys (`YEO-100`)
 *
 * A computed key that is spelled out in full — `{ ["dangerouslySetInnerHTML"]:
 * … }`, or the same thing in a template literal with nothing substituted into
 * it — **is** a call site. It is the quoted key with two more characters
 * around it: the compiler folds it to the same property name before anything
 * else sees it, React reads it identically, and the argument about the pair of
 * quotes applies unchanged to a pair of brackets. That half is closed.
 *
 * An **assembled** key — `{ ["dangerously" + rest]: v }` — walks past, and
 * after `YEO-100` it does so as a decision. It is undecidable in general
 * without evaluating the expression, so the only implementable version is a
 * proxy: fail on any computed key in an object that also looks like props.
 * That is declined, for three reasons.
 *
 * First, "looks like props" is the same guess this file refuses to make above,
 * pointed the other way — and here it would be guessing in order to *raise* a
 * failure rather than to suppress one, on `{ [kind]: … }` in every lookup
 * table and reducer under `lib/`.
 *
 * Second, and worse, of the two ways to quiet such a failure neither is any
 * good. Rewriting the key rearranges working code to satisfy a scanner. A
 * marker means a register entry whose justification is "this expression does
 * not evaluate to that string" — a claim no reviewer can check by reading the
 * call site, unlike "this HTML has already been through the allowlist" or
 * "this script is a constant", which are the entries there now. A register of
 * verifiable arguments is worth reading; one diluted with unverifiable ones
 * gets skimmed, and then the verifiable ones stop being read either.
 *
 * Third, the threat model does not support the cost. This guards against a
 * contributor rendering a database string because it was already a string —
 * nobody assembles this key by accident. Somebody deliberately hiding a sink
 * from a syntax-tree scanner has cheaper routes that no per-node matcher
 * reaches at all: `Object.assign`, a key held in a variable, a `ref.current
 * .innerHTML =`. Closing the spelled-out spelling above removes an accident;
 * chasing the rest would be a proof, and this is a tripwire.
 *
 * What would reopen it: an assembled key appearing in this repository for any
 * legitimate reason. That would be evidence the shape is idiomatic here, and
 * the trade above is the only thing holding the answer in place.
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
    return staticKeyOf(node.name) === INNER_HTML_ATTRIBUTE;
  }

  return false;
}

/**
 * The property name a key is known to be, or `null` when it takes running the
 * program to find out.
 *
 * Every spelling the compiler folds to a string on its own is one it can be
 * matched by; everything else — a numeric key, a private name, an expression
 * with a variable anywhere in it — is `null`, which is a "no" this file
 * declines to guess at rather than a "no" it has established. See the note on
 * computed keys above for why that is where the line sits.
 */
function staticKeyOf(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;

  if (ts.isComputedPropertyName(name)) {
    const key = name.expression;
    return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
      ? key.text
      : null;
  }

  return null;
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
