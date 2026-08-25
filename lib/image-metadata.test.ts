import { describe, expect, it } from "vitest";

import { stripLocation, UnreadableImageError } from "@/lib/image-metadata";
import {
  app0Jfif,
  app1Exif,
  app1Xmp,
  app2Icc,
  app13Iptc,
  comment,
  contains,
  COMMENT_TEXT,
  crc32,
  gpsFields,
  GPS_DATE_STAMP,
  IHDR,
  IPTC_CITY,
  jpeg,
  MAKER_NOTE_TEXT,
  png,
  PNG_TEXT,
  shortField,
  asciiField,
  TAG,
  tiff,
  undefinedField,
  VP8X,
  webp,
  XMP_LATITUDE,
  GIF,
  type Field,
} from "@/test/image-fixtures";

/**
 * The scrub (E5-T2, `YEO-42`), tested against files built a byte at a time in
 * `test/image-fixtures.ts`.
 *
 * Two properties have to hold together, and testing either alone would miss
 * the point of the ticket: **the location is gone** and **the orientation is
 * still there**. A scrubber that deleted the whole Exif block passes the
 * first and turns every portrait photograph in the wiki on its side; one that
 * preserved everything passes the second and ships somebody's home address to
 * a storage host.
 *
 * Every test that asserts something is absent first asserts it was present in
 * the input. Without that, an implementation that returned an empty buffer —
 * or one whose fixture never contained the coordinates in the first place —
 * would be reported as passing.
 */

const CAPTURED_AT = "2019:07:04 12:00:00";

/** The Exif block a phone would write: orientation, a date, a maker note, a location. */
function phoneExif(little = true): Uint8Array {
  return tiff({
    little,
    ifd0: [
      shortField(TAG.orientation, 6, little),
      asciiField(TAG.dateTimeOriginal, CAPTURED_AT),
    ],
    exif: [
      undefinedField(
        TAG.makerNote,
        [...MAKER_NOTE_TEXT].map((c) => c.charCodeAt(0)),
      ),
    ],
    gps: gpsFields(little),
  });
}

/** The JPEG segments of `file`, up to the start of the scan. */
function segmentsOf(
  file: Uint8Array,
): { marker: number; payload: Uint8Array }[] {
  const found: { marker: number; payload: Uint8Array }[] = [];
  let at = 2;
  while (at + 4 <= file.length && file[at] === 0xff) {
    const marker = file[at + 1];
    if (marker === 0xda) break;
    const length = (file[at + 2] << 8) | file[at + 3];
    found.push({ marker, payload: file.subarray(at + 4, at + 2 + length) });
    at += 2 + length;
  }
  return found;
}

/** The TIFF block inside a JPEG's Exif segment, or null if there is none. */
function exifOf(file: Uint8Array): Uint8Array | null {
  const app1 = segmentsOf(file).find(
    ({ marker, payload }) =>
      marker === 0xe1 &&
      String.fromCharCode(...payload.subarray(0, 4)) === "Exif",
  );
  return app1 ? app1.payload.subarray(6) : null;
}

/** A tiny, independent TIFF reader. The module under test is not consulted. */
function directory(block: Uint8Array, at?: number) {
  const little = block[0] === 0x49;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const offset = at ?? view.getUint32(4, little);
  const count = view.getUint16(offset, little);
  const entries = Array.from({ length: count }, (_, index) => {
    const entry = offset + 2 + index * 12;
    return {
      tag: view.getUint16(entry, little),
      type: view.getUint16(entry + 2, little),
      count: view.getUint32(entry + 4, little),
      value: view.getUint32(entry + 8, little),
      short: view.getUint16(entry + 8, little),
    };
  });
  return { entries, tags: entries.map((entry) => entry.tag) };
}

const orientationOf = (block: Uint8Array): number | undefined =>
  directory(block).entries.find((entry) => entry.tag === TAG.orientation)
    ?.short;

/** The chunks of a PNG, in order. */
function chunksOf(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const found: { type: string; data: Uint8Array; crc: number; at: number }[] =
    [];
  let at = 8;
  while (at + 8 <= file.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    found.push({
      type,
      data: file.subarray(at + 8, at + 8 + length),
      crc: view.getUint32(at + 8 + length),
      at,
    });
    at += 12 + length;
  }
  return found;
}

/** The chunks of a WebP, in order, with RIFF's even-length padding removed. */
function riffChunksOf(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const found: { type: string; data: Uint8Array }[] = [];
  let at = 12;
  while (at + 8 <= file.length) {
    const length = view.getUint32(at + 4, true);
    found.push({
      type: String.fromCharCode(...file.subarray(at, at + 4)),
      data: file.subarray(at + 8, at + 8 + length),
    });
    at += 8 + length + (length % 2);
  }
  return found;
}

