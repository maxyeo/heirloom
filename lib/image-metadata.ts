import type { ImageType } from "@/lib/image-type";

/**
 * Taking the location out of an uploaded photograph, and leaving the
 * orientation in (E5-T2, `YEO-42`).
 *
 * ## Why an upload endpoint owns this at all
 *
 * Family photographs are phone photographs, and a phone photograph taken at
 * home carries the coordinates of the home in it. Nobody who uploads one is
 * thinking about that, which is the entire problem: the metadata is invisible
 * in every program that shows the picture and precise to a few metres in
 * every program that reads the file.
 *
 * The site is private, but the *file* does not stay behind the site. It is
 * handed to a storage host, fetched by a browser over a signed URL, saved by
 * a relative, forwarded, backed up. Each of those is fine for a photograph
 * and none of them is fine for an address, so the coordinates come out at the
 * door — once, on the way in, before anything else can copy the file
 * somewhere this code does not run.
 *
 * ## Why the Exif block is not simply deleted
 *
 * Deleting it is three lines and gets the other acceptance criterion wrong.
 * **Orientation lives in the same block as location.** A phone writes the
 * sensor's reading into Exif tag `0x0112` and stores the pixels the way the
 * sensor delivered them, so a photograph taken in portrait is a landscape
 * image plus a note saying "rotate this". Browsers honour the note — CSS
 * `image-orientation` defaults to `from-image`, so an `<img>` renders it
 * upright with no help from anyone. Strip the block and there is no note:
 * every portrait photograph in the wiki lies on its side, permanently, with
 * the information needed to fix it destroyed on upload.
 *
 * That is the whole reason this file is byte-level surgery rather than a
 * deletion. GPS comes out; everything the renderer relies on stays.
 *
 * ## What "surgery" means here, and why it is safe
 *
 * The Exif payload is a TIFF structure: a header, then image file
 * directories (IFDs) of twelve-byte entries, whose values either fit in four
 * bytes or sit elsewhere in the block at an absolute offset. Rewriting one
 * generally means recomputing every offset in it, which is where a
 * home-grown Exif writer earns its reputation.
 *
 * None of that happens here, because **the scrub is length-preserving and
 * touches no offset**:
 *
 * - The GPS IFD's own bytes, and the bytes of every value it points at, are
 *   overwritten with zeroes where they lie.
 * - The GPS pointer entry is removed from its directory by shifting the
 *   entries after it down twelve bytes and decrementing the entry count. The
 *   twelve bytes freed at the end are zeroed. Every *other* entry keeps its
 *   value at the same absolute offset it always had, because values are
 *   addressed from the start of the TIFF block and that did not move.
 *
 * So no offset in the file is rewritten and no length changes — which in turn
 * means the container around the Exif block does not have to be rebuilt
 * either: a JPEG segment keeps its length, a PNG chunk keeps its length (only
 * its CRC is recomputed), a RIFF chunk keeps its length.
 *
 * ## Fail closed, always
 *
 * Two rules, and they are what make a hand-written parser defensible here:
 *
 * 1. **Metadata that cannot be understood is removed, not passed through.**
 *    An Exif block whose structure does not parse is dropped whole. The cost
 *    is a rotated photograph; the alternative is shipping bytes this code
 *    could not read on the theory that they were probably harmless.
 * 2. **A container that cannot be walked is rejected.** {@link
 *    UnreadableImageError} propagates to the route, which answers 400. The
 *    file already matched an image signature, so failing here means it is
 *    truncated or corrupt — refusing it is both the safe answer and the true
 *    one.
 *
 * ## What is removed beyond the GPS tags
 *
 * Coordinates hide in more than one place, and the ones that are not needed
 * to draw the picture are removed outright rather than inspected:
 *
 * - **XMP** (`APP1` in JPEG, `iTXt` in PNG, the `XMP ` chunk in WebP, an
 *   Application Extension in GIF) has an `exif:GPSLatitude` of its own, which
 *   phones and editors write alongside the Exif one. Nothing renders from it,
 *   and it reaches all four of these formats — including the one with no Exif
 *   block at all.
 * - **IPTC / Photoshop resources** (`APP13`) carry a sub-location, city and
 *   country as plain text.
 * - **Every other `APPn` and the JPEG comment segment.** In JPEG this is an
 *   allowlist rather than a list of things to delete — `APP0` (JFIF), `APP2`
 *   when it is an ICC profile, and the scrubbed Exif `APP1` are kept, and
 *   the rest of a sixteen-marker grab-bag of vendor extensions goes. PNG is
 *   treated the other way round, as a blocklist of its three text chunk
 *   types, because PNG chunk types are registered and non-textual ones do
 *   not carry prose.
 * - **GIF's application, comment and plain-text extensions**, kept to an
 *   allowlist of the graphic control extension and the Netscape loop count —
 *   see `stripGif`, which also records why the earlier belief that a GIF had
 *   nothing to remove was wrong.
 *
 * ICC profiles are kept deliberately: dropping one does not protect anything
 * and visibly shifts the colours of every photograph taken on a
 * wide-gamut phone.
 *
 * The maker note goes too, and for the opposite reason to everything else in
 * that list: it is a vendor-defined blob in an undocumented format, several
 * of which repeat the coordinates inside it, and it cannot be parsed in
 * general. So it is removed in general.
 *
 * ## What is deliberately kept
 *
 * Everything else in the Exif block: orientation, the capture date, the
 * camera and lens, the exposure. This is a family archive, and a photograph's
 * date and camera are the sort of thing it exists to remember — "when was
 * this taken" is a question somebody will ask of these files long after
 * everyone who could answer it from memory has stopped being available to
 * ask.
 *
 * That is the argument against the tidier implementation, which is to read
 * the orientation out, throw the whole block away, and write back a
 * twenty-byte Exif block containing that one tag. It is less code and it
 * cannot get an offset wrong. It also destroys the capture date of every
 * photograph the family uploads, irreversibly, in exchange for removing
 * fields that carry no location — and the offsets it avoids getting wrong
 * are ones this implementation never touches either.
 *
 * ## One rule, and what it is worth
 *
 * Every container here decides what survives the same way: **a block is kept
 * for its shape, never for its label.** A label is a claim the file makes
 * about itself, and a block kept on its claim is a block whose contents were
 * never looked at — which is an arbitrary-data channel with a respectable
 * name on it. Review found that mistake three times in this file (a GIF
 * graphic control extension, a JPEG `APP0`, and a PNG blocklist that kept a
 * chunk for *not* being named), each time in a branch sitting beside one that
 * did it correctly. The fixed-shape blocks are now checked against their
 * mandated size, and the variable-length ones are on allowlists of types the
 * format itself defines.
 *
 * ## What this cannot promise
 *
 * Not "no chosen bytes reach the store". That is not available to any image
 * scrubber and it is worth writing down rather than implying otherwise: an
 * image *is* arbitrary bytes. A palette is up to 768 bytes of chosen values,
 * a colour profile is a binary blob kept deliberately for colour accuracy,
 * and the pixels are the payload — a megapixel of them will carry a megabyte
 * of anything at all, in the clear or in the low bits, and no amount of
 * container walking changes that. A GIF's image-data chain is the same story
 * one level down: sub-blocks past the point a decoder has all its pixels are
 * never read and are kept, and telling them apart would mean decompressing
 * the image to find out.
 *
 * What it does promise is narrower and is the thing the ticket asked for:
 * **no metadata block reaches the store unread.** Every block that is not
 * pixels, palette or profile is either dropped, or scrubbed, or matched
 * against a shape that leaves it no room to carry anything. Location
 * metadata is removed from all four formats, in every place any of them
 * defines for it.
 *
 * ## Known limits
 *
 * PNG, WebP and GIF keep whatever orientation tag they arrived with, and
 * nothing re-synthesises one — nothing that produces those formats produces a
 * rotated one, so there is nothing to respect. GIF has no Exif block at all,
 * so what it loses is only the extension blocks named above.
 *
 * The known limit worth stating is the shape of the defence rather than a
 * gap in it: three of the four formats are handled by walking a container
 * this file understands, and a container it stops understanding is refused
 * rather than forwarded. That is a bet that refusing a damaged file is better
 * than storing an unread one, and it is recorded in `docs/architecture.md`
 * along with everything above.
 */

