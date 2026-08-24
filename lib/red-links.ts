import { entryHref, entrySlugFromHref } from "@/lib/entry-links";
import {
  collapseWhitespace,
  decodeHtmlEscapes,
  escapeHtmlAttribute,
  HTML_TOKEN_PATTERN,
} from "@/lib/html-text";

/**
 * Red links (E11-T6, `YEO-76`): a link to an entry nobody has written yet is
 * red, and clicking it offers to write it.
 *
 * ## Why resolution happens here and not in the stored HTML
 *
 * docs/architecture.md settles the shape, and E2-T5 (`YEO-28`) built to it: a
 * link between entries is stored as a plain site-relative
 * `<a href="/wiki/rose-hall">` and nothing else, because
 * `lib/sanitize-html.ts` allows exactly one attribute on an `a` and it is
 * `href`. A `class="new"` written into the body would be stripped on the next
 * save, so nothing about "this target exists" can be denormalised into the
 * document. **The href is the marker**, and whether it resolves is a question
 * asked of `pages.slug` at render time.
 *
 * That is what makes the fourth acceptance criterion true for free: an entry
 * that gets written turns every link pointing at it blue on the next render,
 * with no sweep over stored HTML and no edit to the linking entry. Renaming
 * and deleting work the same way in reverse.
 *
 * ## One query per page render
 *
 * The criterion to design around rather than retrofit, because a version that
 * issues one query per link looks identical on screen. The shape here makes
 * the wrong version hard to write:
 *
 *   - `scanEntryLinks` walks the body **once** and returns every internal
 *     link it found, slug and text together.
 *   - the lookup is handed a `Set` of slugs and called **once**, whatever the
 *     body contains — see `resolveEntryLinks`, and the call-count assertions
 *     in `lib/red-links.test.ts`.
 *   - `markMissingEntryLinks` is synchronous and takes an already-resolved
 *     set, so there is no `await` inside the rewrite for a per-link query to
 *     hide in.
 *
 * A body with no internal links issues no query at all.
 *
 * ## What E11-T5 should call
 *
 * The person infobox (`YEO-75`) renders its links as React elements from
 * person rows rather than as a chunk of HTML, so it needs the *decision*
 * without the rewrite. That is `entryLinkProps`, which both this module's
 * rewrite and the infobox's `<Link>`s go through, so "what a red link is" has
 * one description. The infobox resolves its slugs with the same
 * `findExistingSlugs` the page render uses — collected into that one query
 * rather than added as a second.
 *
 * ## Order matters, once
 *
 * This runs **after** `sanitizeHtml`, never before. The rewrite adds `class`
 * and `title` to the anchors it touches, and the sanitiser's allowlist would
 * strip both — sanitising afterwards would silently undo the whole feature.
 * `lib/red-links.test.ts` states that as an assertion so it is a fact about
 * the code rather than a note in a docblock.
 */

/** The class Vector 2022 paints red. See `a.new` in `app/globals.css`. */
export const NEW_LINK_CLASS = "new";

/**
 * The tooltip on a red link, spelled exactly as the acceptance criterion
 * asks. MediaWiki's own wording, and worth keeping: it says the entry is
 * absent rather than that something has gone wrong, which is the whole
 * difference between a red link and a broken one.
 */
export const MISSING_ENTRY_TITLE = "page does not exist";

/** Where E1-T8's create flow lives. */
const NEW_ENTRY_PATH = "/wiki/new";

/**
 * The query parameter `/wiki/new` reads a suggested title from.
 *
 * A suggestion and not an instruction: the form pre-fills the field with it
 * and the author can type over it. Nothing downstream trusts it — the address
 * of the new entry is still derived from whatever is finally submitted, by
 * `lib/create-page.ts`, which has no slug parameter for a reason.
 */
export const NEW_ENTRY_TITLE_PARAM = "title";

