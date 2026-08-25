/**
 * Turning a chosen photograph into the two images that get stored (E5-T4,
 * `YEO-44`).
 *
 * ## Why this is not in `lib/portrait.ts`
 *
 * It was, for about an hour, and `lib/gedcom.purity.test.ts` refused it. That
 * test walks the *whole import closure* of the GEDCOM parser and mapper and
 * fails if it reaches anything at all, and the path is short: a person's
 * record now has a portrait key on it, so `lib/individual-input.ts` validates
 * one, so everything `lib/portrait.ts` imports becomes something the GEDCOM
 * parser imports. With the upload arithmetic in there, that closure grew
 * `lib/image-upload.ts` and with it `lib/image-metadata.ts` — a byte-level
 * Exif scrubber, reachable from a file parser that will never see an image.
 *
 * The test was right, and the fix is the split rather than a wider allowlist.
 * Two different questions were living in one module:
 *
 * - **What a portrait *is*** — which key names one, how it becomes a `src`,
 *   which of the two a node loads. Every reader asks these, including the
 *   validator on the import path. That is `lib/portrait.ts`, and it depends
 *   on nothing but text handling and what a storage key is allowed to look
 *   like.
 * - **How a portrait is *made*** — how big, how many bytes, what encoding.
 *   Exactly one caller asks these: `components/PortraitField.tsx`, at the
 *   moment somebody picks a file. That is this module, and it is where the
 *   upload endpoint's cap belongs.
 *
 * The general rule is worth keeping: a module on the record's read path
 * should not import the write path's dependencies, because the read path is
 * reachable from everywhere.
 */

import { type Dimensions, scaledTo, shouldReencode } from "./image-scale";
import { MAX_UPLOAD_BYTES } from "./image-endpoint";
import { PORTRAIT_THUMB_MAX_EDGE } from "./portrait";

/**
 * The longest edge a stored *portrait* may have, in image pixels.
 *
 * The detail panel is 320 pixels wide, so 1600 is five times more than
 * anything on screen needs — and that is the point. This is an archive of a
 * family's photographs, and the copy it keeps should still be worth having
 * when somebody opens it full-screen, or prints it, or exports the lot
 * (E7-T4). The cap exists to clear {@link MAX_UPLOAD_BYTES}, not to decide
 * what a photograph is worth.
 *
 * It is a ceiling and not a target: {@link shouldReencode} leaves anything
 * already under it — and under the byte cap — completely untouched, original
 * bytes and all.
 */
export const PORTRAIT_MAX_EDGE = 1600;

/**
 * Whether the chosen photograph has to be re-encoded before it can be
 * uploaded as the portrait.
 *
 * A thin binding of {@link shouldReencode} to this application's two caps, so
 * that the component doing the canvas work names one function rather than
 * four numbers. The byte cap is the endpoint's own — imported rather than
 * restated, because a copy of `4 * 1024 * 1024` here would be a second place
 * to change it and the failure of forgetting is an upload refused after the
 * work of scaling it.
 */
export function portraitNeedsReencoding(
  source: Dimensions,
  byteLength: number,
): boolean {
  return shouldReencode(
    source,
    byteLength,
    PORTRAIT_MAX_EDGE,
    MAX_UPLOAD_BYTES,
  );
}

/**
 * The media type a thumbnail is encoded as.
 *
 * WebP because it is the smallest of the four types the upload endpoint
 * accepts (`lib/image-type.ts`) and the only one of them with an alpha
 * channel, so a PNG portrait with a transparent background does not acquire a
 * black one on the way through.
 *
 * Nothing downstream depends on getting it. `HTMLCanvasElement.toBlob` is
 * specified to fall back to `image/png` when it does not know the type asked
 * for, and PNG is on the allowlist too — so a browser that cannot write WebP
 * produces a larger thumbnail rather than a failure, and the endpoint sniffs
 * the bytes either way rather than believing this string.
 */
export const PORTRAIT_THUMB_TYPE = "image/webp";

/**
 * The size a thumbnail of `source` should be drawn at, or `null` when there
 * is no thumbnail worth making.
 *
 * Aspect ratio is preserved — the crop to a square is the *node's* business,
 * done in CSS with `object-cover`, and doing it here as well would bake one
 * view's framing into a stored file. A photograph is never re-cropped by the
 * thing that displays it; it is only ever displayed smaller.
 *
 * `null` for an image already inside the box, and that case is the one worth
 * being deliberate about: re-encoding a 100-pixel avatar "to make a
 * thumbnail" produces a second file no smaller than the first, with
 * generation loss for the trouble. The caller then stores no thumbnail key,
 * and `nodePortraitKey` falls back to the original — which is the right
 * answer, because the original already *is* thumbnail-sized. It is also why
 * that fallback is not dead code.
 *
 * `null` too for a degenerate size, which is what a decoder reports for a
 * file it could not read. See `scaledTo`.
 */
export function thumbnailSize(
  source: Dimensions,
  maxEdge: number = PORTRAIT_THUMB_MAX_EDGE,
): Dimensions | null {
  const scaled = scaledTo(source, maxEdge);
  if (scaled === null) return null;
  // `scaledTo` returns the source unchanged when it already fits; here that
  // means "do not make one" rather than "make one the same size".
  const unchanged =
    scaled.width === source.width && scaled.height === source.height;
  return unchanged ? null : scaled;
}
