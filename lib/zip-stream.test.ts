import { describe, expect, it } from "vitest";

import {
  assertMemberFits,
  assertSafeMemberName,
  centralHeader,
  type CentralEntry,
  endOfCentralDirectory,
  MAX_MEMBER_BYTES,
  ZipWriteError,
  type ZipMember,
  zipChunks,
} from "@/lib/zip-stream";
import { collect, crc32, readZip, zipText } from "@/test/read-zip";

/**
 * The ZIP writer (E7-T4, `YEO-54`).
 *
 * ## What is actually being checked
 *
 * That something else can open what this writes. `test/read-zip.ts` is that
 * something else: it takes the path the format specifies — scan backwards for
 * the end record, read the central directory, go to each member by the offset
 * recorded there — rather than walking the local headers front to back, which
 * is the path a streaming writer makes easy and is not how anybody's archive
 * tool opens a file. An assertion that the writer's own bytes match the
 * writer's own layout would pass for an archive nothing can read.
 *
 * The checksums are computed a second time, in the reader, for the same
 * reason.
 *
 * ## The properties worth pinning
 *
 * - **The archive is streamed.** Members are consumed one at a time and only
 *   when asked for, which is what makes the acceptance criterion true rather
 *   than claimed; `it("asks for each member only when the last is finished")`
 *   is the assertion that would fail if somebody collected the members into
 *   an array first.
 * - **Sizes and checksums are correct after the fact.** Every member is
 *   written with zeros in its local header and the truth in a data
 *   descriptor, so a mistake here is an archive whose table of contents is a
 *   fiction.
 * - **Nothing can name a member out of its directory.** Zip Slip.
 */

const NOON = new Date("2026-08-25T12:00:00.000Z");

/** An archive from a plain list, since most cases do not need laziness. */
async function zip(members: ZipMember[]): Promise<Uint8Array> {
  return collect(zipChunks(toAsync(members), NOON));
}

async function* toAsync<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

describe("an archive", () => {
  it("is readable through its central directory", async () => {
    const archive = readZip(
      await zip([
        { name: "RESTORE.md", body: "# how to read this\n" },
        { name: "data/pages.jsonl", body: '{"id":"1"}\n' },
      ]),
    );

    expect([...archive.byName.keys()]).toEqual([
      "RESTORE.md",
      "data/pages.jsonl",
    ]);
    expect(zipText(archive, "RESTORE.md")).toBe("# how to read this\n");
    expect(zipText(archive, "data/pages.jsonl")).toBe('{"id":"1"}\n');
  });

  it("records a checksum that matches the bytes it stored", async () => {
    const archive = readZip(await zip([{ name: "a.txt", body: "hello" }]));
    const entry = archive.byName.get("a.txt")!;

    // Computed by the reader's own implementation, not the writer's.
    expect(entry.crc).toBe(crc32(entry.bytes));
    expect(entry.crc).toBe(crc32(new TextEncoder().encode("hello")));
  });

  it("declares every member as streamed, which is why the sizes are late", async () => {
    const archive = readZip(await zip([{ name: "a.txt", body: "hello" }]));

    expect(archive.byName.get("a.txt")!.streamed).toBe(true);
  });

  it("survives an empty member", async () => {
    // A table with no rows is the ordinary case on a new wiki, and a
    // zero-length member is where an off-by-one in the descriptor shows up.
    const archive = readZip(
      await zip([
        { name: "empty.jsonl", body: "" },
        { name: "after.txt", body: "still here" },
      ]),
    );

    expect(zipText(archive, "empty.jsonl")).toBe("");
    expect(zipText(archive, "after.txt")).toBe("still here");
  });

  it("is a ZIP file even with no members at all", async () => {
    const archive = readZip(await zip([]));

    expect(archive.entries).toEqual([]);
  });

  it("stores bytes that are not text, unchanged", async () => {
    // A photograph is the reason this module exists, and a JPEG contains
    // every byte value including the ones a text encoder would mangle.
    const photo = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) photo[index] = index;

    const archive = readZip(await zip([{ name: "images/a.jpg", body: photo }]));

    expect([...archive.byName.get("images/a.jpg")!.bytes]).toEqual([...photo]);
  });

  it("reassembles a body that arrives in many chunks", async () => {
    async function* chunked() {
      yield "one ";
      yield "two ";
      yield "three";
    }

    const archive = readZip(await zip([{ name: "a.txt", body: chunked() }]));

    expect(zipText(archive, "a.txt")).toBe("one two three");
  });

  it("reads a ReadableStream body to the end", async () => {
    // What `fetch` hands back for an image, which is the shape that matters
    // most and the one a `for await` would only work for on some runtimes.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("from "));
        controller.enqueue(new TextEncoder().encode("the store"));
        controller.close();
      },
    });

    const archive = readZip(await zip([{ name: "a.jpg", body: stream }]));

    expect(zipText(archive, "a.jpg")).toBe("from the store");
  });
});

