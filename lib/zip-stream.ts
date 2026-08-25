/**
 * A ZIP archive written as a stream, without holding any of it in memory
 * (E7-T4, `YEO-54`).
 *
 * ## Why this is written here rather than installed
 *
 * The acceptance criterion is that the export *streams* rather than buffering
 * the whole archive, and that rules out most of what a dependency would have
 * given us: the popular archivers are built on Node streams and a
 * `Content-Disposition` route handler wants a Web `ReadableStream`
 * (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`). What is left
 * once compression is dropped — see below — is a header layout, a CRC-32, and
 * a table of contents. That is this file. It imports nothing, which is the
 * property that lets `npm test` drive it with no database, no network and no
 * Next.js runtime, and it is the reason a format decision here can be checked
 * rather than trusted.
 *
 * ## Why ZIP, and not tar
 *
 * Two reasons, and the second is the one that actually decided it.
 *
 * **Who opens it.** docs/product.md: *"The primary author is **not** a
 * developer."* A `.zip` is a double-click in Finder and in Windows Explorer.
 * Every archive format is a command line for somebody.
 *
 * **What can be streamed.** A `tar` header states the member's length
 * *before* its bytes, so a member whose length is not yet known cannot be
 * written without buffering it first — and most of this archive is generated
 * as it is read out of Postgres, so none of its lengths are known in advance.
 * ZIP has an answer built into the format: set bit 3 of the general-purpose
 * flags, write zeros in the local header, and follow the data with a **data
 * descriptor** carrying the real CRC and sizes. That is what makes an entry
 * of unknown length streamable, and it is the shape Go's `archive/zip` writer
 * emits for every archive it produces.
 *
 * ## Why nothing is compressed
 *
 * Every entry is stored (method 0). The archive is mostly photographs, which
 * are already compressed, and the JSON beside them is small by comparison. In
 * exchange the writer has no deflate implementation and no dependency on
 * `CompressionStream`'s `deflate-raw` — which is a recent addition to Node
 * and would make the download's viability a function of the host's runtime
 * version. An uncompressed ZIP is also the one every tool that has ever read
 * a ZIP can read.
 *
 * ## What is deliberately not implemented
 *
 * **ZIP64 for a single enormous member.** The data descriptor is written
 * immediately after the member's bytes, so its 4-byte size fields are
 * committed before a later member could reveal that the archive needed the
 * 8-byte form. {@link MAX_MEMBER_BYTES} is therefore a hard limit, enforced
 * with a throw rather than a silent wrap: an image is capped at 4 MB on
 * upload (`lib/image-upload.ts`) and the JSON members are a wiki's text, so
 * nothing this application produces can approach it. An archive whose *total*
 * size passes 4 GiB is a different matter and is handled — see
 * {@link zipChunks}.
 *
 * **Encryption.** The response is served over TLS behind a session guard and
 * lands on the reader's own disk. What happens to it after that is the
 * reader's, and a passphrase they would have to keep somewhere is the thing
 * `docs/backups.md` says makes an operator's backup unopenable years later.
 */

/** `PK\x03\x04` — the header before each member's bytes. */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** `PK\x07\x08` — the descriptor after them, carrying what the header could not. */
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

/** `PK\x01\x02` — one per member, in the table of contents at the end. */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;

/** `PK\x05\x06` — the last record in the file, pointing at that table. */
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** `PK\x06\x06` — the 64-bit form of it, present only when one is needed. */
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;

/** `PK\x06\x07` — how a reader finds the record above without scanning. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** The extra field that carries a value too large for its 32-bit slot. */
const ZIP64_EXTRA_FIELD_ID = 0x0001;

/**
 * Bit 3 (data descriptor) and bit 11 (the name is UTF-8).
 *
 * Bit 3 is what this whole module rests on: it tells a reader that the CRC
 * and the sizes in the local header are not yet known and will follow the
 * data. Bit 11 says the filename bytes are UTF-8 rather than CP437, which is
 * what stops a reader in a non-Western locale from mojibaking a name — and
 * every name here is ASCII today, so it is a promise that costs nothing now
 * and is correct the day it does not.
 */
const FLAGS = 0x0008 | 0x0800;

/** Stored, not deflated. See the module docblock. */
const METHOD_STORED = 0;

/** PKZIP 2.0 — the oldest version that understands a data descriptor. */
const VERSION_STORED = 20;