describe("a JPEG from a phone", () => {
  const original = jpeg([
    app0Jfif(),
    app1Exif(phoneExif()),
    app1Xmp(),
    app13Iptc(),
    app2Icc(),
    comment(),
  ]);

  it("carries a location four different ways to begin with", () => {
    // The non-vacuity guard for everything below. Each of these is a real
    // place a phone or an editor puts coordinates.
    expect(contains(original, GPS_DATE_STAMP)).toBe(true);
    expect(contains(original, XMP_LATITUDE)).toBe(true);
    expect(contains(original, IPTC_CITY)).toBe(true);
    expect(contains(original, MAKER_NOTE_TEXT)).toBe(true);
    expect(directory(exifOf(original)!).tags).toContain(TAG.gpsIfd);
  });

  const scrubbed = stripLocation(original, "image/jpeg");

  it("has none of them afterwards", () => {
    expect(contains(scrubbed, GPS_DATE_STAMP)).toBe(false);
    expect(contains(scrubbed, XMP_LATITUDE)).toBe(false);
    expect(contains(scrubbed, IPTC_CITY)).toBe(false);
    expect(contains(scrubbed, MAKER_NOTE_TEXT)).toBe(false);
  });

  it("removes the GPS pointer as well as what it pointed at", () => {
    // Zeroing the directory without removing the entry would leave a reader
    // reporting coordinates of 0°N 0°E, which is a real place in the Gulf of
    // Guinea rather than an absence.
    expect(directory(exifOf(scrubbed)!).tags).not.toContain(TAG.gpsIfd);
  });

  it("keeps the orientation, which is the whole reason for the surgery", () => {
    expect(orientationOf(exifOf(scrubbed)!)).toBe(6);
  });

  it("keeps the capture date and the rest of the Exif block", () => {
    // A family archive is exactly the place where "when was this taken" is
    // worth more than the bytes it costs.
    expect(contains(scrubbed, CAPTURED_AT)).toBe(true);
    expect(directory(exifOf(scrubbed)!).tags).toContain(TAG.dateTimeOriginal);
  });

  it("keeps the colour profile and drops the rest of the segments", () => {
    // ICC survives because dropping it visibly shifts the colours of every
    // photograph from a wide-gamut phone and protects nothing.
    expect(segmentsOf(scrubbed).map((segment) => segment.marker)).toEqual([
      0xe0, 0xe1, 0xe2,
    ]);
    expect(contains(scrubbed, "ICC_PROFILE")).toBe(true);
    expect(contains(scrubbed, COMMENT_TEXT)).toBe(false);
  });

  it("leaves the image data alone", () => {
    // The scan and everything structural after it is copied through
    // untouched — this module rewrites metadata, not pixels.
    expect([...scrubbed.subarray(scrubbed.length - 9)]).toEqual([
      0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9,
    ]);
  });

  it("does not modify the buffer it was given", () => {
    // Callers hold the body of a request; a function that rewrote it under
    // them would be a trap.
    expect(contains(original, GPS_DATE_STAMP)).toBe(true);
  });
});

describe("a big-endian Exif block", () => {
  // Motorola byte order is not exotic — several camera makers write it — and
  // every offset and count in the scrub is read through it.
  const original = jpeg([app1Exif(phoneExif(false))]);
  const scrubbed = stripLocation(original, "image/jpeg");

  it("is scrubbed the same way", () => {
    expect(contains(original, GPS_DATE_STAMP)).toBe(true);
    expect(contains(scrubbed, GPS_DATE_STAMP)).toBe(false);
    expect(orientationOf(exifOf(scrubbed)!)).toBe(6);
  });
});

describe("an Exif block that cannot be understood", () => {
  /**
   * The rule that makes a hand-written parser defensible: metadata this code
   * cannot read is removed rather than passed through. The cost is a rotated
   * photograph; the alternative is forwarding bytes on the theory that they
   * were probably harmless.
   */
  it("is dropped whole when the TIFF header is nonsense", () => {
    const file = jpeg([app1Exif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))]);
    expect(exifOf(stripLocation(file, "image/jpeg"))).toBeNull();
  });

  it("is dropped whole when the GPS pointer leads outside the block", () => {
    const block = tiff({
      ifd0: [
        shortField(TAG.orientation, 3),
        { tag: TAG.gpsIfd, type: 4, data: [0xff, 0xff, 0x00, 0x00] },
      ],
    });
    const scrubbed = stripLocation(jpeg([app1Exif(block)]), "image/jpeg");
    // Orientation goes with it. That is the trade, and it is the safe half.
    expect(exifOf(scrubbed)).toBeNull();
  });

  it("is dropped whole when a GPS field has a type of unknown width", () => {
    const gps: Field[] = [
      { tag: TAG.gpsLatitude, type: 99, data: [1, 2, 3, 4, 5, 6] },
    ];
    const scrubbed = stripLocation(
      jpeg([app1Exif(tiff({ ifd0: [shortField(TAG.orientation, 1)], gps }))]),
      "image/jpeg",
    );
    expect(exifOf(scrubbed)).toBeNull();
  });
});

