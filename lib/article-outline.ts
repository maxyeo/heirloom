import sanitize from "sanitize-html";

import { FALLBACK_SLUG, slugFromTitle } from "@/lib/entry-slug";
import { ALLOWED_ATTRIBUTES, SANITIZE_OPTIONS } from "@/lib/sanitize-html";

/**
 * An entry's section structure, read off its body at render time (E11-T3,
 * `YEO-73`).
 *
 * ## Why nothing here is stored
 *
 * A heading's id is a function of its text and its position among the other
 * headings, and both change the moment an author edits the article. Storing
 * the id would mean storing an answer to a question the next save re-asks:
 * rename "Early life" to "Childhood" and a stored `#early-life` still resolves,
 * still looks fine in a link, and now points at the wrong section — or at
 * nothing, silently. Recomputing on every render costs one parse of a few
 * kilobytes and cannot go stale, so that is what this does.
 *
 * The other half of the same argument is that `lib/sanitize-html.ts` does not
 * allow an `id` attribute through at all, deliberately: an id an author can
 * type is an id that can collide with the application's own DOM. So the ids
 * here are the only ids a body ever has, and this module is the only thing
 * that mints them.
 *
 * ## Who else needs this
 *
 * **E11-T4 (`YEO-74`)**, the section `[edit]` links. It has to link to exactly
 * the ids the contents panel anchors to, which is why the derivation is an
 * exported function over `bodyHtml` rather than something a component works
 * out for itself while rendering. Two implementations of "text becomes an id"
 * would agree for about a week, and the disagreement would show up as anchors
 * that scroll nowhere rather than as a failing build.
 *
 * ## Why the sanitiser does the writing
 *
 * `readArticleOutline` returns the body *with the ids in it*, and it gets them
 * there by running `sanitize-html` a second time with a `transformTags` that
 * replaces each heading's attributes with the one id this module chose. It
 * would be shorter to `String.replace` the `<h2>` tags in the already-sanitised
 * string, and it would work, right up until something upstream hands this
 * function HTML that has not been through the allowlist. Going back through
 * the sanitiser means the value this module returns is sanitiser output no
 * matter what it was given — injecting ids cannot become a way around the
 * pipeline, because the injection *is* the pipeline. It also costs nothing in
 * fidelity: `sanitizeHtml` is idempotent, so a second pass over an already
 * clean body changes only the headings.
 *
 * Two passes rather than one because `transformTags` fires on the opening tag,
 * before the heading's text has been parsed, and the id is derived from that
 * text. So: one pass to read the headings, one to write the ids back. Both
 * passes parse the same string with the same options, so the nth heading of
 * the first is the nth heading of the second.
 */

/** The heading levels an entry body can contain — see `ALLOWED_TAGS`. */
export const HEADING_LEVELS = [2, 3, 4] as const;

export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export type OutlineHeading = {
  /** The `id` written onto the heading, and so the fragment that reaches it. */
  id: string;
  level: HeadingLevel;
  /** The heading's text, with markup removed and entities decoded. */
  text: string;
};

/** A heading plus the headings nested under it. See `nestHeadings`. */
export type OutlineNode = OutlineHeading & { children: OutlineNode[] };

export type ArticleOutline = {
  /** The body, sanitised, with an `id` on every heading. */
  html: string;
  /** Every heading in the body, in document order. */
  headings: OutlineHeading[];
};

/**
 * The id given to a heading whose text contains no letters or digits — "—",
 * "…", an emoji on its own.
 *
 * `slugFromTitle` has its own answer for that case (`FALLBACK_SLUG`, "entry"),
 * and it is the wrong word here: this is a section of an entry, not an entry.
 * Deduplication does the rest, so a body with two such headings gets `section`
 * and `section-2` rather than one unreachable anchor.
 */
export const FALLBACK_HEADING_ID = "section";

/**
 * The empty element the shell leaves in the sidebar for the article route's
 * contents panel to be rendered into (`components/AppShell.tsx`).
 *
 * It is declared in `lib/` rather than beside the component because
 * `RESERVED_HEADING_IDS` below has to know the ids the panel occupies, and a
 * `lib/` module importing from `components/` would invert the layering the
 * rest of `lib/` keeps.
 */
export const ARTICLE_CONTENTS_SLOT_ID = "site-contents";

/**
 * Ids the page chrome has already taken.
 *
 * A heading id has to be unique in the *document*, not merely among the
 * headings: two elements sharing an id is invalid HTML, and the one that
 * `getElementById` and `#fragment` navigation find is whichever comes first —
 * which is the chrome, since all of it renders above the article. An entry
 * whose author wrote a section called "Site sidebar" would otherwise have one
 * contents-panel link that scrolls to the navigation menu.
 *
 * This is the same guard `RESERVED_SLUGS` in `lib/entry-slug.ts` puts on entry
 * addresses, for the same reason, and it works the same way: the name counts
 * as taken, so the first heading to want it gets the `-2`. The literals are
 * repeated from the components that declare them — `components/AppShell.tsx`
 * (`SIDEBAR_ID` and `CONTENT_ID`), `components/SiteSidebar.tsx` (its
 * `-heading`) and `components/ArticleContents.tsx` — because a `lib/` module
 * reaching into `components/` would invert the layering the rest of `lib/`
 * keeps. `lib/article-outline.test.ts` checks the set against those files, so
 * a renamed id cannot quietly stop being reserved.
 *
 * Only the chrome that renders *on an article page* belongs here. The tree
 * canvas's own skip target (`TREE_SKIP_TARGET_ID`, `YEO-108`) deliberately does
 * not: `/tree` renders no article body, so there is no heading for it to
 * collide with, and reserving it would take a word away from every entry in
 * the wiki to prevent a collision that cannot happen.
 */
