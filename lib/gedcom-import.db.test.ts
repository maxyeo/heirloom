import { asc, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { parseGedcomText } from "@/lib/gedcom";
import { type GedcomMapping, mapGedcom } from "@/lib/gedcom-map";
import {
  type ImportOutcome,
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
  return (await readLedger(digest)).length;
}

/**
 * Every ledger row for a digest, oldest first (`YEO-95`).
 *
 * A digest can have more than one row since releasing became possible — one
 * live claim and any number of retired ones — so the tests below have to be
 * able to say *which* row they mean rather than counting.
 */
async function readLedger(digest: string) {
  return db
    .select({
      id: schema.gedcomImports.id,
      individualCount: schema.gedcomImports.individualCount,
      releasedAt: schema.gedcomImports.releasedAt,
      releasedBy: schema.gedcomImports.releasedBy,
    })
    .from(schema.gedcomImports)
    .where(eq(schema.gedcomImports.digest, digest))
    .orderBy(
      asc(schema.gedcomImports.importedAt),
      asc(schema.gedcomImports.id),
    );
}

/** How many rows of an import's people are still tagged with its ledger id. */
async function countTaggedWith(importId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.individuals.id })
    .from(schema.individuals)
    .where(eq(schema.individuals.importId, importId));
  return rows.length;
}

