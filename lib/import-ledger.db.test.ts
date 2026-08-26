import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { findImportByDigest } from "@/lib/import-ledger";

/**
 * Database tests for the ledger's one read (`YEO-89`). Run with
 * `npm run test:db`; see docs/testing.md for the `.db.test.ts` split.
 *
 * `priorImportFrom`'s shaping — which fields land where — is exercised here
 * too, since there is no pure-side test of it: it takes a database row, so a
 * literal handed to it directly would only prove the function agrees with
 * itself about a shape it invented. What is worth a real database for is
 * narrower than that: that a row written with `db.insert` comes back out
 * through `findImportByDigest` naming the same file, and that a digest
 * nobody has imported answers `null` rather than throwing.
 *
 * Since `YEO-95` there is a third thing only a database can settle. A digest
 * can now have more than one row — one live claim and any number of released
 * ones — so "the row for this digest" stopped being a phrase with an obvious
 * meaning, and a `select` with no predicate would return whichever row
 * Postgres happened to hand back first. The `released_at is null` clause is
 * what makes the answer both deterministic and the one the guard would give.
 */

const DIGEST = "import-ledger-fixture-digest-1";
const OTHER_DIGEST = "import-ledger-fixture-digest-2";
/**
 * One digest twice: a released row and the live one beside it (`YEO-95`).
 * This is the shape a file that has been imported, released and imported
 * again actually leaves behind.
 */
const REIMPORTED_DIGEST = "import-ledger-fixture-digest-3";
/** A digest whose only row has been released. Nothing is claiming it. */
const RELEASED_DIGEST = "import-ledger-fixture-digest-4";
const ROW_ID = "00000000-0000-4000-8000-0000000e0001";
const OTHER_ROW_ID = "00000000-0000-4000-8000-0000000e0002";
const RETIRED_ROW_ID = "00000000-0000-4000-8000-0000000e0003";
const LIVE_ROW_ID = "00000000-0000-4000-8000-0000000e0004";
const RELEASED_ONLY_ROW_ID = "00000000-0000-4000-8000-0000000e0005";

const FIXTURE_IDS = [
  ROW_ID,
  OTHER_ROW_ID,
  RETIRED_ROW_ID,
  LIVE_ROW_ID,
  RELEASED_ONLY_ROW_ID,
];

async function removeFixture() {
  await db
    .delete(schema.gedcomImports)
    .where(inArray(schema.gedcomImports.id, FIXTURE_IDS));
}

const IMPORTED_AT = new Date("2026-03-03T00:00:00.000Z");
const RELEASED_AT = new Date("2026-04-01T00:00:00.000Z");

beforeAll(async () => {
  await removeFixture();

  await db.insert(schema.gedcomImports).values([
    {
      id: ROW_ID,
      digest: DIGEST,
      fileName: "family.ged",
      byteCount: 4096,
      individualCount: 412,
      unionCount: 120,
      unionChildCount: 300,
      importedAt: IMPORTED_AT,
      importedBy: "rose@example.com",
    },
    {
      id: OTHER_ROW_ID,
      digest: OTHER_DIGEST,
      // No filename: `form.get()` yields a `Blob`, and only a `File` carries
      // one — this row is what that ordinary case looks like in the ledger.
      fileName: null,
      byteCount: 128,
      individualCount: 0,
      unionCount: 0,
      unionChildCount: 0,
      importedAt: IMPORTED_AT,
      importedBy: null,
    },
    {
      id: RETIRED_ROW_ID,
      digest: REIMPORTED_DIGEST,
      fileName: "the-first-attempt.ged",
      byteCount: 4096,
      individualCount: 7,
      unionCount: 0,
      unionChildCount: 0,
      importedAt: IMPORTED_AT,
      importedBy: "rose@example.com",
      releasedAt: RELEASED_AT,
      releasedBy: "rose@example.com",
    },
    {
      id: LIVE_ROW_ID,
      digest: REIMPORTED_DIGEST,
      fileName: "the-one-that-stuck.ged",
      byteCount: 4096,
      individualCount: 9,
      unionCount: 0,
      unionChildCount: 0,
      importedAt: RELEASED_AT,
      importedBy: "rose@example.com",
    },
    {
      id: RELEASED_ONLY_ROW_ID,
      digest: RELEASED_DIGEST,
      fileName: "let-go-of.ged",
      byteCount: 64,
      individualCount: 3,
      unionCount: 0,
      unionChildCount: 0,
      importedAt: IMPORTED_AT,
      releasedAt: RELEASED_AT,
      releasedBy: "rose@example.com",
    },
  ]);
});

afterAll(removeFixture);

describe("findImportByDigest", () => {
  it("names the earlier import, shaped for the wire", async () => {
    const found = await findImportByDigest(DIGEST);

    expect(found).toEqual({
      // On the wire since `YEO-95`, and the reason it is: this is the value a
      // release names, so the row the reader is *told* about and the row a
      // release would retire are the same row by construction.
      id: ROW_ID,
      importedAt: IMPORTED_AT.toISOString(),
      fileName: "family.ged",
      counts: { people: 412, unions: 120, children: 300 },
    });
  });

  it("answers null for a digest whose only claim has been released (YEO-95)", async () => {
    // The escape hatch, seen from the preview's side. A released row refuses
    // nothing, so saying "already imported" about one would put a sentence on
    // the screen that the very next request contradicts.
    expect(await findImportByDigest(RELEASED_DIGEST)).toBeNull();
  });

  it("names the live claim, not a released one, when a digest has both", async () => {
    /**
     * The case that only exists after `YEO-95`, and the reason the clause is
     * a correctness fix rather than a policy statement. Two rows carry this
     * digest; without the predicate this select has no `order by` and no
     * other filter, so which one came back would be Postgres's business
     * rather than this module's — and it would sometimes be the retired one,
     * naming a file and a count that are no longer what stands in the way.
     */
    const found = await findImportByDigest(REIMPORTED_DIGEST);

    expect(found?.id).toBe(LIVE_ROW_ID);
    expect(found?.fileName).toBe("the-one-that-stuck.ged");
    expect(found?.counts.people).toBe(9);
  });

  it("carries a null filename and a null importedBy through untouched", async () => {
    const found = await findImportByDigest(OTHER_DIGEST);

    expect(found?.fileName).toBeNull();
    expect(found?.counts).toEqual({ people: 0, unions: 0, children: 0 });
  });

  it("answers null for a digest nothing has imported", async () => {
    const found = await findImportByDigest(
      "import-ledger-fixture-digest-never-seen",
    );

    expect(found).toBeNull();
  });
});
