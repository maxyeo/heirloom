import { describe, expect, it } from "vitest";

import {
  archiveMembers,
  DATA_PREFIX,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportArchiveInput,
  type ExportManifest,
  GEDCOM_MEMBER,
  MANIFEST_MEMBER,
  RESTORE_MEMBER,
} from "@/lib/export-archive";
import { zipChunks } from "@/lib/zip-stream";
import { collect, readZip, zipText } from "@/test/read-zip";

/**
 * What a full export contains (E7-T4, `YEO-54`).
 *
 * Every acceptance criterion of this ticket except one is a statement about
 * the *contents* of the archive, and `lib/export-archive.ts` is where those
 * are decided — so they are asserted here, against literals, with no
 * database, no image store and no HTTP. That is the split `lib/export-tree.ts`
 * describes and the reason it exists.
 *
 * The assertions go through a real archive rather than over the member list,
 * because "the archive contains the GEDCOM" is a claim about a file somebody
 * unzips, not about a generator's `yield`. `test/read-zip.ts` opens it the way
 * an archive tool does.
 *
 * The remaining criterion — that it streams — is `lib/zip-stream.test.ts` and
 * `app/api/export/full/route.test.ts`.
 */

const NOON = new Date("2026-08-25T12:00:00.000Z");

/** A tree with one person, so the GEDCOM member is something openable. */
const GEDCOM = ["0 HEAD", "1 CHAR UTF-8", "0 TRLR", ""].join("\n");

function bytes(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function input(
  overrides: Partial<ExportArchiveInput> = {},
): ExportArchiveInput {
  return {
    generatedAt: NOON,
    gedcom: GEDCOM,
    tables: [
      {
        table: "pages",
        rows: [
          {
            id: "p1",
            slug: "rose-hall",
            title: "Rose Hall",
            body_html: "<p>x</p>",
          },
        ],
      },
      { table: "revisions", rows: [{ id: "r1", page_id: "p1" }] },
      { table: "individuals", rows: [] },
    ],
    images: [],
    schema: {
      migrationsApplied: 6,
      latestMigrationAt: "2026-05-22T09:15:00.000Z",
    },
    openImage: async () => ({ found: false, reason: "no store in this test" }),
    ...overrides,
  };
}

async function archiveOf(overrides: Partial<ExportArchiveInput> = {}) {
  return readZip(
    await collect(zipChunks(archiveMembers(input(overrides)), NOON)),
  );
}

function manifestOf(archive: Awaited<ReturnType<typeof archiveOf>>) {
  return JSON.parse(zipText(archive, MANIFEST_MEMBER)) as ExportManifest;
}

describe("the archive", () => {
  it("carries the GEDCOM, the rows and a manifest", async () => {
    // The first acceptance criterion, in one assertion, as an unzipped file
    // listing rather than as a promise about a generator.
    const archive = await archiveOf();

    expect([...archive.byName.keys()]).toEqual([
      RESTORE_MEMBER,
      GEDCOM_MEMBER,
      `${DATA_PREFIX}pages.jsonl`,
      `${DATA_PREFIX}revisions.jsonl`,
      `${DATA_PREFIX}individuals.jsonl`,
      MANIFEST_MEMBER,
    ]);
  });

  it("puts the tree in byte for byte, from the one serialiser", async () => {
    // E7-T1's `writeGedcom` output, unmodified: the archive must not become a
    // second place a GEDCOM is assembled.
    expect(zipText(await archiveOf(), GEDCOM_MEMBER)).toBe(GEDCOM);
  });

  it("writes one row per line, keyed by column name", async () => {
    const pages = zipText(await archiveOf(), `${DATA_PREFIX}pages.jsonl`);

    expect(pages).toBe(
      '{"id":"p1","slug":"rose-hall","title":"Rose Hall","body_html":"<p>x</p>"}\n',
    );
    // The property a restore rests on: a line parses on its own, so a table
    // of any size is readable one line at a time.
    expect(JSON.parse(pages.trimEnd())).toMatchObject({ slug: "rose-hall" });
  });

  it("writes an empty member for a table with no rows", async () => {
    // Not a missing member: a restore that found no `individuals.jsonl` could
    // not tell "no people" from "this export forgot the people".
    const archive = await archiveOf();

    expect(zipText(archive, `${DATA_PREFIX}individuals.jsonl`)).toBe("");
    expect(manifestOf(archive).tables).toContainEqual({
      table: "individuals",
      member: `${DATA_PREFIX}individuals.jsonl`,
      rows: 0,
    });
  });

  it("holds many rows without one line per chunk", async () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      id: `p${index}`,
    }));
    const archive = await archiveOf({ tables: [{ table: "pages", rows }] });

    const lines = zipText(archive, `${DATA_PREFIX}pages.jsonl`)
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(5000);
    expect(JSON.parse(lines[4999])).toEqual({ id: "p4999" });
  });
});

describe("the manifest", () => {
  it("says what kind of file this is and how to read it", async () => {
    const manifest = manifestOf(await archiveOf());

    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(manifest.restore).toContain(RESTORE_MEMBER);
  });

  it("dates the archive from the moment it was given", async () => {
    // Passed in rather than read, which is what makes this a literal.
    expect(manifestOf(await archiveOf()).generatedAt).toBe(
      "2026-08-25T12:00:00.000Z",
    );
  });

  it("records how far through the migrations the schema was", async () => {
    // The one thing a restorer cannot work out from the data: rows loaded
    // into a schema that is not theirs fail in ways that look like damage.
    // A count rather than a name, because Drizzle's ledger records hashes.
    expect(manifestOf(await archiveOf()).schema).toEqual({
      migrationsApplied: 6,
      latestMigrationAt: "2026-05-22T09:15:00.000Z",
    });
  });

  it("counts what actually went in, not what was intended", async () => {
    const manifest = manifestOf(await archiveOf());

    expect(manifest.counts.rows).toBe(2);
    expect(manifest.tables.map((table) => table.rows)).toEqual([1, 1, 0]);
  });
});