/**
 * The address of the create flow, pre-titled.
 *
 * `URLSearchParams` rather than interpolation: a link's text is prose, and
 * prose contains `&`, `#` and `?`. Each of those interpolated raw would
 * truncate the query or invent a second parameter, and the author would land
 * on the form with half a name in it.
 *
 * @param title the text to pre-fill the title field with
 * @returns a site-relative href, e.g. `/wiki/new?title=Walter+Hale`
 */
export function newEntryHref(title: string): string {
  const query = new URLSearchParams({ [NEW_ENTRY_TITLE_PARAM]: title });
  return `${NEW_ENTRY_PATH}?${query}`;
}

/**
 * The link a caller should render for one entry target — blue if the entry
 * exists, red if it does not.
 *
 * Shaped as props rather than as markup so a React call site can spread it
 * onto a `<Link>` and this module's own rewrite can serialise it, without
 * either owning the rule. `className` and `title` are absent on a resolved
 * link rather than empty, so spreading adds no attributes at all in the
 * ordinary case.
 */
export type EntryLinkProps = {
  href: string;
  className?: string;
  title?: string;
};

/** Something a link points at, and how the link reads. */
export type EntryLinkTarget = {
  /**
   * The `pages.slug` the link names, or `null` when there is no slug to name.
   *
   * Nullable for E11-T5's sake, and it is not a convenience. A link in the
   * article body always has a slug — it was parsed out of an href. A row in a
   * person infobox often does not: "Father: Walter Hale" is a person whose
   * `individuals.page_id` is empty, so no entry has ever existed for them and
   * there is no address to have been written down. That is the *purest* red
   * link there is, and an API that demanded a slug would have forced the
   * infobox to invent one.
   */
  slug: string | null;
  /**
   * The link's text, as a reader sees it — what a red link pre-fills the
   * create form with.
   */
  text: string;
};

/**
 * What to render for a link to this target.
 *
 * The one description of what a red link *is*, so the article body and the
 * infobox (E11-T5) cannot disagree about it.
 *
 * A red link points at the create flow rather than at the missing entry,
 * which is what turns "someone should write about Walter" into one click. It
 * falls back to the slug when the link has no text of its own — an anchor
 * wrapping only markup, or an empty one — because a create form pre-filled
 * with nothing is worse than one pre-filled with an approximation.
 *
 * ## Why it takes the whole set
 *
 * Rather than a boolean the caller worked out. The set is the result of the
 * page's one query, so passing it here is what makes "one query per render"
 * survive a second caller: a component handed a resolved set can render fifty
 * links without asking anything, and there is no per-target `exists` for
 * someone to compute with a lookup of their own.
 *
 * @param target the slug to link to, if any, and the text to offer as a title
 * @param existingSlugs the slugs that exist, from `findExistingSlugs`
 * @returns props for an `a`/`Link`: `href`, and on a red link the class and
 *   tooltip
 */
export function entryLinkProps(
  target: EntryLinkTarget,
  existingSlugs: ReadonlySet<string>,
): EntryLinkProps {
  if (target.slug !== null && existingSlugs.has(target.slug)) {
    return { href: entryHref(target.slug) };
  }

  return {
    href: newEntryHref(target.text || target.slug || ""),
    className: NEW_LINK_CLASS,
    title: MISSING_ENTRY_TITLE,
  };
}

/**
 * One internal link found in a body, and where its opening tag sits.
 *
 * The offsets are what let the rewrite replace an opening `<a>` and leave
 * every other byte of the document untouched, rather than re-serialising a
 * parse tree and hoping the escaping survives the round trip.
 */
export type EntryLinkOccurrence = {
  /** The `pages.slug` this link points at, decoded. */
  slug: string;
  /** The link's text, decoded and with whitespace collapsed. */
  text: string;
  /** Index of the `<` of the opening tag. */
  start: number;
  /** Index just past the `>` of the opening tag. */
  end: number;
};

/** An anchor the scan is inside; `slug` is null for a link that leaves the site. */
type OpenAnchor = {
  slug: string | null;
  text: string;
  start: number;
  end: number;
};

