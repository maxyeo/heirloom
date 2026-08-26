import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { readReferencedImageKeys } from "@/lib/image-references";
import { IMAGE_ROUTE } from "@/lib/storage-key";
import { addedByHand } from "@/test/people-fixtures";

/**
 * What only Postgres can prove about the orphan sweep's reference scan.
 *
 * `lib/image-references.test.ts` covers the parsing against literals and
 * `lib/image-sweep.test.ts` covers the orphan rule. What is left here is the
 * claim that cannot be checked without real rows: **that the scan asks all
 * three sources**, and keeps asking them.
 *
 * That is not a hypothetical worry. Each of the three has a plausible-looking
 * "optimisation" that would pass every other test in the suite:
 *
 * - dropping `revisions`, because the current body is what the wiki renders;
 * - dropping the portrait columns, because they are not entry content;
 * - dropping `pages`, because every current body is also the newest revision
 *   — which is nearly true and not true.
 *
 * Every one of those turns this file red, by name, and every one of them
 * would otherwise ship as a silent deletion bug: `db/images-sweep.ts` reads
 * this set and deletes what is not in it, and photographs are the one thing
 * the nightly backup does not carry (docs/backups.md). See docs/testing.md
 * for why this is a `.db.test.ts`.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made.
const PAGE = "00000000-0000-4000-8000-0000000045a1";
const BARE_PAGE = "00000000-0000-4000-8000-0000000045a2";
const OLD_REVISION = "00000000-0000-4000-8000-0000000045b1";
const NEW_REVISION = "00000000-0000-4000-8000-0000000045b2";
const PERSON = "00000000-0000-4000-8000-0000000045c1";
const PORTRAIT_PERSON = "00000000-0000-4000-8000-0000000045c2";

/** Still in the entry that has it. */
const CURRENT_IMAGE = "images/ab/0e5b6c2f-1234-4a56-89ab-cdef45000001.jpg";
/**
 * Taken out of the entry, and still in every revision written while it was
 * there. The key this whole ticket is about.
 */
const REMOVED_IMAGE = "images/cd/0e5b6c2f-1234-4a56-89ab-cdef45000002.jpg";
/** A person's portrait and its thumbnail — referenced by no body anywhere. */
const PORTRAIT_IMAGE = "images/ef/0e5b6c2f-1234-4a56-89ab-cdef45000003.jpg";
const PORTRAIT_THUMB = "images/3a/0e5b6c2f-1234-4a56-89ab-cdef45000004.webp";
/**
 * Never written to any row. The control: without one, a scan that returned
 * every key it could think of would pass everything below.
 */
const UNREFERENCED = "images/7f/0e5b6c2f-1234-4a56-89ab-cdef45000005.jpg";

function imgTag(key: string): string {
  return `<img src="${IMAGE_ROUTE}/${key.slice("images/".length)}">`;
}

