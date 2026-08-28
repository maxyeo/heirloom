import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { DATA_PREFIX, MANIFEST_MEMBER } from "@/lib/export-archive";
import { fullExportStream, readFullExport } from "@/lib/export-full";
import { IMAGE_ROUTE } from "@/lib/storage-key";
import { readZip, zipText } from "@/test/read-zip";
import { addedByHand } from "@/test/people-fixtures";

/**
 * What only Postgres can prove about `lib/export-full.ts`.
 *
 * The archive's *contents* are decided by `lib/export-archive.ts` and asserted
 * against literals in `lib/export-archive.test.ts` with no database in sight.
 * What is left here is everything that is a claim about the queries, and every
 * one of them is a claim a mocked Drizzle chain would answer by agreeing with
 * itself:
 *
 *   - the JSON keys really are the **column** names, not Drizzle's JS property
 *     names — the whole restore procedure rests on that one sentence;
 *   - `pages.search_vector` is really absent, because it is `generated always`
 *     and an export carrying it is an export that cannot be loaded back;
 *   - the tables come out in an order a restore can follow, and `revisions`
 *     come out oldest-first so `restored_from_id` always points at a row
 *     already loaded;
 *   - the images an entry body refers to are found, including one referred to
 *     only by an old revision.
 *
 * See docs/testing.md for why this is a `.db.test.ts`, and which CI job runs
 * it.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made.
const PAGE = "00000000-0000-4000-8000-0000000054a1";
const OTHER_PAGE = "00000000-0000-4000-8000-0000000054a2";
const OLD_REVISION = "00000000-0000-4000-8000-0000000054b1";
const NEW_REVISION = "00000000-0000-4000-8000-0000000054b2";
const PERSON = "00000000-0000-4000-8000-0000000054c1";
const PORTRAIT_PERSON = "00000000-0000-4000-8000-0000000054c2";

/** Two photographs: one still in the entry, one only in its history. */
const CURRENT_IMAGE = "images/ab/0e5b6c2f-1234-4a56-89ab-cdef54000001.jpg";
const REMOVED_IMAGE = "images/cd/0e5b6c2f-1234-4a56-89ab-cdef54000002.jpg";

/**
 * A person's own portrait and its thumbnail (E5-T4, `YEO-44`) — a column
 * reference rather than one parsed out of a body, and the regression guard
 * for "the full backup silently stops being a backup for portraits".
 */
const PORTRAIT_IMAGE = "images/ef/0e5b6c2f-1234-4a56-89ab-cdef54000003.jpg";
const PORTRAIT_THUMB_IMAGE =
  "images/3a/0e5b6c2f-1234-4a56-89ab-cdef54000004.webp";

function imgTag(key: string): string {
  return `<img src="${IMAGE_ROUTE}/${key.slice("images/".length)}">`;
}

const NOON = new Date("2026-08-25T12:00:00.000Z");

