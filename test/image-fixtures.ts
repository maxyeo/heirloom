/**
 * Image files built a byte at a time, for `lib/image-metadata.test.ts` and
 * everything downstream of it (E5-T2, `YEO-42`).
 *
 * ## Why these are not files in `test/fixtures/`
 *
 * That directory is where GEDCOM fixtures live and it is the right home for
 * them, because a `.ged` is text: a reviewer opens it and can see what the
 * test is claiming. A JPEG is not. Committing a binary photograph would
 * mean every assertion about it — that it carries GPS, that it carries an
 * orientation of 6, that the maker note is where the test says — would be a
 * claim nobody reviewing the diff could check, about bytes nobody reviewing
 * the diff can read.
 *
 * Built here instead, the fixture *is* the claim. `gpsIfd()` below is six
 * lines and a reader can see the coordinates go in, which is what makes it
 * meaningful when a test then asserts they are gone.
 *
 * ## They are deliberately not decodable
 *
 * None of these files contains real pixel data — the scan is a handful of
 * bytes and the PNG has no valid `IDAT`. Nothing under test decodes an
 * image: the modules here walk containers and rewrite metadata, and a real
 * photograph would be a megabyte of noise around the four hundred bytes that
 * matter.
 */

/** The field types used below, and the width of one value of each. */
/**
 * Every builder below is typed `Uint8Array<ArrayBuffer>` rather than plain
 * `Uint8Array`. `lib/image-metadata.ts` pins that same backing store for a
 * reason it explains there — only an `ArrayBuffer`-backed view is a
 * `BlobPart` — and a fixture typed loosely would need a cast at every call.
 */
const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
};

export interface Field {
  tag: number;
  type: number;
  /** The value, already encoded. Count is derived from its length. */
  data: number[];
}

const bytes = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

const u16 = (value: number, little: boolean): number[] =>
  little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];

