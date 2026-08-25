/**
 * Reading a ZIP archive back, for tests (E7-T4, `YEO-54`).
 *
 * ## Why the suite has its own reader
 *
 * `lib/zip-stream.ts` writes a container format by hand, and the only
 * assertion worth making about a container format is that something else can
 * open it. Asserting on the bytes the writer emitted — "the local header is
 * 30 bytes and starts with `PK\x03\x04`" — checks that the writer agrees with
 * itself, which it always will.
 *
 * So this reads the archive the way a reader is *specified* to: find the
 * end-of-central-directory record by scanning backwards for its signature,
 * take the member list from the central directory it points at, and go to
 * each member by the offset recorded there. That is the path `unzip`, macOS's
 * Archive Utility and Windows Explorer all take, and it is the one that fails
 * if the table of contents disagrees with the file — which is precisely the
 * mistake a hand-written writer makes.
 *
 * It deliberately does **not** parse the archive front-to-back through the
 * local headers, because that path is the one a streaming writer makes easy
 * and is not how the archive will actually be opened. The data descriptors
 * are checked separately, by comparing what the central directory claims
 * against the bytes that are there.
 *
 * Reading only: it understands stored (uncompressed) members, which is all
 * `zipChunks` writes, and it throws on anything else rather than guessing.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;

export type ZipEntry = {
  name: string;
  /** The member's bytes, as the central directory located them. */
  bytes: Uint8Array;
  /** The CRC-32 the central directory recorded. */
  crc: number;
  /** Whether the local header set the data-descriptor flag (bit 3). */
  streamed: boolean;
  /** Whether the central directory entry carried a ZIP64 extra field. */
  zip64: boolean;
};

export type ZipArchive = {
  entries: ZipEntry[];
  /** Members by name, for the common case. */
  byName: Map<string, ZipEntry>;
  /** Whether the archive carried a ZIP64 end-of-central-directory record. */
  zip64: boolean;
};

/** The archive, or a throw naming what was wrong with it. */
export function readZip(archive: Uint8Array): ZipArchive {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );

  const endOffset = findEndOfCentralDirectory(view);
  let count = view.getUint16(endOffset + 10, true);
  let directoryOffset = view.getUint32(endOffset + 16, true);

  // The 64-bit records sit immediately before the classic one when they are
  // present, and the locator is what points back at the record.
  const zip64 =
    endOffset >= 20 &&
    view.getUint32(endOffset - 20, true) === ZIP64_LOCATOR_SIGNATURE;
  if (zip64) {
    const recordOffset = Number(view.getBigUint64(endOffset - 12, true));
    if (
      view.getUint32(recordOffset, true) !==
      ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error("ZIP64 locator does not point at a ZIP64 end record");
    }
    count = Number(view.getBigUint64(recordOffset + 32, true));
    directoryOffset = Number(view.getBigUint64(recordOffset + 48, true));
  } else if (count === UINT16_MAX || directoryOffset === UINT32_MAX) {
    throw new Error("Archive needs ZIP64 but carries no ZIP64 end record");
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`No central directory header at ${at}`);
    }

    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    if (method !== 0) {
      throw new Error(`Member ${index} uses compression method ${method}`);
    }

    const crc = view.getUint32(at + 16, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let localOffset = view.getUint32(at + 42, true);

    const name = new TextDecoder().decode(
      archive.subarray(at + 46, at + 46 + nameLength),
    );

    const extra = archive.subarray(
      at + 46 + nameLength,
      at + 46 + nameLength + extraLength,
    );
    const wide = readZip64Extra(extra, {
      size: size === UINT32_MAX,
      offset: localOffset === UINT32_MAX,
    });
    if (wide.size !== null) size = wide.size;
    if (wide.offset !== null) localOffset = wide.offset;

    if (view.getUint32(localOffset, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`Member ${JSON.stringify(name)} has no local header`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      bytes: archive.subarray(dataAt, dataAt + size),
      crc,
      streamed: (flags & 0x0008) !== 0,
      zip64: extraLength > 0,
    });

    at += 46 + nameLength + extraLength + commentLength;
  }

  return {
    entries,
    byName: new Map(entries.map((entry) => [entry.name, entry])),
    zip64,
  };
}

/** A member's text, or a throw if the archive has no such member. */
export function zipText(archive: ZipArchive, name: string): string {
  const entry = archive.byName.get(name);
  if (!entry) {
    throw new Error(
      `No member ${JSON.stringify(name)}; the archive has ${[
        ...archive.byName.keys(),
      ].join(", ")}`,
    );
  }
  return new TextDecoder().decode(entry.bytes);
}

/**
 * CRC-32 of `bytes`, computed independently of the writer.
 *
 * A second implementation on purpose: a test that checked the writer's
 * checksum with the writer's own function would pass for an archive every
 * other tool rejects.
 */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Everything an async generator of chunks produces, as one array. */
export async function collect(
  chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    length += chunk.length;
  }

  const whole = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

/**
 * The end-of-central-directory record, found the way a reader finds it.
 *
 * Backwards from the end, because the record is last and carries a
 * variable-length comment after it. The comment is empty in everything this
 * repository writes, so the scan finds it immediately; it is a scan anyway
 * because that is what the format requires and a test that assumed the fixed
 * position would not be reading a ZIP file.
 */
function findEndOfCentralDirectory(view: DataView): number {
  for (let at = view.byteLength - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return at;
    }
  }
  throw new Error("Not a ZIP file: no end-of-central-directory record");
}

/**
 * The ZIP64 extra field's values, in the order the spec fixes them.
 *
 * Only the fields whose 32-bit slots held the sentinel are present, and they
 * appear in a fixed order — uncompressed size, compressed size, offset — so
 * which one a given 8 bytes belongs to depends on what the caller found in
 * the header. That coupling is the format's, not this reader's.
 */
function readZip64Extra(
  extra: Uint8Array,
  wanted: { size: boolean; offset: boolean },
): { size: number | null; offset: number | null } {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let at = 0;

  while (at + 4 <= extra.length) {
    const id = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (id !== ZIP64_EXTRA_FIELD_ID) {
      at += 4 + length;
      continue;
    }

    let field = at + 4;
    let size: number | null = null;
    let offset: number | null = null;
    if (wanted.size) {
      size = Number(view.getBigUint64(field, true));
      // The compressed size follows the uncompressed one; both are written,
      // and for a stored member they are the same number.
      field += 16;
    }
    if (wanted.offset) offset = Number(view.getBigUint64(field, true));
    return { size, offset };
  }

  return { size: null, offset: null };
}