/**
 * A buffer of image bytes, pinned to a plain `ArrayBuffer` backing.
 *
 * The type argument is not decoration. TypeScript distinguishes a
 * `Uint8Array` over an `ArrayBuffer` from one over a `SharedArrayBuffer`, and
 * only the former is a `BlobPart` — so a signature written as a bare
 * `Uint8Array` produces bytes that cannot be handed to `new Blob([...])`
 * without a cast, which is the one thing standing between this module and
 * `lib/storage.ts`. Pinning it here means no call site has to.
 */
export type ImageBytes = Uint8Array<ArrayBuffer>;

/** Thrown when a file matched an image signature but cannot be walked. */
export class UnreadableImageError extends Error {
  constructor(reason: string) {
    super(`Unreadable image: ${reason}`);
    this.name = "UnreadableImageError";
  }
}

/**
 * The three tags this scrub reacts to.
 *
 * `GPS_IFD` and `MAKER_NOTE` are removed; `EXIF_IFD` is followed, because it
 * is where a maker note actually lives. Everything else in the block —
 * orientation, the capture date, the camera, the lens, the exposure — is left
 * exactly where it was.
 */
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_MAKER_NOTE = 0x927c;

/**
 * Byte width of each TIFF field type, indexed by the type code.
 *
 * An unknown code is not defaulted to anything. A value whose length cannot
 * be computed is a value that cannot be found in order to be erased, and
 * guessing four bytes would leave the rest of it in the file.
 */
const TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

/**
 * How far the directory graph is followed.
 *
 * `IFD0 → IFD1` is the usual chain and `IFD0 → Exif IFD` the usual nesting,
 * so real files reach two. The bound is here because every step is an offset
 * *read out of the file*: a damaged or hostile one can point anywhere,
 * including back at itself.
 */
const MAX_DEPTH = 8;

/**
 * How many directory entries one *upload* may spend before the rest of its
 * metadata is treated as hostile and dropped.
 *
 * Two things had to be said in the right unit here, and the first one is the
 * bound most parsers get wrong. A directory holds up to 65,535 entries and
 * every one of them may point at a *different* child directory, so a block
 * one level deep can ask for entries × entries of work — and the two obvious
 * guards both wave it through: nothing recurses past depth one, and no offset
 * is ever revisited, because the children are genuinely distinct. Overlapping
 * them inside one block makes the file small while the work stays quadratic.
 * So depth is not the unit; entries are.
 *
 * The second is that **the budget belongs to the file, not to the block**. A
 * container may hold as many Exif blocks as it has room for — repeated `eXIf`
 * chunks in a PNG, repeated `EXIF` chunks in a WebP, repeated `Exif\0\0`
 * `APP1` segments in a JPEG — and a per-block budget is simply multiplied by
 * however many blocks fit in four megabytes. That is the same mistake one
 * level up, and it is worth naming because the per-block version *looks*
 * finished: every individual block is bounded, and the file is not.
 *
 * Spending it across the whole walk is also what makes fan-out cost anything
 * within a block, since the children are reached from one parent.
 *
 * Real files are three or four directories of a few dozen entries each, so
 * this leaves around two orders of magnitude of headroom. What it costs when
 * it does fire is the same thing every other parse failure costs — the block
 * is dropped, the orientation with it, and the location goes either way. A
 * file that has already spent this much being strange is not one the rest of
 * this code was going to understand.
 */
const MAX_ENTRIES = 4096;

/**
 * One walk of one Exif block: the bytes, how to read them, and what it has
 * spent so far.
 *
 * Carried as a value rather than as five parameters threaded through four
 * functions, because `seen` and `entries` are *shared mutable* state — the
 * whole point of both is that a nested call spends the same budget the caller
 * was spending. Passing them positionally invites the version of this where
 * one call site forgets and a guard silently stops applying below it.
 */