async function removeFixture() {
  // `individuals.page_id` is `ON DELETE SET NULL`, so the people have to go
  // explicitly; revisions cascade with their page.
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, [PERSON, PORTRAIT_PERSON]));
  await db
    .delete(schema.pages)
    .where(inArray(schema.pages.id, [PAGE, BARE_PAGE]));
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and
  // would otherwise greet the next one with a duplicate key on these ids.
  await removeFixture();

  await db.insert(schema.pages).values([
    {
      id: PAGE,
      slug: "sweep-fixture-rose-hall",
      title: "Rose Hall",
      // The photograph that is *left*. `REMOVED_IMAGE` is deliberately
      // absent from this body — it survives only in the revision below.
      bodyHtml: `<p>Rose.</p>${imgTag(CURRENT_IMAGE)}`,
    },
    {
      id: BARE_PAGE,
      slug: "sweep-fixture-walter-hale",
      title: "Walter Hale",
      bodyHtml: "<p>Walter, photographed never.</p>",
    },
  ]);

  await db.insert(schema.revisions).values([
    {
      id: OLD_REVISION,
      pageId: PAGE,
      title: "Rose Hall",
      bodyHtml: `<p>Rose.</p>${imgTag(REMOVED_IMAGE)}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: NEW_REVISION,
      pageId: PAGE,
      title: "Rose Hall",
      bodyHtml: `<p>Rose.</p>${imgTag(CURRENT_IMAGE)}`,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      restoredFromId: OLD_REVISION,
    },
  ]);

  await db.insert(schema.individuals).values(
    addedByHand([
      { id: PERSON, pageId: PAGE, givenName: "Rose", surname: "Hall" },
      {
        id: PORTRAIT_PERSON,
        givenName: "Walter",
        surname: "Hale",
        portraitKey: PORTRAIT_IMAGE,
        portraitThumbKey: PORTRAIT_THUMB,
      },
    ]),
  );
});

afterAll(removeFixture);

describe("readReferencedImageKeys", () => {
  it("finds an image the current entry body uses", async () => {
    const { keys } = await readReferencedImageKeys();

    expect(keys.has(CURRENT_IMAGE)).toBe(true);
  });

  it("finds an image only an old revision still contains", async () => {
    // **The trap.** `REMOVED_IMAGE` appears in no current body — it was taken
    // out of the entry — but the revision that had it is append-only and
    // E1-T7 can restore it. Scanning only `pages` would call this key an
    // orphan and delete it, and the restore months later would bring back a
    // body pointing at a photograph that no longer exists, with the broken
    // `<img>` baked into a row nobody can edit.
    const { keys } = await readReferencedImageKeys();

    expect(keys.has(REMOVED_IMAGE)).toBe(true);
  });

  it("finds a portrait and its thumbnail, which appear in no body at all", async () => {
    // E5-T4 put keys on `individuals` directly. A sweep that scanned only
    // HTML would find every portrait in the wiki unreferenced and delete the
    // lot on its first run — including the thumbnails, without which the
    // tree fetches full-resolution photographs to draw itself.
    const { keys } = await readReferencedImageKeys();

    expect(keys.has(PORTRAIT_IMAGE)).toBe(true);
    expect(keys.has(PORTRAIT_THUMB)).toBe(true);
  });

  it("does not invent a reference to an image no row mentions", async () => {
    // The control. Without this, a scan that returned everything would pass
    // every assertion above and the sweep would never reclaim anything.
    const { keys } = await readReferencedImageKeys();

    expect(keys.has(UNREFERENCED)).toBe(false);
  });

  it("attributes each reference to the source it came from", async () => {
    // The counts are what the dry-run report prints, and they are how a
    // wrong answer becomes visible: zero portrait references against a wiki
    // full of photographs is a bug somebody can see.
    const references = await readReferencedImageKeys();

    expect(references.fromPages).toBeGreaterThanOrEqual(1);
    expect(references.fromRevisions).toBeGreaterThanOrEqual(2);
    expect(references.fromPortraits).toBeGreaterThanOrEqual(2);
  });

  it("reads through a transaction when given one", async () => {
    // How `db/images-sweep.ts` calls it, so that the three reads describe one
    // instant rather than three.
    const references = await db.transaction((tx) =>
      readReferencedImageKeys(tx),
    );

    expect(references.keys.has(REMOVED_IMAGE)).toBe(true);
  });
});

describe("the sweep's view of this fixture", () => {
  it("would delete only the image nothing points at", async () => {
    // The end-to-end statement of the ticket, with a store standing in for
    // the real one: four of these keys are referenced through three
    // different mechanisms, and exactly one is not.
    const { planImageSweep } = await import("@/lib/image-sweep");
    const { keys } = await readReferencedImageKeys();

    const now = new Date("2026-08-25T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const plan = planImageSweep({
      listed: [
        CURRENT_IMAGE,
        REMOVED_IMAGE,
        PORTRAIT_IMAGE,
        PORTRAIT_THUMB,
        UNREFERENCED,
      ].map((key) => ({ key, size: 1000, uploadedAt: old })),
      referenced: keys,
      now,
      // This fixture is a handful of objects in a database that may hold
      // other people's rows, so the fraction rule is not the subject here.
      maxOrphanFraction: 1,
    });

    expect(plan.orphans.map((object) => object.key)).toEqual([UNREFERENCED]);
  });
});
