/**
 * Reading sanitised entry HTML as a stream of tokens, and reading the text
 * back out of it.
 *
 * ## Why this is shared rather than duplicated
 *
 * `lib/content-diff.ts` (E1-T6, `YEO-20`) introduced this scanner and wrote
 * down the reasoning that still governs it: the tag set in an entry body is
 * *closed* — `lib/sanitize-html.ts` guarantees it — so a regex that walks tags
 * and text runs in source order is enough, and pulling `jsdom` into the server
 * bundle to read a handful of tag names out of an allowlisted document would
 * be over-building.
 *
 * E11-T6 (`YEO-76`) needed the same walk for a different question — which
 * `<a>`s point at entries — and a second copy of a regex that has to agree
 * with the sanitiser's output is a second place for that agreement to drift.
 * So the three pieces both modules need live here: the token pattern, the
 * escape decoder, and whitespace normalisation. The parts that differ (what
 * each module *does* with the tokens) stay in the modules.
 *
 * Nothing here imports `@/db` or anything else with a runtime environment, so
 * both callers stay testable under `npm test` — see docs/testing.md.
 */

/**
 * Tags, text runs, and comments, in one pass.
 *
 * Four alternatives in one regex rather than four passes, so the scanner sees
 * the document in source order and a `<` inside a text run cannot be mistaken
 * for a tag it is not. Comments are matched first so that a `>` inside one
 * does not terminate a phantom tag.
 *
 * The groups, in order:
 *
 *   1. the closing slash, present on `</p>` and empty on `<p>`
 *   2. the tag name, as written
 *   3. everything between the tag name and the `>` — the attributes, raw
 *   4. a run of text
 *
 * A match's `index` and `[0].length` locate the token in the source, which is
 * what lets a caller rewrite one tag and leave every other byte of the
 * document exactly as it found it. See `markMissingEntryLinks`.
 *
 * `[^>]*` for the attribute run is safe against the input this scans and only
 * against that input: `sanitize-html` escapes `&`, `<`, `>` and `"` inside
 * attribute values, so a `>` cannot appear in one. A hand-written document
 * that broke that rule would end a tag early here, which degrades to markup
 * this scanner does not recognise rather than to a crash.
 *
 * Declared with `g` and consumed with `matchAll`, which clones the regex
 * rather than advancing `lastIndex` on it — so sharing one module-level
 * pattern between callers is safe.
 */
export const HTML_TOKEN_PATTERN =
  /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>|([^<]+)/g;

/**
 * The four escapes `sanitizeHtml` emits, decoded in one pass.
 *
 * Deliberately not a character-reference decoder. `sanitize-html` parses its
 * input with htmlparser2, which decodes *every* entity in the document —
 * `&mdash;`, `&#8212;`, `&#x2019;`, `&nbsp;` all reach these callers as the
 * characters they name — and re-escapes only `&`, `<`, `>` and `"` on the way
 * out. So those four are the entire set that can still be in a scanned
 * string, and a named table, a decimal branch and a hex branch would each be
 * code no input can reach.
 *
 * One pass matters even for four. Replacing `&amp;` before `&lt;` would turn
 * the *literal* text `&amp;lt;` — which is how a real `&lt;` in the prose is
 * stored — into `<`. Matching all four in one `replace` decodes each `&…;`
 * exactly once.
 */
const ESCAPE_PATTERN = /&(amp|lt|gt|quot);/g;

const ESCAPES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

/**
 * Turn the escapes back into the characters they stand for.
 *
 * @param text a text run or attribute value, as it appears in the source
 * @returns the same text as a reader sees it
 */
export function decodeHtmlEscapes(text: string): string {
  return text.replace(ESCAPE_PATTERN, (_whole, name: string) => ESCAPES[name]);
}

/**
 * Whitespace as the browser renders it: any run of it is one space, and the
 * ends are trimmed.
 *
 * This is what makes both callers indifferent to how the editor happened to
 * pretty-print its output — a diff does not report a re-indented paragraph as
 * an edit, and a red link's suggested title does not arrive with the newline
 * TipTap put after the opening tag. JavaScript's `\s` includes ` `, so a
 * non-breaking space — which renders as a space — collapses with the rest.
 *
 * @param text decoded text, with whatever spacing the source had
 * @returns the same text with runs of whitespace collapsed and the ends
 *   trimmed
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The reverse of `decodeHtmlEscapes`, for a value being written *into* an
 * attribute of generated markup.
 *
 * `markMissingEntryLinks` builds an opening `<a>` tag and the read route hands
 * the result to React as raw HTML, so every value interpolated into it has to
 * be unable to close the attribute or the tag. In practice the two values it
 * writes are a percent-encoded href and a constant, neither of which contains
 * any of these characters — which is exactly why this is here rather than
 * assumed: the assumption is invisible, and one call site that stops holding
 * it is a script tag in a reader's session.
 *
 * ## Why both quote characters
 *
 * Today's only caller writes into `attr="…"`, so escaping `'` changes
 * nothing. It is escaped anyway because the alternative is a function that is
 * safe *by convention* — correct only as long as every future caller
 * remembers which quote it chose — and the convention is exactly the kind
 * that is invisible when it breaks. Covering both makes it safe by
 * construction, at the cost of one character in a character class.
 *
 * This is deliberately **not** the exact inverse of `decodeHtmlEscapes`,
 * which decodes only the four escapes `sanitizeHtml` emits. An escaper being
 * wider than its decoder is the safe direction for the pair to differ in:
 * this one has to cover everything dangerous, that one only has to read back
 * what the sanitiser actually writes.
 *
 * `&` is escaped by being part of the same alternation rather than a separate
 * pass, so an already-escaped `&amp;` cannot be double-escaped.
 *
 * @param value the raw value to place inside an attribute's quotes
 * @returns the value, safe to interpolate into `attr="…"` or `attr='…'`
 */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        // Numeric rather than `&apos;`, which predates HTML5 as an HTML
        // entity and is not decoded by every consumer of a stored string.
        "'": "&#39;",
      })[character] ?? character,
  );
}
