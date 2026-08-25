/**
 * What kind of image a browser actually sent (E5-T2, `YEO-42`).
 *
 * ## Why the upload's own `Content-Type` is not consulted
 *
 * A multipart part carries whatever media type the client wrote on it, and
 * the client is a program on somebody else's machine. `curl -F
 * 'file=@shell.html;type=image/png'` is the whole attack, and it is one flag
 * long. Trusting that header would mean the allowlist checked a *claim* and
 * the store held a *file*, with nothing tying the two together — and the
 * store is where the bytes get served from later, under a signed URL, with a
 * content type this application chose.
 *
 * So the type is read off the first few bytes and the header is ignored
 * completely. Not compared, not used as a hint, not logged as a
 * disagreement — there is nothing to do with it that is better than reading
 * the file.
 *
 * ## Why sniffing is enough here, and where it would not be
 *
 * Content sniffing is a bad general-purpose idea: "looks like a GIF" is not
 * "is safe to serve", and the browser's own sniffing rules are a security
 * bug generator. What makes it sound in this one place is the direction it
 * is used in. This is an *allowlist* — four signatures, each one a fixed
 * byte string that no HTML document, SVG, or script can begin with — and
 * anything that does not match is refused rather than guessed at. A sniffer
 * that fell back to a default, or that ranked candidates, would be the
 * dangerous kind.
 *
 * It is deliberately not a validator. These signatures say "this is a JPEG
 * file" and say nothing about whether the JPEG decodes; a truncated or
 * corrupt image passes here and renders as a broken picture, which is the
 * right outcome for a family wiki. What cannot pass is a file that is not an
 * image at all, and that is the property the endpoint needs: nothing reaches
 * the store that a browser could be talked into treating as markup.
 *
 * ## SVG is not on the list, and that is the point
 *
 * SVG is the obvious fifth entry and the one that must never be added. It is
 * a document format with script in it, served same-origin here would be
 * cross-site scripting with an `<img>` tag in front of it, and no signature
 * can tell a safe one from a hostile one because both are well-formed XML.
 * `lib/sanitize-html.ts` reduces authored markup to an allowlist for exactly
 * this reason; letting an author *upload* the markup instead would walk
 * around it. The four types here are all raster formats a decoder turns into
 * pixels.
 */

/**
 * The media types an upload may be, in the order they are tried.
 *
 * The ticket's allowlist verbatim. It is exported so the route handler's
 * error message and its tests name the same set rather than two copies of
 * it that can drift.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * The extension each type is stored under.
 *
 * The stored key's extension comes from the *sniffed* type, never from the
 * uploaded filename — see `lib/storage-key.ts`. It is not decorative: with a
 * key like `images/ab/<uuid>.jpg` the type survives a move to a host that
 * infers content types from pathnames, and a directory of these is legible
 * to whoever is looking at a backup.
 *
 * `.jpg` rather than `.jpeg`, and `.jpe`/`.jfif` do not appear at all: there
 * is exactly one spelling per type here because these strings are minted,
 * not parsed, and a second spelling would only ever be a second thing to
 * keep in sync.
 */
const EXTENSIONS: Readonly<Record<ImageType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** The file extension `type` is stored under, without the dot. */
export function extensionFor(type: ImageType): string {
  return EXTENSIONS[type];
}

/**
 * A byte signature, and where in the file it has to appear.
 *
 * `at` exists for WebP alone, and WebP is the reason this is a list of
 * checks rather than a table of prefixes: a WebP file begins `RIFF`, four
 * bytes of length, then `WEBP` — and `RIFF` on its own is also a WAV, an
 * AVI, and an ANI cursor. Matching only the first four bytes would put audio
 * files through an image allowlist.
 */
interface Signature {
  readonly type: ImageType;
  readonly parts: readonly { at: number; bytes: readonly number[] }[];
}

const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

const SIGNATURES: readonly Signature[] = [
  /**
   * `FF D8 FF` — SOI, then the marker byte of whatever segment comes first.
   * The third byte is checked because `FF D8` alone is two bytes and two
   * bytes match too much; it is not pinned to a *particular* marker because
   * which one comes first is a real difference between encoders (`FF E0`
   * JFIF, `FF E1` Exif, `FF DB` from a bare quantisation table).
   */
  { type: "image/jpeg", parts: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  /**
   * The full eight-byte PNG signature, including the CR-LF and Ctrl-Z that
   * are in it to make a file mangled by an ASCII-mode transfer fail loudly.
   */
  {
    type: "image/png",
    parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  /** `RIFF` … `WEBP`, with the four-byte RIFF length in between. */
  {
    type: "image/webp",
    parts: [
      { at: 0, bytes: ascii("RIFF") },
      { at: 8, bytes: ascii("WEBP") },
    ],
  },
  /**
   * `GIF87a` and `GIF89a`, as two signatures rather than a prefix match on
   * `GIF`: those are the only two versions that exist, and the version
   * digits are what make this six bytes of evidence instead of three.
   */
  { type: "image/gif", parts: [{ at: 0, bytes: ascii("GIF87a") }] },
  { type: "image/gif", parts: [{ at: 0, bytes: ascii("GIF89a") }] },
];

function matches(bytes: Uint8Array, signature: Signature): boolean {
  return signature.parts.every(
    (part) =>
      bytes.length >= part.at + part.bytes.length &&
      part.bytes.every((byte, index) => bytes[part.at + index] === byte),
  );
}

/**
 * The type `bytes` really is, or `null` if it is not one of the four.
 *
 * `null` rather than a throw, and rather than a default: an upload that is
 * not an allowed image is an ordinary thing for a caller to be handed — it
 * is what a mis-clicked PDF looks like — and the route turns it into a 415
 * with a readable message. There is no branch here that guesses.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  return (
    SIGNATURES.find((signature) => matches(bytes, signature))?.type ?? null
  );
}
