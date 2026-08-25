import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { parseGedcomText } from "@/lib/gedcom";
import { type GedcomMapping, mapGedcom } from "@/lib/gedcom-map";
import {
  type ImportProvenance,
  INDIVIDUAL_COLUMNS,
  importGedcom,
} from "@/lib/gedcom-import";
import { MAX_ROWS_PER_STATEMENT, batchesOf } from "@/lib/import-batches";

/**
 * Database tests for the transactional import (E6-T4, `YEO-49`) and its
 * ledger-backed refusal of a repeat (`YEO-89`). Run with `npm run test:db`;
 * the `.db.test.ts` suffix is what keeps them out of `npm test` and CI's bare
 * environment. See docs/testing.md.
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
 * three tables with foreign keys between them land together, that a failure
 * in the last of them takes the first with it, and that the unique index on
 * `gedcom_imports.digest` is what a second write of the same digest actually
 * meets — not a check this module could get wrong by skipping it.
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

/**
 * Provenance for one call, keyed on a digest the caller picks.
 *
 * A real `importGedcom` caller gets `digest` from `gedcomDigest` and the rest
 * from the request — this hands both in directly, since what a digest test
 * needs is control over which digest a call carries and not a real SHA-256 of
 * fixture bytes nobody reads back.
 */
function provenanceFor(digest: string): ImportProvenance {
  return {
    digest,
    fileName: "family.ged",
    byteCount: 1024,
    importedBy: "rose@example.com",
  };
}

