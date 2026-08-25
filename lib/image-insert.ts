import { MAX_UPLOAD_BYTES } from "@/lib/image-endpoint";
import { ALLOWED_IMAGE_TYPES, type ImageType } from "@/lib/image-type";

/**
 * Everything the editor's image button decides, taken away from the editor
 * (E5-T3, `YEO-43`).
 *
 * The same split `lib/image-upload.ts` makes on the server, for the same
 * reason and with the same payoff. What is left in
 * `components/EntryEditor.tsx` and `components/image-upload.ts` is the part
 * that can only exist in a browser — a file picker, a drop event, an
 * `XMLHttpRequest`, a canvas — and everything that is a *judgement* is here,
 * as a function from a value to a value, tested in plain Node with no
 * document (docs/testing.md: "prefer no DOM").
 *
 * The judgements are worth naming, because each one is somewhere this could
 * be quietly wrong:
 *
 * - Which of the things a drop or a paste carries is a photograph at all.
 * - What to write in `alt` when nobody typed one, and — the harder half —
 *   when to write nothing rather than noise.
 * - Whether a file has to be shrunk before it can be posted, and to what.
 */

/**
 * The `accept` attribute for the file picker.
 *
 * Media types rather than extensions, and the same four `lib/image-type.ts`
 * sniffs for, so the picker offers exactly what the endpoint will accept. It
 * is a convenience and never a check: a file picker's filter is advisory —
 * every platform has a way past it, and a drag-and-drop bypasses it entirely
 * — so {@link isPicture} below runs on everything regardless, and the real
 * decision is made on the server from the bytes.
 */
export const IMAGE_ACCEPT = ALLOWED_IMAGE_TYPES.join(",");

/** Whether `type` is one of the four media types this wiki stores. */
export function isAllowedImageType(type: string): type is ImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * The parts of a `File` anything here looks at.
 *
 * A structural type rather than `File` itself, so that a test can state the
 * case it means — `{ name: "letter.pdf", type: "application/pdf", size: 12 }`
 * — instead of constructing a `File` to carry three fields into an assertion.
 * Every real caller passes a `File`, which satisfies this.
 */
export interface PickedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

/**
 * Whether this is something to try to upload.
 *
 * A drop carries whatever was dragged, and a paste from a word processor
 * carries a picture *and* the text around it, plus an `text/html` flavour of
 * both. Filtering on the type is what stops "paste a paragraph that happens
 * to have a photo in it" from posting a `.docx`.
 */
export function isPicture(file: PickedFile): boolean {
  return isAllowedImageType(file.type);
}

/** Every picture among `files`, in the order they arrived. */
export function picturesAmong<T extends PickedFile>(
  files: readonly T[],
): readonly T[] {
  return files.filter(isPicture);
}

/**
 * Words that carry no information about what is in the picture.
 *
 * Two kinds, kept in one list because they are refused for one reason. The
 * first are what a camera, a phone or a screenshot tool writes — the handful
 * of prefixes that account for very nearly every unedited photograph:
 * `IMG_4021.JPG`, `DSC01234.JPG`, `PXL_20240712_…`, `Screenshot 2026-08-25 at
 * 14.02.png`. The second are the connectors those tools string them together
 * with, which are words but say nothing on their own.
 *
 * Matched whole and case-insensitively against the *letter runs* in a
 * filename, so `DSC01234` — one token to a person, letters and digits to a
 * regular expression — is recognised by its `DSC`.
 */
const EMPTY_WORDS = new Set([
  "img",
  "image",
  "images",
  "photo",
  "photos",
  "picture",
  "pic",
  "dsc",
  "dscn",
  "dscf",
  "pxl",
  "mvimg",
  "screenshot",
  "screen",
  "shot",
  "capture",
  "scan",
  "scanned",
  "untitled",
  "copy",
  "final",
  "edit",
  "edited",
  "export",
  "whatsapp",
  "received",
  "download",
  "downloaded",
  // Connectors, and the articles a generated name strings them with.
  "a",
  "an",
  "the",
  "and",
  "at",
  "on",
  "of",
  "to",
  "in",
  "by",
]);

/**
 * What to put in `alt`, from the file's own name — or `null` for "say
 * nothing".
 *
 * ## Why the filename at all
 *
 * Because the alternative is an image with no text alternative, and the
 * alternative to *that* is a caption field on a toolbar that the product
 * decision in `lib/editor-extensions.ts` fixes at six controls. A family
 * naming a file `Rose and Bill at Southwold, 1952.jpg` has already written
 * the caption; the button should not make them write it twice.
 *
 * ## Why `null` is half the point
 *
 * `alt="IMG 4021"` is worse than no alt at all. A screen reader announces it
 * as an image called "IMG 4021", which is a claim that the picture has been
 * described when it has not — and an *absent* `alt` is a signal an assistive
 * technology can act on, where a junk one is not. The rule is therefore:
 * **use the name only when something in it is a word somebody chose.**
 *
 * The original spelling is kept for the text that *is* used — `Rose and Bill,
 * 1952` keeps its comma and its year — because {@link EMPTY_WORDS} decides
 * whether the name is worth using, not what it should say. Only underscores
 * become spaces, because that is what an underscore in a filename is.
 */
