/**
 * Everything about downscaling an image that is arithmetic rather than
 * pixels (E5-T4, `YEO-44`).
 *
 * ## Why this is a module with no DOM in it
 *
 * Resizing an image in a browser is three calls — `createImageBitmap`, a
 * canvas `2d` context, `toBlob` — wrapped around a handful of decisions:
 * what box to draw into, and whether to bother at all. The three calls cannot
 * be tested here, because `npm test` runs in jsdom and jsdom has no canvas.
 * The decisions can, and they are the part that is ever wrong.
 *
 * So the split is the one the repository already makes between
 * `lib/parse-date.ts` and `components/DateField.tsx`: the reasoning lives in
 * a pure module with a test beside it, and the irreducible platform call
 * lives in the component that is allowed to have one. What is left in the
 * component is short enough to read and has no branches to get wrong.
 *
 * ## Why the caps are arguments rather than constants here
 *
 * Two callers want different numbers out of the same arithmetic — a portrait
 * and its thumbnail differ only in how big they are allowed to be — and a
 * module that hard-coded either would be a module the other one could not
 * use. The numbers themselves are stated where they mean something:
 * `lib/portrait.ts` for a person's photograph, `lib/image-upload.ts` for the
 * endpoint's byte cap.
 */

/** The dimensions of an image, in pixels. */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * `source` scaled so its longest edge is at most `maxEdge`, preserving the
 * aspect ratio.
 *
 * **Never upscales.** An image already inside the box is returned unchanged,
 * because the alternative is drawing a 200-pixel photograph into a
 * 1600-pixel canvas and producing a file eight times the size with no more
 * detail in it than it started with.
 *
 * `null` for a degenerate source — zero, negative, or not a finite number.
 * That is what a decoder reports for a file it could not read, and every
 * arithmetic answer from here on would be `NaN` or `0`; a canvas of either
 * size throws rather than drawing nothing, so the honest answer is that there
 * is no box to draw into.
 */
export function scaledTo(
  source: Dimensions,
  maxEdge: number,
): Dimensions | null {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) return null;

  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    /**
     * At least one pixel on the short edge. A 4000x3 panorama scales to
     * 160x0.12, and `Math.round` of that is zero — a canvas dimension that
     * throws. The floor is what keeps an absurd input from becoming an
     * exception on a path whose worst honest outcome is an ugly thumbnail.
     */
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Whether an image is worth re-encoding before it is uploaded.
 *
 * Two independent reasons, and the second is the one that is easy to forget:
 *
 * - **It is too big to look at.** Over `maxEdge` on either side, so a
 *   downscale would actually remove pixels.
 * - **It is too big to send.** Over `maxBytes`, which is the upload
 *   endpoint's cap. A 5 MB PNG of an 800x600 scan is under `maxEdge` on both
 *   sides and would still be refused by `POST /api/images`; re-encoding it is
 *   the only thing between the family and an error message. This is the case
 *   `lib/image-upload.ts` predicted when it wrote that "a recent phone
 *   produces 3–12 MB images, so a meaningful share of what a family actually
 *   wants to upload will be refused… the fix is to downscale in a canvas
 *   before it posts".
 *
 * `false` means "send the original bytes untouched", which is a real answer
 * and not just an optimisation: a re-encode is generation loss, it costs the
 * animation of an animated GIF, and — for the path that matters most here —
 * it discards the Exif capture date and camera that `lib/image-metadata.ts`
 * went to byte-level trouble to preserve. A file that does not need
 * re-encoding should not be re-encoded.
 */
export function shouldReencode(
  source: Dimensions,
  byteLength: number,
  maxEdge: number,
  maxBytes: number,
): boolean {
  if (byteLength > maxBytes) return true;
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height)) {
    return false;
  }
  return source.width > maxEdge || source.height > maxEdge;
}