/** PKZIP 4.5 — the oldest version that understands ZIP64. */
const VERSION_ZIP64 = 45;

/**
 * Unix (3) in the high byte, {@link VERSION_STORED} in the low one.
 *
 * The host byte is what makes the external attributes below mean file
 * permissions rather than DOS attribute bits, which is what gets a member
 * extracted as `-rw-r--r--` instead of `-rwxrwxrwx`.
 */
const VERSION_MADE_BY = (3 << 8) | VERSION_STORED;

/** `0644`, in the top 16 bits where a Unix-made ZIP puts its mode. */
const EXTERNAL_ATTRIBUTES = 0o100644 << 16;

/** The largest value a 32-bit field can hold; also its "look in ZIP64" sentinel. */
const UINT32_MAX = 0xffffffff;

/** The largest value a 16-bit field can hold; also its ZIP64 sentinel. */
const UINT16_MAX = 0xffff;

/**
 * The largest a single member may be.
 *
 * One byte **below** 4 GiB − 1, and the missing byte is the whole point.
 * `0xffffffff` is not just the largest value a 32-bit size field can hold, it
 * is also that field's *sentinel*: a reader that finds it there is told the
 * real size is in a ZIP64 extra field. A member of exactly that many bytes
 * would therefore have to be described in ZIP64 — and it cannot be, because
 * its data descriptor was written in the 32-bit form immediately after its
 * bytes, long before the table of contents. Excluding the value removes the
 * case rather than mis-encoding it.
 *
 * Enforced rather than assumed. Exceeding it would produce an archive that
 * looks valid and unpacks a truncated file, which is the precise failure this
 * ticket exists to rule out — *a backup nobody can restore is a file, not a
 * backup*. Nothing this application produces comes near it: an image is
 * capped at 4 MB on upload (`lib/image-upload.ts`) and the other members are
 * a wiki's text.
 */
export const MAX_MEMBER_BYTES = UINT32_MAX - 1;

/** Bytes a member can be given as, when it is not produced incrementally. */
type ZipBodyChunk = string | Uint8Array;

/**
 * What a member's bytes can be.
 *
 * The async forms are the point of the module: an `AsyncIterable` is what a
 * generator reading rows out of Postgres produces, and a `ReadableStream` is
 * what `fetch` hands back for an image. Neither has to be sized, counted or
 * held.
 */
export type ZipBody =
  ZipBodyChunk | AsyncIterable<ZipBodyChunk> | ReadableStream<Uint8Array>;

/** One file in the archive. */
export type ZipMember = {
  /**
   * Its path inside the archive, with forward slashes.
   *
   * Checked by {@link assertSafeMemberName}, because this is the value an
   * extractor turns into a path on the reader's disk.
   */
  name: string;
  body: ZipBody;
};

/**
 * The error a member name or an oversized member raises.
 *
 * A named class rather than a bare `Error` so that a caller — or a test — can
 * tell "this archive is malformed" from "the database went away halfway
 * through", which are the two ways this generator can stop early and want
 * very different responses.
 */
export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipWriteError";
  }
}

/**
 * Refuse a member name that an extractor could turn into a path outside the
 * directory it is extracting into.
 *
 * This is Zip Slip, and it is worth defending against here even though every
 * name this application writes is either a constant or a storage key that
 * `lib/storage-key.ts` has already validated. The reason is the same one that
 * module gives for validating keys that today cannot be steered: the check
 * has to be in the writer, because the writer is what survives somebody later
 * naming a member after something a person typed.
 *
 * @throws ZipWriteError if the name could escape, or cannot be represented
 */
export function assertSafeMemberName(name: string): void {
  const fail = (reason: string): never => {
    throw new ZipWriteError(
      `Unsafe archive member name (${reason}): ${JSON.stringify(name)}`,
    );
  };

  if (name.length === 0) fail("empty");
  // A drive-relative or absolute path is extracted relative to nothing.
  if (name.startsWith("/")) fail("leading slash");
  if (/^[A-Za-z]:/.test(name)) fail("drive letter");
  // ZIP paths are POSIX. A backslash is a legal filename character on Unix
  // and a separator on Windows, so a name containing one means two different
  // things depending on who unpacks it.
  if (name.includes("\\")) fail("backslash");
  if (name.endsWith("/")) fail("trailing slash");

  for (const segment of name.split("/")) {
    if (segment.length === 0) fail("empty segment");
    if (segment === "." || segment === "..") fail("relative segment");
  }

  // The name length is a 16-bit field, and it counts encoded bytes rather
  // than characters.
  if (new TextEncoder().encode(name).length > UINT16_MAX) fail("too long");
}