export function altTextFromFilename(name: string): string | null {
  const withoutExtension = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const cleaned = withoutExtension.replace(/[_\s]+/g, " ").trim();
  if (cleaned === "") return null;

  /**
   * Runs of letters, in any script, ignoring everything between them.
   *
   * Splitting on separators would not do the job: `DSC01234` has none, and
   * neither does `IMG4021`. Digits are never words here — a date, a counter
   * and a sensor's frame number are the same non-answer — so the question is
   * only whether any run of letters is one somebody chose.
   *
   * A lone letter is refused as well (`a.jpg`, `P.png`); two are allowed,
   * because two letters is a whole name in several scripts.
   */
  const words = cleaned.match(/\p{L}+/gu) ?? [];
  const meaningful = words.some(
    (word) => word.length >= 2 && !EMPTY_WORDS.has(word.toLowerCase()),
  );

  return meaningful ? cleaned : null;
}

/**
 * The media type a resized picture is re-encoded as.
 *
 * JPEG, always, and not because it is the best format for every input. It is
 * the only one every browser's `canvas.toBlob` is required to produce: asking
 * for `image/webp` on a browser that cannot encode it does not fail, it
 * silently hands back a PNG — which for a photograph is *larger* than the
 * file that was already too large, so the resize would look like it worked
 * and the upload would still be refused.
 *
 * What it costs is transparency, which is why {@link DOWNSCALE_BACKGROUND}
 * exists. The trade is worth taking because of when it applies: this path is
 * reached only by a file that would otherwise be **refused outright**, so the
 * comparison is a flattened background against no picture at all.
 */
export const DOWNSCALE_TYPE = "image/jpeg";

/**
 * What transparent pixels become. White rather than the theme's paper colour:
 * the pixels are baked into a file that outlives the stylesheet, gets
 * exported, and may be opened in something that is not this application.
 * Leaving it unpainted gives black, which is what an unfilled canvas is.
 */
export const DOWNSCALE_BACKGROUND = "#ffffff";

/**
 * How hard to try, in order.
 *
 * A list rather than a formula because a JPEG's size is a property of its
 * *content* — a portrait against a plain wall and a beach full of pebbles
 * compress an order of magnitude apart — so there is no arithmetic that turns
 * "4 MB" into "these dimensions". The honest approach is to encode, measure,
 * and try again smaller.
 *
 * The first step is the one nearly every photograph lands on: 2400px on the
 * long edge is larger than any screen a family wiki gets read on, and 0.82
 * takes a 12 MB phone photograph to roughly 1 MB. The last is the floor —
 * 1200px is still a good deal larger than the 46em content column
 * (`--container-content`), so a picture that needs three attempts still looks
 * right in the article. Below that it would be worth failing instead, which
 * is what happens: the endpoint refuses, and the author is told the file is
 * too large rather than shown a blurry version of it.
 */
export const DOWNSCALE_STEPS = [
  { longestEdge: 2400, quality: 0.82 },
  { longestEdge: 1600, quality: 0.75 },
  { longestEdge: 1200, quality: 0.7 },
] as const;

/**
 * Whether this file has to be shrunk before it can be posted.
 *
 * Two rules, and the second one is the one that would be missed:
 *
 * - **Over the cap gets resized.** {@link MAX_UPLOAD_BYTES} is not a
 *   preference and cannot be raised — see `lib/image-endpoint.ts` — so a
 *   phone photograph either goes through a canvas or does not go at all.
 * - **A GIF never does.** Re-encoding one through a canvas keeps a single
 *   frame, so an animation an author uploaded would arrive as a still, which
 *   is content loss disguised as a feature working. An oversized GIF is
 *   refused by the endpoint with a sentence saying so, which is the honest
 *   answer.
 *
 * Note what is *not* here: a dimension check. A 3 MB, 6000px-wide photograph
 * is left alone, because it is within the cap, the browser scales it down to
 * the column anyway, and the archive is better off with the larger original.
 * This function exists to make an upload possible, not to normalise a
 * library.
 */
export function needsDownscale(file: PickedFile): boolean {
  if (file.type === "image/gif") return false;
  return file.size > MAX_UPLOAD_BYTES;
}

/** A width and a height, in whole pixels. */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * `source` scaled so that neither side exceeds `longestEdge`, keeping its
 * aspect ratio — or `source` unchanged if it already fits.
 *
 * Never upscales: a small file that is over the cap is over it for some other
 * reason (a PNG of a photograph, most likely), and stretching its pixels to
 * 2400px would make it larger still.
 *
 * Rounds rather than floors, and clamps to at least one pixel each way, so
 * that an extreme panorama cannot produce a zero-height canvas — which is not
 * an error in any browser, just a blank picture.
 */
export function scaleToFit(
  source: Dimensions,
  longestEdge: number,
): Dimensions {
  const longest = Math.max(source.width, source.height);
  if (longest <= longestEdge) return { ...source };

  const factor = longestEdge / longest;
  return {
    width: Math.max(1, Math.round(source.width * factor)),
    height: Math.max(1, Math.round(source.height * factor)),
  };
}

/**
 * How far along an upload is, as a whole percentage.
 *
 * `null` when the total is unknown or nonsensical, which is a real answer
 * rather than a defensive one: `XMLHttpRequest` reports
 * `lengthComputable: false` for a body it cannot measure, and a progress bar
 * that renders `NaN%` — or, worse, sits confidently at 0 — is worse than one
 * that says it is working without saying how far. See
 * `components/EntryEditor.tsx`, which renders an indeterminate bar for this.
 *
 * Clamped at both ends. A browser reporting `loaded` slightly past `total`
 * (the request body is the file plus its multipart framing) must not produce
 * "103%".
 */
export function uploadPercent(loaded: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(loaded) || loaded < 0) return null;
  return Math.min(100, Math.round((loaded / total) * 100));
}