/**
 * Read one attribute out of the raw attribute run of an opening tag.
 *
 * The quoting cases are all handled even though `sanitize-html` always emits
 * double quotes, because this reads a *stored* body and a row written before
 * the sanitiser existed — or by a hand-run `UPDATE` — is exactly the input
 * that is neither well-formed nor anyone's fault. An attribute it cannot
 * parse yields `null`, which reads downstream as "not an entry link" and
 * leaves the tag alone.
 */
const ATTRIBUTE_PATTERN =
  /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attributeValue(attributes: string, name: string): string | null {
  for (const match of attributes.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1].toLowerCase() !== name) continue;
    // Exactly one of the three value alternatives fired; the others are empty.
    return match[2] || match[3] || match[4] || "";
  }
  return null;
}

/**
 * Every link to an entry in a body, in document order, in one pass.
 *
 * ## What counts as an entry link
 *
 * `entrySlugFromHref` decides, and nothing here second-guesses it. That is
 * the point of importing it rather than matching `/wiki/` again: E2-T5 wrote
 * down the hard cases deliberately — an absolute URL naming this host is
 * still external, `/wiki/rose/edit` is a route rather than an entry, a
 * fragment belongs to the entry it hangs off, and a broken percent-escape
 * yields `null` instead of throwing `URIError` out of a render. A second
 * parser here would be a second set of answers to those questions, and the
 * link panel and the red links would drift apart.
 *
 * ## Why a stack
 *
 * An `a` whose href is external still has to be *tracked*, or its `</a>`
 * would close an entry link opened around it and put the wrong text on the
 * wrong link. Nested anchors are not valid HTML and `sanitize-html` does not
 * emit them, so the stack is rarely deeper than one — it is here so that a
 * malformed stored body degrades to a link this module ignores rather than to
 * text attributed to the wrong target.
 *
 * An anchor that is never closed is dropped: it contributes no occurrence and
 * so stays blue. That is the safe direction to fail in — a link left alone,
 * never a rewrite against a target that was never read.
 *
 * @param html a body, already through `sanitizeHtml`
 * @returns every internal link, in the order their opening tags appear
 */