interface Walk {
  bytes: Uint8Array;
  view: DataView;
  little: boolean;
  /**
   * Directory offsets already walked, so a cycle is not walked twice.
   *
   * Per block, and it has to be: an offset is relative to the start of its
   * own TIFF block, so two blocks in one file share a numbering and would
   * otherwise mask each other's directories.
   */
  seen: Set<number>;
  /**
   * The file's remaining allowance, shared by every block in it. Negative
   * means the walk is over.
   */
  budget: Budget;
}

/** {@link MAX_ENTRIES}, counted down across one upload. */
interface Budget {
  entries: number;
}

/**
 * Charge `count` entries to the walk, and say whether it could afford them.
 *
 * The directory itself costs one on top of its entries, so a fan-out of empty
 * directories is bounded too — otherwise 65,535 children of zero entries each
 * would be free.
 */
function afford(walk: Walk, count: number): boolean {
  walk.budget.entries -= count + 1;
  return walk.budget.entries >= 0;
}

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

const startsWith = (bytes: Uint8Array, at: number, text: string): boolean =>
  bytes.length >= at + text.length && ascii(bytes, at, text.length) === text;

/**
 * The bytes an entry's value occupies outside the entry, or null if it has
 * none — or `false` if the entry cannot be measured at all.
 *
 * TIFF stores a value inside its twelve-byte entry when it fits in four
 * bytes and elsewhere in the block when it does not, which is why erasing
 * one is two different operations wearing one name.
 */
function externalValue(
  walk: Walk,
  entry: number,
): { at: number; length: number } | null | false {
  const size = TYPE_SIZES[walk.view.getUint16(entry + 2, walk.little)];
  if (size === undefined) return false;

  const length = size * walk.view.getUint32(entry + 4, walk.little);
  if (length <= 4) return null;

  const at = walk.view.getUint32(entry + 8, walk.little);
  if (at + length > walk.bytes.length) return false;
  return { at, length };
}

/**
 * Overwrite the GPS directory at `offset` and every value it points at.
 *
 * Returns false — possibly having already zeroed part of it — if the
 * directory does not parse. The caller drops the whole Exif block in that
 * case, so a half-erased one never ships, and the partial work is not worth
 * a second pass to avoid.
 */
function eraseGpsIfd(walk: Walk, offset: number): boolean {
  const { bytes, view, little } = walk;
  if (offset + 2 > bytes.length) return false;
  const count = view.getUint16(offset, little);
  if (!afford(walk, count)) return false;

  const end = offset + 2 + count * 12 + 4;
  if (end > bytes.length) return false;

  for (let index = 0; index < count; index += 1) {
    const value = externalValue(walk, offset + 2 + index * 12);
    if (value === false) return false;
    if (value) bytes.fill(0, value.at, value.at + value.length);
  }

  bytes.fill(0, offset, end);
  return true;
}

/**
 * Remove entry `index` from the directory at `offset`, keeping the block the
 * same length.
 *
 * The four bytes after the last entry point at the next directory, and a
 * reader finds them by counting entries — so they move down with the entries
 * rather than staying put. The twelve bytes freed at the end are zeroed;
 * they belonged to this directory, so nothing else can be relying on them.
 *
 * The shift is linear in the entries after the one removed, which is the one
 * cost {@link MAX_ENTRIES} does not charge for directly: a directory packed
 * with removable tags moves bytes proportional to the *square* of its entry
 * count. It is still bounded, because the entry count is — worst case is
 * around `MAX_ENTRIES²` byte moves, a few million, which measures in single
 * digit milliseconds. Worth saying plainly, because "entries examined" is
 * what the budget counts and this is the work that rides along behind it.
 */
function removeEntry(
  walk: Walk,
  offset: number,
  index: number,
  count: number,
): void {
  const first = offset + 2;
  const end = first + count * 12 + 4;
  walk.bytes.copyWithin(first + index * 12, first + (index + 1) * 12, end);
  walk.bytes.fill(0, end - 12, end);
  walk.view.setUint16(offset, count - 1, walk.little);
}

/**
 * Erase location from the directory at `offset`, everything nested under it,
 * and everything further along its chain.
 *
 * `index` advances only when an entry is *kept*. Removing one shifts the next
 * entry into the slot just examined, so stepping over it would skip a second
 * GPS pointer sitting immediately after the first — which is not a shape any
 * camera produces and is exactly the shape somebody would produce on purpose.
 */
function scrubDirectory(walk: Walk, offset: number, depth: number): boolean {
  const { view, little } = walk;
  if (depth >= MAX_DEPTH || walk.seen.has(offset)) return false;
  walk.seen.add(offset);

  if (offset + 2 > walk.bytes.length) return false;
  let count = view.getUint16(offset, little);
  if (!afford(walk, count)) return false;
  if (offset + 2 + count * 12 + 4 > walk.bytes.length) return false;

  for (let index = 0; index < count;) {
    const entry = offset + 2 + index * 12;
    const tag = view.getUint16(entry, little);

    /**
     * A pointer tag is a LONG (or the `IFD` type, which is a LONG by another
     * name) holding exactly one offset. Anything else is a pointer this code
     * cannot follow, and an Exif block containing one is a block it cannot
     * promise anything about.
     */
    const pointer = (): number | null => {
      const type = view.getUint16(entry + 2, little);
      if (type !== 4 && type !== 13) return null;
      if (view.getUint32(entry + 4, little) !== 1) return null;
      return view.getUint32(entry + 8, little);
    };

    if (tag === TAG_GPS_IFD) {
      const target = pointer();
      if (target === null) return false;
      if (!eraseGpsIfd(walk, target)) return false;
      removeEntry(walk, offset, index, count);
      count -= 1;
      continue;
    }

    if (tag === TAG_MAKER_NOTE) {
      /**
       * A vendor blob in an undocumented format, several of which repeat the
       * coordinates inside it. It cannot be parsed in general, so it is
       * removed in general — the alternative is shipping bytes on the theory
       * that this particular camera is one of the ones that does not.
       *
       * The loss is real and small: lens and shutter data that nothing here
       * reads, from the one field in the block that no reader can interpret
       * without knowing which camera wrote it.
       */
      const value = externalValue(walk, entry);
      if (value === false) return false;
      if (value) walk.bytes.fill(0, value.at, value.at + value.length);
      removeEntry(walk, offset, index, count);
      count -= 1;
      continue;
    }

    if (tag === TAG_EXIF_IFD) {
      const target = pointer();
      if (target === null) return false;
      if (!scrubDirectory(walk, target, depth + 1)) return false;
    }

    index += 1;
  }

  // Read after the loop rather than before it: the pointer to the next
  // directory sits immediately after the last entry, and the last entry may
  // have moved.
  const next = view.getUint32(offset + 2 + count * 12, little);
  if (next === 0) return true;
  return scrubDirectory(walk, next, depth + 1);
}

