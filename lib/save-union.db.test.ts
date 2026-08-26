import { eq, like, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { createIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";
import type { AddSpouseInput } from "@/lib/union-input";
import { FIXTURE_MEMBER } from "@/test/people-fixtures";

/**
 * Database tests for the add-spouse write path (E3-T4, `YEO-32`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * The *rules* are pure and are tested without a database in
 * `lib/union-input.test.ts`. What is left here is only what is a property of
 * Postgres rather than of TypeScript:
 *
 * - `sequence` is chosen by looking at the rows that already exist, which is
 *   the whole of "a second union without touching the first";
 * - creating a partner inline is one transaction, so a refused union leaves no
 *   stranger behind;
 * - a partner deleted between the picker loading and the form submitting is a
 *   status rather than a foreign-key violation.
 *
 * Mocking Drizzle would leave every one of those unproven.
 *
 * Isolated by given name rather than by fixed ids, exactly as
 * `lib/save-individual.db.test.ts` is: `addSpouse` inserts the rows and
 * Postgres chooses their ids. `unions` cascades from `individuals`, so
 * deleting the people takes the unions with them.
 */

const PREFIX = "save-union-fixture";

function name(suffix: string): string {
  return `${PREFIX} ${suffix}`;
}

async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
}

/** Create a fixture person, failing loudly rather than returning a union. */
async function makePerson(suffix: string): Promise<string> {
  const result = await createIndividual(
    { givenName: name(suffix) },
    FIXTURE_MEMBER,
  );
  if (result.status !== "created") {
    throw new Error(`Expected created, got ${result.status}.`);
  }
  return result.id;
}

/** Every union either of these people belongs to, oldest sequence first. */
async function unionsFor(...ids: string[]) {
  const rows = await db
    .select()
    .from(schema.unions)
    .where(
      or(
        ...ids.flatMap((id) => [
          eq(schema.unions.partnerAId, id),
          eq(schema.unions.partnerBId, id),
        ]),
      ),
    );
  return rows.sort((a, b) => a.sequence - b.sequence);
}

async function countFixturePeople(): Promise<number> {
  const rows = await db
    .select({ id: schema.individuals.id })
    .from(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
  return rows.length;
}

function submission(overrides: Partial<AddSpouseInput>): AddSpouseInput {
  return {
    personId: "",
    partnerMode: "existing",
    partnerId: "",
    partner: {},
    union: {},
    ...overrides,
  };
}

/** Add a spouse, failing loudly rather than returning a union of statuses. */
async function add(input: AddSpouseInput) {
  const result = await addSpouse(input, FIXTURE_MEMBER);
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
  return result;
}

beforeEach(removeFixture);
afterAll(removeFixture);

describe("addSpouse", () => {
  it("writes a union between two people who are already on the tree", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");

    const { unionId, partnerId } = await add(
      submission({
        personId: rose,
        partnerId: thomas,
        union: {
          type: "marriage",
          startDate: "1912-06-04",
          startDateQualifier: "about",
          startDatePrecision: "day",
          endDate: "1938-02-19",
          endReason: "death",
          notes: "at St Anne's",
        },
      }),
    );

    expect(partnerId).toBe(thomas);

    const [union] = await db
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, unionId));

    // Round-tripped through the real columns and their enums.
    expect(union).toMatchObject({
      partnerAId: rose,
      partnerBId: thomas,
      type: "marriage",
      startDate: "1912-06-04",
      startDateQualifier: "about",
      startDatePrecision: "day",
      endDate: "1938-02-19",
      endDateQualifier: "exact",
      endDatePrecision: "day",
      endReason: "death",
      sequence: 0,
      notes: "at St Anne's",
    });
  });

  it("records a union whose partner is not known, inventing nobody", async () => {
    const rose = await makePerson("Rose");

    const { partnerId } = await add(
      submission({ personId: rose, partnerMode: "unknown" }),
    );

    expect(partnerId).toBe(null);
    expect((await unionsFor(rose))[0].partnerBId).toBe(null);
    // No placeholder person was created to stand in for the partner.
    expect(await countFixturePeople()).toBe(1);
  });
});

