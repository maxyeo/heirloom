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
 */

const DIGEST = "import-ledger-fixture-digest-1";
const OTHER_DIGEST = "import-ledger-fixture-digest-2";
const ROW_ID = "00000000-0000-4000-8000-0000000e0001";
const OTHER_ROW_ID = "00000000-0000-4000-8000-0000000e0002";

async function removeFixture() {
  await db
    .delete(schema.gedcomImports)
    .where(inArray(schema.gedcomImports.id, [ROW_ID, OTHER_ROW_ID]));
}

const IMPORTED_AT = new Date("2026-03-03T00:00:00.000Z");

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
  ]);
});

afterAll(removeFixture);

describe("findImportByDigest", () => {
  it("names the earlier import, shaped for the wire", async () => {
    const found = await findImportByDigest(DIGEST);

    expect(found).toEqual({
      importedAt: IMPORTED_AT.toISOString(),
      fileName: "family.ged",
      counts: { people: 412, unions: 120, children: 300 },
    });
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