/**
 * Erase every trace of location from a TIFF/Exif block, in place.
 *
 * Returns false if the block could not be understood, in which case the
 * caller drops it whole rather than passing on bytes this code could not
 * read.
 *
 * The GPS pointer is looked for in *every* directory reached, not only in
 * IFD0 where the specification puts it. Reading a file the way its author
 * intended is precisely the assumption not to make about a file somebody
 * uploaded.
 */
function scrubExif(bytes: Uint8Array, budget: Budget): boolean {
  if (bytes.length < 8) return false;

  const little =
    bytes[0] === 0x49 && bytes[1] === 0x49
      ? true
      : bytes[0] === 0x4d && bytes[1] === 0x4d
        ? false
        : null;
  if (little === null) return false;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return false;

  const first = view.getUint32(4, little);
  // A TIFF header whose first directory offset is zero has no directories at
  // all. Nothing to erase, and nothing wrong with it.
  if (first === 0) return true;

  return scrubDirectory(
    { bytes, view, little, seen: new Set(), budget },
    first,
    0,
  );
}

/**
 * CRC-32 as PNG defines it, which is the ordinary IEEE one.
 *
 * Needed for exactly one thing: an `eXIf` chunk whose bytes were rewritten
 * has a stale checksum, and a PNG decoder is entitled to reject the file over
 * it. The table is built once on first use rather than written out as 256
 * literals nobody can proofread.
 */
let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Join the kept ranges of `bytes` into one buffer. */
function join(
  bytes: Uint8Array,
  ranges: readonly [number, number][],
): ImageBytes {
  const total = ranges.reduce((sum, [from, to]) => sum + (to - from), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of ranges) {
    out.set(bytes.subarray(from, to), at);
    at += to - from;
  }
  return out;
}

/**
 * Whether a JPEG segment survives, and the allowlist that decides it.
 *
 * The Exif case mutates `bytes` in place before answering, which is what
 * keeps the segment's declared length honest — a scrub that changed the
 * length would need the length rewritten, and this is the file that exists
 * to not have to do that.
 */
function keepJpegSegment(
  bytes: Uint8Array,
  budget: Budget,
  marker: number,
  payload: number,
  payloadEnd: number,
): boolean {
  switch (marker) {
    case 0xe0:
      /**
       * APP0, and only when it is a bare JFIF header: the identifier, two
       * version bytes, a density unit, two densities and two thumbnail
       * dimensions — fourteen bytes of payload, exactly.
       *
       * It was kept on its marker alone, which is the same mistake the GIF
       * walk made with `0xF9`: a marker is a claim, and an `APP0` segment can
       * carry sixty-five kilobytes behind that claim. A longer one is either
       * a JFXX extension or a JFIF with an embedded thumbnail, and what is
       * lost by refusing both is a pixel-density hint and a thumbnail nothing
       * renders.
       */
      return (
        payloadEnd - payload === 14 && startsWith(bytes, payload, "JFIF\0")
      );
    case 0xe1: // APP1 — Exif, or XMP wearing the same marker.
      if (!startsWith(bytes, payload, "Exif\0\0")) return false;
      return scrubExif(bytes.subarray(payload + 6, payloadEnd), budget);
    case 0xe2: // APP2 — kept only when it is a colour profile.
      return startsWith(bytes, payload, "ICC_PROFILE\0");
    default:
      return keepJpegStructural(bytes, marker, payload, payloadEnd);
  }
}

/**
 * Walks a payload built of back-to-back records, each declaring its own
 * length, and answers whether they tile it exactly. `next` returns where the
 * record starting at `at` ends, or `null` when it is malformed.
 *
 * Tiling *exactly* is the point. A payload with anything left over after its
 * last well-formed record is carrying that remainder for some other reason.
 */
function spansExactly(
  from: number,
  to: number,
  next: (at: number) => number | null,
): boolean {
  let at = from;
  while (at < to) {
    const after = next(at);
    if (after === null || after <= at || after > to) return false;
    at = after;
  }
  return at === to;
}

/** Start of frame, in all its numberings, and `DHP`, which shares its header. */
const isJpegFrame = (marker: number): boolean =>
  (marker >= 0xc0 && marker <= 0xc3) ||
  (marker >= 0xc5 && marker <= 0xc7) ||
  (marker >= 0xc9 && marker <= 0xcb) ||
  (marker >= 0xcd && marker <= 0xcf) ||
  marker === 0xde;

/**
 * The structural segments, kept for the shape each one mandates rather than
 * for the range its marker falls in.
 *
 * `0xC0`–`0xCF` and `0xDB`–`0xDF` took the marker's word for it and never
 * read the payload behind it, which is the same trust the GIF walk placed in
 * `0xF9`. It matters more here: a JPEG may legally define the same table
 * twice, later overriding earlier, so a segment labelled `DQT` and filled
 * with something else rides along inside a photograph that decodes and
 * displays exactly as it should. Nothing looks wrong, which is why nothing
 * would have been noticed.
 *
 * Each of these has an internal structure that must consume its payload
 * exactly. A payload that does not is not the thing its marker claims.
 */
