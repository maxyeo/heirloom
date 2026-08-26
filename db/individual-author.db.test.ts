import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { INDIVIDUAL_AUTHOR_SOURCES } from "@/lib/individual-author";
import { addChild } from "@/lib/save-child";
import { createIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";
import { FIXTURE_AUTHOR, FIXTURE_MEMBER } from "@/test/people-fixtures";

/**
 * The half of `YEO-104` that only a real Postgres can answer.
 *
 * `lib/individual-author.test.ts` owns the mapping — who did this, therefore
 * what is written — and runs in `npm test`. What is left for this file is the
 * part that lives in the database and in the write paths:
 *
 *   - the **shape of the column**, which is what makes the ticket's "a new
 *     path that forgets should fail a test, not silently write a null" true.
 *     It is enforced by the compiler rather than by a test — a required
 *     insert value — and the compiler only enforces it for as long as the
 *     column has no default. So the assertion here is about the column
 *     definition, and it is the assertion that would fail if somebody made
 *     the type error go away by adding one;
 *   - that the migration's backfill value is still a value the column can
 *     hold, so a row that predates the column stays distinguishable from
 *     every other row;
 *   - and that each write path actually reaches `authorColumns`, which no
 *     amount of type-checking can show: a path could satisfy the compiler
 *     with the wrong author as easily as with the right one.
 *
 * The GEDCOM import's answer is asserted in `lib/gedcom-import.db.test.ts`,
 * beside the fixtures that can produce one, and read back from the feed's own
 * query in `lib/recent-changes.db.test.ts`.
 */

/** `104` is the ticket; the prefix is what teardown deletes by. */
const PREFIX = "Zzauthor104";
const name = (suffix: string) => `${PREFIX} ${suffix}`;

async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
}

beforeAll(removeFixture);
afterAll(removeFixture);

/** The author columns of one fixture person, by id. */
async function authorOf(id: string) {
  const [row] = await db
    .select({
      createdBySource: schema.individuals.createdBySource,
      createdBy: schema.individuals.createdBy,
    })
    .from(schema.individuals)
    .where(eq(schema.individuals.id, id));
  return row;
}

describe("the individuals author columns", () => {
  /**
   * The guard on the guard.
   *
   * A default is the shortcut this ticket names as the wrong answer, and the
   * reason is not style: whatever value it took would have been stamped onto
   * every row that already existed, inventing authorship for people nobody
   * can attribute. It would also silently disarm the compile-time
   * requirement, since a column with a default is optional in Drizzle's
   * insert type — so a write path that forgot the author would go back to
   * writing a plausible-looking lie and nothing would go red.
   *
   * Read from `information_schema` rather than from `db/schema.ts`, because
   * what is running is the migration, not the TypeScript.
   */
  it("keeps created_by_source not null and defaultless", async () => {
    const rows = await db.execute<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select column_name, is_nullable, column_default
      from information_schema.columns
      where table_name = 'individuals'
        and column_name in ('created_by_source', 'created_by')
      order by column_name
    `);

    expect([...rows]).toEqual([
      // Nullable, and every one of its nulls explained by the column beside
      // it — see `db/schema.ts`.
      { column_name: "created_by", is_nullable: "YES", column_default: null },
      {
        column_name: "created_by_source",
        is_nullable: "NO",
        column_default: null,
      },
    ]);
  });

  /**
   * The enum, as Postgres holds it. `db/schema.ts` builds it from
   * `INDIVIDUAL_AUTHOR_SOURCES` rather than repeating the labels, so this is
   * really asserting that the migration ran — a label added to the tuple and
   * never migrated would compile, pass every unit test, and fail on the first
   * insert that used it.
   */
  it("holds exactly the sources the application knows about", async () => {
    const rows = await db.execute<{ label: string }>(sql`
      select enumlabel as label
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'created_by_source'
      order by enumsortorder
    `);

    expect([...rows].map((row) => row.label)).toEqual([
      ...INDIVIDUAL_AUTHOR_SOURCES,
    ]);
  });

  /**
   * `legacy` is the migration's backfill value and nothing in TypeScript can
   * produce it (`IndividualAuthor` has no arm for it), which is what keeps it
   * meaning exactly "this row predates the column". A row still has to be
   * able to *hold* it, or every person who existed before this ticket would
   * have been unrepresentable and the migration could not have run.
   */
  it("accepts the legacy value the backfill wrote", async () => {
    const [row] = await db
      .insert(schema.individuals)
      .values({
        givenName: name("Legacy"),
        createdBySource: "legacy",
        createdBy: null,
      })
      .returning({ id: schema.individuals.id });

    expect(await authorOf(row.id)).toEqual({
      createdBySource: "legacy",
      createdBy: null,
    });
  });
});

describe("the write paths", () => {
  it("records the member who added a person by hand", async () => {
    const created = await createIndividual(
      { givenName: name("Agnes") },
      FIXTURE_MEMBER,
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") return;

    expect(await authorOf(created.id)).toEqual({
      createdBySource: "member",
      createdBy: FIXTURE_AUTHOR,
    });
  });

  /**
   * The add-spouse flow, which creates a person *inside somebody else's
   * transaction* and therefore does not go through `createIndividual` at all
   * — it repeats the insert, for the rollback reason its own comment gives.
   * A repeated insert is a repeated chance to forget, which is exactly why
   * this is asserted separately rather than assumed from the test above.
   */
  it("records the member who added a partner inline", async () => {
    const person = await createIndividual(
      { givenName: name("Thomas") },
      FIXTURE_MEMBER,
    );
    if (person.status !== "created") throw new Error("fixture person failed");

    const added = await addSpouse(
      {
        personId: person.id,
        partnerMode: "new",
        // Read only in `existing` mode; named because the type requires it.
        partnerId: "",
        partner: { givenName: name("Rose") },
        union: {},
      },
      FIXTURE_MEMBER,
    );

    expect(added.status).toBe("added");
    if (added.status !== "added" || added.partnerId === null) return;

    expect(await authorOf(added.partnerId)).toEqual({
      createdBySource: "member",
      createdBy: FIXTURE_AUTHOR,
    });
  });

  /** The add-child flow, which repeats the insert for the same reason. */
  it("records the member who added a child inline", async () => {
    const person = await createIndividual(
      { givenName: name("Walter") },
      FIXTURE_MEMBER,
    );
    if (person.status !== "created") throw new Error("fixture person failed");

    const union = await addSpouse(
      {
        personId: person.id,
        partnerMode: "unknown",
        partnerId: "",
        partner: {},
        union: {},
      },
      FIXTURE_MEMBER,
    );
    if (union.status !== "added") throw new Error("fixture union failed");

    const added = await addChild(
      {
        childMode: "new",
        // Read only in `existing` mode; named because the type requires it.
        childId: null,
        child: { givenName: name("Edward") },
        link: { unionId: union.unionId, relation: "biological" },
      },
      FIXTURE_MEMBER,
    );

    expect(added.status).toBe("added");
    if (added.status !== "added") return;

    expect(await authorOf(added.childId)).toEqual({
      createdBySource: "member",
      createdBy: FIXTURE_AUTHOR,
    });
  });
});