/**
 * Refuse a member this writer cannot describe.
 *
 * Checked against the running total rather than against each chunk, because
 * the limit is on the member and a body arrives in pieces.
 *
 * A function of a number rather than a branch inside the write loop, so that
 * it can be asserted against a literal: the alternative is a test that
 * actually produces four gigabytes to reach the throw, which is minutes of
 * CI to check one comparison. This is the same split `checkGedcomUpload` in
 * `lib/import-preview.ts` draws for the upload cap, for the same reason.
 *
 * @throws ZipWriteError if `size` cannot be written into a data descriptor
 */
export function assertMemberFits(name: string, size: number): void {
  if (size > MAX_MEMBER_BYTES) {
    throw new ZipWriteError(
      `Archive member ${JSON.stringify(name)} is larger than ` +
        `${MAX_MEMBER_BYTES} bytes, which this writer cannot describe.`,
    );
  }
}

/** What the central directory has to remember about a member already written. */
export type CentralEntry = {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
};

const encoder = new TextEncoder();

/**
 * CRC-32, the checksum ZIP has carried since 1989.
 *
 * The table is built once, on first use, rather than written out as 256
 * literals nobody can review. Note the `>>> 0` on the way out: JavaScript's
 * bitwise operators produce *signed* 32-bit integers, and a checksum with the
 * top bit set would otherwise be written as a negative number.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * A CRC-32 accumulated over however many chunks the bytes arrive in.
 *
 * The archive's integrity check is the format's own, deliberately: every
 * member carries one of these, and `unzip -t` verifies all of them. A second
 * digest recorded in the manifest would be a second thing to keep in step and
 * the one nobody would actually run.
 */
function crc32() {
  let value = 0xffffffff;
  return {
    update(bytes: Uint8Array): void {
      for (let index = 0; index < bytes.length; index += 1) {
        value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
      }
    },
    digest(): number {
      return (value ^ 0xffffffff) >>> 0;
    },
  };
}

/**
 * A little-endian writer over a fixed-size record.
 *
 * Every ZIP record is a fixed run of 2-, 4- and 8-byte little-endian fields
 * in a fixed order, so this lets each one below read as its own layout table
 * rather than as a column of `setUint16(18, …, true)` calls whose offsets a
 * reader has to add up to check. `done` asserts the record was filled
 * exactly, which turns a miscounted field — the one mistake that produces a
 * plausible-looking corrupt archive — into a throw at the moment it is made.
 */
class ZipRecord {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;

  constructor(private readonly length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.at, value, true);
    this.at += 4;
    return this;
  }

  u64(value: number): this {
    this.view.setBigUint64(this.at, BigInt(value), true);
    this.at += 8;
    return this;
  }

  done(): Uint8Array {
    if (this.at !== this.length) {
      throw new ZipWriteError(
        `Record is ${this.at} bytes, expected ${this.length}`,
      );
    }
    return this.bytes;
  }
}

function record(length: number): ZipRecord {
  return new ZipRecord(length);
}

/**
 * MS-DOS's date and time, which is what ZIP stores.
 *
 * Two-second resolution, no year before 1980, and no timezone — the format
 * predates all three concerns. **Read as UTC**, which makes the value a
 * function of the `Date` it is given rather than of the server's `TZ`, for
 * the same reason `gedcomFilename` in `lib/export-endpoint.ts` dates its file
 * in UTC: the server is the only clock in the exchange, and a timestamp that
 * moved with a deployment region would be a worse surprise than one that is
 * an hour off a reader's wall clock.
 */
function dosDateTime(moment: Date): { time: number; date: number } {
  const year = Math.max(moment.getUTCFullYear(), 1980);
  return {
    time:
      (moment.getUTCHours() << 11) |
      (moment.getUTCMinutes() << 5) |
      (moment.getUTCSeconds() >> 1),
    date:
      ((year - 1980) << 9) |
      ((moment.getUTCMonth() + 1) << 5) |
      moment.getUTCDate(),
  };
}

