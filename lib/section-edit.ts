import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { HEADING_LEVELS, type OutlineHeading } from "@/lib/article-outline";
import { entryHref } from "@/lib/entry-links";
import { escapeHtmlAttribute, HTML_TOKEN_PATTERN } from "@/lib/html-text";

/**
 * The `[edit]` beside every heading (E11-T4, `YEO-74`) — where each one points,
 * how it gets into the body, and how the editor at the other end finds the
 * section again.
 *
 * ## It is not section editing, and that is deliberate
 *
 * On Wikipedia `[edit]` opens *only that section*, which is possible because
 * an article is wikitext: it splits on `==` headings and rejoins losslessly.
 * Here an entry is one HTML document written in a WYSIWYG editor, so the same
 * feature would mean cutting `bodyHtml` at heading boundaries, editing a
 * fragment and splicing it back — and a list or a floated image that straddles
 * a heading corrupts the document at every one of those steps. It would also
 * complicate the revision model, which stores whole documents (E1-T6).
 *
 * So `[edit]` opens the **full editor, scrolled to that section with the
 * cursor in it**. The author gets the same affordance — click the heading's
 * `[edit]`, land there ready to type — at none of that risk. True section
 * editing, if it is ever wanted, is its own ticket with its own argument.
 *
 * ## Who may see it
 *
 * Everybody who can see the article, because in this application the two are
 * the same set of people. `proxy.ts` makes every route private, `requireSession`
 * in `lib/session.ts` is the single access boundary, and there is no role,
 * no permission column and no second tier of account behind it: a viewer who
 * can read an entry can already open `/wiki/[slug]/edit` and save it. The
 * ticket's last criterion is conditional — "if that distinction ever exists" —
 * and it does not, so nothing here checks for one. The day it does, the check
 * belongs beside whatever hides the Edit tab in `lib/article-tabs.ts`, and
 * this module's caller stops calling it.
 *
 * ## Why the ids come from `lib/article-outline.ts`
 *
 * Because the contents panel's anchors do (E11-T3, `YEO-73`). The nth id in
 * `readArticleOutline(...).headings` is the id written onto the nth heading in
 * `readArticleOutline(...).html`, so a link built here from the headings lands
 * on the heading rendered from the html. Slugging the text a second time would
 * agree with that for about a week.
 */

/**
 * The heading tags an entry body can hold, derived from the levels rather than
 * written out again.
 *
 * A second literal `["h2", "h3", "h4"]` would be a second answer to a question
 * `lib/article-outline.ts` has already answered, and the two would agree until
 * the day a level was added to one of them. The failure that day would be
 * silent and specific: the counter below only advances on a tag it recognises,
 * so an unrecognised heading would shift every `[edit]` link after it onto the
 * wrong section rather than going missing.
 */
const HEADING_TAGS: ReadonlySet<string> = new Set(
  HEADING_LEVELS.map((level) => `h${level}`),
);

/**
 * The query parameter the editor reads the target section from.
 *
 * A query parameter rather than a fragment, for one reason that settles it:
 * a fragment never reaches the server. The editor route resolves the heading
 * id to a position in the document it is already loading, on the server, and
 * hands the client a number — see `sectionHeadingIndex`. A `#early-life`
 * would have to be read after hydration and resolved in the browser, which
 * means shipping the sanitiser and the outline reader to it.
 *
 * The fragment is also *already taken*: `/wiki/rose-hall#early-life` is the
 * reader's link to that section, and the editor is a different address.
 */
export const SECTION_PARAM = "section";

/**
 * The address of the editor, opened on one section.
 *
 * @param slug the entry's `pages.slug`
 * @param headingId a heading id from `readArticleOutline`
 * @returns a site-relative href, e.g. `/wiki/rose-hall/edit?section=early-life`
 */
export function sectionEditHref(slug: string, headingId: string): string {
  const query = new URLSearchParams({ [SECTION_PARAM]: headingId });
  // `entryHref` already encodes the slug, and it is the one place that decides
  // what an entry's address looks like.
  return `${entryHref(slug)}/edit?${query}`;
}

/**
 * The section a request is asking for, out of the route's `searchParams`.
 *
 * Total, and never throws: a missing parameter, an empty one and a repeated
 * one (`?section=a&section=b`, which Next hands over as an array) all resolve
 * to a single answer. A repeat takes the first, which is the same rule a
 * browser applies to a duplicated fragment — and either way the value is only
 * ever *looked up* in the outline, so an id from anywhere is a heading that
 * exists or a heading that does not.
 *
 * @param value the raw `searchParams[SECTION_PARAM]`
 * @returns the requested heading id, or `null` for no request at all
 */