describe("creating the partner inline", () => {
  it("writes the person and the union together", async () => {
    const rose = await makePerson("Rose");

    const { partnerId } = await add(
      submission({
        personId: rose,
        partnerMode: "new",
        partner: {
          givenName: name("Walter"),
          surname: "Byrne",
          sex: "male",
          birthDate: "1905-07-11",
        },
      }),
    );

    if (partnerId === null) throw new Error("expected a partner to be created");

    const [walter] = await db
      .select()
      .from(schema.individuals)
      .where(eq(schema.individuals.id, partnerId));

    expect(walter).toMatchObject({
      givenName: name("Walter"),
      surname: "Byrne",
      sex: "male",
      birthDate: "1905-07-11",
    });
    expect((await unionsFor(rose))[0].partnerBId).toBe(partnerId);
  });

  /**
   * The reason both writes share a transaction. Half of this operation is
   * worse than none: a person written without their union is a stranger on the
   * canvas with nothing to say who they are.
   */
  it("writes no person at all when the union is refused", async () => {
    const rose = await makePerson("Rose");

    const result = await addSpouse(
      submission({
        personId: rose,
        partnerMode: "new",
        partner: { givenName: name("Walter") },
        // Ongoing contradicts an end date, so validation refuses the union.
        union: { endDate: "1938-02-19", endReason: "ongoing" },
      }),
      FIXTURE_MEMBER,
    );

    expect(result.status).toBe("invalid");
    expect(await countFixturePeople()).toBe(1);
    expect(await unionsFor(rose)).toEqual([]);
  });
});

describe("a second union", () => {
  /**
   * The ticket's headline requirement, and the reason `unions` are their own
   * nodes: two people in the seed fixture each appear in two unions, which is
   * the case `d3-tree` cannot draw.
   */
  it("is placed after the first without rewriting it", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");

    const first = await add(
      submission({
        personId: rose,
        partnerId: thomas,
        union: { type: "marriage", endReason: "death" },
      }),
    );
    const second = await add(
      submission({
        personId: rose,
        partnerId: walter,
        union: { type: "marriage" },
      }),
    );

    const unions = await unionsFor(rose);
    expect(unions.map((union) => union.id)).toEqual([
      first.unionId,
      second.unionId,
    ]);
    expect(unions.map((union) => union.sequence)).toEqual([0, 1]);

    // The first union is untouched: same row, same partners, same end reason.
    expect(unions[0]).toMatchObject({
      partnerAId: rose,
      partnerBId: thomas,
      endReason: "death",
    });
  });

  /**
   * The sequence has to make sense from either side of the union. If the
   * *partner* has been married before, this one is their second as well.
   */
  it("counts the unions the partner already had, not only the person's", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const mary = await makePerson("Mary");

    // Thomas married Mary first; Rose is marrying Thomas second.
    await add(submission({ personId: thomas, partnerId: mary }));
    const second = await add(submission({ personId: rose, partnerId: thomas }));

    const [union] = await db
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, second.unionId));
    expect(union.sequence).toBe(1);
  });

  it("honours an order the caller states outright", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");

    const { unionId } = await add(
      submission({ personId: rose, partnerId: thomas, union: { sequence: 7 } }),
    );

    const [union] = await db
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, unionId));
    expect(union.sequence).toBe(7);
  });
});