describe("the streaming", () => {
  it("asks for each member only when the last is finished", async () => {
    /**
     * The acceptance criterion, as a property rather than as a claim. If the
     * writer collected its members up front, or read a body ahead, this
     * generator would run to completion before any byte was produced — and
     * `lib/export-archive.ts` depends on the opposite, because it writes a
     * manifest that counts what went before it.
     */
    const asked: string[] = [];

    async function* members(): AsyncGenerator<ZipMember> {
      asked.push("first");
      yield { name: "a.txt", body: "a" };
      asked.push("second");
      yield { name: "b.txt", body: "b" };
      asked.push("done");
    }

    const chunks = zipChunks(members(), NOON);

    expect(asked).toEqual([]);
    await chunks.next();
    expect(asked).toEqual(["first"]);

    await collect(chunks);
    expect(asked).toEqual(["first", "second", "done"]);
  });

  it("can be given up part way through", async () => {
    // A closed tab. The generator has to be returnable so the image response
    // it is reading is released rather than left open.
    let closed = false;

    async function* members(): AsyncGenerator<ZipMember> {
      try {
        yield { name: "a.txt", body: "a" };
        yield { name: "b.txt", body: "b" };
      } finally {
        closed = true;
      }
    }

    const chunks = zipChunks(members(), NOON);
    await chunks.next();
    await chunks.return(undefined);

    expect(closed).toBe(true);
  });
});

describe("a member name", () => {
  it.each([
    ["/etc/passwd", "an absolute path"],
    ["../../etc/passwd", "a path that climbs out"],
    ["data/../../x", "a climb in the middle"],
    ["C:/windows/x", "a drive letter"],
    ["data\\pages.jsonl", "a backslash, which is a separator on Windows"],
    ["", "nothing at all"],
    ["data//pages.jsonl", "an empty segment"],
    ["data/", "a trailing slash"],
  ])("refuses %j — %s", (name) => {
    expect(() => assertSafeMemberName(name)).toThrow(ZipWriteError);
  });

  it.each([
    "RESTORE.md",
    "manifest.json",
    "data/pages.jsonl",
    "images/ab/0e5b6c2f-1234-4a56-89ab-cdef01234567.jpg",
    "a...b",
  ])("accepts %j", (name) => {
    expect(() => assertSafeMemberName(name)).not.toThrow();
  });

  it("is refused by the writer, not only by the checker", async () => {
    // The check has to be on the path the archive actually takes, or it is a
    // function nobody calls.
    await expect(zip([{ name: "../escape", body: "x" }])).rejects.toThrow(
      ZipWriteError,
    );
  });
});

describe("the limit on one member", () => {
  it("stops one byte below the value that means something else", () => {
    /**
     * Stated as a number because the failure it prevents is invisible.
     * `0xffffffff` is the largest a 32-bit size field can hold *and* the
     * sentinel meaning "the real size is in a ZIP64 extra field" — which a
     * member of that size could not have, since its data descriptor was
     * written in the 32-bit form long before the table of contents. So the
     * cap excludes the value rather than mis-encoding it.
     */
    expect(MAX_MEMBER_BYTES).toBe(0xfffffffe);
    expect(MAX_MEMBER_BYTES).toBeLessThan(0xffffffff);
  });

  it("is a throw rather than a wrap", () => {
    /**
     * Asserted against the guard rather than by writing four gigabytes to
     * reach it. Nothing this application produces can get here — an image is
     * capped at 4 MB on upload (`lib/image-upload.ts`) and the JSON members
     * are a wiki's text — which is exactly why the branch needs a test rather
     * than a comment: it is unreachable in practice and would be wrong in
     * silence.
     */
    expect(() => assertMemberFits("huge.bin", MAX_MEMBER_BYTES)).not.toThrow();
    expect(() => assertMemberFits("huge.bin", MAX_MEMBER_BYTES + 1)).toThrow(
      ZipWriteError,
    );
    expect(() => assertMemberFits("huge.bin", MAX_MEMBER_BYTES + 1)).toThrow(
      /larger than/,
    );
  });
});

/**
 * The ZIP64 records, decoded against the specification.
 *
 * ## Why these are checked directly rather than through an archive
 *
 * Because the archive that would exercise them is four gigabytes. The 32-bit
 * field that actually overflows in practice is not a member's size — an image
 * is capped at 4 MB on upload — it is a member's **offset**, which is the
 * total written so far, so a few thousand photographs reach it. That is a
 * real archive rather than a hypothetical one, and it is the one case this
 * suite cannot afford to produce on every run.
 *
 * So the records are built with the offsets they would have, and read back
 * here field by field with a `DataView`, against the layout the specification
 * fixes rather than against the writer's own constants. A test that asked
 * `test/read-zip.ts` about these would be asking one of ours about another.
 */