async function removeFixture() {
  // `individuals.page_id` is `ON DELETE SET NULL`, so the person has to go
  // explicitly; revisions cascade with their page.
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, [PERSON, PORTRAIT_PERSON]));
  await db
    .delete(schema.pages)
    .where(inArray(schema.pages.id, [PAGE, OTHER_PAGE]));
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and would
  // otherwise greet the next one with a duplicate key on these ids.
  await removeFixture();

  await db.insert(schema.pages).values([
    {
      id: PAGE,
      slug: "export-fixture-rose-hall",
      title: "Rose Hall",
      // Written straight in rather than through `sanitizeHtml`, which is
      // still deliberate now that E5-T3 (`YEO-43`) has put `img` on the
      // allowlist: what this fixture is about is the scan, and going through
      // the sanitiser would make every case here depend on a second module
      // agreeing that the `src` is one of ours.
      bodyHtml: `<p>Rose.</p>${imgTag(CURRENT_IMAGE)}`,
    },
    {
      id: OTHER_PAGE,
      slug: "export-fixture-walter-hale",
      title: "Walter Hale",
      bodyHtml: "<p>Walter.</p>",
    },
  ]);

  await db.insert(schema.revisions).values([
    {
      id: OLD_REVISION,
      pageId: PAGE,
      title: "Rose Hall",
      // The photograph that was taken out of the entry later. Revisions are
      // append-only, so it is still part of the wiki.
      bodyHtml: `<p>Rose.</p>${imgTag(REMOVED_IMAGE)}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: NEW_REVISION,
      pageId: PAGE,
      title: "Rose Hall",
      bodyHtml: `<p>Rose.</p>${imgTag(CURRENT_IMAGE)}`,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      // A restore, pointing at the row above — the self-reference that makes
      // the ordering of this table load-bearing.
      restoredFromId: OLD_REVISION,
    },
  ]);

  await db.insert(schema.individuals).values(
    addedByHand([
      { id: PERSON, pageId: PAGE, givenName: "Rose", surname: "Hall" },
      {
        id: PORTRAIT_PERSON,
        givenName: "Walter",
        surname: "Portrait",
        portraitKey: PORTRAIT_IMAGE,
        portraitThumbKey: PORTRAIT_THUMB_IMAGE,
      },
    ]),
  );
});

afterAll(removeFixture);

/** The fixture's own rows, picked out of whatever else the database holds. */
function ours(rows: readonly Record<string, unknown>[], ids: string[]) {
  return rows.filter((row) => ids.includes(String(row.id)));
}

describe("what is read", () => {
  it("names every table a restore has to load, in the order it loads them", async () => {
    const { tables } = await readFullExport(NOON);

    expect(tables.map((table) => table.table)).toEqual([
      "pages",
      "revisions",
      // `gedcom_imports` (`YEO-89`) sits ahead of the three tables that
      // reference it — see `EXPORT_TABLES`'s own docblock for why a restore
      // fails its foreign key if this ever moved below `individuals`.
      "gedcom_imports",
      "individuals",
      "unions",
      "union_children",
      // E11-T8 (`YEO-78`). Appended rather than placed beside `pages`, which
      // is where they read most naturally: the assertions below index this
      // list positionally, so inserting in the middle renumbers them all.
      // `categories` before `page_categories`, which references it.
      "categories",
      "page_categories",
    ]);
  });

  it("keys every row by its column name, not by Drizzle's property name", async () => {
    /**
     * The sentence the whole restore procedure rests on — *"every key is the
     * name of a column"* — and the one that would silently stop being true if
     * somebody swapped the mapping for a plain `select()`. `bodyHtml` is the
     * case that shows it: the JS property and the column differ.
     */
    const { tables } = await readFullExport(NOON);
    const page = ours(tables[0].rows, [PAGE])[0];

    expect(Object.keys(page)).toContain("body_html");
    expect(Object.keys(page)).not.toContain("bodyHtml");
    expect(page.slug).toBe("export-fixture-rose-hall");
  });

  it("leaves out the column Postgres computes for itself", async () => {
    // `pages.search_vector` is `generated always`. An export carrying it is an
    // export that cannot be loaded back, because an insert naming it fails.
    const { tables } = await readFullExport(NOON);

    expect(Object.keys(tables[0].rows[0])).not.toContain("search_vector");
  });

  it("orders revisions oldest first, so a self-reference is loadable", async () => {
    // `restored_from_id` points at another revision. Causality guarantees the
    // source is older, so oldest-first is an order in which every row's
    // reference already exists.
    const { tables } = await readFullExport(NOON);
    const revisions = ours(tables[1].rows, [OLD_REVISION, NEW_REVISION]);

    expect(revisions.map((row) => row.id)).toEqual([
      OLD_REVISION,
      NEW_REVISION,
    ]);
    expect(revisions[1].restored_from_id).toBe(OLD_REVISION);
  });

  it("carries the same tree the GEDCOM download would", async () => {
    const { gedcom } = await readFullExport(NOON);

    expect(gedcom).toContain("0 HEAD");
    expect(gedcom).toContain("1 CHAR UTF-8");
    expect(gedcom).toContain("Rose");
    expect(gedcom.trimEnd().endsWith("0 TRLR")).toBe(true);
  });

  it("reads how far through the migrations the database is", async () => {
    /**
     * A count rather than a name, because Drizzle's ledger records a hash of
     * each migration's SQL and nothing that maps back to a filename without
     * the repository in hand. Compared against the files in `drizzle/`, which
     * is the same comparison `docs/deploying.md` has an operator make.
     */
    // Not destructured as `schema`, which is `@/db`'s table namespace above.
    const ledger = (await readFullExport(NOON)).schema;
    const { readdirSync } = await import("node:fs");
    const migrations = readdirSync("drizzle").filter((file) =>
      file.endsWith(".sql"),
    );

    expect(ledger).not.toBeNull();
    expect(ledger!.migrationsApplied).toBe(migrations.length);
    expect(ledger!.latestMigrationAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });
});

describe("the photographs it looks for", () => {
  it("includes one that only an old revision refers to", async () => {
    /**
     * The reason both tables are scanned. A photograph taken out of an entry
     * last year is still in the revision that had it, revisions are
     * append-only, and an export that carried only what the current bodies use
     * would restore a history with holes in it.
     */
    const { images } = await readFullExport(NOON);
    const keys = images.map((image) => image.key);

    expect(keys).toContain(CURRENT_IMAGE);
    expect(keys).toContain(REMOVED_IMAGE);
  });

  it("lists each once, with the address an entry body asks for", async () => {
    // The current image is referenced by a page *and* a revision; it is one
    // file in the archive, not two members with the same name.
    const { images } = await readFullExport(NOON);
    const current = images.filter((image) => image.key === CURRENT_IMAGE);

    expect(current).toHaveLength(1);
    expect(current[0].url).toBe(
      `${IMAGE_ROUTE}/ab/0e5b6c2f-1234-4a56-89ab-cdef54000001.jpg`,
    );
  });

  /**
   * The regression this file exists to guard: a full backup that carried
   * portraits but left every thumbnail behind would restore a tree that
   * fetches full-resolution photographs to draw hundreds of nodes at once —
   * the exact cost E5-T4 exists to avoid, reintroduced by the recovery.
   */
  it("includes both of an individual's portrait keys, not just the original", async () => {
    const { images } = await readFullExport(NOON);
    const keys = images.map((image) => image.key);

    expect(keys).toContain(PORTRAIT_IMAGE);
    expect(keys).toContain(PORTRAIT_THUMB_IMAGE);
  });
});

describe("the archive it produces", () => {
  it("is a ZIP a reader can open, with the wiki inside it", async () => {
    /**
     * End to end, through the real queries and the real writer. The image
     * bytes are the one thing this cannot reach — there is no store in a test
     * environment — so they come back listed rather than included, which is
     * itself the behaviour worth seeing: an unreachable store costs the
     * pictures, never the archive.
     */
    const archive = readZip(
      new Uint8Array(await new Response(fullExportStream(NOON)).arrayBuffer()),
    );

    const pages = zipText(archive, `${DATA_PREFIX}pages.jsonl`);
    expect(pages).toContain('"slug":"export-fixture-rose-hall"');

    const manifest = JSON.parse(zipText(archive, MANIFEST_MEMBER));
    expect(manifest.format).toBe("heirloom-export");
    expect(manifest.generatedAt).toBe("2026-08-25T12:00:00.000Z");
    expect(manifest.images.map((image: { key: string }) => image.key)).toEqual(
      expect.arrayContaining([CURRENT_IMAGE, REMOVED_IMAGE]),
    );
  });
});

/**
 * Retired entries in the archive (E1-T10, `YEO-122`).
 *
 * ## Why this is not quite the "round trip" the ticket names
 *
 * The acceptance criterion says a full export/restore round trip preserves
 * retired-ness, and there is no JSONL *loader* in this repository to round-trip
 * through: `db/restore.ts` replays a `pg_dump`, and reading the archive back is
 * a documented manual procedure (`RESTORE.md`). So what is provable here is the
 * export half, stated exactly — the rows come out, and the two columns come out
 * with them — and that is the half a code change can break.
 *
 * It is also the half that fails silently. An archive missing `deleted_at`
 * restores into a wiki where every retirement anybody ever made has been
 * undone: entries somebody deliberately took out of the index are back in it,
 * back in search, months or years later, and nothing about the restore looks
 * wrong at the time. An archive missing the *rows* is worse and louder —
 * `revisions.page_id` would fail its foreign key on the way in.
 *
 * `PAGE` is the one retired here rather than `OTHER_PAGE`, because it is the
 * one with photographs in it: that makes the last assertion below about a
 * retired entry's pictures rather than about somebody else's.
 */
describe("a retired entry", () => {
  beforeAll(async () => {
    await db
      .update(schema.pages)
      .set({
        deletedAt: new Date("2026-03-01T00:00:00.000Z"),
        deletedBy: "rose@example.com",
      })
      .where(inArray(schema.pages.id, [PAGE]));
  });

  afterAll(async () => {
    await db
      .update(schema.pages)
      .set({ deletedAt: null, deletedBy: null })
      .where(inArray(schema.pages.id, [PAGE]));
  });

  it("is carried, and so is the fact that it is retired", async () => {
    const { tables } = await readFullExport(NOON);
    const [retired] = ours(tables[0].rows, [PAGE]);

    // The row is here at all — `lib/export-full.ts` is one of the two modules
    // exempted from the live-pages filter, and this is why.
    expect(retired).toBeDefined();

    // And it says so, under the *column* names a restore inserts by. The whole
    // restore procedure rests on these being column names rather than
    // Drizzle's JS properties, which is why they are spelled out here rather
    // than read off the object.
    expect(retired.deleted_at).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(retired.deleted_by).toBe("rose@example.com");
  });

  it("leaves a live entry's columns null", async () => {
    // The control. Without it, an export that wrote a timestamp into every row
    // would pass the assertion above, and would restore as a wiki with no
    // entries in the index at all.
    const { tables } = await readFullExport(NOON);
    const [live] = ours(tables[0].rows, [OTHER_PAGE]);

    expect(live.deleted_at).toBeNull();
    expect(live.deleted_by).toBeNull();
  });

  it("still carries its revisions", async () => {
    // `revisions.page_id` is `on delete cascade`, which is the argument the
    // whole ticket rests on: a hard delete would have taken these with it.
    // A retirement does not, and the archive carries them exactly as before.
    const { tables } = await readFullExport(NOON);

    expect(ours(tables[1].rows, [OLD_REVISION, NEW_REVISION])).toHaveLength(2);
  });

  it("still carries the photographs its body refers to", async () => {
    // The other half of §2 of the ticket, from the archive's side rather than
    // the sweep's: a retired entry's pictures are still the family's, so they
    // are still in the file the family takes with them.
    // `lib/image-references.ts` is shared by the export and the sweep exactly
    // so that these two cannot come to different answers.
    const { images } = await readFullExport(NOON);
    const keys = images.map((image) => image.key);

    expect(keys).toContain(CURRENT_IMAGE);
    expect(keys).toContain(REMOVED_IMAGE);
  });
});