/** Every chunk of a body, whichever of the three shapes it arrived in. */
async function* bodyChunks(body: ZipBody): AsyncGenerator<Uint8Array> {
  if (typeof body === "string") {
    yield encoder.encode(body);
    return;
  }
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }

  // A `ReadableStream` is async-iterable on Node but not in every runtime
  // that has one, so it is read through its reader rather than through a
  // `for await` that would work here and not somewhere else.
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      // Releasing matters on the error path: an abandoned reader keeps the
      // underlying source — an open HTTP response, here — from being
      // collected.
      reader.releaseLock();
      await body.cancel().catch(() => {});
    }
    return;
  }

  for await (const chunk of body) {
    yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
  }
}

/**
 * The whole archive, chunk by chunk, in the order the bytes go out.
 *
 * ## The members arrive lazily, and that is load-bearing
 *
 * `members` is an `AsyncIterable`, not an array, and this generator consumes
 * one member's body **completely** before asking for the next. So a producer
 * can count what it has written and describe it in a later member — which is
 * exactly how `lib/backup-archive.ts` writes a manifest that reports what the
 * archive actually contains rather than what it intended to contain.
 *
 * ## ZIP64, and when it appears
 *
 * The 32-bit fields that can overflow on an archive of ordinary photographs
 * are the *offsets*, not the sizes: pass 4 GiB of total output and a member's
 * local-header offset no longer fits. The table of contents is written last,
 * when every offset is known, so those are handled properly — an entry whose
 * offset or size does not fit carries a ZIP64 extra field, and the archive
 * gets a ZIP64 end-of-directory record when the totals need one. What cannot
 * be handled retroactively is a single member over 4 GiB, whose descriptor
 * was written long before; see {@link MAX_MEMBER_BYTES}.
 *
 * @param members the files, in the order they should appear
 * @param modified the timestamp to stamp every member with, passed in rather
 *   than read so that the archive is a function of its inputs
 */
export async function* zipChunks(
  members: AsyncIterable<ZipMember>,
  modified: Date,
): AsyncGenerator<Uint8Array> {
  const { time, date } = dosDateTime(modified);
  const central: CentralEntry[] = [];
  let offset = 0;

  for await (const member of members) {
    assertSafeMemberName(member.name);
    const name = encoder.encode(member.name);
    const start = offset;

    const header = record(30)
      .u32(LOCAL_HEADER_SIGNATURE)
      .u16(VERSION_STORED)
      .u16(FLAGS)
      .u16(METHOD_STORED)
      .u16(time)
      .u16(date)
      // CRC and both sizes are unknown until the body has been written, which
      // is what bit 3 of FLAGS announces. They are repeated for real in the
      // data descriptor below and again in the central directory.
      .u32(0)
      .u32(0)
      .u32(0)
      .u16(name.length)
      .u16(0)
      .done();

    yield header;
    yield name;
    offset += header.length + name.length;

    const checksum = crc32();
    let size = 0;
    for await (const chunk of bodyChunks(member.body)) {
      if (chunk.length === 0) continue;
      size += chunk.length;
      assertMemberFits(member.name, size);
      checksum.update(chunk);
      yield chunk;
    }
    offset += size;

    const crc = checksum.digest();
    const descriptor = record(16)
      .u32(DATA_DESCRIPTOR_SIGNATURE)
      .u32(crc)
      // Stored, so the compressed and uncompressed sizes are the same number.
      .u32(size)
      .u32(size)
      .done();

    yield descriptor;
    offset += descriptor.length;

    central.push({ name, crc, size, offset: start });
  }

  const directoryOffset = offset;
  for (const entry of central) {
    const chunk = centralHeader(entry, time, date);
    yield chunk;
    offset += chunk.length;
  }
  const directorySize = offset - directoryOffset;

  yield* endOfCentralDirectory(central.length, directorySize, directoryOffset);
}