describe("a container that cannot be walked", () => {
  it("is refused rather than stored", () => {
    // A file that matched an image signature and then did not parse is
    // truncated or damaged, and refusing it is both the safe answer and the
    // true one.
    const truncated = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00,
    ]);
    expect(() => stripLocation(truncated, "image/jpeg")).toThrow(
      UnreadableImageError,
    );
  });

  it("is refused when a PNG chunk runs past the end", () => {
    const file = png([{ type: "IHDR", data: IHDR }]);
    new DataView(file.buffer).setUint32(8, 0x0000_ffff);
    expect(() => stripLocation(file, "image/png")).toThrow(
      UnreadableImageError,
    );
  });
});

describe("a PNG", () => {
  const original = png([
    { type: "IHDR", data: IHDR },
    { type: "eXIf", data: [...phoneExif()] },
    { type: "tEXt", data: [...PNG_TEXT].map((c) => c.charCodeAt(0)) },
    { type: "IDAT", data: [1, 2, 3] },
    { type: "IEND", data: [] },
  ]);
  const scrubbed = stripLocation(original, "image/png");

  it("starts out carrying a location in two of its chunks", () => {
    expect(contains(original, GPS_DATE_STAMP)).toBe(true);
    expect(contains(original, PNG_TEXT)).toBe(true);
  });

  it("loses the GPS tags and every text chunk", () => {
    expect(contains(scrubbed, GPS_DATE_STAMP)).toBe(false);
    expect(contains(scrubbed, PNG_TEXT)).toBe(false);
    expect(chunksOf(scrubbed).map((chunk) => chunk.type)).toEqual([
      "IHDR",
      "eXIf",
      "IDAT",
      "IEND",
    ]);
  });

  it("keeps the orientation in the chunk it rewrote", () => {
    const exif = chunksOf(scrubbed).find((chunk) => chunk.type === "eXIf")!;
    expect(orientationOf(exif.data)).toBe(6);
  });

  it("repairs the checksum of the chunk it rewrote", () => {
    // A stale CRC is a PNG a decoder is entitled to reject, and the file
    // would look fine to every assertion above.
    const exif = chunksOf(scrubbed).find((chunk) => chunk.type === "eXIf")!;
    const typed = [...[..."eXIf"].map((c) => c.charCodeAt(0)), ...exif.data];
    expect(exif.crc).toBe(crc32(typed));
  });
});

describe("a WebP", () => {
  const original = webp([
    { type: "VP8X", data: VP8X },
    { type: "EXIF", data: [...phoneExif()] },
    { type: "XMP ", data: [...XMP_LATITUDE].map((c) => c.charCodeAt(0)) },
    { type: "VP8 ", data: [1, 2, 3] },
  ]);
  const scrubbed = stripLocation(original, "image/webp");

  it("starts out carrying a location in two chunks", () => {
    expect(contains(original, GPS_DATE_STAMP)).toBe(true);
    expect(contains(original, XMP_LATITUDE)).toBe(true);
  });

  it("scrubs the Exif chunk and drops the XMP one", () => {
    expect(contains(scrubbed, GPS_DATE_STAMP)).toBe(false);
    expect(contains(scrubbed, XMP_LATITUDE)).toBe(false);
    expect(riffChunksOf(scrubbed).map((chunk) => chunk.type)).toEqual([
      "VP8X",
      "EXIF",
      "VP8 ",
    ]);
    expect(orientationOf(riffChunksOf(scrubbed)[1].data)).toBe(6);
  });

  it("stops the header announcing metadata that is no longer there", () => {
    // A decoder trusts these bits. The XMP one has to go; the Exif one stays,
    // because that chunk survived.
    expect(riffChunksOf(scrubbed)[0].data[0]).toBe(0x2a);
  });

  it("fixes the RIFF length, which counts everything after itself", () => {
    const view = new DataView(scrubbed.buffer, scrubbed.byteOffset);
    expect(view.getUint32(4, true)).toBe(scrubbed.length - 8);
  });

  it("keeps the padding byte of an odd-length chunk out of the image data", () => {
    // RIFF pads to an even boundary and does not count the pad in the length,
    // so a walker that forgets it reads the next chunk one byte late.
    const odd = webp([
      { type: "VP8X", data: VP8X },
      { type: "XMP ", data: [1, 2, 3] },
      { type: "VP8 ", data: [9, 9, 9, 9] },
    ]);
    const out = stripLocation(odd, "image/webp");
    expect(riffChunksOf(out).map((chunk) => chunk.type)).toEqual([
      "VP8X",
      "VP8 ",
    ]);
    expect([...riffChunksOf(out)[1].data]).toEqual([9, 9, 9, 9]);
  });
});