describe("when somebody has gone", () => {
  it("reports a person who is no longer on the tree", async () => {
    const thomas = await makePerson("Thomas");
    const rose = await makePerson("Rose");
    await db.delete(schema.individuals).where(eq(schema.individuals.id, rose));

    expect(
      await addSpouse(
        submission({ personId: rose, partnerId: thomas }),
        FIXTURE_MEMBER,
      ),
    ).toEqual({ status: "person-not-found" });
  });

  it("reports an id that is not shaped like a person at all", async () => {
    const thomas = await makePerson("Thomas");

    expect(
      await addSpouse(
        submission({ personId: "nobody", partnerId: thomas }),
        FIXTURE_MEMBER,
      ),
    ).toEqual({ status: "person-not-found" });
  });

  /**
   * The picker is built from a graph the browser loaded some time ago, so a
   * partner deleted since then is an ordinary race. Left to the foreign key it
   * would be a thrown constraint violation and an error boundary; checked, it
   * is a sentence the form renders beside the picker.
   */
  it("reports a partner deleted since the picker was drawn", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    await db
      .delete(schema.individuals)
      .where(eq(schema.individuals.id, thomas));

    expect(
      await addSpouse(
        submission({ personId: rose, partnerId: thomas }),
        FIXTURE_MEMBER,
      ),
    ).toEqual({ status: "partner-not-found" });

    expect(await unionsFor(rose)).toEqual([]);
  });

  it("writes nothing when the input is refused", async () => {
    const rose = await makePerson("Rose");

    const result = await addSpouse(
      submission({ personId: rose, partnerId: rose }),
      FIXTURE_MEMBER,
    );

    expect(result.status).toBe("invalid");
    expect(await unionsFor(rose)).toEqual([]);
  });
});

describe("date ranges (YEO-88)", () => {
  /**
   * The database half of the highest-consequence risk in the ticket: a range
   * is two columns per bound, and the individual side of the write path
   * already has `EditPersonForm.test.tsx`'s round trip guarding it. This is
   * the union side of the same guarantee, proved against real Postgres
   * rather than mocked — `lib/union-input.test.ts` already proves the
   * validator's rules in isolation; what only a real database can show is
   * that both new columns actually round-trip through their real enums.
   */
  it("stores a start-date range, both bounds and both precisions intact", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");

    const { unionId } = await add(
      submission({
        personId: rose,
        partnerId: thomas,
        union: {
          startDate: "1912-01-01",
          startDatePrecision: "year",
          startDateUpper: "1913-06-01",
          startDateUpperPrecision: "month",
        },
      }),
    );

    const [union] = await db
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, unionId));

    // Mixed precision (year lower, month upper) is what proves the second
    // precision column genuinely carries its own value rather than mirroring
    // the first.
    expect(union).toMatchObject({
      startDate: "1912-01-01",
      startDateQualifier: "exact",
      startDatePrecision: "year",
      startDateUpper: "1913-06-01",
      startDateUpperPrecision: "month",
    });
  });

  it("stores an end-date range, both bounds and both precisions intact", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");

    const { unionId } = await add(
      submission({
        personId: rose,
        partnerId: thomas,
        union: {
          endDate: "1938-03-01",
          endDatePrecision: "month",
          endDateUpper: "1939-01-01",
          endDateUpperPrecision: "year",
          endReason: "divorce",
        },
      }),
    );

    const [union] = await db
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, unionId));

    // `endDateUpper` is the upper bound of the *end date*, and has nothing to
    // do with `endReason` — the name collision ("end" appears in both) is
    // the one a future reader will trip on, so this pins them as independent:
    // the range round-trips exactly as given, and the reason is still the
    // reason the caller chose, not something the range write overwrote.
    expect(union).toMatchObject({
      endDate: "1938-03-01",
      endDateQualifier: "exact",
      endDatePrecision: "month",
      endDateUpper: "1939-01-01",
      endDateUpperPrecision: "year",
      endReason: "divorce",
    });
  });

  it("takes the column defaults for a union with no range at all", async () => {
    // The "migration changes the meaning of nothing" claim, asserted for
    // unions the way `lib/save-individual.db.test.ts` already asserts it for
    // people: a row written without touching the new columns reads back
    // `upper === null` and `upperPrecision === "day"`.
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");

    const { unionId } = await add(
      submission({
        personId: rose,
        partnerId: thomas,
        union: { startDate: "1912-06-04" },
      }),
    );

    const [union] = await db
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, unionId));

    expect(union).toMatchObject({
      startDateUpper: null,
      startDateUpperPrecision: "day",
      endDateUpper: null,
      endDateUpperPrecision: "day",
    });
  });
});