export function sectionParam(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) return sectionParam(value[0]);
  if (typeof value !== "string" || value === "") return null;
  return value;
}

/**
 * Which heading a section id means, as a position in document order.
 *
 * **An unknown id is not an error.** A heading renamed since the link was
 * rendered is the ordinary case rather than an edge one — ids are derived from
 * heading text and never stored (see `lib/article-outline.ts`), so the first
 * save that retitles a section invalidates every `[edit]` link above it, and
 * an author may well have one open in another tab. The answer is `null`, which
 * the editor route turns into "open normally, at the top". Nothing is said
 * about it: the author asked to edit the entry and the entry is what they got.
 *
 * The result is an *index*, not an id, because that is what survives the trip
 * into the editor. The editor's document is a ProseMirror tree with no ids in
 * it at all — `lib/sanitize-html.ts` allows none through — but its headings
 * are the body's headings in the same order, so "the third heading" resolves
 * on the client without the outline reader, the sanitiser, or either of their
 * dependencies being shipped to the browser.
 *
 * @param headings every heading in the body, from `readArticleOutline`
 * @param sectionId the requested id, from `sectionParam`
 * @returns its index in document order, or `null` if no heading has that id
 */
export function sectionHeadingIndex(
  headings: readonly OutlineHeading[],
  sectionId: string | null,
): number | null {
  if (sectionId === null) return null;
  const index = headings.findIndex((heading) => heading.id === sectionId);
  return index === -1 ? null : index;
}

/**
 * The `[edit]` itself, as markup.
 *
 * Wikipedia's small bracketed style, in E11-T1 tokens: the size, the face and
 * the placement are `.wiki-editsection` in `app/globals.css`, and there is not
 * a colour here — the anchor takes the one blue the palette has from the base
 * `a` rule.
 *
 * The brackets are `aria-hidden` because they are punctuation drawn around a
 * link rather than anything to read out; MediaWiki puts them in the markup
 * too, rather than in `::before`, so that they are copied with the text and
 * survive a stylesheet that does not load. The `title` is the same sentence
 * MediaWiki uses, and it is a `title` rather than an `aria-label` on purpose:
 * an `aria-label` becomes the link's accessible name, and the link is inside
 * the heading, so it would replace "edit" in the heading's own name with the
 * heading's text a second time.
 *
 * The leading space is the one departure from MediaWiki's markup, and it is
 * there for the same accessible name. The link sits inside the heading, so the
 * name is the heading's text and the link's text concatenated — without a text
 * node between them a screen reader announces "Early lifeedit". The space is
 * *not* `aria-hidden`, because being read is its entire job, and it costs
 * nothing on screen: it is trailing whitespace at the end of a line, and what
 * follows it is floated out of the flow anyway.
 */
function sectionEditLink(slug: string, heading: OutlineHeading): string {
  const href = escapeHtmlAttribute(sectionEditHref(slug, heading.id));
  // A heading can have no text at all: an empty `<h2>` the author left behind,
  // or one holding nothing but an empty `<strong>`. It still gets an id
  // (`FALLBACK_HEADING_ID`) and still gets an `[edit]` — there is simply no
  // section name to put in the tooltip.
  const title = escapeHtmlAttribute(
    heading.text === "" ? "Edit section" : `Edit section: ${heading.text}`,
  );

  return (
    " " +
    '<span class="wiki-editsection">' +
    '<span aria-hidden="true">[</span>' +
    `<a href="${href}" title="${title}">edit</a>` +
    '<span aria-hidden="true">]</span>' +
    "</span>"
  );
}