export const RESERVED_HEADING_IDS: ReadonlySet<string> = new Set([
  // components/AppShell.tsx — the `<nav>` the hamburger's `aria-controls`
  // points at, and the heading `components/SiteSidebar.tsx` labels it with.
  "site-sidebar",
  "site-sidebar-heading",
  // components/AppShell.tsx — the content region, and so where `YEO-108`'s
  // "skip to content" link lands.
  "site-content",
  // components/ArticleContents.tsx — the contents panel's own three.
  ARTICLE_CONTENTS_SLOT_ID,
  `${ARTICLE_CONTENTS_SLOT_ID}-heading`,
  `${ARTICLE_CONTENTS_SLOT_ID}-list`,
]);

/** The tags a body heading can be, and the level each one means. */
const HEADING_TAGS = new Map<string, HeadingLevel>([
  ["h2", 2],
  ["h3", 3],
  ["h4", 4],
]);

/**
 * The entities `sanitize-html` puts back into text, undone.
 *
 * The parser hands text to `textFilter` already re-escaped — `Salt & Pepper`
 * arrives as `Salt &amp; Pepper` — and that string is the wrong thing to slug
 * or to render as a label: React escapes what it prints, so an undecoded
 * `&amp;` reaches the reader as the five characters `&amp;`.
 *
 * One `replace` with an alternation rather than five chained ones, because
 * chaining gets the order wrong in a way that is easy to miss: undoing `&amp;`
 * first turns the literal text `&amp;lt;` into `&lt;` and the next pass turns
 * that into `<`. A single pass consumes each entity once and moves past it.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|#39);/g;

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * A heading's text as a person reads it: entities decoded, whitespace
 * collapsed, ends trimmed.
 *
 * The collapse matters because the parser splits text at every entity and
 * every child tag, and an author who typed a line break inside a heading gets
 * a newline in the middle of it. A contents entry is one line.
 */
function headingText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/**
 * The id a heading's text asks for, before anything is done about collisions.
 *
 * Delegates to `slugFromTitle` rather than slugging again: that function is
 * already the repository's answer to "text becomes a URL-safe name", accents,
 * apostrophes, non-Latin scripts and all, and a second answer would differ
 * from it in exactly the cases nobody tests. The one thing it decides
 * differently is the empty case, which it answers with the word "entry" — so
 * that case is settled here, before delegating.
 *
 * Deterministic and total: the same text always gives the same id, and every
 * text gives one. Both are load-bearing. `slugCandidate`'s random tail, which
 * `lib/entry-slug.ts` reaches for once numbered addresses run out, would be
 * actively wrong here — a heading id has to be the same on this render as on
 * the last one, or every link into the article breaks on reload.
 *
 * @param text the heading's text, as `readArticleOutline` read it
 * @returns a base id of Unicode letters, digits and hyphens, never empty
 */
export function headingId(text: string): string {
  if (!/[\p{L}\p{N}]/u.test(text)) return FALLBACK_HEADING_ID;

  const slug = slugFromTitle(text);
  // Defensive: `slugFromTitle` cannot return the fallback for text that has a
  // letter or a digit in it, and if that ever changes, "entry" is still not
  // the word this module wants.
  return slug === FALLBACK_SLUG ? FALLBACK_HEADING_ID : slug;
}

/**
 * `base`, or the first `base-2`, `base-3`, … that nothing has claimed.
 *
 * Counting from 2 for the reason `slugCandidate` gives: that is how a person
 * counts a second thing with the same name, and `early-life-1` implies an
 * `early-life-0` that does not exist. The count is unbounded — an article with
 * forty sections called "Notes" is absurd, but it is an absurdity that has to
 * produce forty working anchors rather than a repeat.
 */
function claimId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Where the collector is while walking the body: inside a heading, or not. */
type OpenHeading = { tag: string; index: number };

/**
 * Pass one: every heading in the body, with its level and its text.
 *
 * `transformTags` gives the opening tag, `onCloseTag` gives the matching close
 * and `textFilter` gives every run of text in between — including the text
 * inside a `<strong>` or an `<a>` nested in the heading, which is why the
 * "am I inside a heading" question is answered by the open/close pair rather
 * than by `textFilter`'s own `tagName` argument. That argument is the text's
 * *immediate* parent, so for `<h2><a href="…">Rose Hall</a></h2>` it is `a`.
 *
 * Every hook returns its input unchanged. This pass exists for its side
 * effects; the string it produces is thrown away.
 */