describe("a GIF", () => {
  it("is passed through untouched", () => {
    // No Exif block, and no coordinate anywhere in the specification.
    // Rebuilding it to prove that would only be a chance to break it.
    expect(stripLocation(GIF, "image/gif")).toEqual(GIF);
  });
});

describe("an Exif block with no location in it", () => {
  it("comes back with everything it arrived with", () => {
    const original = jpeg([
      app1Exif(
        tiff({
          ifd0: [
            shortField(TAG.orientation, 8),
            asciiField(TAG.dateTimeOriginal, CAPTURED_AT),
          ],
        }),
      ),
    ]);
    const scrubbed = stripLocation(original, "image/jpeg");
    expect(orientationOf(exifOf(scrubbed)!)).toBe(8);
    expect(contains(scrubbed, CAPTURED_AT)).toBe(true);
  });
});

/**
 * An Exif block whose directories fan out: one entry-rich parent pointing at
 * many small children, none of which repeats an offset and none of which
 * nests more than one deep.
 *
 * This is the shape that gets past a depth bound and a visited-offset set
 * while still asking for entries × entries of work, and it is why the walk
 * carries a budget rather than only those two guards. Every child here is
 * individually unremarkable; what makes the block hostile is the sum.
 */
function fanOutExif(
  children: number,
  entriesEach: number,
  size: number,
): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(size);
  const view = new DataView(block.buffer);
  block[0] = 0x49;
  block[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, children, true);

  const base = 8 + 2 + children * 12 + 4;
  // The children overlap by two bytes each, so one run of counts serves them
  // all — which is what keeps the file small while the work stays quadratic.
  for (let at = 0; at < children * 2; at += 2) {
    view.setUint16(base + at, entriesEach, true);
  }
  for (let index = 0; index < children; index += 1) {
    const entry = 10 + index * 12;
    view.setUint16(entry, TAG.exifIfd, true);
    view.setUint16(entry + 2, 4, true);
    view.setUint32(entry + 4, 1, true);
    view.setUint32(entry + 8, base + index * 2, true);
  }
  return block;
}

describe("an Exif block that asks for more work than it is worth", () => {
  it("is dropped, and the budget for it is shared across directories", () => {
    // 100 children of 50 entries each. No directory is remarkable on its own
    // and nothing recurses past depth one, so a per-directory limit would
    // wave every part of this through and pay the whole cost.
    const scrubbed = stripLocation(
      jpeg([app1Exif(fanOutExif(100, 50, 4096))]),
      "image/jpeg",
    );
    expect(exifOf(scrubbed)).toBeNull();
  });

  it("still scrubs a block far larger than any camera writes", () => {
    // The other half of the bound: generous enough that a real file, even an
    // unusually chatty one, is nowhere near it.
    const crowded = tiff({
      ifd0: [
        shortField(TAG.orientation, 6),
        ...Array.from({ length: 300 }, (_, index) =>
          shortField(0x0200 + index, index),
        ),
      ],
      gps: gpsFields(),
    });
    const scrubbed = stripLocation(jpeg([app1Exif(crowded)]), "image/jpeg");

    expect(contains(crowded, GPS_DATE_STAMP)).toBe(true);
    expect(contains(scrubbed, GPS_DATE_STAMP)).toBe(false);
    expect(orientationOf(exifOf(scrubbed)!)).toBe(6);
  });
});

describe("a second directory in the chain", () => {
  const original = jpeg([
    app1Exif(
      tiff({
        ifd0: [shortField(TAG.orientation, 1)],
        ifd1: [shortField(0x0103, 6)],
        gps: gpsFields(),
        gpsIn: "ifd1",
      }),
    ),
  ]);

  it("is searched too, though no camera puts a location there", () => {
    // The specification says the GPS pointer belongs in IFD0. Reading a file
    // the way its author intended is the assumption not to make about a file
    // somebody uploaded, so every directory reached is searched — including
    // the thumbnail directory, where a specification-abiding reader would
    // report no location at all.
    expect(contains(original, GPS_DATE_STAMP)).toBe(true);
    expect(directory(exifOf(original)!).tags).not.toContain(TAG.gpsIfd);

    const scrubbed = stripLocation(original, "image/jpeg");
    expect(contains(scrubbed, GPS_DATE_STAMP)).toBe(false);
    expect(orientationOf(exifOf(scrubbed)!)).toBe(1);
  });
});
