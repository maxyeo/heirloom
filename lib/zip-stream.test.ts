import { describe, expect, it } from "vitest";

import {
  assertMemberFits,
  assertSafeMemberName,
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
  it("is the largest a 32-bit data descriptor can describe", () => {
    // Stated as a number rather than left implicit, because the failure it
    // prevents — a size field wrapping — produces an archive that looks fine
    // and unpacks a truncated file.
    expect(MAX_MEMBER_BYTES).toBe(0xffffffff);
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
