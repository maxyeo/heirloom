import { eq, like, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getFamilyGraph } from "@/lib/family-graph";
import { derivePersonDetail } from "@/lib/person-detail";
import { reorderUnions } from "@/lib/reorder-unions";
import { createIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";
import { formatMove } from "@/lib/union-order";

/**
 * Database tests for the union sequence editor (E3-T7, `YEO-35`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * The arithmetic is pure and is tested without a database in
 * `lib/union-order.test.ts`. What is left here is only what is a property of
 * Postgres rather than of TypeScript, and it is most of what the ticket is
 * actually asking for:
 *
 * - the order the author asked for survives a round trip through
 *   `getFamilyGraph`, whose `ORDER BY sequence, start_date` is the thing the
 *   whole feature exists to reach — and it does so **with every date null**,
 *   which is the case dates alone cannot express;
 * - reordering one person's unions does not write anybody else's rows, which
 *   is the coherence question a single shared `sequence` column raises and the
 *   one no unit test can settle;
 * - a list that has gone out of date is refused rather than written into.
 *
 * Isolated by given name rather than by fixed ids, exactly as
 * `lib/save-union.db.test.ts` is: `addSpouse` inserts the unions and Postgres
 * chooses their ids. `unions` cascades from `individuals`, so deleting the
 * fixture people takes every union with them.
 */

const PREFIX = "reorder-unions-fixture";

function name(suffix: string): string {
  return `${PREFIX} ${suffix}`;
}

async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
}

async function makePerson(suffix: string): Promise<string> {
  const result = await createIndividual({ givenName: name(suffix) });
  if (result.status !== "created") {
    throw new Error(`Expected created, got ${result.status}.`);
  }
  return result.id;
}

/**
 * Marry two fixture people, recording no dates at all.
 *
 * Which is the whole point: "works when every date involved is null" is an
 * acceptance criterion, so the fixtures are built the way the records this
 * feature exists for actually arrive — a marriage everyone remembers and
 * nobody wrote down.
 */
async function marry(
  personId: string,
  partnerId: string,
  sequence?: number,
): Promise<string> {
  const result = await addSpouse({
    personId,
    partnerMode: "existing",
    partnerId,
    partner: {},
    union: sequence === undefined ? {} : { sequence },
  });
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
  return result.unionId;
}

/** Every union one person is a partner in, as the row actually stands. */
async function unionsFor(personId: string) {
  return db
    .select({ id: schema.unions.id, sequence: schema.unions.sequence })
    .from(schema.unions)
    .where(
      or(
        eq(schema.unions.partnerAId, personId),
        eq(schema.unions.partnerBId, personId),
      ),
    );
}

async function sequenceOf(unionId: string): Promise<number> {
  const [row] = await db
    .select({ sequence: schema.unions.sequence })
    .from(schema.unions)
    .where(eq(schema.unions.id, unionId));
  return row.sequence;
}

/**
 * A person's unions in the order the tree draws them, read the long way round:
 * through `getFamilyGraph`'s `ORDER BY` and then through the same
 * `derivePersonDetail` the panel renders.
 *
 * Deliberately not a query of its own. The acceptance criterion is that the
 * ordering is visible *in the tree*, and the only honest way to assert that is
 * to ask the two functions the tree actually uses.
 */
async function orderInTree(personId: string): Promise<string[]> {
  const graph = await getFamilyGraph();
  const detail = derivePersonDetail(graph, personId);
  if (detail === null) throw new Error("The person is not in the graph.");
  return detail.spouses.map((spouse) => spouse.unionId);
}

/** Every date on every union of a person, for the "all null" precondition. */
async function datesFor(personId: string): Promise<(string | null)[]> {
  const rows = await db
    .select({
      startDate: schema.unions.startDate,
      endDate: schema.unions.endDate,
    })
    .from(schema.unions)
    .where(
      or(
        eq(schema.unions.partnerAId, personId),
        eq(schema.unions.partnerBId, personId),
      ),
    );
  return rows.flatMap((row) => [row.startDate, row.endDate]);
}

const NOBODY = "00000000-0000-4000-8000-00000000dead";

beforeEach(removeFixture);
afterAll(removeFixture);