function keepJpegStructural(
  bytes: Uint8Array,
  marker: number,
  payload: number,
  payloadEnd: number,
): boolean {
  const length = payloadEnd - payload;

  switch (marker) {
    case 0xc4:
      /**
       * DHT — Huffman tables back to back: a class-and-id byte, sixteen
       * counts, then one symbol for each unit the counts add up to.
       *
       * Counting the symbols is not enough on its own. The symbol region
       * is the widest thing in this file that a shape could still be put
       * to: any byte is a legal symbol *value*, so measuring only the
       * length leaves the whole region free. What constrains it is that
       * the counts have to describe a code a decoder could actually use —
       * no more than 256 symbols, and a code space that does not overflow
       * (Kraft) — and that a table does not give the same symbol two
       * codes. Together those turn "any bytes at all" into a permutation
       * of distinct values under a valid tree, which is not a channel
       * worth having but is a far narrower one than it was.
       */
      return spansExactly(payload, payloadEnd, (at) => {
        if (bytes[at] >> 4 > 1 || (bytes[at] & 0x0f) > 3) return null;
        if (at + 17 > payloadEnd) return null;

        let symbols = 0;
        let space = 0;
        for (let i = 0; i < 16; i += 1) {
          const count = bytes[at + 1 + i];
          symbols += count;
          space += count << (15 - i);
        }
        if (symbols > 256 || space > 1 << 16) return null;
        if (at + 17 + symbols > payloadEnd) return null;

        const seen = new Set<number>();
        for (let i = 0; i < symbols; i += 1) seen.add(bytes[at + 17 + i]);
        if (seen.size !== symbols) return null;

        return at + 17 + symbols;
      });
    case 0xdb:
      // DQT — quantisation tables back to back: a precision-and-id byte,
      // then sixty-four values held in one byte each, or two.
      return spansExactly(payload, payloadEnd, (at) => {
        const precision = bytes[at] >> 4;
        if (precision > 1 || (bytes[at] & 0x0f) > 3) return null;
        return at + 1 + (precision === 0 ? 64 : 128);
      });
    case 0xcc:
      /**
       * DAC — arithmetic conditioning, and dropped outright.
       *
       * Validating it record by record is not enough, and the reason is
       * worth keeping: a record is a class-and-id byte followed by the
       * value being conditioned, and only the first of those has a shape.
       * Eight of the 256 first bytes are legal, so a filler byte in every
       * first position and a chosen byte in every second smuggles data at
       * half bandwidth, exactly reconstructable, scaling with the segment
       * — and several segments are legal.
       *
       * The conditioning value has no shape to check it against, so the
       * only sound options are to drop the segment or to keep the channel.
       * Arithmetic-coded JPEG costs nothing to refuse: no mainstream
       * encoder emits it and most decoders cannot read it, so a file that
       * needs this segment is one no browser here would render anyway.
       */
      return false;
    case 0xc8:
      // JPG — reserved, carrying nothing any decoder is defined to read.
      return false;
    case 0xdc: // DNL, a line count.
    case 0xdd: // DRI, a restart interval.
      return length === 2;
    case 0xdf:
      // EXP — one byte of horizontal and vertical expansion.
      return length === 1;
    default:
      // A frame header: sample precision, two dimensions and a component
      // count, then three bytes describing each component it declares.
      if (!isJpegFrame(marker)) return false;
      if (length < 6 || bytes[payload + 5] < 1) return false;
      return length === 6 + 3 * bytes[payload + 5];
  }
}

function stripJpeg(bytes: ImageBytes, budget: Budget): ImageBytes {
  const keep: [number, number][] = [[0, 2]]; // SOI
  let at = 2;

  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) throw new UnreadableImageError("expected a marker");

    // Any number of 0xFF bytes may pad the gap before a marker's code.
    let code = at + 1;
    while (code < bytes.length && bytes[code] === 0xff) code += 1;
    if (code >= bytes.length)
      throw new UnreadableImageError("truncated marker");
    const marker = bytes[code];

    /**
     * The start of a scan, and the end of anything worth reading. What
     * follows is entropy-coded data whose length is not declared anywhere —
     * it runs to the next marker, and finding that means decoding it. Every
     * metadata segment precedes the first scan, so the rest of the file is
     * copied through as it is.
     */
    if (marker === 0xda) break;

    // Standalone markers: no length, no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      keep.push([at, code + 1]);
      at = code + 1;
      continue;
    }

    if (code + 3 > bytes.length)
      throw new UnreadableImageError("truncated segment");
    const length = (bytes[code + 1] << 8) | bytes[code + 2];
    if (length < 2)
      throw new UnreadableImageError("segment length below its own header");
    const end = code + 1 + length;
    if (end > bytes.length)
      throw new UnreadableImageError("segment runs past the end");

    if (keepJpegSegment(bytes, budget, marker, code + 3, end)) {
      keep.push([at, end]);
    }
    at = end;
  }

  keep.push([at, bytes.length]);
  return join(bytes, keep);
}

/**
 * PNG chunk types that survive, plus `eXIf`, which is scrubbed rather than
 * kept as it stands.
 *
 * An allowlist, and it replaced a blocklist of the three text chunk types.
 * The blocklist was the same error as keeping a block for its label, one step
 * weaker: it kept a chunk for *not being named*, so any private or unknown
 * type — `gpSd`, say, holding a latitude — went to the store untouched. PNG's
 * registered types are a closed set and its private ones are by definition
 * things this application has no reason to carry.
 *
 * What is listed is everything that draws, colours or times the image:
 * the four critical chunks, the colour and rendering hints, the APNG
 * animation chunks (without which an animated PNG loses its frames), and the
 * HDR signalling chunks. What is not listed and therefore goes: `tEXt`,
 * `zTXt`, `iTXt` — which is how XMP arrives — `tIME`, and everything nobody
 * has registered.
 */
const PNG_KEEP: ReadonlySet<string> = new Set([
  // The image itself.
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  // Colour, transparency and rendering intent.
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "bKGD",
  "hIST",
  "sPLT",
  "pHYs",
  // APNG.
  "acTL",
  "fcTL",
  "fdAT",
  // HDR signalling.
  "cICP",
  "mDCv",
  "cLLi",
]);

/** The payload length each fixed-size PNG chunk is defined to carry. */
const PNG_FIXED: ReadonlyMap<string, number> = new Map([
  ["IHDR", 13],
  ["IEND", 0],
  ["gAMA", 4],
  ["cHRM", 32],
  ["sRGB", 1],
  ["pHYs", 9],
  ["acTL", 8],
  ["fcTL", 26],
  ["cICP", 4],
  ["mDCv", 24],
  ["cLLi", 8],
]);

