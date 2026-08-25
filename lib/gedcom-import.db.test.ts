import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { parseGedcomText } from "@/lib/gedcom";
import { type GedcomMapping, mapGedcom } from "@/lib/gedcom-map";
import { INDIVIDUAL_COLUMNS, importGedcom } from "@/lib/gedcom-import";
import { MAX_ROWS_PER_STATEMENT, batchesOf } from "@/lib/import-batches";

/**
 * Database tests for the transactional import (E6-T4, `YEO-49`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * What is deliberately **not** here:
 *
 * - **The batch arithmetic.** `lib/import-batches.test.ts` owns it, with no
 *   database, so that the acceptance criterion about round trips is checked on
 *   every commit rather than only when somebody remembers to run this suite.
 * - **The bare transaction semantics.** That postgres.js commits a callback
 *   which returns normally, and unwinds one that throws, is already pinned by
 *   `lib/reorder-unions.db.test.ts` under "the transaction semantics
 *   reorderUnions relies on". Copying those assertions here would be a second
 *   place to maintain one fact about the driver.
 *
 * What is left is the part that is only true of a real database: that rows in
 * three tables with foreign keys between them land together, and that a
 * failure in the last of them takes the first with it.
 */

const PREFIX = "gedcom-import-fixture";

/**
 * A file with more individuals than fit in one statement, and one family.
 *
 * Sized from `MAX_ROWS_PER_STATEMENT` rather than from a literal, so that the
 * day the cap changes this fixture either still spans two statements or fails
 * the precondition below — never quietly shrinks to one and stops testing the
 * thing it exists for.
 */
function fixtureText(people: number): string {
  const lines = ["0 HEAD", "1 CHAR UTF-8", "1 GEDC", "2 VERS 5.5.1"];

  for (let index = 1; index <= people; index += 1) {
    lines.push(`0 @I${index}@ INDI`);
    lines.push(`1 NAME ${PREFIX} ${index} /Test/`);
    lines.push("1 SEX U");
    // The first three are the family below, so they carry its back-pointers.
    if (index === 1 || index === 2) lines.push("1 FAMS @F1@");
    if (index === 3) lines.push("1 FAMC @F1@");
  }

  lines.push("0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@");
  lines.push("0 TRLR");

  return lines.join("\n");
}

function fixtureMapping(people = MAX_ROWS_PER_STATEMENT + 1): GedcomMapping {
  return mapGedcom(parseGedcomText(fixtureText(people)));
}

async function removeFixture() {
  // `unions` and `union_children` both cascade from `individuals`, so the
  // people are the only thing teardown has to name.
  await db
    .delete(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
}

async function countFixturePeople(): Promise<number> {
  const rows = await db
    .select({ id: schema.individuals.id })
    .from(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
  return rows.length;
}

/** Whether a specific minted id is in the database. Ids come from the mapping. */
async function unionExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.unions.id })
    .from(schema.unions)
    .where(eq(schema.unions.id, id));
  return rows.length > 0;
}

beforeEach(removeFixture);
afterAll(removeFixture);

describe("importGedcom", () => {
  it("needs more than one statement, or the tests below prove less", () => {
    /**
     * A precondition rather than a comment. The rollback assertion is only
     * worth anything if the individuals span at least two statements — that is
     * what makes "the first batch was unwound" a different claim from "the one
     * statement never ran". Asserted here so that a change to the cap fails
     * loudly instead of hollowing the file out.
     */
    const mapping = fixtureMapping();
    expect(
      batchesOf(mapping.individuals, INDIVIDUAL_COLUMNS).length,
    ).toBeGreaterThan(1);
  });

  it("writes every row across all three tables", async () => {
    const mapping = fixtureMapping();

    const counts = await importGedcom(mapping);

    expect(counts).toEqual({
      individuals: MAX_ROWS_PER_STATEMENT + 1,
      unions: 1,
      unionChildren: 1,
    });

    // The counts are computed from the arrays in hand, so they are only worth
    // reading if the database agrees with them.
    expect(await countFixturePeople()).toBe(MAX_ROWS_PER_STATEMENT + 1);
    expect(await unionExists(mapping.unions[0].id)).toBe(true);

    const links = await db
      .select({ childId: schema.unionChildren.childId })
      .from(schema.unionChildren)
      .where(eq(schema.unionChildren.unionId, mapping.unions[0].id));
    expect(links).toHaveLength(1);

    /**
     * The ordering criterion, and it needs no assertion of its own: the union
     * names two `individuals` ids in `not null`-able foreign keys, so this
     * insert could not have succeeded had the people not already been in the
     * same transaction. Writing the tables in any other order fails here.
     */
    const [union] = await db
      .select({
        partnerAId: schema.unions.partnerAId,
        partnerBId: schema.unions.partnerBId,
      })
      .from(schema.unions)
      .where(eq(schema.unions.id, mapping.unions[0].id));
    expect(union.partnerAId).not.toBeNull();
    expect(union.partnerBId).not.toBeNull();
  });

  it("leaves nothing behind when a later statement fails", async () => {
    /**
     * Fault *injection*, and it is worth being plain about that. The mapper
     * resolves every foreign key before it returns, so a dangling `childId` is
     * unreachable from a real file — `lib/gedcom.purity.test.ts` and
     * `mapChildren` together are what make it so. What this stands in for is
     * the class of fault the transaction actually exists to survive and that no
     * test can summon on demand: a dropped connection, a statement timeout, a
     * constraint added in a later migration.
     *
     * It is injected into the **last** table on purpose. A failure in the
     * first statement would prove almost nothing; this one is raised by
     * Postgres after 1,001 individuals have been written across two statements
     * and a union across a third, so "nothing remains" is the whole import
     * unwinding rather than a write that never started.
     */
    const broken = fixtureMapping();
    broken.unionChildren[0].childId = crypto.randomUUID();

    await expect(importGedcom(broken)).rejects.toThrow();

    expect(await countFixturePeople()).toBe(0);
    expect(await unionExists(broken.unions[0].id)).toBe(false);
  });

  it("writes nothing, and does not fail, for a file with nothing in it", async () => {
    /**
     * Drizzle's `values()` throws on an empty array, so this is not a
     * degenerate case that merely happens to work — it is the landmine
     * `batchesOf` disarms, pinned in the one place it would actually fire. A
     * GEDCOM file with people but no families reaches it for real.
     */
    const counts = await importGedcom({
      individuals: [],
      unions: [],
      unionChildren: [],
      issues: [],
    });

    expect(counts).toEqual({ individuals: 0, unions: 0, unionChildren: 0 });
  });
});