describe("reorderUnions", () => {
  it("puts a later marriage first, with every date null", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");

    const first = await marry(rose, thomas);
    const second = await marry(rose, walter);

    // The precondition this whole feature exists for: nothing about either
    // union says which came first except `sequence`.
    expect(await datesFor(rose)).toEqual([null, null, null, null]);
    expect(await orderInTree(rose)).toEqual([first, second]);

    const result = await reorderUnions({
      personId: rose,
      order: [first, second],
      move: formatMove("up", second),
    });

    expect(result).toEqual({ status: "reordered", unionIds: [second, first] });
    expect(await orderInTree(rose)).toEqual([second, first]);
  });

  it("writes a strictly increasing sequence, so nothing is left to the tie-break", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");

    // The state a tree that predates any reorder is in: `sequence` is
    // `not null default 0`, and here both unions are explicitly at it.
    const first = await marry(rose, thomas, 0);
    const second = await marry(rose, walter, 0);

    await reorderUnions({
      personId: rose,
      order: [first, second],
      move: formatMove("down", first),
    });

    expect(await sequenceOf(second)).toBe(0);
    expect(await sequenceOf(first)).toBe(1);
  });

  it("does not touch a union the person is not in", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");
    const ada = await makePerson("Ada");

    const roseThomas = await marry(rose, thomas);
    const roseWalter = await marry(rose, walter);
    // `nextSequence` numbers this one past the highest *either* partner holds,
    // so Walter's second union lands above his first rather than colliding
    // with it. That is exactly the arrangement a renumber-from-zero would
    // destroy.
    const walterAda = await marry(walter, ada);

    const before = await sequenceOf(walterAda);
    expect(before).toBeGreaterThan(await sequenceOf(roseWalter));

    await reorderUnions({
      personId: rose,
      order: [roseThomas, roseWalter],
      move: formatMove("up", roseWalter),
    });

    // Rose's order changed…
    expect(await orderInTree(rose)).toEqual([roseWalter, roseThomas]);
    // …and Walter's did not, because the numbers Rose's unions swapped were
    // the ones they already held between them.
    expect(await sequenceOf(walterAda)).toBe(before);
    expect(await orderInTree(walter)).toEqual([roseWalter, walterAda]);
  });

  it("refuses a list that no longer describes the person's unions", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");

    const first = await marry(rose, thomas);
    const second = await marry(rose, walter);
    const before = await unionsFor(rose);

    // The panel was rendered before the second marriage was recorded — the
    // ordinary way to reach this is two tabs on the same person.
    const result = await reorderUnions({
      personId: rose,
      order: [first],
      move: formatMove("down", first),
    });

    expect(result).toEqual({ status: "stale" });
    expect(await unionsFor(rose)).toEqual(before);
    expect(await orderInTree(rose)).toEqual([first, second]);
  });

  it("refuses a list naming a union that belongs to somebody else", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");
    const ada = await makePerson("Ada");

    const roseThomas = await marry(rose, thomas);
    const walterAda = await marry(walter, ada);
    const before = await sequenceOf(walterAda);

    const result = await reorderUnions({
      personId: rose,
      order: [roseThomas, walterAda],
      move: formatMove("up", walterAda),
    });

    expect(result).toEqual({ status: "stale" });
    expect(await sequenceOf(walterAda)).toBe(before);
  });

  it("writes nothing for a move that runs off the end", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");

    const first = await marry(rose, thomas);
    const second = await marry(rose, walter);
    const before = await unionsFor(rose);

    // A second click landing before the first one's revalidation repainted the
    // buttons.
    const result = await reorderUnions({
      personId: rose,
      order: [first, second],
      move: formatMove("up", first),
    });

    expect(result).toEqual({ status: "unchanged" });
    expect(await unionsFor(rose)).toEqual(before);
  });

  it("reports a person who is no longer in the tree", async () => {
    const result = await reorderUnions({
      personId: NOBODY,
      order: [],
      move: formatMove("up", NOBODY),
    });

    expect(result).toEqual({ status: "person-not-found" });
  });

  it("reports a person id that is not shaped like one", async () => {
    // Without the shape check this reaches `eq(individuals.id, value)` and
    // Postgres raises `invalid input syntax for type uuid` — a 500 rather
    // than a state the panel can render.
    const result = await reorderUnions({
      personId: "rose",
      order: [],
      move: formatMove("up", NOBODY),
    });

    expect(result).toEqual({ status: "person-not-found" });
  });

  it("survives three unions being walked into a new order one press at a time", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");
    const silas = await makePerson("Silas");

    const a = await marry(rose, thomas);
    const b = await marry(rose, walter);
    const c = await marry(rose, silas);

    // Each press re-reads the order the way the panel would, which is what the
    // real control does after every revalidation.
    for (const move of [formatMove("up", c), formatMove("up", c)]) {
      const order = await orderInTree(rose);
      const result = await reorderUnions({ personId: rose, order, move });
      expect(result.status).toBe("reordered");
    }

    expect(await orderInTree(rose)).toEqual([c, a, b]);
  });
});
