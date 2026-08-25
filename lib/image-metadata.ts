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
 * - **XMP** (`APP1` in JPEG, `iTXt` in PNG, the `XMP ` chunk in WebP) has an
 *   `exif:GPSLatitude` of its own, which phones and editors write alongside
 *   the Exif one. Nothing renders from it.
 * - **IPTC / Photoshop resources** (`APP13`) carry a sub-location, city and
 *   country as plain text.
 * - **Every other `APPn` and the JPEG comment segment.** In JPEG this is an
 *   allowlist rather than a list of things to delete — `APP0` (JFIF), `APP2`
 *   when it is an ICC profile, and the scrubbed Exif `APP1` are kept, and
 *   the rest of a sixteen-marker grab-bag of vendor extensions goes. PNG is
 *   treated the other way round, as a blocklist of its three text chunk
 *   types, because PNG chunk types are registered and non-textual ones do
 *   not carry prose.
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
 * ## Known limits
 *
 * GIF is passed through untouched: it has no Exif block and no coordinate
 * anywhere in its specification. PNG and WebP keep whatever orientation tag
 * they arrived with but nothing re-synthesises one, because nothing that
 * produces a PNG produces a rotated one. Both are recorded in
 * `docs/architecture.md`.
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
    case 0xe0: // APP0 — JFIF/JFXX. Pixel density and a thumbnail; no prose.
      return true;
    case 0xe1: // APP1 — Exif, or XMP wearing the same marker.
      if (!startsWith(bytes, payload, "Exif\0\0")) return false;
      return scrubExif(bytes.subarray(payload + 6, payloadEnd), budget);
    case 0xe2: // APP2 — kept only when it is a colour profile.
      return startsWith(bytes, payload, "ICC_PROFILE\0");
    default:
      // Every other APPn (including APP13's IPTC block) and the comment
      // segment. Everything below 0xE0 is structural — quantisation tables,
      // Huffman tables, frame headers — and is kept.
      return !(marker >= 0xe3 && marker <= 0xef) && marker !== 0xfe;
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

/** PNG chunk types that exist to carry text, and nothing else. */
const PNG_TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);

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

    if (PNG_TEXT_CHUNKS.has(type)) {
      // Dropped whole. Nothing renders from these, and XMP arrives as one.
    } else if (type === "eXIf") {
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
    } else {
      keep.push([at, end]);
    }

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

    if (type === "VP8X") {
      vp8x = data;
      keep.push([at, end]);
    } else if (type === "XMP ") {
      cleared |= VP8X_XMP;
    } else if (type === "EXIF") {
      if (scrubExif(bytes.subarray(data, data + length), budget)) {
        keep.push([at, end]);
      } else cleared |= VP8X_EXIF;
    } else {
      keep.push([at, end]);
    }

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
 * Return `bytes` with its location metadata removed.
 *
 * Nothing is ever scrubbed in place in the caller's buffer: every format that
 * has work to do copies first, because callers hold the body of a request and
 * a function that quietly rewrote a buffer its caller still had a reference to
 * would be a trap in a file about not surprising anyone. GIF has no work to
 * do, so it is returned as it came — the one case where the result and the
 * argument are the same object, and the one case where that cannot matter.
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
      // GIF has no Exif block and no coordinate anywhere in its
      // specification. There is nothing to take out, and rebuilding the file
      // to prove it would only be a chance to break it.
      return bytes;
  }
}