describe("the images", () => {
  const images = [
    { key: "images/ab/one.jpg", url: "/api/images/ab/one.jpg" },
    { key: "images/cd/two.jpg", url: "/api/images/cd/two.jpg" },
  ];

  it("are in the archive under the key the entries refer to them by", async () => {
    // The key *is* the archive path, which is what makes putting them back a
    // matter of uploading each file under its own name.
    const archive = await archiveOf({
      images,
      openImage: async (key) => ({
        found: true,
        body: bytes(`bytes of ${key}`),
      }),
    });

    expect(zipText(archive, "images/ab/one.jpg")).toBe(
      "bytes of images/ab/one.jpg",
    );
    expect(zipText(archive, "images/cd/two.jpg")).toBe(
      "bytes of images/cd/two.jpg",
    );
  });

  it("are also listed with the address the wiki asks for them at", async () => {
    /**
     * The acceptance criterion is *"included **or** listed with their URLs"*,
     * and both halves are done rather than one chosen — the file is here and
     * the manifest says what asks for it. The URL listed is the site-relative
     * one the bodies carry, never the signed storage URL, which is a
     * credential with a fifteen-minute timer on it.
     */
    const archive = await archiveOf({
      images,
      openImage: async () => ({ found: true, body: bytes("x") }),
    });

    expect(manifestOf(archive).images).toEqual([
      {
        key: "images/ab/one.jpg",
        url: "/api/images/ab/one.jpg",
        member: "images/ab/one.jpg",
        included: true,
        note: null,
      },
      {
        key: "images/cd/two.jpg",
        url: "/api/images/cd/two.jpg",
        member: "images/cd/two.jpg",
        included: true,
        note: null,
      },
    ]);
  });

  it("are listed as absent, with a reason, when the store has not got them", async () => {
    // Append-only revisions outlive the images they reference, so this is an
    // ordinary state of affairs rather than a failure — and an archive that
    // stopped at the first one would stop working as the wiki aged.
    const archive = await archiveOf({
      images,
      openImage: async (key) =>
        key === "images/ab/one.jpg"
          ? { found: true, body: bytes("here") }
          : {
              found: false,
              reason: "The image store no longer has this file.",
            },
    });

    expect(archive.byName.has("images/cd/two.jpg")).toBe(false);
    expect(manifestOf(archive).images[1]).toEqual({
      key: "images/cd/two.jpg",
      url: "/api/images/cd/two.jpg",
      member: null,
      included: false,
      note: "The image store no longer has this file.",
    });
  });

  it("count the gaps, so a reader can tell a whole archive from a partial one", async () => {
    const archive = await archiveOf({
      images,
      openImage: async (key) =>
        key === "images/ab/one.jpg"
          ? { found: true, body: bytes("here") }
          : { found: false, reason: "The image store could not be reached." },
    });

    expect(manifestOf(archive).counts).toMatchObject({
      images: 2,
      imagesIncluded: 1,
      imagesMissing: 1,
    });
  });
});

describe("the restore document", () => {
  it("is the first member, so it is the first thing a listing shows", async () => {
    expect((await archiveOf()).entries[0].name).toBe(RESTORE_MEMBER);
  });

  it("names every member a reader will find", async () => {
    const restore = zipText(await archiveOf(), RESTORE_MEMBER);

    expect(restore).toContain(GEDCOM_MEMBER);
    expect(restore).toContain(MANIFEST_MEMBER);
    expect(restore).toContain(`${DATA_PREFIX}pages.jsonl`);
    expect(restore).toContain("images/");
  });

  it("states the load order, because a restore in the wrong one fails", async () => {
    const restore = zipText(await archiveOf(), RESTORE_MEMBER);

    // `revisions` point at `pages`, so pages must be listed first — the
    // ordering is `lib/export-full.ts`'s and this is what prints it.
    expect(restore.indexOf("1. `pages`")).toBeGreaterThan(-1);
    expect(restore.indexOf("`pages`")).toBeLessThan(
      restore.indexOf("`revisions`"),
    );
  });

  it("says which schema the rows belong to, and how to get there", async () => {
    const restore = zipText(await archiveOf(), RESTORE_MEMBER);

    expect(restore).toContain("6 migrations applied");
    // Actionable rather than descriptive: apply that many, then check.
    expect(restore).toContain(
      "select count(*) from drizzle.__drizzle_migrations",
    );
  });

  it("says so plainly when it could not find that out", async () => {
    // Silence would be worse than an admission: a restorer would assume the
    // newest schema and find out they were wrong after loading.
    const restore = zipText(await archiveOf({ schema: null }), RESTORE_MEMBER);

    expect(restore).toContain("unknown");
  });

  it("warns off the one column that must not be inserted", async () => {
    // `pages.search_vector` is generated; an insert naming it fails.
    expect(zipText(await archiveOf(), RESTORE_MEMBER)).toContain(
      "search_vector",
    );
  });

  it("tells a reader how to check the archive before trusting it", async () => {
    // "A backup nobody can restore is a file, not a backup" — and a backup
    // nobody can *verify* is a hope.
    expect(zipText(await archiveOf(), RESTORE_MEMBER)).toContain("unzip -t");
  });
});
