import sanitize from "sanitize-html";

import { imageKeyFromHref } from "@/lib/storage-key";

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
 * bullet list, link, image. That toolbar is a product decision rather than a
 * scoping compromise, and an allowlist wider than the toolbar is a set of tags
 * no button can produce and therefore no one has looked at.
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
  // Photograph (E5-T3, `YEO-43`). The toolbar's image button was shipped
  // disabled precisely so that enabling it and widening this list happened in
  // one change. `src` is restricted further than a tag name can express — see
  // `isStoredImageSrc` below.
  "img",
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
 *
 * `img` carries `src` and `alt` and nothing else. Not `width`/`height`, which
 * are presentation and belong to the stylesheet with everything else; not
 * `srcset`, which is a second list of URLs that would need the same check
 * `src` gets below and would be one more place to forget it; not `loading` or
 * `title`, which no button produces. `alt` is here because an image with no
 * text alternative is unreadable to a screen reader, and E5-T3 seeds one from
 * the file's own name so that every image inserted by the button arrives with
 * one.
 */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  img: ["src", "alt"],
};

/**
 * Whether an `<img src>` names a photograph this application stores.
 *
 * This is the acceptance criterion "`img` and its `src` … restricted to the
 * storage host", and the reason it is a *path* check rather than a hostname
 * check is settled in docs/architecture.md#the-storage-seam:
 *
 * > **The sanitiser allowlist never needs to name a storage host.** Pinning
 * > `img[src]` to `*.blob.vercel-storage.com` would have written the vendor
 * > into the one file that is meant to be about markup, and undone the
 * > portability claim from a direction nothing was watching.
 *
 * The stable reference an entry body carries is a site-relative path of this
 * application's own — `/api/images/ab/<uuid>.jpg` — which `GET /api/images/…`
 * resolves to a freshly signed URL per request, behind the session guard. So
 * "the storage host" as an author's HTML can spell it *is* that route, and
 * the check is `imageKeyFromHref`: the same function `lib/entry-images.ts`
 * uses to decide which images an export must carry, and the same one E5-T5's
 * orphan sweep will use to decide which are referenced. All three agree
 * about what "one of ours" means because there is one function that says.
 *
 * What it refuses is everything else, and each one matters:
 *
 * - **An absolute URL, even to this host.** A body that reaches out to the
 *   network at render time is a body that leaks a reader's IP address and
 *   `Referer` to whoever wrote it — the classic tracking pixel — and this
 *   wiki is behind an email allowlist precisely so that reading it is not
 *   observable from outside. It also ages badly: bodies outlive the domain
 *   they were written on.
 * - **A `data:` URI.** Megabytes of base64 in a `text` column, copied into
 *   every revision, with no key for E5-T5 to sweep and nothing for the export
 *   to find.
 * - **A path that is not under the image route**, or one that is but does not
 *   spell a safe storage key — `imageKeyFromHref` runs the same
 *   `assertSafeStorageKey` the route does.
 */
export function isStoredImageSrc(src: string | undefined): boolean {
  return src !== undefined && imageKeyFromHref(src) !== null;
}

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
  // `src` as well as `href`, so that a `javascript:` or `data:` image loses
  // its attribute before `exclusiveFilter` below ever sees it. Belt and
  // braces: an `img` with no `src` left is dropped whole by that filter.
  allowedSchemesAppliedToAttributes: ["href", "src"],
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
  /**
   * The one rule an allowlist of tags and attributes cannot state: which
   * *values* `img[src]` may hold (E5-T3, `YEO-43`).
   *
   * `exclusiveFilter` drops the whole element rather than only the offending
   * attribute, and that is the difference between a foreign image
   * disappearing and a permanently broken picture icon sitting in the entry.
   * It runs on every element, so the tag is checked first — the predicate has
   * to be false for every `p` and every `a` in the document.
   *
   * `attribs.src` arrives with HTML entities already decoded, which is what
   * `imageKeyFromHref` documents itself as wanting. A percent-escape is *not*
   * decoded here, and must not be: that function decodes the path itself,
   * once, before validating it.
   */
  exclusiveFilter: (frame) =>
    frame.tag === "img" && !isStoredImageSrc(frame.attribs.src),
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