/**
 * Whether a kept chunk carries a payload of the size its type defines.
 *
 * `PNG_KEEP` matched the four-character type and nothing else, which is a
 * claim taken on trust exactly as a JPEG marker was: `gAMA` is four bytes of
 * gamma, but a `gAMA` chunk declaring four hundred was kept whole, tail
 * included. Decoders tolerate a repeated ancillary chunk, so — as with a
 * duplicate JPEG table — the carrier still rendered normally.
 *
 * The variable ones are named here with whatever does bound them: a palette
 * is a whole number of colours and at most 256, a histogram one entry per
 * colour, transparency at most one byte per colour. `IDAT`, `fdAT`, `iCCP`
 * and `sPLT` stay genuinely variable, because compressed data and colour
 * profiles are arbitrary bytes by construction. That is this scrubber's
 * limit, and it is the limit the module's docblock states.
 */
function pngLengthFits(type: string, length: number): boolean {
  const fixed = PNG_FIXED.get(type);
  if (fixed !== undefined) return length === fixed;

  switch (type) {
    case "PLTE":
      return length > 0 && length % 3 === 0 && length <= 768;
    case "hIST":
      return length > 0 && length % 2 === 0 && length <= 512;
    case "tRNS":
      return length > 0 && length <= 256;
    case "sBIT":
      return length >= 1 && length <= 4;
    case "bKGD":
      return length === 1 || length === 2 || length === 6;
    case "fdAT":
      return length >= 4; // A sequence number, then frame data.
    case "iCCP":
    case "sPLT":
      return length >= 3; // A name, its terminator, and at least one byte.
    case "IDAT":
      return true;
    default:
      return false;
  }
}

function stripPng(bytes: ImageBytes, budget: Budget): ImageBytes {
  const keep: [number, number][] = [[0, 8]]; // The eight-byte signature.
  let at = 8;

  while (at + 8 <= bytes.length) {
    const length =
      (bytes[at] << 24) |
      (bytes[at + 1] << 16) |
      (bytes[at + 2] << 8) |
      bytes[at + 3];
    if (length < 0) throw new UnreadableImageError("chunk length past 2GiB");

    const type = ascii(bytes, at + 4, 4);
    const data = at + 8;
    const end = data + length + 4; // …including the four-byte CRC.
    if (end > bytes.length)
      throw new UnreadableImageError("chunk runs past the end");

    if (type === "eXIf") {
      if (scrubExif(bytes.subarray(data, data + length), budget)) {
        // The chunk's own bytes changed, so its checksum has to be redone
        // over type-and-data, which is what PNG covers with the CRC.
        const crc = crc32(bytes.subarray(at + 4, data + length));
        new DataView(bytes.buffer, bytes.byteOffset).setUint32(
          data + length,
          crc,
        );
        keep.push([at, end]);
      }
    } else if (PNG_KEEP.has(type) && pngLengthFits(type, length)) {
      keep.push([at, end]);
    }
    // Everything else is dropped whole, including every private and unknown
    // type. Nothing renders from them.

    at = end;
    if (type === "IEND") break;
  }

  keep.push([at, bytes.length]);
  return join(bytes, keep);
}

/**
 * Bit in a WebP `VP8X` chunk's flag byte announcing that the file carries a
 * given kind of metadata. A decoder is entitled to trust these, so a dropped
 * chunk has to clear its bit or the file describes something that is no
 * longer there.
 */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/**
 * WebP chunks that survive, `EXIF` aside — it is scrubbed, and `XMP ` is
 * always dropped.
 *
 * An allowlist for the same reason PNG has one: the walk used to keep any
 * chunk it did not recognise, and RIFF lets a file carry as many
 * four-character chunks as it likes. These seven are the whole of what the
 * format defines for drawing an image — the extended header, a colour
 * profile, the animation header and its frames, an alpha plane, and the two
 * bitstream types.
 */
const WEBP_KEEP: ReadonlySet<string> = new Set([
  "VP8X",
  "ICCP",
  "ANIM",
  "ANMF",
  "ALPH",
  "VP8 ",
  "VP8L",
]);

/**
 * Whether a kept WebP chunk carries the payload its type defines.
 *
 * The same gap PNG had, and RIFF makes it wider: chunk skipping is driven
 * entirely by the declared length, so an oversized `VP8X` or `ANIM` with a
 * valid prefix and an arbitrary tail is skipped over cleanly by a decoder
 * and displays as though nothing were there. `ICCP` and the two bitstreams
 * are variable by nature and stay unmeasured.
 */
function webpLengthFits(
  bytes: Uint8Array,
  view: DataView,
  type: string,
  data: number,
  length: number,
): boolean {
  switch (type) {
    case "VP8X":
      return length === 10;
    case "ANIM":
      return length === 6;
    case "ANMF":
      // A sixteen-byte frame header, then the frame's own chunks. `ANMF` is
      // a container, so measuring its length would leave the same gap one
      // level down: a frame is entitled to sub-chunks, and nothing says an
      // `XMP ` cannot be among them. They are walked, and the frame is kept
      // only when they tile it exactly and every one of them draws.
      return length >= 16 && framesOnly(bytes, view, data + 16, data + length);
    case "ALPH":
      return length >= 1;
    default:
      return true;
  }
}

/** The chunks a single animation frame may carry: its pixels, and its alpha. */
const WEBP_FRAME: ReadonlySet<string> = new Set(["ALPH", "VP8 ", "VP8L"]);

function framesOnly(
  bytes: Uint8Array,
  view: DataView,
  from: number,
  to: number,
): boolean {
  let at = from;
  while (at < to) {
    if (at + 8 > to) return false;
    const type = ascii(bytes, at, 4);
    const length = view.getUint32(at + 4, true);
    const end = at + 8 + length + (length % 2);
    if (end > to || end <= at) return false;
    if (!WEBP_FRAME.has(type)) return false;
    at = end;
  }
  return at === to;
}