/**
 * Put an `[edit]` at the end of every heading in a body.
 *
 * ## Why this splices HTML rather than rendering components
 *
 * Because the link has to sit *inside* the heading, and the heading is one
 * element in the middle of a body that React is handed as a single string of
 * raw HTML. A component can render beside the article or after it, never into
 * the middle of that string. MediaWiki's own markup has the `[edit]` inside
 * the heading for the same reason its skin does — it floats to the end of the
 * heading's line, above the rule that `h2` carries.
 *
 * The cost, stated plainly: the heading's accessible name gains the word
 * "edit". That is the trade MediaWiki made for a decade, and the alternative —
 * wrapping every heading in a flex container and moving `h1, h2`'s bottom rule
 * onto the wrapper — is a change to the base type scale of the whole site for
 * the benefit of one word.
 *
 * ## Why it is safe to run where it does
 *
 * This is **not** a sanitiser pass. It walks the tokens
 * (`lib/html-text.ts` — the same scanner `lib/red-links.ts` and
 * `lib/content-diff.ts` use), copies every byte it is given, and inserts a
 * fixed shape of markup before each heading's closing tag. Nothing is
 * re-serialised and no attribute is dropped, so it cannot undo the red-link
 * rewrite the way a second `sanitizeHtml` would — which is the ordering trap
 * `lib/red-links.test.ts` pins down.
 *
 * The article route runs it *between* the outline and the red links, so the
 * red-link rewrite stays the last thing to touch the document. That order is
 * asserted in `lib/section-edit.test.ts`: an `[edit]` link is never mistaken
 * for an entry link and turned red (`entrySlugFromHref` rejects `/wiki/x/edit`
 * as the deeper path it is), and a genuine red link still comes out red with
 * the `[edit]` links in the string.
 *
 * A body with no headings comes back byte-identical, which is the other half
 * of "no headings, no chrome" — the contents panel already renders nothing.
 *
 * @param html the body, from `readArticleOutline().html`
 * @param headings the headings of that same body, in document order
 * @param slug the entry the headings belong to
 * @returns the same body with an `[edit]` inside each heading
 */
export function insertSectionEditLinks(
  html: string,
  headings: readonly OutlineHeading[],
  slug: string,
): string {
  if (headings.length === 0) return html;

  let rewritten = "";
  let cursor = 0;
  let index = 0;
  /**
   * The heading tag currently open, or `null`.
   *
   * One value rather than a stack, because a heading cannot contain another
   * one — and that is guaranteed by the input rather than assumed of it. This
   * runs on `sanitize-html`'s output, which is the serialisation of a real
   * HTML5 parse: the parser closes an open heading when it meets the next one,
   * and closes an open `p` around a heading, so `<h2>a<h3>b</h3></h2>` cannot
   * survive to reach this loop. `collectHeadings` in `lib/article-outline.ts`
   * counts on the same guarantee, which is what keeps the nth heading here the
   * nth heading there.
   */
  let open: string | null = null;

  for (const token of html.matchAll(HTML_TOKEN_PATTERN)) {
    const [, closing, tagName] = token;
    // No tag name: a text run or a comment. Neither can hold a heading.
    if (!tagName) continue;

    const tag = tagName.toLowerCase();
    if (!HEADING_TAGS.has(tag)) continue;

    if (!closing) {
      open = tag;
      continue;
    }

    // A `</h2>` closing nothing is malformed markup that the sanitiser does
    // not emit; if it ever arrives, it closes no heading and consumes no id.
    if (open !== tag) continue;
    open = null;

    const heading = headings[index];
    index += 1;
    // More headings in the document than in the list. The two come from one
    // call to `readArticleOutline`, so this cannot happen — and if it ever
    // does, an `[edit]` pointing at the wrong section is worse than none.
    if (heading === undefined) break;

    // Everything up to this closing tag, copied across untouched, and the
    // link inserted just inside it.
    rewritten += html.slice(cursor, token.index);
    rewritten += sectionEditLink(slug, heading);
    cursor = token.index;
  }

  return rewritten + html.slice(cursor);
}

/**
 * Where the nth heading is in an editor document.
 *
 * The client half of `sectionHeadingIndex`. It counts `heading` nodes in
 * document order — every one of them, since the editor is configured with
 * levels 2, 3 and 4 and no others (`lib/editor-extensions.ts`), which is the
 * same set `readArticleOutline` reads. So the nth heading here is the nth
 * heading there, and the index carried through the URL means the same thing at
 * both ends.
 *
 * `null` for an index past the end, which is another way a stale link degrades
 * rather than throws: an editor that opens at the top is a working editor.
 *
 * The ProseMirror import is a *type* import, so this module stays free of any
 * runtime dependency on the editor and its callers on the server pay nothing
 * for it.
 *
 * @param doc the editor's document, `editor.state.doc`
 * @param index the heading's position in document order, from zero
 * @returns the document position of that heading node, or `null`
 */
export function headingNodePosition(
  doc: ProseMirrorNode,
  index: number,
): number | null {
  if (index < 0) return null;

  let seen = 0;
  let found: number | null = null;

  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name !== "heading") return true;

    if (seen === index) found = pos;
    seen += 1;
    // Nothing inside a heading is a heading.
    return false;
  });

  return found;
}
