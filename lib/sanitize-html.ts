import sanitize from "sanitize-html";

/**
 * The allowlist for entry bodies.
 *
 * TipTap output goes into `pages.body_html` / `revisions.body_html` — a plain
 * `text` column — and comes back out through `dangerouslySetInnerHTML`. There
 * is no RLS under the database and no CSP over the browser (see
 * docs/architecture.md), so this module is the only thing standing between a
 * payload pasted in from elsewhere on the web and a script running with a
 * signed-in author's session.
 *
 * ## Where this gets called
 *
 * Both ends of the round trip, deliberately:
 *
 * - **On write** — the save action (E1-T3, `YEO-17`) sanitises before the
 *   `revisions` insert and the `pages` update, so nothing unsafe is ever
 *   stored.
 * - **On read** — the page route (E1-T1, `YEO-15`) sanitises again before
 *   `dangerouslySetInnerHTML`.
 *
 * Sanitising on write alone would be a bet that every row in the table was
 * written by a version of the code that had this module wired in — a bet that
 * loses on the first row that predates it, the first `db:seed`, and the first
 * manual `UPDATE` in a Supabase SQL console. Sanitising on read alone would
 * leave the stored value hostile, which turns every future consumer (search
 * indexing, diffs, export) into a place the same bug can reappear. So: both.
 * The function is idempotent, so doing it twice costs only the parse.
 *
 * ## Why the list is this short
 *
 * It is the E1-T2 toolbar (`YEO-16`) and nothing else: bold, italic, heading,
 * bullet list, link. That toolbar is a product decision rather than a scoping
 * compromise, and an allowlist wider than the toolbar is a set of tags no
 * button can produce and therefore no one has looked at.
 *
 * This couples the two tickets on purpose, and the coupling runs one way: the
 * editor must not be able to emit anything absent from here. Concretely, E1-T2
 * should configure StarterKit so the extensions with no button are off —
 * `orderedList`, `blockquote`, `codeBlock`, `code`, `horizontalRule`,
 * `strike`, `underline` — and cap `heading` at the levels below. Anything it
 * emits regardless is silently dropped here, which shows up as content loss,
 * not as an error.
 */
export const ALLOWED_TAGS = [
  // Structural. TipTap emits these whatever the toolbar offers.
  "p",
  "br",
  // Bold and italic. TipTap's Bold/Italic marks render as these, not b/i.
  "strong",
  "em",
  // Heading. h1 is the article title, which the page chrome owns (E11-T2), so
  // body headings start at h2 — the same convention Wikipedia articles use.
  "h2",
  "h3",
  "h4",
  // Bullet list. Not `ol`: the toolbar has no ordered-list button.
  "ul",
  "li",
  // Link.
  "a",
  // Deliberately absent: `img`. The toolbar's image button is disabled until
  // E5-T3 (`YEO-43`), which is blocked on this module precisely so that
  // enabling the button and widening the allowlist happen in one change.
] as const;

/**
 * Attributes, per tag. Everything else goes, which is what disposes of `on*`
 * handlers without needing to enumerate them: `onerror` is not on this list,
 * so it is not kept. `style` and `class` are absent too — presentation belongs
 * to the stylesheet (E11-T1), and a `style` attribute is a real vector
 * (`position: fixed` overlays, and historically `expression()`).
 *
 * `id` is absent as well. E11-T3's pinned table of contents needs stable
 * heading ids, but those are derived at render time from the heading text, not
 * authored — an author-supplied `id` can collide with the app's own DOM.
 */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
};

/**
 * Schemes a link may use. Site-relative hrefs (`/wiki/rose`, `#section`) carry
 * no scheme and are allowed separately — see `allowProtocolRelative` below,
 * which is what stops `//evil.example` from sneaking through as "relative".
 *
 * `javascript:` and `data:` are absent, which is the point of the list.
 */
export const ALLOWED_URL_SCHEMES = ["http", "https", "mailto"] as const;

/**
 * The allowlist as sanitize-html wants it.
 *
 * Exported so that a pass which has to *add* something to the output can start
 * from this object rather than restate it. `lib/article-outline.ts` is the one
 * that does: it re-runs the sanitiser with `id` permitted on `h2`/`h3`/`h4` so
 * that the heading ids E11-T3 and E11-T4 anchor to are written by the
 * sanitiser itself rather than spliced into its output afterwards. Deriving
 * from this constant is what keeps that pass from quietly falling behind a
 * tightening made here.
 *
 * Widen it nowhere else. A caller that wants a *looser* allowlist wants a
 * different module.
 */
export const SANITIZE_OPTIONS: sanitize.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: Object.fromEntries(
    Object.entries(ALLOWED_ATTRIBUTES).map(([tag, attrs]) => [tag, [...attrs]]),
  ),
  allowedSchemes: [...ALLOWED_URL_SCHEMES],
  allowedSchemesAppliedToAttributes: ["href"],
  // `//evil.example/x` inherits the page's scheme. Without this it reads as a
  // scheme-less — and therefore "relative" — URL and survives.
  allowProtocolRelative: false,
  // Drop disallowed tags rather than escaping them into visible source.
  disallowedTagsMode: "discard",
  // Tags whose *contents* are dropped along with the tag. Without this,
  // discarding `<script>` keeps `alert(1)` as body text. The first four are
  // sanitize-html's defaults; the rest are here because their contents are
  // markup or code rather than prose the reader was meant to see.
  nonTextTags: [
    "script",
    "style",
    "textarea",
    "option",
    "iframe",
    "noscript",
    "template",
    "title",
  ],
  // Anything after a `</html>` in the input is discarded rather than parsed as
  // a sibling document — a known shape for smuggling markup past a sanitiser.
  enforceHtmlBoundary: true,
};

/**
 * Reduce untrusted HTML to the allowlist above.
 *
 * Accepts `null`/`undefined` for the read path's convenience — `body_html`
 * defaults to the empty string, and a page with no body should render as
 * nothing rather than as a crash.
 *
 * @example
 * ```ts
 * // E1-T3, before writing:
 * const bodyHtml = sanitizeHtml(formData.get("body")?.toString());
 * // E1-T1, before rendering:
 * <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(page.bodyHtml) }} />
 * ```
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return "";
  return sanitize(html, SANITIZE_OPTIONS);
}