const u32 = (value: number, little: boolean): number[] => {
  const be = [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  return little ? be.reverse() : be;
};

export const asciiField = (tag: number, text: string): Field => ({
  tag,
  type: 2,
  data: [...bytes(text), 0],
});

export const shortField = (
  tag: number,
  value: number,
  little = true,
): Field => ({
  tag,
  type: 3,
  data: u16(value, little),
});

export const rationalField = (
  tag: number,
  pairs: readonly [number, number][],
  little = true,
): Field => ({
  tag,
  type: 5,
  data: pairs.flatMap(([n, d]) => [...u32(n, little), ...u32(d, little)]),
});

export const undefinedField = (tag: number, data: number[]): Field => ({
  tag,
  type: 7,
  data,
});

/** Exif tag numbers the tests name. */
export const TAG = {
  orientation: 0x0112,
  dateTimeOriginal: 0x9003,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  makerNote: 0x927c,
  gpsLatitude: 0x0002,
  gpsDateStamp: 0x001d,
} as const;

/**
 * A location, spelled so a test can search the file for it.
 *
 * The date stamp is a string rather than more coordinates because a run of
 * ASCII is findable in a buffer with `indexOf`, which is what lets the tests
 * assert the *input* still contains it — the non-vacuity check without which
 * a scrubber that returned an empty file would pass everything.
 */
export const GPS_DATE_STAMP = "1999:12:31";

export const gpsFields = (little = true): Field[] => [
  rationalField(
    TAG.gpsLatitude,
    [
      [51, 1],
      [30, 1],
      [0, 1],
    ],
    little,
  ),
  asciiField(TAG.gpsDateStamp, GPS_DATE_STAMP),
];

/** A vendor blob, findable the same way. */
export const MAKER_NOTE_TEXT = "MakerNoteSecretPayload";

interface TiffOptions {
  little?: boolean;
  /** Entries in IFD0, before any pointer entries are appended. */
  ifd0?: Field[];
  /** Entries in the Exif sub-IFD. Adds a pointer to IFD0 when present. */
  exif?: Field[];
  /** Entries in the GPS IFD. Adds a pointer to IFD0 when present. */
  gps?: Field[];
  /** Entries in IFD1, reached through IFD0's next-directory pointer. */
  ifd1?: Field[];
  /**
   * Which directory the GPS pointer is written into. IFD0 is where the
   * specification puts it; `"ifd1"` builds the file that a
   * specification-abiding reader would report as carrying no location at all.
   */
  gpsIn?: "ifd0" | "ifd1";
}

const directorySize = (count: number): number => 2 + count * 12 + 4;

/**
 * A TIFF/Exif block: header, directories, then a heap of the values too big
 * to sit inside their own entries.
 *
 * Laid out in that order on purpose — it is the order a camera writes, and it
 * means every external value is at a *higher* offset than every directory, so
 * a test that finds a coordinate in the heap knows the entry pointing at it
 * came first.
 */
export function tiff(options: TiffOptions = {}): Uint8Array<ArrayBuffer> {
  const little = options.little ?? true;
  const ifd0 = [...(options.ifd0 ?? [])];
  const ifd1 = options.ifd1 ? [...options.ifd1] : undefined;
  const { exif, gps } = options;
  const gpsInIfd1 = options.gpsIn === "ifd1";

  // Positions are fixed before anything is written, because a pointer entry
  // in IFD0 has to name a directory that has not been laid out yet.
  const pointers = (exif ? 1 : 0) + (gps && !gpsInIfd1 ? 1 : 0);
  const exifAt = 8 + directorySize(ifd0.length + pointers);
  const gpsAt = exifAt + (exif ? directorySize(exif.length) : 0);
  const ifd1At = gpsAt + (gps ? directorySize(gps.length) : 0);
  const ifd1Count = (ifd1?.length ?? 0) + (gps && gpsInIfd1 ? 1 : 0);
  const heapAt = ifd1At + (ifd1 ? directorySize(ifd1Count) : 0);

  const gpsPointer = { tag: TAG.gpsIfd, type: 4, data: u32(gpsAt, little) };
  if (exif) ifd0.push({ tag: TAG.exifIfd, type: 4, data: u32(exifAt, little) });
  if (gps && !gpsInIfd1) ifd0.push(gpsPointer);
  if (gps && gpsInIfd1) ifd1?.push(gpsPointer);

  const heap: number[] = [];
  const out: number[] = [
    ...bytes(little ? "II" : "MM"),
    ...u16(42, little),
    ...u32(8, little),
  ];

  const writeDirectory = (fields: Field[], next: number): void => {
    out.push(...u16(fields.length, little));
    for (const field of fields) {
      out.push(...u16(field.tag, little), ...u16(field.type, little));
      out.push(...u32(field.data.length / TYPE_SIZE[field.type], little));
      if (field.data.length <= 4) {
        // Inline, left-aligned in the four value bytes, zero-padded.
        out.push(...field.data, ...new Array(4 - field.data.length).fill(0));
      } else {
        out.push(...u32(heapAt + heap.length, little));
        heap.push(...field.data);
      }
    }
    out.push(...u32(next, little));
  };

  writeDirectory(ifd0, ifd1 ? ifd1At : 0);
  if (exif) writeDirectory(exif, 0);
  if (gps) writeDirectory(gps, 0);
  if (ifd1) writeDirectory(ifd1, 0);

  return new Uint8Array([...out, ...heap]);
}

/** A JPEG segment: a marker byte and the payload that follows its length. */
export interface Segment {
  marker: number;
  payload: number[];
}

export const app1Exif = (block: Uint8Array): Segment => ({
  marker: 0xe1,
  payload: [...bytes("Exif\0\0"), ...block],
});

export const XMP_LATITUDE = "exif:GPSLatitude=51,30.000000N";

export const app1Xmp = (): Segment => ({
  marker: 0xe1,
  payload: [
    ...bytes("http://ns.adobe.com/xap/1.0/\0"),
    ...bytes(`<x:xmpmeta>${XMP_LATITUDE}</x:xmpmeta>`),
  ],
});

export const IPTC_CITY = "IPTC-City-Cambridge";

export const app13Iptc = (): Segment => ({
  marker: 0xed,
  payload: [...bytes("Photoshop 3.0\0"), ...bytes(IPTC_CITY)],
});

export const ICC_PROFILE = [...bytes("ICC_PROFILE\0"), 1, 1, 0, 0, 0, 0];

export const app2Icc = (): Segment => ({ marker: 0xe2, payload: ICC_PROFILE });

export const app0Jfif = (): Segment => ({
  marker: 0xe0,
  payload: [...bytes("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0],
});

export const COMMENT_TEXT = "Taken at home";

export const comment = (): Segment => ({
  marker: 0xfe,
  payload: bytes(COMMENT_TEXT),
});

/**
 * A JPEG: start of image, the given segments, a start-of-scan with a scrap of
 * entropy-coded data behind it, and an end of image.
 */
export function jpeg(segments: readonly Segment[]): Uint8Array<ArrayBuffer> {
  const out: number[] = [0xff, 0xd8];
  for (const { marker, payload } of segments) {
    const length = payload.length + 2;
    out.push(0xff, marker, length >> 8, length & 0xff, ...payload);
  }
  // SOS, a two-byte header, then "pixels", then EOI.
  out.push(0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9);
  return new Uint8Array(out);
}

/**
 * CRC-32, written again here rather than imported from the module under test.
 *
 * `lib/image-metadata.ts` recomputes the checksum of a PNG chunk it rewrites,
 * and a test that verified that with the same implementation would only
 * prove the function agrees with itself.
 */
export function crc32(input: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface Chunk {
  type: string;
  data: number[];
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const PNG_TEXT = "Comment\0Taken at home, 51.5N 0.1W";

/** A PNG: the signature, then length/type/data/CRC for each chunk. */
export function png(chunks: readonly Chunk[]): Uint8Array<ArrayBuffer> {
  const out: number[] = [...PNG_SIGNATURE];
  for (const { type, data } of chunks) {
    const typed = [...bytes(type), ...data];
    out.push(...u32(data.length, false), ...typed, ...u32(crc32(typed), false));
  }
  return new Uint8Array(out);
}

export const IHDR = [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0];

/** A WebP: the RIFF header, then each chunk, padded to an even length. */
export function webp(chunks: readonly Chunk[]): Uint8Array<ArrayBuffer> {
  const body: number[] = [];
  for (const { type, data } of chunks) {
    body.push(...bytes(type), ...u32(data.length, true), ...data);
    if (data.length % 2 === 1) body.push(0);
  }
  const out = [
    ...bytes("RIFF"),
    ...u32(body.length + 4, true),
    ...bytes("WEBP"),
    ...body,
  ];
  return new Uint8Array(out);
}

/**
 * A `VP8X` header claiming the file carries every kind of metadata there is.
 *
 * The flag byte is what a decoder trusts, so a scrub that removes a chunk
 * without clearing its bit leaves the file describing something that is no
 * longer in it. `0x2e` is ICC, alpha, Exif and XMP all announced at once.
 */
export const VP8X = [0x2e, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * A GIF sub-block chain: length-prefixed runs of at most 255 bytes, ended by
 * a zero length. Every variable-length payload in a GIF is one of these.
 */
const subBlocks = (data: readonly number[]): number[] => {
  const out: number[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const chunk = data.slice(at, at + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
};

/** A graphic control extension: frame delay and transparency. Kept by the scrub. */
export const gifGraphicControl = (delay = 10): number[] => [
  0x21,
  0xf9,
  0x04,
  0x00,
  delay,
  0x00,
  0x00,
  0x00,
];

/**
 * A Netscape loop count — the one application extension that survives,
 * because without it an animated GIF plays once instead of looping.
 */
export const gifLoop = (count = 0): number[] => [
  0x21,
  0xff,
  0x0b,
  ...bytes("NETSCAPE2.0"),
  0x03,
  0x01,
  count & 0xff,
  count >> 8,
  0x00,
];

/** A 1×1 image block with no local colour table. */
export const gifImage = (data: readonly number[]): number[] => [
  0x2c,
  0,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  0x00,
  0x02,
  ...subBlocks(data),
];

/**
 * A payload of the kind a mislabelled extension can smuggle: a location, in
 * plain text, behind a label whose real contents are four bytes of timing.
 */
export const GIF_SMUGGLED =
  "GPSLatitude=37.4620N,GPSLongitude=122.2591W,HomeAddress=221B";

/**
 * An extension with an arbitrary label and a payload — the shape a real one
 * is *not*. Used to check that a block is kept for its shape rather than for
 * the label it claims.
 */
export const gifExtension = (
  label: number,
  payload: readonly number[],
): number[] => [0x21, label, ...subBlocks(payload)];

export const GIF_COMMENT_TEXT = "Taken at home, 37.77N 122.41W";

/** A comment extension: free-form text, and a carrier like any other. */
export const gifComment = (text = GIF_COMMENT_TEXT): number[] => [
  0x21,
  0xfe,
  ...subBlocks(bytes(text)),
];

/** An application extension with an eleven-byte identifier and a payload. */
export const gifApplication = (
  identifier: string,
  payload: readonly number[],
): number[] => [0x21, 0xff, 0x0b, ...bytes(identifier), ...subBlocks(payload)];

export const GIF_XMP_LATITUDE =
  "<exif:GPSLatitude>37,46.2400N</exif:GPSLatitude>";

/**
 * XMP as it is actually written into a GIF, magic trailer and all.
 *
 * This is the encoding `exiftool`, ImageMagick and Photoshop's "Save for Web"
 * produce, and it is a deliberate abuse of the sub-block chain: the packet is
 * **not** length-prefixed, so the walker reads the packet's own ASCII bytes
 * as sub-block lengths and hops through the text in irregular strides. What
 * makes that terminate is the trailer — a descending run 0xFF…0x01 — because
 * a hop from any byte of a descending run lands at the same place: 256 bytes
 * past the run's start, which is where the zero sits.
 *
 * The fixture carries the real thing rather than a tidy length-prefixed
 * approximation, because a scrubber that only handled the tidy version would
 * pass a test and fail on every file in the wild.
 */
export const gifXmp = (packet = GIF_XMP_LATITUDE): number[] => [
  0x21,
  0xff,
  0x0b,
  ...bytes("XMP DataXMP"),
  ...bytes(packet),
  0x01,
  ...Array.from({ length: 255 }, (_, index) => 255 - index),
  0x00,
  0x00,
];

/**
 * A GIF89a: header, a 1×1 logical screen with a two-colour global table, the
 * given blocks, and the trailer.
 */
export function gif(
  blocks: readonly (readonly number[])[],
): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...bytes("GIF89a"),
    1,
    0,
    1,
    0, // one pixel each way
    0x80, // a global colour table follows, of two entries
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xff,
    0xff,
    ...blocks.flat(),
    0x3b,
  ]);
}

export const GIF: Uint8Array<ArrayBuffer> = gif([gifImage([0x4c, 0x01, 0x00])]);

/** Whether `haystack` contains `needle` as a run of bytes. */
export function contains(haystack: Uint8Array, needle: string): boolean {
  const target = bytes(needle);
  return haystack.some((_, at) =>
    target.every((byte, index) => haystack[at + index] === byte),
  );
}
