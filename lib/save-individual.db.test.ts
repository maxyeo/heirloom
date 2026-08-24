import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { createIndividual, updateIndividual } from "@/lib/save-individual";

/**
 * Database tests for the person write path (E3-T1, `YEO-29`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * The *rules* are pure and are tested without a database in
 * `lib/individual-input.test.ts`. What is left here is only what is a property
 * of Postgres rather than of TypeScript: that the cleaned record round-trips
 * through the real columns and their enums, that the no-op check compares
 * against what is actually stored, and that a refusal writes nothing at all.
 * Mocking Drizzle would leave every one of those unproven.
 *
 * These tests cannot use fixed ids the way `lib/save-page.db.test.ts` does —
 * `createIndividual` inserts the row and Postgres chooses its id. They are
 * isolated by given name instead: every fixture name below starts with one
 * recognisable prefix, and teardown deletes exactly that prefix.
 */

const PREFIX = "save-individual-fixture";

/** A given name guaranteed to sit under the fixture prefix. */
function name(suffix: string): string {
  return `${PREFIX} ${suffix}`;
}

async function removeFixture() {
  // `unions` and `union_children` both cascade from `individuals`, so deleting
  // the people is enough even once E3-T4 and E3-T5 start linking them.
  await db
    .delete(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
}

async function readPerson(id: string) {
  const [person] = await db
    .select()
    .from(schema.individuals)
    .where(eq(schema.individuals.id, id));
  return person;
}

async function countFixtureRows(): Promise<number> {
  const rows = await db
    .select({ id: schema.individuals.id })
    .from(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
  return rows.length;
}

/** Create a fixture person, failing loudly rather than returning a union. */
async function create(
  input: Parameters<typeof createIndividual>[0],
): Promise<string> {
  const result = await createIndividual(input);
  if (result.status !== "created") {
    throw new Error(`Expected created, got ${result.status}.`);
  }
  return result.id;
}

beforeEach(removeFixture);
afterAll(removeFixture);

describe("createIndividual", () => {
  it("writes every field through to the real columns", async () => {
    const id = await create({
      givenName: name("ada"),
      surname: "Lovelace",
      sex: "female",
      birthDate: "1815-12-10",
      birthDateQualifier: "about",
      birthDatePrecision: "day",
      birthPlace: "London",
      deathDate: "1852-11-27",
      deathDateQualifier: "before",
      deathDatePrecision: "day",
      deathPlace: "Marylebone",
      notes: "Countess of Lovelace.",
    });

    const person = await readPerson(id);

    expect(person).toMatchObject({
      givenName: name("ada"),
      surname: "Lovelace",
      sex: "female",
      birthDate: "1815-12-10",
      birthDateQualifier: "about",
      birthDatePrecision: "day",
      birthPlace: "London",
      deathDate: "1852-11-27",
      deathDateQualifier: "before",
      deathDatePrecision: "day",
      deathPlace: "Marylebone",
      notes: "Countess of Lovelace.",
    });
  });

  it("stores a date column as the same ISO string it was given", async () => {
    // The one thing a pure test cannot show: postgres.js returns a `date`
    // column as a string rather than a `Date`, so no timezone can shift the
    // day between writing 1815-12-10 and reading it back.
    const id = await create({
      givenName: name("iso"),
      birthDate: "1815-12-10",
    });

    expect(await readPerson(id)).toMatchObject({ birthDate: "1815-12-10" });
  });

  it("leaves the wiki link alone, since that is E2's to set", async () => {
    const id = await create({ givenName: name("unlinked") });

    expect(await readPerson(id)).toMatchObject({ pageId: null });
  });

  it("takes the column defaults for everything not given", async () => {
    const id = await create({ givenName: name("minimal") });

    expect(await readPerson(id)).toMatchObject({
      surname: null,
      sex: "unknown",
      birthDate: null,
      birthDateQualifier: "exact",
      birthDatePrecision: "day",
      birthPlace: null,
      deathDate: null,
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
      deathPlace: null,
      notes: null,
    });
  });

  it("writes nothing at all when the input is refused", async () => {
    const result = await createIndividual({
      givenName: "",
      notes: name("refused"),
    });

    expect(result.status).toBe("invalid");
    expect(await countFixtureRows()).toBe(0);
  });

  it("allows two people with the same name", async () => {
    // A son named for his father is the most ordinary thing in genealogy, so
    // a name collision is not evidence of a duplicate.
    const first = await create({ givenName: name("john"), surname: "Smith" });
    const second = await create({ givenName: name("john"), surname: "Smith" });

    expect(first).not.toBe(second);
    expect(await countFixtureRows()).toBe(2);
  });
});

describe("updateIndividual", () => {
  it("changes the row it names", async () => {
    const id = await create({ givenName: name("before"), surname: "Old" });

    const result = await updateIndividual(id, {
      givenName: name("after"),
      surname: "New",
      birthDate: "1900-01-01",
      birthDateQualifier: "about",
      birthDatePrecision: "day",
    });

    expect(result).toEqual({ status: "updated", id });
    expect(await readPerson(id)).toMatchObject({
      givenName: name("after"),
      surname: "New",
      birthDate: "1900-01-01",
      birthDateQualifier: "about",
      birthDatePrecision: "day",
    });
  });

  it("clears a field that is submitted blank", async () => {
    // The write is a whole record, not a patch: an author who empties the
    // birthplace input means to remove it, and `null` is how that is stored.
    const id = await create({
      givenName: name("clearing"),
      birthPlace: "London",
    });

    await updateIndividual(id, { givenName: name("clearing"), birthPlace: "" });

    expect(await readPerson(id)).toMatchObject({ birthPlace: null });
  });

  it("reports a resubmission of the same values as unchanged", async () => {
    const id = await create({
      givenName: name("noop"),
      surname: "Same",
      birthDate: "1900-01-01",
    });

    // Deliberately re-sent with untrimmed whitespace and a blank optional
    // field: `unchanged` has to mean "the row would not move" rather than
    // "the author retyped it identically".
    const result = await updateIndividual(id, {
      givenName: `  ${name("noop")}  `,
      surname: "Same",
      birthDate: "1900-01-01",
      deathPlace: "",
    });

    expect(result).toEqual({ status: "unchanged", id });
  });

  it("notices a change in any single field", async () => {
    const id = await create({ givenName: name("onefield"), notes: "First." });

    const result = await updateIndividual(id, {
      givenName: name("onefield"),
      notes: "Second.",
    });

    expect(result).toEqual({ status: "updated", id });
    expect(await readPerson(id)).toMatchObject({ notes: "Second." });
  });

  it("reports an id that names no row as not-found", async () => {
    const result = await updateIndividual(
      "00000000-0000-4000-8000-0000000e0029",
      { givenName: name("ghost") },
    );

    expect(result).toEqual({ status: "not-found" });
  });

  it("reports an id that is not a uuid as not-found rather than throwing", async () => {
    // Without the shape check in `isRowId` this reaches Postgres, which raises
    // `invalid input syntax for type uuid` — a thrown error rather than a
    // query that returns no rows. This is the assertion behind that guard.
    const result = await updateIndividual("not-a-uuid", {
      givenName: name("ghost"),
    });

    expect(result).toEqual({ status: "not-found" });
  });

  it("writes nothing when the input is refused", async () => {
    const id = await create({ givenName: name("keep"), surname: "Original" });

    const result = await updateIndividual(id, {
      givenName: "",
      surname: "Overwritten",
    });

    expect(result.status).toBe("invalid");
    expect(await readPerson(id)).toMatchObject({
      givenName: name("keep"),
      surname: "Original",
    });
  });

  it("refuses an invalid id before it looks the row up", async () => {
    // Validation must not be reachable past a bad reference, and a bad
    // reference must not depend on the fields being good.
    const result = await updateIndividual("not-a-uuid", { givenName: "" });

    expect(result).toEqual({ status: "not-found" });
  });
});