function collectHeadings(
  bodyHtml: string,
): { level: HeadingLevel; raw: string }[] {
  const collected: { level: HeadingLevel; raw: string }[] = [];
  let open: OpenHeading | null = null;

  const transformTags = Object.fromEntries(
    [...HEADING_TAGS].map(([tag, level]) => [
      tag,
      (tagName: string, attribs: sanitize.Attributes) => {
        collected.push({ level, raw: "" });
        open = { tag, index: collected.length - 1 };
        return { tagName, attribs };
      },
    ]),
  );

  sanitize(bodyHtml, {
    ...SANITIZE_OPTIONS,
    transformTags,
    onCloseTag: (name) => {
      const current: OpenHeading | null = open;
      if (current && name === current.tag) open = null;
    },
    textFilter: (text) => {
      const current: OpenHeading | null = open;
      if (current) collected[current.index].raw += text;
      return text;
    },
  });

  return collected;
}

/**
 * Pass two: the body again, with each heading's attributes replaced by its id.
 *
 * `allowedAttributes` is widened to permit `id` on the three heading tags and
 * nowhere else, and the transform *replaces* the attribute object rather than
 * adding to it — so an `id` that arrived on the input, from whatever source,
 * is discarded here rather than merged with. The widening is local to this
 * call; `sanitizeHtml` itself still allows no `id` anywhere.
 */
function writeHeadingIds(bodyHtml: string, ids: readonly string[]): string {
  let next = 0;

  const transformTags = Object.fromEntries(
    [...HEADING_TAGS.keys()].map((tag) => [
      tag,
      (tagName: string): sanitize.Tag => {
        const id = ids[next];
        next += 1;
        // `undefined` only if the two passes disagreed about how many headings
        // the body has, which they cannot; an attribute-less heading is a
        // better failure than `id=""`.
        return { tagName, attribs: id === undefined ? {} : { id } };
      },
    ]),
  );

  return sanitize(bodyHtml, {
    ...SANITIZE_OPTIONS,
    allowedAttributes: {
      ...Object.fromEntries(
        Object.entries(ALLOWED_ATTRIBUTES).map(([tag, attrs]) => [
          tag,
          [...attrs],
        ]),
      ),
      ...Object.fromEntries(
        [...HEADING_TAGS.keys()].map((tag) => [tag, ["id"]]),
      ),
    },
    transformTags,
  });
}

/**
 * Read an entry body's sections, and give every heading in it an id.
 *
 * This is the function E11-T4 (`YEO-74`) shares: the ids in `headings` are the
 * ids in `html`, in the same order, so a section `[edit]` link built from one
 * reaches the heading rendered from the other.
 *
 * The returned `html` is sanitiser output — see this module's header — so it
 * is what belongs in `dangerouslySetInnerHTML`, not the string that was passed
 * in. A body with no headings comes back with an empty `headings` array, which
 * is what tells the article route to render no contents panel at all.
 *
 * @param bodyHtml the entry's body; already sanitised at both ends of the
 *   round trip (see `lib/sanitize-html.ts`), and sanitised again here
 * @returns the body with heading ids, and the headings in document order
 *
 * @example
 * ```ts
 * const outline = readArticleOutline(sanitizeHtml(entry.bodyHtml));
 * // outline.headings → [{ id: "early-life", level: 2, text: "Early life" }]
 * // outline.html     → '<h2 id="early-life">Early life</h2>…'
 * ```
 */
export function readArticleOutline(bodyHtml: string): ArticleOutline {
  if (!bodyHtml) return { html: "", headings: [] };

  const taken = new Set(RESERVED_HEADING_IDS);
  const headings = collectHeadings(bodyHtml).map(({ level, raw }) => {
    const text = headingText(raw);
    return { id: claimId(headingId(text), taken), level, text };
  });

  return {
    html: writeHeadingIds(
      bodyHtml,
      headings.map((heading) => heading.id),
    ),
    headings,
  };
}

/**
 * The flat list of headings as the tree the contents panel draws.
 *
 * A heading nests under the nearest preceding heading of a *shallower* level,
 * which is the rule that makes a jumped level behave sensibly: an `h4` after
 * an `h2` with no `h3` between them is a child of that `h2` rather than the
 * start of a phantom level, and an article that opens with an `h3` — perfectly
 * possible, since nothing stops an author picking "Heading 3" first — puts it
 * at the top rather than dropping it.
 *
 * Kept separate from `readArticleOutline` because the two answer different
 * questions and only one of them is shared: E11-T4 wants a heading's id, in
 * document order, and has no use for the nesting.
 */
export function nestHeadings(
  headings: readonly OutlineHeading[],
): OutlineNode[] {
  const roots: OutlineNode[] = [];
  /** The path from the root to the last heading placed, deepest last. */
  const ancestors: OutlineNode[] = [];

  for (const heading of headings) {
    const node: OutlineNode = { ...heading, children: [] };

    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].level >= heading.level
    ) {
      ancestors.pop();
    }

    const parent = ancestors[ancestors.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);

    ancestors.push(node);
  }

  return roots;
}
