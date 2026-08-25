import { attributeValue, HTML_TOKEN_PATTERN } from "@/lib/html-text";
import { imageKeyFromHref } from "@/lib/storage-key";

/**
 * Which images an entry body refers to (E7-T4, `YEO-54`).
 *
 * ## Why the archive asks the bodies and not the store
 *
 * `lib/storage.ts` exports exactly `put`, `get` and `delete`, and
 * docs/architecture.md#the-storage-seam is explicit that the moment a fourth
 * function appears — `list` among them — the set of hosts that can implement
 * the seam narrows to the ones that agree with Vercel. So there is no
 * enumeration of the store to export from, and there should not be one.
 *
 * What there is instead is a *reference graph*: an image is in the wiki
 * because some body points at it. That is the same question E5-T5's orphan
 * sweep asks from the other side ("referenced by no revision"), which is why
 * both go through `imageKeyFromHref` rather than each matching `/api/images/`
 * for themselves.
 *
 * ## Revisions count, not just the current body
 *
 * A photograph removed from an entry last year is still in the revision that
 * had it, and revisions are append-only — *"nothing is ever destroyed"*
 * (docs/product.md). An export that carried only the images the current
 * bodies use would quietly drop every picture anybody had ever taken out of
 * an entry, and the history would restore with holes in it. So the caller
 * scans both tables and unions the result; see `lib/export-full.ts`.
 *
 * ## This finds nothing today, and that is expected
 *
 * `img` is deliberately absent from `lib/sanitize-html.ts`'s allowlist until
 * E5-T3 (`YEO-43`) enables the toolbar's image button, so no stored body
 * contains one yet. The scan is written against the reference shape
 * docs/architecture.md fixes rather than against today's emptiness: the
 * alternative is an export that silently stops being a backup on the day
 * images start appearing in entries, which is exactly the kind of decay
 * nobody notices until the restore.
 *
 * Nothing here imports `@/db`, so `npm test` drives it with no database — the
 * split `lib/export-tree.ts` describes, on the same line.
 */

/**
 * Every image this application stores that `html` refers to, in the order
 * their tags appear, without repeats.
 *
 * One pass over the body, sharing `HTML_TOKEN_PATTERN` with
 * `lib/content-diff.ts` and `lib/red-links.ts` so that all three agree about
 * what a tag is. An `img` whose `src` is not one of ours — an absolute URL, a
 * `data:` URI, a path that is not under the image route — contributes
 * nothing rather than being an error: an export must not refuse to run
 * because of one odd `src`.
 *
 * @param html a stored body
 * @returns storage keys, deduplicated, in document order
 */
export function scanEntryImages(html: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const token of html.matchAll(HTML_TOKEN_PATTERN)) {
    // Read by index rather than destructured, for the reason `scanEntryLinks`
    // gives: `RegExpExecArray` types every group as `string`, and an
    // alternative that did not fire leaves an empty slot rather than
    // `undefined` as far as the compiler is concerned.
    const closing = token[1];
    const tagName = token[2];
    const attributes = token[3];

    // `img` is void: there is no closing tag, and a stray `</img>` in a
    // stored body carries no `src` to read.
    if (closing) continue;
    if (!tagName || tagName.toLowerCase() !== "img") continue;

    const src = attributeValue(attributes, "src");
    if (src === null) continue;

    // The attribute is stored escaped — `sanitize-html` escapes `&` in
    // attribute values — so an `src` with a query in it arrives as
    // `…?a=1&amp;b=2`. `decodeHtmlEscapes` is not applied here because
    // `imageKeyFromHref` drops the query before it decodes anything, and the
    // key itself is minted from a UUID and cannot contain an escape.
    const key = imageKeyFromHref(src);
    if (key === null) continue;

    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return keys;
}