describe("the ZIP64 records", () => {
  /** 5 GiB — an offset no 32-bit field can hold. */
  const HUGE = 5 * 1024 * 1024 * 1024;

  function entry(offset: number): CentralEntry {
    return {
      name: new TextEncoder().encode("images/ab/photo.jpg"),
      crc: 0x12345678,
      size: 4096,
      offset,
    };
  }

  function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  describe("a member's entry in the table of contents", () => {
    it("carries no extra field while its offset fits", () => {
      const header = centralHeader(entry(1000), 0, 0);

      // Extra-field length is at offset 30, and the version needed at 6.
      expect(view(header).getUint16(30, true)).toBe(0);
      expect(view(header).getUint16(6, true)).toBe(20);
      expect(view(header).getUint32(42, true)).toBe(1000);
    });

    it("moves an offset that does not fit into a ZIP64 extra field", () => {
      const header = centralHeader(entry(HUGE), 0, 0);
      const decoded = view(header);
      const extraLength = decoded.getUint16(30, true);
      const nameLength = decoded.getUint16(28, true);
      const extraAt = 46 + nameLength;

      // The 32-bit slot holds the sentinel that sends a reader to the extra.
      expect(decoded.getUint32(42, true)).toBe(0xffffffff);
      // 4.5 is the oldest version that understands what follows.
      expect(decoded.getUint16(6, true)).toBe(45);

      expect(extraLength).toBe(12);
      expect(decoded.getUint16(extraAt, true)).toBe(0x0001);
      expect(decoded.getUint16(extraAt + 2, true)).toBe(8);
      expect(Number(decoded.getBigUint64(extraAt + 4, true))).toBe(HUGE);
    });

    it("treats the sentinel value itself as not fitting", () => {
      /**
       * The boundary, and the reason it is a boundary: `0xffffffff` is both
       * the largest value the slot can hold and the marker meaning "the real
       * one is elsewhere". Written literally, it would send a reader looking
       * for an extra field that was not there.
       */
      const header = centralHeader(entry(0xffffffff), 0, 0);
      const decoded = view(header);

      expect(decoded.getUint16(30, true)).toBe(12);
      expect(
        Number(
          decoded.getBigUint64(46 + decoded.getUint16(28, true) + 4, true),
        ),
      ).toBe(0xffffffff);
    });

    it("never has to move a member's size, because one cannot get that big", () => {
      // `MAX_MEMBER_BYTES` keeps a size strictly below the sentinel, since a
      // size needing ZIP64 would have needed it in a data descriptor written
      // long before this record.
      expect(MAX_MEMBER_BYTES).toBeLessThan(0xffffffff);
      expect(MAX_MEMBER_BYTES).toBe(0xfffffffe);
    });
  });

  describe("the end of the archive", () => {
    /** The three records, concatenated as they are written. */
    function endRecords(count: number, size: number, offset: number) {
      const parts = [...endOfCentralDirectory(count, size, offset)];
      return { parts, lengths: parts.map((part) => part.length) };
    }

    it("is one 22-byte record while everything fits", () => {
      const { parts, lengths } = endRecords(6, 400, 5000);

      expect(lengths).toEqual([22]);
      expect(view(parts[0]).getUint32(0, true)).toBe(0x06054b50);
      expect(view(parts[0]).getUint16(10, true)).toBe(6);
      expect(view(parts[0]).getUint32(16, true)).toBe(5000);
    });

    it("adds the 64-bit record and its locator once it does not", () => {
      const { parts, lengths } = endRecords(6, 400, HUGE);

      // The ZIP64 end record, its locator, and the classic record every
      // reader scans backwards for — in that order and no other.
      expect(lengths).toEqual([56, 20, 22]);

      const zip64 = view(parts[0]);
      expect(zip64.getUint32(0, true)).toBe(0x06064b50);
      // The record's own size, counted from the field after this one.
      expect(Number(zip64.getBigUint64(4, true))).toBe(44);
      expect(zip64.getUint16(14, true)).toBe(45);
      expect(Number(zip64.getBigUint64(32, true))).toBe(6);
      expect(Number(zip64.getBigUint64(40, true))).toBe(400);
      expect(Number(zip64.getBigUint64(48, true))).toBe(HUGE);

      const locator = view(parts[1]);
      expect(locator.getUint32(0, true)).toBe(0x07064b50);
      // The ZIP64 record sits immediately after the central directory.
      expect(Number(locator.getBigUint64(8, true))).toBe(HUGE + 400);
      expect(locator.getUint32(16, true)).toBe(1);
    });

    it("leaves the sentinel in every classic field that cannot hold the truth", () => {
      const { parts } = endRecords(6, 400, HUGE);
      const classic = view(parts[2]);

      expect(classic.getUint32(0, true)).toBe(0x06054b50);
      // The count and the directory size still fit; only the offset does not,
      // and each field takes the sentinel on its own account.
      expect(classic.getUint16(10, true)).toBe(6);
      expect(classic.getUint32(12, true)).toBe(400);
      expect(classic.getUint32(16, true)).toBe(0xffffffff);
    });

    it("goes 64-bit on a count that does not fit either", () => {
      // 65,535 members is the sentinel in a 16-bit count, so it is already
      // too many to state in the classic record.
      const { lengths } = endRecords(0xffff, 400, 5000);

      expect(lengths).toEqual([56, 20, 22]);
    });
  });
});
