/**
 * How a person's portrait thumbnail is made (E5-T4, `YEO-44`).
 *
 * ## Why a thumbnail exists at all
 *
 * The tree loads the whole family at once — `getFamilyGraph` selects every row
 * and the layout runs in the browser, because "a family tree is small"
 * (docs/architecture.md). Small is a few hundred people, and a few hundred
 * people with photographs is a few hundred images on one canvas, each drawn
 * into a box forty-eight pixels wide. Serving the originals there downloads
 * several hundred megapixels to paint a contact sheet.
 *
 * That is the whole of what this module is for, and it is worth being precise
 * about the difference from `lib/image-insert.ts` next door, which also
 * shrinks images. **E5-T3 resizes reluctantly and E5-T4 resizes always.** The
 * editor shrinks a photograph only when it is too large to send at all, and a
 * file under the cap goes to the store byte for byte, keeping its own format
 * and its Exif. A portrait is *additionally* copied down to a size the canvas
 * can afford, and that copy is a second stored object rather than a
 * replacement — the original is kept at full resolution, because this is an
 * archive of a family's photographs.
 *
 * So the two callers share the endpoint (`lib/image-endpoint.ts`), the
 * uploader (`components/image-upload.ts`) and the arithmetic (`scaleToFit`),
 * and differ in what they ask for. What is left here is the asking.
 *
 * ## Why this is separate from `lib/portrait.ts`
 *
 * `lib/gedcom.purity.test.ts` walks the whole import closure of the GEDCOM
 * parser and fails if it reaches anything at all, and the path is short: a
 * person's record now has a portrait key on it, so `lib/individual-input.ts`
 * validates one, so everything `lib/portrait.ts` imports becomes something
 * the GEDCOM parser imports. With the upload arithmetic in there, that
 * closure grew `lib/image-upload.ts` and with it `lib/image-metadata.ts` — a
 * byte-level Exif scrubber, reachable from a text-file parser that will never
 * see an image.
 *
 * The split is the fix rather than a wider allowlist. `lib/portrait.ts` is
 * what a portrait *is* — which key names one, how it becomes a `src` — and
 * every reader asks that, including the validator on the import path. This is
 * how one is *made*, and exactly one caller asks: `components/PortraitField.tsx`,
 * at the moment somebody picks a file.
 */

import { scaleToFit, type Dimensions } from "./image-insert";
import { PORTRAIT_NODE_SIZE } from "./portrait";

/**
 * The longest edge a stored thumbnail may have, in image pixels.
 *
 * Four times {@link PORTRAIT_NODE_SIZE}, and the multiplier is the reason for
 * the number rather than the number being round. A thumbnail is drawn into a
 * 48-pixel box on a display that may have two or three device pixels per CSS
 * pixel, and it is drawn `object-cover` — so the box crops a square out of
 * whatever aspect ratio the photograph has, and the edge that survives the
 * crop is the *shorter* one. 192 leaves a portrait-shaped photograph sharp at
 * 3x and a panoramic one sharp at 2x, at a few kilobytes each.
 *
 * It is not a display size. The node's box is CSS; this is how many pixels
 * are stored behind it.
 */
export const PORTRAIT_THUMB_MAX_EDGE = PORTRAIT_NODE_SIZE * 4;

/**
 * The media type a thumbnail is encoded as.
 *
 * WebP, and deliberately **not** `DOWNSCALE_TYPE` — the JPEG that
 * `lib/image-insert.ts` uses for the same three canvas calls. The difference
 * is what the output is *for*. That one replaces the author's file on its way
 * to the store, so it takes the format every browser is required to be able
 * to write and accepts losing transparency as the price of the file arriving
 * at all. This one is a derived extra beside an original that is kept intact,
 * so it can afford the better format: WebP is the smallest of the four types
 * the endpoint accepts and the only one of them with an alpha channel, which
 * means a PNG portrait with a transparent background does not acquire a black
 * one on the tree.
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
 * `null` too for a degenerate size — zero, negative, or not a finite number,
 * which is what a decoder reports for a file it could not read. `scaleToFit`
 * is arithmetic and would return `NaN` or `0`, and a canvas of either size
 * throws rather than drawing nothing; the honest answer is that there is no
 * thumbnail to make.
 */
export function thumbnailSize(
  source: Dimensions,
  maxEdge: number = PORTRAIT_THUMB_MAX_EDGE,
): Dimensions | null {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) return null;

  const scaled = scaleToFit(source, maxEdge);
  // `scaleToFit` returns the source unchanged when it already fits; here that
  // means "do not make one" rather than "make one the same size".
  const unchanged =
    scaled.width === source.width && scaled.height === source.height;
  return unchanged ? null : scaled;
}
