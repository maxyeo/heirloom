import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getFamilyGraph } from "@/lib/family-graph";

/**
 * The reference database test — the `.db.test.ts` suffix is what keeps it out
 * of `npm test` and out of CI's bare environment. Run it with
 * `npm run test:db`. See docs/testing.md for the pattern.
 *
 * What is worth testing here is the part that only a real Postgres can answer:
 * the ORDER BY. `getFamilyGraph` sorts unions by `sequence` first and
 * `start_date` second, because families reliably remember that she remarried
 * after he died long after the actual year is lost — sorting on dates alone
 * silently scrambles the story whenever one is missing. That ordering lives in
 * SQL, so no amount of mocking would prove it.
 */

// Fixture rows are inserted with explicit ids so that teardown can delete
// exactly what this file created, and assertions can ignore whatever else the
// database already holds.
const ROSE = "00000000-0000-4000-8000-00000000f001";
const WALTER = "00000000-0000-4000-8000-00000000f002";
const UNIONS = {
  thirdBySequence: "00000000-0000-4000-8000-00000000f103",
  firstBySequence: "00000000-0000-4000-8000-00000000f101",
  secondNoDate: "00000000-0000-4000-8000-00000000f102",
  secondEarlierDate: "00000000-0000-4000-8000-00000000f104",
  qualified: "00000000-0000-4000-8000-00000000f105",
} as const;

/**
 * Deleting the individual is enough: both `unions.partner_a_id` and
 * `partner_b_id` are ON DELETE CASCADE, so her unions go with her.
 */
async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, [ROSE, WALTER]));
}

beforeAll(async () => {
  // Also cleaning up *before* inserting, not just after. Interrupting a run
  // skips `afterAll`, which would otherwise leave these fixed ids behind and
  // fail the next run on a duplicate key — a confusing way to greet whoever
  // runs this next.
  await removeFixture();

  await db.insert(schema.individuals).values([
    {
      id: ROSE,
      givenName: "Rose",
      surname: "Fixture",
    },
    // Inserted with no qualifier at all, which is what an existing row looks
    // like the moment after the migration runs.
    {
      id: WALTER,
      givenName: "Walter",
      surname: "Fixture",
      birthDate: "1905-09-08",
      deathDate: "1978-04-25",
    },
  ]);

  // Inserted deliberately out of order, so a query that lost its ORDER BY
  // would come back in a different order than the assertion expects rather
  // than accidentally passing on insertion order.
  await db.insert(schema.unions).values([
    { id: UNIONS.thirdBySequence, partnerAId: ROSE, sequence: 3 },
    { id: UNIONS.secondNoDate, partnerAId: ROSE, sequence: 2 },
    { id: UNIONS.firstBySequence, partnerAId: ROSE, sequence: 1 },
    {
      id: UNIONS.secondEarlierDate,
      partnerAId: ROSE,
      sequence: 2,
      startDate: "1946-04-01",
    },
    {
      id: UNIONS.qualified,
      partnerAId: ROSE,
      partnerBId: WALTER,
      sequence: 4,
      startDate: "1948-07-03",
      startDateQualifier: "about",
      startDatePrecision: "day",
    },
  ]);
});

afterAll(async () => {
  await removeFixture();
});

describe("getFamilyGraph", () => {
  it("orders unions by sequence first and start date second", async () => {
    const graph = await getFamilyGraph();
    const ids = new Set<string>(Object.values(UNIONS));
    const ours = graph.unions.filter((union) => ids.has(union.id));

    expect(ours.map((union) => union.id)).toEqual([
      UNIONS.firstBySequence,
      // Same sequence, so the recorded date breaks the tie — and a NULL date
      // must not sort ahead of a known one.
      UNIONS.secondEarlierDate,
      UNIONS.secondNoDate,
      UNIONS.thirdBySequence,
      UNIONS.qualified,
    ]);
  });

  /**
   * The qualifier columns are `not null default 'exact'`, so a row written
   * without one — every row that predates the migration — has to come back
   * qualified rather than null. That default lives in Postgres, which is why
   * this assertion cannot move to a unit test.
   */
  it("defaults a date qualifier to exact when none was written", async () => {
    const graph = await getFamilyGraph();
    const walter = graph.people.find((person) => person.id === WALTER);
    const union = graph.unions.find((u) => u.id === UNIONS.secondNoDate);

    expect(walter).toMatchObject({
      birthDateQualifier: "exact",
      birthDatePrecision: "day",
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
    });
    expect(union).toMatchObject({ startDateQualifier: "exact" });
  });

  it("carries a stored qualifier through to the graph", async () => {
    const graph = await getFamilyGraph();
    const union = graph.unions.find((u) => u.id === UNIONS.qualified);

    expect(union).toMatchObject({
      startDate: "1948-07-03",
      startDateQualifier: "about",
      startDatePrecision: "day",
    });
  });

  it("returns the fixture partner among the people it loads", async () => {
    const graph = await getFamilyGraph();
    const rose = graph.people.find((person) => person.id === ROSE);

    expect(rose).toMatchObject({ givenName: "Rose", surname: "Fixture" });
  });
});
