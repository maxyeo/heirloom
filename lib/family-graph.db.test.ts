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
const UNIONS = {
  thirdBySequence: "00000000-0000-4000-8000-00000000f103",
  firstBySequence: "00000000-0000-4000-8000-00000000f101",
  secondNoDate: "00000000-0000-4000-8000-00000000f102",
  secondEarlierDate: "00000000-0000-4000-8000-00000000f104",
} as const;

/**
 * Deleting the individual is enough: both `unions.partner_a_id` and
 * `partner_b_id` are ON DELETE CASCADE, so her unions go with her.
 */
async function removeFixture() {
  await db.delete(schema.individuals).where(inArray(schema.individuals.id, [ROSE]));
}

beforeAll(async () => {
  // Also cleaning up *before* inserting, not just after. Interrupting a run
  // skips `afterAll`, which would otherwise leave these fixed ids behind and
  // fail the next run on a duplicate key — a confusing way to greet whoever
  // runs this next.
  await removeFixture();

  await db.insert(schema.individuals).values({
    id: ROSE,
    givenName: "Rose",
    surname: "Fixture",
  });

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
    ]);
  });

  it("returns the fixture partner among the people it loads", async () => {
    const graph = await getFamilyGraph();
    const rose = graph.people.find((person) => person.id === ROSE);

    expect(rose).toMatchObject({ givenName: "Rose", surname: "Fixture" });
  });
});
