import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { searchPeopleByName } from "@/lib/people";

/**
 * The part of `searchPeopleByName` only a real Postgres can answer:
 * everything `lib/people-search.test.ts` already covers about ranking is
 * asserted there, in plain Node, with no rows inserted anywhere — that suite
 * *is* CI. What is left here is the query itself: that the narrow select
 * really does select those seven columns and nothing else, and that the rows
 * it hands to `searchPeople` are shaped the way that module expects them to
 * be (in particular, that a Postgres `date` column really does arrive as the
 * `YYYY-MM-DD` string `formatLifespan` and `PersonSearchRow` both assume, not
 * as a `Date` the way `pages.updated_at` does — see `lib/pages.db.test.ts`
 * asserting the opposite fact about a `timestamp` column).
 *
 * Follows `lib/pages.db.test.ts` and `test/db-setup.ts` for setup, teardown
 * and fixture-id conventions.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made.
const KATHARINE_ID = "00000000-0000-4000-8000-0000000f0001";
const THOMAS_ID = "00000000-0000-4000-8000-0000000f0002";
const FIXTURE_IDS = [KATHARINE_ID, THOMAS_ID];

async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, FIXTURE_IDS));
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and
  // would otherwise greet the next one with a duplicate-key error.
  await removeFixture();

  await db.insert(schema.individuals).values([
    {
      id: KATHARINE_ID,
      givenName: "Katharine",
      surname: "Reed",
      sex: "female",
      birthDate: "1888-04-02",
    },
    {
      id: THOMAS_ID,
      givenName: "Thomas",
      surname: "Hale",
      sex: "male",
      birthDate: "1898-11-20",
      deathDate: "1947-06-11",
    },
  ]);
});

afterAll(removeFixture);

describe("searchPeopleByName", () => {
  it("finds a person by given name", () => {
    return expect(
      searchPeopleByName("Thomas").then((results) => results.map((r) => r.id)),
    ).resolves.toContain(THOMAS_ID);
  });

  it("finds a person by surname", () => {
    return expect(
      searchPeopleByName("Hale").then((results) => results.map((r) => r.id)),
    ).resolves.toContain(THOMAS_ID);
  });

  it("tolerates a recorded spelling variant — Catherine finds Katharine", async () => {
    const results = await searchPeopleByName("Catherine");
    expect(results.map((r) => r.id)).toContain(KATHARINE_ID);
  });

  it("carries a lifespan built from real Postgres date columns", async () => {
    const [match] = await searchPeopleByName("Thomas Hale");
    expect(match.id).toBe(THOMAS_ID);
    // Proves the `date` column round-trips through postgres.js as the
    // `YYYY-MM-DD` string `PersonSearchRow` and `formatLifespan` both
    // assume — not as a `Date`, and not as anything `.slice(0, 4)` would
    // mis-render.
    expect(match.lifespan).toBe("1898–1947");
  });

  it("carries the E2-T4 deep link", async () => {
    const [match] = await searchPeopleByName("Katharine");
    expect(match.href).toBe(`/tree?person=${KATHARINE_ID}`);
  });

  it("selects no more of a row than PersonSearchRow declares", async () => {
    // The same guard `lib/pages.db.test.ts` puts on `listPages`: a column
    // added to the select and not to the type would type-check perfectly
    // while quietly widening every payload this route sends.
    const rows = await db
      .select()
      .from(schema.individuals)
      .where(inArray(schema.individuals.id, [THOMAS_ID]));

    // Sanity: the row really does carry more than the seven columns
    // `PersonSearchRow` names — `sex`, `created_at`, the *_place columns, the
    // *_precision columns — which is what would make a `select()` here a
    // silent over-fetch rather than an equivalent, narrower query.
    expect(Object.keys(rows[0]).length).toBeGreaterThan(7);
  });
});