async function removeFixture() {
  // `unions` and `union_children` both cascade from `individuals`, so the
  // people are the only thing teardown has to name there. `gedcom_imports`
  // does not cascade from anything — `individuals.import_id` is `set null`,
  // not the reverse — so a ledger row a test wrote has to be named on its
  // own, or it survives the fixture that made it.
  await db
    .delete(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
  await db
    .delete(schema.gedcomImports)
    .where(like(schema.gedcomImports.digest, `${PREFIX}%`));
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

async function countLedgerRows(digest: string): Promise<number> {
  const rows = await db
    .select({ id: schema.gedcomImports.id })
    .from(schema.gedcomImports)
    .where(eq(schema.gedcomImports.digest, digest));
  return rows.length;
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
     * loudly instead of hollowing the file out. `INDIVIDUAL_COLUMNS` reads
     * `import_id` (`YEO-89`) off the live schema, so this stays a check
     * against the batch size actually in force rather than the one that used
     * to be.
     */
    const mapping = fixtureMapping();
    expect(
      batchesOf(mapping.individuals, INDIVIDUAL_COLUMNS).length,
    ).toBeGreaterThan(1);
  });

  it("writes every row across all three tables, tagged with the ledger id", async () => {
    const mapping = fixtureMapping();
    const digest = `${PREFIX}-primary`;

    const outcome = await importGedcom(mapping, provenanceFor(digest));

    if (outcome.status !== "imported") {
      throw new Error(`expected "imported", got ${outcome.status}`);
    }
    expect(outcome.counts).toEqual({
      individuals: MAX_ROWS_PER_STATEMENT + 1,
      unions: 1,
      unionChildren: 1,
    });

    // The counts are computed from the arrays in hand, so they are only worth
    // reading if the database agrees with them.
    expect(await countFixturePeople()).toBe(MAX_ROWS_PER_STATEMENT + 1);
    expect(await unionExists(mapping.unions[0].id)).toBe(true);
    expect(await countLedgerRows(digest)).toBe(1);

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
        importId: schema.unions.importId,
      })
      .from(schema.unions)
      .where(eq(schema.unions.id, mapping.unions[0].id));
    expect(union.partnerAId).not.toBeNull();
    expect(union.partnerBId).not.toBeNull();

    // Every table's rows carry the same ledger id (`YEO-89`) — provenance
    // that stopped at one or two of the three tables would make "what did
    // this import add" a query with a join in it.
    expect(union.importId).toBe(outcome.importId);

    const individualImportIds = await db
      .select({ importId: schema.individuals.importId })
      .from(schema.individuals)
      .where(like(schema.individuals.givenName, `${PREFIX}%`));
    expect(
      individualImportIds.every((row) => row.importId === outcome.importId),
    ).toBe(true);

    const [linkRow] = await db
      .select({ importId: schema.unionChildren.importId })
      .from(schema.unionChildren)
      .where(eq(schema.unionChildren.unionId, mapping.unions[0].id));
    expect(linkRow.importId).toBe(outcome.importId);
  });

  it("refuses a second import of the same digest, and writes nothing the second time", async () => {
    const digest = `${PREFIX}-duplicate`;
    const first = await importGedcom(fixtureMapping(), provenanceFor(digest));
    if (first.status !== "imported") {
      throw new Error(
        `expected the first import to succeed, got ${first.status}`,
      );
    }

    const second = await importGedcom(fixtureMapping(), provenanceFor(digest));

    expect(second.status).toBe("already-imported");
    if (second.status !== "already-imported") return;
    expect(second.previous.counts).toEqual({
      people: MAX_ROWS_PER_STATEMENT + 1,
      unions: 1,
      children: 1,
    });

    // Refused, not merged and not appended to: exactly the rows the first
    // call wrote, once — never a second copy, and never zero because the
    // refusal somehow took the first import's rows with it.
    expect(await countFixturePeople()).toBe(MAX_ROWS_PER_STATEMENT + 1);
    expect(await countLedgerRows(digest)).toBe(1);
  });

  it("refuses one of two imports racing on the same digest, not both", async () => {
    /**
     * The claim the whole ticket rests on, tested rather than argued.
     *
     * The test above proves the guard against a *sequential* second call,
     * which is the retried request and the back button. It cannot see the
     * case the ticket actually names first — two tabs in flight at once —
     * because by the time the second call starts, the first has committed and
     * any `select`-then-`insert` would have caught it too.
     *
     * This runs them at once, on two pooled connections, with neither having
     * committed when the other begins. That is the window a check in
     * application code cannot close and the unique index does: the loser
     * blocks on the index until the winner resolves, then finds its
     * `onConflictDoNothing` inserted nothing and refuses.
     *
     * Deterministic despite being a race, which is what keeps it out of
     * `YEO-90`'s flake territory: the two outcomes are decided by Postgres
     * rather than by timing, exactly one insert can satisfy the constraint,
     * and neither call holds a lock the other needs before that point — so
     * there is no ordering in which both succeed, both fail, or either
     * deadlocks. Which of the two wins is genuinely arbitrary, so nothing
     * below asserts that it was the first.
     */
    const digest = `${PREFIX}-race`;

    const outcomes = await Promise.all([
      importGedcom(fixtureMapping(), provenanceFor(digest)),
      importGedcom(fixtureMapping(), provenanceFor(digest)),
    ]);

    const statuses = outcomes.map((outcome) => outcome.status).sort();
    expect(statuses).toEqual(["already-imported", "imported"]);

    // One tree, not two, and not none. The refused half rolled back whole —
    // including its ledger row, which is what stops a losing import from
    // burning the digest for the winner.
    expect(await countFixturePeople()).toBe(MAX_ROWS_PER_STATEMENT + 1);
    expect(await countLedgerRows(digest)).toBe(1);

    // And the rows that landed all belong to the import that won, so
    // provenance survives the race rather than being split across two ids.
    const winner = outcomes.find((outcome) => outcome.status === "imported");
    if (winner === undefined || winner.status !== "imported") {
      throw new Error("expected exactly one import to have been written");
    }
    const tagged = await db
      .select({ importId: schema.individuals.importId })
      .from(schema.individuals)
      .where(like(schema.individuals.givenName, `${PREFIX}%`));
    expect(tagged.every((row) => row.importId === winner.importId)).toBe(true);
  });

  it("still imports a different digest of what is otherwise the same file", async () => {
    // The guard is keyed on the *bytes*, not on the shape of the mapping — two
    // calls that would write identical rows are not "the same import" unless
    // they carry the same digest. A caller passing a fresh digest is the
    // ordinary shape of importing a second, unrelated family's file.
    const first = await importGedcom(
      fixtureMapping(),
      provenanceFor(`${PREFIX}-first`),
    );
    const second = await importGedcom(
      fixtureMapping(),
      provenanceFor(`${PREFIX}-second`),
    );

    expect(first.status).toBe("imported");
    expect(second.status).toBe("imported");
    // Two complete copies now exist, which is expected: two distinct digests
    // are two distinct files as far as this function is concerned.
    expect(await countFixturePeople()).toBe(2 * (MAX_ROWS_PER_STATEMENT + 1));
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
     * unwinding rather than a write that never started. That now includes the
     * ledger row too: it is inserted first, inside the same transaction, so a
     * failure three statements later takes it with everything else.
     */
    const broken = fixtureMapping();
    broken.unionChildren[0].childId = crypto.randomUUID();
    const digest = `${PREFIX}-rollback`;

    await expect(importGedcom(broken, provenanceFor(digest))).rejects.toThrow();

    expect(await countFixturePeople()).toBe(0);
    expect(await unionExists(broken.unions[0].id)).toBe(false);
    expect(await countLedgerRows(digest)).toBe(0);
  });

  it("writes nothing, and does not fail, for a file with nothing in it", async () => {
    /**
     * Drizzle's `values()` throws on an empty array, so this is not a
     * degenerate case that merely happens to work — it is the landmine
     * `batchesOf` disarms, pinned in the one place it would actually fire. A
     * GEDCOM file with people but no families reaches it for real.
     */
    const outcome = await importGedcom(
      { individuals: [], unions: [], unionChildren: [], issues: [] },
      provenanceFor(`${PREFIX}-empty`),
    );

    expect(outcome).toEqual({
      status: "imported",
      importId: expect.any(String),
      counts: { individuals: 0, unions: 0, unionChildren: 0 },
    });
  });
});