export function scanEntryLinks(html: string): EntryLinkOccurrence[] {
  const found: EntryLinkOccurrence[] = [];
  /** The anchors currently open, outermost first. */
  const open: OpenAnchor[] = [];

  for (const token of html.matchAll(HTML_TOKEN_PATTERN)) {
    // Read by index rather than destructured with `!== undefined` checks:
    // `RegExpExecArray` types every group as `string`, so comparing one
    // against `undefined` is a type error even though an unmatched
    // alternative really does leave the slot empty. Truthiness says the same
    // thing here — none of these alternatives can match an empty string, so
    // an empty slot is always one that did not fire.
    const closing = token[1];
    const tagName = token[2];
    const attributes = token[3];
    const text = token[4];

    if (text) {
      // Only an anchor's own text matters, and only the innermost one's.
      const anchor = open.at(-1);
      if (anchor) anchor.text += text;
      continue;
    }

    // No tag name: the comment alternative matched. Not rendered, not text.
    if (!tagName) continue;
    if (tagName.toLowerCase() !== "a") continue;

    if (closing) {
      const anchor = open.pop();
      // A stray `</a>` in a stored body closes nothing.
      if (!anchor || anchor.slug === null) continue;

      found.push({
        slug: anchor.slug,
        text: collapseWhitespace(decodeHtmlEscapes(anchor.text)),
        start: anchor.start,
        end: anchor.end,
      });
      continue;
    }

    const href = attributeValue(attributes, "href");
    open.push({
      // The href is an attribute *value*, so it arrives escaped — `&amp;`
      // rather than `&`. `entrySlugFromHref` reads a URL, not markup.
      slug: href === null ? null : entrySlugFromHref(decodeHtmlEscapes(href)),
      text: "",
      start: token.index,
      end: token.index + token[0].length,
    });
  }

  // Ordered by where each *opening* tag sits, which is what the rewrite below
  // needs — anchors are recorded on close, so the array is built out of order
  // only when one anchor encloses another.
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Every distinct entry a body links to.
 *
 * The set to hand a lookup: distinct, so an entry mentioned nine times is one
 * value in one query rather than nine.
 *
 * @param html a body, already through `sanitizeHtml`
 * @returns the slugs it links to, each once
 */
export function entryLinkSlugs(html: string): Set<string> {
  return new Set(scanEntryLinks(html).map((link) => link.slug));
}

/**
 * Turn every link whose target is absent into a red link.
 *
 * Synchronous, and takes an already-resolved set — that is what makes "one
 * query per page render" a property of the shape rather than a rule someone
 * has to keep. Links whose target exists are not touched at all, so a body
 * with nothing missing comes out byte-identical to what went in.
 *
 * @param html a body, already through `sanitizeHtml`
 * @param existingSlugs the subset of the body's slugs that exist
 * @param links the scan, when the caller already has one; scanned here if not
 * @returns the same HTML with unresolved links marked
 */
/** No entry exists, for the branch of `entryLinkProps` that says so. */
const EMPTY_SLUGS: ReadonlySet<string> = new Set();

export function markMissingEntryLinks(
  html: string,
  existingSlugs: ReadonlySet<string>,
  links: readonly EntryLinkOccurrence[] = scanEntryLinks(html),
): string {
  let rewritten = "";
  let cursor = 0;

  for (const link of links) {
    if (existingSlugs.has(link.slug)) continue;

    const props = entryLinkProps(
      { slug: link.slug, text: link.text },
      // Known missing — that is what the `has` above just established. Going
      // through `entryLinkProps` regardless is the point: the body and the
      // infobox build a red link from the same three lines.
      EMPTY_SLUGS,
    );

    // Everything between the last rewrite and this opening tag is copied
    // across untouched, which is the whole reason the scan carries offsets:
    // the document is never re-serialised, so no escaping can be lost on the
    // way through.
    rewritten += html.slice(cursor, link.start);
    rewritten +=
      `<a href="${escapeHtmlAttribute(props.href)}"` +
      ` class="${NEW_LINK_CLASS}"` +
      ` title="${escapeHtmlAttribute(MISSING_ENTRY_TITLE)}">`;
    cursor = link.end;
  }

  return rewritten + html.slice(cursor);
}

/**
 * How a caller resolves a set of slugs against `pages.slug`.
 *
 * A parameter rather than an import, for the reason docs/testing.md gives as
 * a general rule ("take it, do not import it"): `lib/pages.ts` imports `@/db`
 * and postgres.js behind it, and this module has to stay loadable in a suite
 * CI runs with no `DATABASE_URL`. It also makes the query count something a
 * unit test can assert directly, which is the criterion that a
 * correct-looking implementation fails silently.
 *
 * `findExistingSlugs` in `lib/pages.ts` is the implementation.
 */
export type ExistingSlugLookup = (
  slugs: ReadonlySet<string>,
) => Promise<ReadonlySet<string>>;

/**
 * Resolve a body's internal links and mark the ones that lead nowhere.
 *
 * The whole feature, as one call: scan once, ask once, rewrite once.
 *
 * @param html a body, already through `sanitizeHtml`
 * @param lookup which of a set of slugs exist — called at most once
 * @returns the body, with unresolved links rendered red
 */
export async function resolveEntryLinks(
  html: string,
  lookup: ExistingSlugLookup,
): Promise<string> {
  const links = scanEntryLinks(html);
  // No internal links, no question to ask. Most bodies in a young wiki.
  if (links.length === 0) return html;

  const existingSlugs = await lookup(new Set(links.map((link) => link.slug)));

  return markMissingEntryLinks(html, existingSlugs, links);
}