/**
 * One member's entry in the table of contents, with ZIP64 if it needs it.
 *
 * ## Only the offset can ever need it
 *
 * A member's *size* cannot: {@link MAX_MEMBER_BYTES} keeps it strictly below
 * the 32-bit sentinel, because a size that needed ZIP64 would have needed it
 * in a data descriptor written long before this point. A member's *offset*
 * can and does — it is the total bytes written so far, so a few thousand
 * photographs are enough to pass 4 GiB, which is a real archive rather than a
 * hypothetical one.
 *
 * So the ZIP64 extra field this writes carries exactly one value. The spec
 * fixes the order of the fields it *could* carry — uncompressed size,
 * compressed size, then offset — and a value is present only when the 32-bit
 * slot standing in for it holds the sentinel, so an extra field holding just
 * the offset is well-formed and is what a reader expects when only the offset
 * slot is `0xffffffff`.
 *
 * Exported for `lib/zip-stream.test.ts`. The ZIP64 branch is reachable only
 * by an archive over 4 GiB, and a test that produced one to check a field
 * offset would cost minutes of CI for every run to exercise sixteen bytes —
 * so the record is checked directly, decoded against the spec. That is the
 * same bargain `assertMemberFits` makes, one layer down.
 */
export function centralHeader(
  entry: CentralEntry,
  time: number,
  date: number,
): Uint8Array {
  // `>=`, not `>`: the sentinel is a value the offset can legitimately take,
  // and writing it literally would tell a reader to look for a ZIP64 field
  // that is not there.
  const offsetOverflows = entry.offset >= UINT32_MAX;

  const extraBytes = offsetOverflows
    ? record(4 + 8)
        .u16(ZIP64_EXTRA_FIELD_ID)
        .u16(8)
        .u64(entry.offset)
        .done()
    : new Uint8Array(0);

  const header = record(46)
    .u32(CENTRAL_HEADER_SIGNATURE)
    .u16(VERSION_MADE_BY)
    .u16(offsetOverflows ? VERSION_ZIP64 : VERSION_STORED)
    .u16(FLAGS)
    .u16(METHOD_STORED)
    .u16(time)
    .u16(date)
    .u32(entry.crc)
    // Stored, so the compressed and uncompressed sizes are the same number,
    // and neither can reach the sentinel — see MAX_MEMBER_BYTES.
    .u32(entry.size)
    .u32(entry.size)
    .u16(entry.name.length)
    .u16(extraBytes.length)
    // No comment, one disk, no internal attributes worth stating.
    .u16(0)
    .u16(0)
    .u16(0)
    .u32(EXTERNAL_ATTRIBUTES)
    .u32(offsetOverflows ? UINT32_MAX : entry.offset)
    .done();

  const chunk = new Uint8Array(
    header.length + entry.name.length + extraBytes.length,
  );
  chunk.set(header, 0);
  chunk.set(entry.name, header.length);
  chunk.set(extraBytes, header.length + entry.name.length);
  return chunk;
}

/**
 * The last records in the file: the 64-bit pair when the archive needs them,
 * and always the 22-byte record every reader looks for.
 *
 * The classic record is written whether or not ZIP64 is in play, with
 * sentinels in the fields that no longer fit. That is not belt and braces —
 * it is the format: a reader finds the end of the archive by scanning
 * backwards for `PK\x05\x06`, and an archive without one is not a ZIP file to
 * anything.
 */
export function* endOfCentralDirectory(
  count: number,
  size: number,
  offset: number,
): Generator<Uint8Array> {
  // `>=` on all three, for the reason `centralHeader` gives: each of these
  // maximum values is also the sentinel that sends a reader to the 64-bit
  // record, so a real total that happens to equal one has to be written
  // there rather than in the slot it fills exactly.
  const needsZip64 =
    count >= UINT16_MAX || size >= UINT32_MAX || offset >= UINT32_MAX;

  if (needsZip64) {
    const zip64Offset = offset + size;

    yield record(56)
      .u32(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE)
      // The size of this record, counted from the field after this one.
      .u64(44)
      .u16(VERSION_MADE_BY)
      .u16(VERSION_ZIP64)
      .u32(0)
      .u32(0)
      .u64(count)
      .u64(count)
      .u64(size)
      .u64(offset)
      .done();

    yield record(20)
      .u32(ZIP64_LOCATOR_SIGNATURE)
      .u32(0)
      .u64(zip64Offset)
      .u32(1)
      .done();
  }

  yield record(22)
    .u32(END_OF_CENTRAL_DIRECTORY_SIGNATURE)
    .u16(0)
    .u16(0)
    .u16(Math.min(count, UINT16_MAX))
    .u16(Math.min(count, UINT16_MAX))
    .u32(Math.min(size, UINT32_MAX))
    .u32(Math.min(offset, UINT32_MAX))
    .u16(0)
    .done();
}