/** The one import that succeeded, or a failure naming what happened instead. */
function written(outcome: ImportOutcome): {
  status: "imported";
  importId: string;
  counts: { individuals: number; unions: number; unionChildren: number };
} {
  if (outcome.status !== "imported") {
    throw new Error(`expected an import, got ${outcome.status}`);
  }
  return outcome;
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

  /**
   * `YEO-104`'s explicit question about this module, answered here rather
   * than argued: an imported person's author is **derived**, not stored.
   *
   * Every row says `import` and carries no email, and the email is one join
   * away on the ledger row `import_id` already points at. Copying
   * `imported_by` onto each person would be a second copy of a fact this
   * schema holds once — free to disagree with the first the moment anything
   * corrects the ledger — so a change that started doing it should fail here,
   * because it would otherwise look like an improvement. See `authorColumns`
   * in `lib/individual-author.ts`.
   */
  it("attributes imported people to the import, storing no email of its own", async () => {
    const digest = `${PREFIX}-authorship`;

    const outcome = await importGedcom(fixtureMapping(), provenanceFor(digest));
    if (outcome.status !== "imported") {
      throw new Error(`expected "imported", got ${outcome.status}`);
    }

    const people = await db
      .select({
        createdBySource: schema.individuals.createdBySource,
        createdBy: schema.individuals.createdBy,
        importedBy: schema.gedcomImports.importedBy,
      })
      .from(schema.individuals)
      .innerJoin(
        schema.gedcomImports,
        eq(schema.individuals.importId, schema.gedcomImports.id),
      )
      .where(like(schema.individuals.givenName, `${PREFIX}%`));

    expect(people).toHaveLength(MAX_ROWS_PER_STATEMENT + 1);
    expect(
      people.every(
        (person) =>
          person.createdBySource === "import" &&
          person.createdBy === null &&
          // The author, one join away, and written from the session by the
          // endpoint exactly as `pages.updated_by` is.
          person.importedBy === "rose@example.com",
      ),
    ).toBe(true);
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

describe("releasing a prior import (YEO-95)", () => {
  const PEOPLE = MAX_ROWS_PER_STATEMENT + 1;

  it("imports again, and keeps the earlier import's record and its provenance", async () => {
    /**
     * The acceptance criterion the whole ticket is about, and the half of it
     * that is easy to get wrong. Releasing must not be a `delete`: the
     * foreign key from `individuals.import_id` is `on delete set null`, so
     * deleting the ledger row would silently strip the provenance from every
     * row of that import which survived — the column `YEO-89` added the
     * ledger for. So the assertion is not only that the second import lands;
     * it is that the first import's row is still there, still carrying its
     * counts, and still named by every person it wrote.
     */
    const digest = `${PREFIX}-released`;
    const first = written(
      await importGedcom(fixtureMapping(), provenanceFor(digest)),
    );

    const second = written(
      await importGedcom(fixtureMapping(), provenanceFor(digest), {
        release: first.importId,
      }),
    );

    expect(second.importId).not.toBe(first.importId);

    // Two ledger rows, not one rewritten: what happened is legible as the two
    // imports it actually was.
    const ledger = await readLedger(digest);
    expect(ledger).toHaveLength(2);
    const [retired, live] = ledger;
    expect(retired.id).toBe(first.importId);
    expect(retired.releasedAt).toBeInstanceOf(Date);
    expect(retired.releasedBy).toBe("rose@example.com");
    expect(retired.individualCount).toBe(PEOPLE);
    expect(live.id).toBe(second.importId);
    expect(live.releasedAt).toBeNull();

    // And the provenance the release did not erase: the first import's people
    // are still tagged with the first import's id.
    expect(await countTaggedWith(first.importId)).toBe(PEOPLE);
    expect(await countTaggedWith(second.importId)).toBe(PEOPLE);
    // Releasing removes nothing, so both copies are in the tree — which is
    // exactly what the screen warns before the override can be pressed.
    expect(await countFixturePeople()).toBe(2 * PEOPLE);
  });

  it("spends itself: the same release replayed is refused, and writes nothing", async () => {
    /**
     * The failure this design exists to avoid, pinned.
     *
     * A release that merely said *let this file through* would stay true
     * however many times it was sent — and a retried request, a second tab,
     * or a back button on the confirm screen would each release whatever was
     * currently in the way and write another complete copy of the tree. That
     * is the duplication `YEO-89` prevents, reached through the door built to
     * escape it.
     *
     * Naming the row makes it single-use with no bookkeeping at all: the
     * second attempt names a row that is no longer live, releases nothing,
     * and meets the ordinary unique index. What it is told about is the
     * import that has just happened, which is the truth.
     */
    const digest = `${PREFIX}-replayed`;
    const first = written(
      await importGedcom(fixtureMapping(), provenanceFor(digest)),
    );
    const second = written(
      await importGedcom(fixtureMapping(), provenanceFor(digest), {
        release: first.importId,
      }),
    );

    const replay = await importGedcom(fixtureMapping(), provenanceFor(digest), {
      release: first.importId,
    });

    expect(replay.status).toBe("already-imported");
    if (replay.status !== "already-imported") return;
    expect(replay.previous.id).toBe(second.importId);

    // Two copies, not three: the replay wrote nothing at all.
    expect(await countFixturePeople()).toBe(2 * PEOPLE);
    expect(await readLedger(digest)).toHaveLength(2);
  });

  it("refuses one of two callers racing to release the same claim, not both", async () => {
    /**
     * The concurrent shape of the test above, and the one an application-side
     * check could not get right. Both callers were shown the same prior
     * import and both are releasing it; neither has committed when the other
     * begins.
     *
     * Two things settle it, in order. The `released_at is null` in the
     * release's own `where` means the second `update` wakes from the first's
     * row lock, re-checks, and skips — so the release happens once. The
     * partial unique index then meets the second insert exactly as it meets
     * any repeat. Which of the two wins is arbitrary, so nothing below
     * asserts that it was the first.
     */
    const digest = `${PREFIX}-release-race`;
    const first = written(
      await importGedcom(fixtureMapping(), provenanceFor(digest)),
    );

    const outcomes = await Promise.all([
      importGedcom(fixtureMapping(), provenanceFor(digest), {
        release: first.importId,
      }),
      importGedcom(fixtureMapping(), provenanceFor(digest), {
        release: first.importId,
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "already-imported",
      "imported",
    ]);

    // One release and one re-import: two copies of the tree, two ledger rows.
    expect(await countFixturePeople()).toBe(2 * PEOPLE);
    const ledger = await readLedger(digest);
    expect(ledger).toHaveLength(2);
    expect(ledger.filter((row) => row.releasedAt === null)).toHaveLength(1);
  });

  it("will not release a claim belonging to another file", async () => {
    // The id crosses the wire, so it is a value the caller controls, and the
    // `where` treats it as a claim to check rather than an instruction. A
    // release naming some other file's ledger row retires nothing — the guard
    // on the file actually being imported is left standing, and the unrelated
    // import keeps its claim.
    const mine = `${PREFIX}-mine`;
    const theirs = `${PREFIX}-theirs`;
    const other = written(
      await importGedcom(fixtureMapping(), provenanceFor(theirs)),
    );
    await importGedcom(fixtureMapping(), provenanceFor(mine));

    const refused = await importGedcom(fixtureMapping(), provenanceFor(mine), {
      release: other.importId,
    });

    expect(refused.status).toBe("already-imported");
    const [untouched] = await readLedger(theirs);
    expect(untouched.releasedAt).toBeNull();
  });

  it("imports normally when there is no live claim to release", async () => {
    // A caller who asked for the override and did not need it — the ledger
    // was not standing in the way. Not an error: what they wanted was this
    // file imported, and the index decides that the way it always has.
    const digest = `${PREFIX}-nothing-to-release`;

    const outcome = await importGedcom(
      fixtureMapping(),
      provenanceFor(digest),
      { release: "00000000-0000-4000-8000-0000000e0fff" },
    );

    expect(outcome.status).toBe("imported");
    expect(await countFixturePeople()).toBe(PEOPLE);
  });
});