function stripWebp(bytes: ImageBytes, budget: Budget): ImageBytes {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep: [number, number][] = [[0, 12]]; // "RIFF", size, "WEBP"
  let at = 12;
  let vp8x: number | null = null;
  let cleared = 0;

  while (at + 8 <= bytes.length) {
    const type = ascii(bytes, at, 4);
    const length = view.getUint32(at + 4, true);
    const data = at + 8;
    // RIFF pads odd-length chunks to an even boundary; the pad byte is not
    // counted in the length but is very much in the file.
    const end = data + length + (length % 2);
    if (end > bytes.length)
      throw new UnreadableImageError("chunk runs past the end");

    if (type === "XMP ") {
      cleared |= VP8X_XMP;
    } else if (type === "EXIF") {
      if (scrubExif(bytes.subarray(data, data + length), budget)) {
        keep.push([at, end]);
      } else cleared |= VP8X_EXIF;
    } else if (
      WEBP_KEEP.has(type) &&
      webpLengthFits(bytes, view, type, data, length)
    ) {
      // Only a `VP8X` of the mandated size is worth remembering: one that
      // fails its measurement is dropped, and there is then no header left
      // holding flags to clear.
      if (type === "VP8X") vp8x = data;
      keep.push([at, end]);
    }
    // Anything else is dropped. There is no flag in `VP8X` to clear for it,
    // because the format does not know it exists either.

    at = end;
  }

  keep.push([at, bytes.length]);
  if (vp8x !== null && cleared !== 0) bytes[vp8x] &= ~cleared;

  const out = join(bytes, keep);
  // The RIFF length counts everything after itself, and chunks were removed.
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

/**
 * GIF block introducers, and the two extension labels this scrub keeps.
 *
 * A GIF is a header, a screen descriptor, a colour table, and then a flat
 * sequence of blocks each identified by its first byte. That flatness is what
 * makes it walkable: unlike a JPEG scan, every block declares its own length,
 * so the file can be rebuilt exactly rather than copied from a point onwards.
 */
const GIF_EXTENSION = 0x21;
const GIF_IMAGE = 0x2c;
const GIF_TRAILER = 0x3b;
const GIF_GRAPHIC_CONTROL = 0xf9;
const GIF_APPLICATION = 0xff;

/**
 * Whether the extension at `at` is exactly the shape its label mandates.
 *
 * The rule this enforces, and the one every branch of the GIF allowlist has
 * to obey: **a block is kept for its shape, never for its label.** A label is
 * a claim the file makes about itself, and the blocks being kept here are
 * kept precisely because their contents are fixed and known — a graphic
 * control extension is four bytes of timing, a loop count is two bytes of
 * count. Keeping one on its label alone means keeping whatever a sub-block
 * chain happens to contain, which is an arbitrary-data channel wearing the
 * name of a four-byte field.
 *
 * `size` is the block-size byte the format mandates for that label and
 * `length` the whole extension including introducer, label and terminator.
 * Both are fixed by the specification, so a block that disagrees with either
 * is not the block it says it is.
 */
function isFixedExtension(
  bytes: Uint8Array,
  at: number,
  end: number,
  label: number,
  size: number,
  length: number,
): boolean {
  return (
    bytes[at + 1] === label && end - at === length && bytes[at + 2] === size
  );
}

/**
 * A graphic control extension: frame delay, disposal and transparency.
 *
 * Eight bytes, always — introducer, label, a block size of exactly four, the
 * four bytes themselves, and the terminator. There is no variable-length
 * form of this block and no version of the format in which there was one.
 */
function isGifGraphicControl(
  bytes: Uint8Array,
  at: number,
  end: number,
): boolean {
  return isFixedExtension(bytes, at, end, GIF_GRAPHIC_CONTROL, 0x04, 8);
}

/**
 * The one application extension that survives: Netscape's loop count.
 *
 * Dropping every application extension would be simpler and would stop every
 * animated GIF in the wiki from looping — the frames and their timing live in
 * graphic control extensions and image blocks, but *how many times it plays*
 * lives in this one, and without it a browser plays the animation once and
 * stops. That is a visible regression on the one format anybody uploads
 * specifically because it moves.
 *
 * It is matched by its exact shape rather than by its name: the eleven-byte
 * identifier, one three-byte sub-block, the sub-block's own leading `0x01`,
 * and the terminator — nineteen bytes with two of them free. A block wearing
 * this name and carrying anything else is not a loop count, and goes with the
 * rest.
 */
const GIF_LOOP = "NETSCAPE2.0";
const GIF_LOOP_LENGTH = 19;

/** A GIF colour table's size in bytes, from the packed field that describes it. */
const colourTableBytes = (packed: number): number =>
  packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;

/**
 * The end of the sub-block chain starting at `at`.
 *
 * Every variable-length payload in a GIF is a chain of sub-blocks, each a
 * length byte followed by that many bytes, ending with a zero length. Walking
 * it is what lets an extension be skipped without understanding it — which is
 * the whole point, since the blocks being removed here are by definition ones
 * whose contents this code has no business interpreting.
 *
 * It also handles the XMP-in-GIF encoding, which is a deliberate abuse of
 * this structure: the packet is *not* length-prefixed, so its own ASCII bytes
 * act as the lengths and the walk hops through the text in irregular strides
 * until a 258-byte trailer of descending values funnels every possible
 * landing point onto the terminating zero. That is the encoding this scrub
 * has to survive, because it is the one the tools in the wild write.
 */
function gifSubBlocksEnd(bytes: Uint8Array, at: number): number {
  let cursor = at;
  while (cursor < bytes.length) {
    const size = bytes[cursor];
    if (size === 0) return cursor + 1;
    cursor += 1 + size;
  }
  throw new UnreadableImageError("sub-block chain runs past the end");
}

/**
 * Whether the extension at `at` is exactly a Netscape loop count.
 *
 * Shape first, then the two bytes inside the sub-block that are also fixed:
 * its own length (`0x03`) and the sub-block id (`0x01`). What is left
 * unchecked is the loop count itself, two bytes at `at + 16`, and it has to
 * be: a real loop count is an arbitrary sixteen-bit number, so there is no
 * shape to hold it to. That is 65,536 states of attacker-chosen value in a
 * file that already carries a palette and a pixel buffer — noted rather than
 * defended, because two bytes cannot hold a coordinate pair and no scrub can
 * remove a field whose whole range is legal.
 */
function isGifLoop(bytes: Uint8Array, at: number, end: number): boolean {
  return (
    isFixedExtension(bytes, at, end, GIF_APPLICATION, 0x0b, GIF_LOOP_LENGTH) &&
    startsWith(bytes, at + 3, GIF_LOOP) &&
    bytes[at + 14] === 0x03 &&
    bytes[at + 15] === 0x01
  );
}

/**
 * Rebuild a GIF without the blocks that carry arbitrary data.
 *
 * ## The premise this replaces was wrong
 *
 * An earlier version of this module returned a GIF untouched, on the grounds
 * that the format has no Exif block and no coordinate in its specification.
 * The first half is true and the second half is not the same claim. **GIF89a
 * defines an Application Extension** — a labelled block of vendor-defined
 * data — and that is the documented mechanism XMP uses to ride in a GIF, the
 * one ImageMagick, Photoshop's "Save for Web" and `exiftool` all write. An
 * XMP packet carries `exif:GPSLatitude` and `exif:GPSLongitude`, which are
 * the same fields already stripped from the other three formats.
 *
 * So a GIF converted from a phone video or a burst by a tool that carries the
 * source metadata across arrives here with the coordinates in it, and the
 * pass-through handed them straight to the store. The comment was not a
 * documentation slip; the threat model had the gap, which is why this file
 * and `docs/architecture.md` now both say what an Application Extension is.
 *
 * ## What is kept
 *
 * Everything that draws or times the picture: the header, the logical screen
 * descriptor, the global and local colour tables, every image block, and the
 * two extensions with a mandated fixed shape — the graphic control extension
 * and the Netscape loop count — **each matched against that shape rather than
 * against its label**. Everything that carries free-form data goes:
 * application extensions other than the loop, comment extensions, and
 * plain-text extensions, which are a legacy rendering feature no decoder has
 * implemented in decades and an arbitrary ASCII carrier in the meantime.
 *
 * The shape check is not decoration. A graphic control extension is four
 * bytes of timing, but its label sits in front of an ordinary sub-block
 * chain, so keeping one on the label alone kept whatever that chain held —
 * sixty bytes of coordinates, or as many kilobytes as the upload cap allows.
 * That is `isFixedExtension`, and the reason both arms of the allowlist go
 * through it.
 *
 * Bytes after the trailer go too. They are outside the image by definition,
 * nothing renders them, and they are the most obvious place left to put
 * something. That is a stricter line than the JPEG walk draws, and the
 * difference is capability rather than judgement: a JPEG scan cannot be
 * traversed without decoding it, so the walk there has to stop and copy the
 * rest; a GIF declares every length, so the file can be rebuilt exactly.
 */
function stripGif(bytes: ImageBytes): ImageBytes {
  // Header (6) and logical screen descriptor (7); the packed field at 10 says
  // whether a global colour table follows.
  if (bytes.length < 13) {
    throw new UnreadableImageError("no logical screen descriptor");
  }
  let at = 13 + colourTableBytes(bytes[10]);
  if (at > bytes.length) {
    throw new UnreadableImageError("global colour table runs past the end");
  }

  const keep: [number, number][] = [[0, at]];

  for (;;) {
    if (at >= bytes.length) throw new UnreadableImageError("no trailer");
    const block = bytes[at];

    if (block === GIF_TRAILER) {
      keep.push([at, at + 1]);
      break;
    }

    if (block === GIF_EXTENSION) {
      if (at + 2 > bytes.length) {
        throw new UnreadableImageError("truncated extension");
      }
      const end = gifSubBlocksEnd(bytes, at + 2);
      // Both arms validate shape. Neither may be relaxed to a label test —
      // see `isFixedExtension`, and the graphic control extension in
      // particular, which was kept on its label alone until a reviewer put
      // sixty bytes of coordinates behind a `0xF9`.
      if (isGifGraphicControl(bytes, at, end) || isGifLoop(bytes, at, end)) {
        keep.push([at, end]);
      }
      at = end;
      continue;
    }

    if (block === GIF_IMAGE) {
      // Image descriptor: nine bytes, the last of them packed, then an
      // optional local colour table, then the LZW code size, then the data.
      if (at + 10 > bytes.length) {
        throw new UnreadableImageError("truncated image descriptor");
      }
      const data = at + 10 + colourTableBytes(bytes[at + 9]);
      if (data + 1 > bytes.length) {
        throw new UnreadableImageError("local colour table runs past the end");
      }
      const end = gifSubBlocksEnd(bytes, data + 1);
      keep.push([at, end]);
      at = end;
      continue;
    }

    // Not a block introducer, which means the walk is no longer aligned to
    // block boundaries and nothing after this point can be trusted.
    throw new UnreadableImageError("unknown block");
  }

  return join(bytes, keep);
}

/**
 * Return `bytes` with its location metadata removed.
 *
 * Nothing is ever scrubbed in place in the caller's buffer: every format that
 * has work to do copies first, because callers hold the body of a request and
 * a function that quietly rewrote a buffer its caller still had a reference to
 * would be a trap in a file about not surprising anyone. GIF needs no copy
 * for a different reason: its walk only ever reads, and assembles a fresh
 * buffer out of the ranges it decided to keep.
 *
 * @throws {UnreadableImageError} if the container cannot be walked.
 */
export function stripLocation(bytes: ImageBytes, type: ImageType): ImageBytes {
  // One allowance for the whole file, handed to every block in it. See
  // {@link MAX_ENTRIES}: minting it per block would bound each block and
  // leave the file unbounded, which is the same mistake one level up.
  const budget: Budget = { entries: MAX_ENTRIES };

  switch (type) {
    case "image/jpeg":
      return stripJpeg(bytes.slice(), budget);
    case "image/png":
      return stripPng(bytes.slice(), budget);
    case "image/webp":
      return stripWebp(bytes.slice(), budget);
    case "image/gif":
      // No copy: `stripGif` only ever reads, and returns a buffer it
      // assembled itself.
      return stripGif(bytes);
  }
}
