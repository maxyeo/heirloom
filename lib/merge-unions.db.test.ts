import { eq, like, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getFamilyGraph } from "@/lib/family-graph";
import { mergeUnions } from "@/lib/merge-unions";
import { attachChild } from "@/lib/save-child";
import { createIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";

/**
 * Database tests for merging two families recorded between the same two people
 * (E3-T10, `YEO-82`). Run with `npm run test:db`; the `.db.test.ts` suffix is
 * what keeps them out of `npm test` and CI's bare environment. See
 * docs/testing.md.
 *
 * What merging *means* is pure and is asserted with no database in
 * `lib/union-merge.test.ts` — which children move, what stops being recorded,
 * where the surviving row sits in the order. What is left here is only what is
 * a property of Postgres rather than of TypeScript, and it is exactly the
 * ticket's acceptance criteria:
 *
 * - **no child link is lost.** The merge ends in a `delete` against a table
 *   that cascades to `union_children`, so this is the one assertion that
 *   cannot be made anywhere but against a real database.
 * - **`sequence` stays coherent for both partners.** One column serves two
 *   people's orders; whether a merge leaves either of them holding a tie is a
 *   question about the rows as written.
 * - **two people genuinely married twice stay expressible.** Nothing here may
 *   merge on its own, and two unions that each leave a partner unrecorded must
 *   not be mergeable at all.
 *
 * Isolated by given name rather than by fixed ids, exactly as
 * `lib/reorder-unions.db.test.ts` is: the ids are Postgres's. `unions`
 * cascades from `individuals`, so deleting the fixture people takes every
 * union and child link with them.
 */

const PREFIX = "merge-unions-fixture";

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

/** Record a union between two fixture people, with whatever it recorded. */
async function marry(
  personId: string,
  partnerId: string,
  union: Record<string, unknown> = {},
): Promise<string> {
  const result = await addSpouse({
    personId,
    partnerMode: "existing",
    partnerId,
    partner: {},
    union,
  });
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
  return result.unionId;
}

/** Record a union with one partner named and the other left unknown. */
async function loneUnion(personId: string): Promise<string> {
  const result = await addSpouse({
    personId,
    partnerMode: "unknown",
    partnerId: null,
    partner: {},
    union: {},
  });
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
  return result.unionId;
}

/** Attach an existing person to a union as its child. */
async function addChildTo(
  unionId: string,
  childId: string,
  relation: "biological" | "adopted" | "step" | "foster" = "biological",
): Promise<void> {
  const result = await db.transaction((tx) =>
    attachChild(tx, {
      childMode: "existing",
      childId,
      child: {},
      link: { unionId, relation },
    }),
  );
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
}

/** Every child link on one union, as the rows actually stand. */
async function childrenOf(unionId: string) {
  return db
    .select({
      childId: schema.unionChildren.childId,
      relation: schema.unionChildren.relation,
    })
    .from(schema.unionChildren)
    .where(eq(schema.unionChildren.unionId, unionId));
}

/** Every union one person is a partner in, with its sequence. */
async function unionsFor(personId: string) {
  return db
    .select({ id: schema.unions.id, sequence: schema.unions.sequence })
    .from(schema.unions)
    .where(
      or(
        eq(schema.unions.partnerAId, personId),
        eq(schema.unions.partnerBId, personId),
      ),
    )
    .orderBy(schema.unions.sequence);
}

async function unionRow(unionId: string) {
  const [row] = await db
    .select()
    .from(schema.unions)
    .where(eq(schema.unions.id, unionId));
  return row;
}

/** Whether one person's unions hold a strictly increasing run of sequences. */
async function hasCoherentOrder(personId: string): Promise<boolean> {
  const sequences = (await unionsFor(personId)).map((u) => u.sequence);
  return sequences.every(
    (value, index) => index === 0 || value > sequences[index - 1],
  );
}

const NOBODY = "00000000-0000-4000-8000-00000000dead";

beforeEach(removeFixture);
afterAll(removeFixture);

describe("mergeUnions", () => {
  it("moves the other record's children across and deletes only the row", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const dora = await makePerson("Dora");
    const edith = await makePerson("Edith");

    const marriage = await marry(rose, walter, { startDate: "1946-09-30" });
    const duplicate = await marry(rose, walter, { type: "unknown" });
    await addChildTo(marriage, dora);
    await addChildTo(duplicate, edith);

    const result = await mergeUnions(marriage, duplicate);
    expect(result.status).toBe("merged");

    /**
     * The acceptance criterion, asserted where it can actually fail. Deleting
     * the duplicate cascades to `union_children`, so a merge that deleted
     * before it copied would take Edith's only recorded parents with it and
     * nothing in the tree would ever say so.
     */
    const children = await childrenOf(marriage);
    expect(children.map((link) => link.childId).sort()).toEqual(
      [dora, edith].sort(),
    );
    expect(await unionRow(duplicate)).toBeUndefined();

    // Nobody was deleted. The merge is a correction to two rows about them.
    const graph = await getFamilyGraph();
    const ids = graph.people.map((person) => person.id);
    for (const person of [rose, walter, dora, edith]) {
      expect(ids).toContain(person);
    }
  });

  it("keeps the surviving link's relation for a child recorded in both", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const dora = await makePerson("Dora");

    const marriage = await marry(rose, walter);
    const duplicate = await marry(rose, walter, { type: "unknown" });
    await addChildTo(marriage, dora, "biological");
    await addChildTo(duplicate, dora, "adopted");

    expect((await mergeUnions(marriage, duplicate)).status).toBe("merged");

    // One link, not two, and the one the author chose to keep. The dialogue
    // said which relation would stand, so this is the write agreeing with it.
    const children = await childrenOf(marriage);
    expect(children).toEqual([{ childId: dora, relation: "biological" }]);
  });

  it("keeps the surviving record's own type, dates and end reason", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");

    const marriage = await marry(rose, walter, {
      type: "marriage",
      startDate: "1946-09-30",
      endDate: "1970-01-02",
      endReason: "divorce",
    });
    const duplicate = await marry(rose, walter, { type: "unknown" });

    expect((await mergeUnions(marriage, duplicate)).status).toBe("merged");

    const row = await unionRow(marriage);
    expect(row.type).toBe("marriage");
    expect(row.startDate).toBe("1946-09-30");
    expect(row.endDate).toBe("1970-01-02");
    expect(row.endReason).toBe("divorce");
  });

  it("keeps both records' notes, because nothing anybody typed is dropped", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");

    const marriage = await marry(rose, walter, { notes: "Parish register." });
    const duplicate = await marry(rose, walter, { notes: "Second entry." });

    expect((await mergeUnions(marriage, duplicate)).status).toBe("merged");

    expect((await unionRow(marriage)).notes).toBe(
      "Parish register.\n\nSecond entry.",
    );
  });

  it("gives the surviving record the earlier place in both partners' orders", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const thomas = await makePerson("Thomas");

    // Rose married Thomas first, then Walter. The duplicate of the Walter
    // marriage is written last, so `nextSequence` puts it past everything.
    await marry(rose, thomas);
    const marriage = await marry(rose, walter);
    const duplicate = await marry(rose, walter, { type: "unknown" });

    const earlier = Math.min(
      (await unionRow(marriage)).sequence,
      (await unionRow(duplicate)).sequence,
    );

    /**
     * Merged the awkward way round: the *duplicate* survives. Without the
     * earlier-of-the-two rule it would keep its own place at the end, and the
     * 1946 marriage would sort below a marriage that came before it.
     */
    expect((await mergeUnions(duplicate, marriage)).status).toBe("merged");

    expect((await unionRow(duplicate)).sequence).toBe(earlier);
    expect(await hasCoherentOrder(rose)).toBe(true);
    expect(await hasCoherentOrder(walter)).toBe(true);
  });

  it("leaves both partners with an unambiguous order when the merge makes a tie", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const thomas = await makePerson("Thomas");
    const nora = await makePerson("Nora");

    /**
     * The case one pass per partner cannot settle. Rose has a marriage to
     * Thomas and two records of Walter; Walter has those two and a marriage to
     * Nora. Every sequence is written by hand so that taking the earlier of the
     * two lands the survivor exactly on top of somebody else's number.
     */
    await marry(rose, thomas, { sequence: 0 });
    const marriage = await marry(rose, walter, { sequence: 1 });
    const duplicate = await marry(rose, walter, { sequence: 3 });
    await marry(walter, nora, { sequence: 1 });

    expect((await mergeUnions(duplicate, marriage)).status).toBe("merged");

    // Coherent for *both*, which is the acceptance criterion's own emphasis.
    expect(await hasCoherentOrder(rose)).toBe(true);
    expect(await hasCoherentOrder(walter)).toBe(true);
  });

  it("refuses two records that do not name the same two people", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const thomas = await makePerson("Thomas");

    const toWalter = await marry(rose, walter);
    const toThomas = await marry(rose, thomas);

    /**
     * The guard that keeps this from being a way to move somebody's children
     * under a couple they were never recorded with. Nothing is written.
     */
    expect((await mergeUnions(toWalter, toThomas)).status).toBe(
      "not-a-duplicate",
    );
    expect(await unionRow(toThomas)).toBeDefined();
  });

  it("refuses two records that each leave a partner unrecorded", async () => {
    const rose = await makePerson("Rose");

    const first = await loneUnion(rose);
    const second = await loneUnion(rose);

    /**
     * The trap this ticket names. Both partner columns are nullable so that an
     * unknown father needs no placeholder person — so two such rows may be
     * Rose's children by two men nobody can name, and merging them would
     * assert that those men were one man.
     */
    expect((await mergeUnions(first, second)).status).toBe("not-a-duplicate");
    expect(await unionRow(second)).toBeDefined();
  });

  it("refuses to merge a record into itself", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const marriage = await marry(rose, walter);

    expect((await mergeUnions(marriage, marriage)).status).toBe(
      "not-a-duplicate",
    );
    expect(await unionRow(marriage)).toBeDefined();
  });

  it("reports a record that is no longer there rather than throwing", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const marriage = await marry(rose, walter);

    expect((await mergeUnions(marriage, NOBODY)).status).toBe("not-found");
    expect((await mergeUnions("not-a-row-id", marriage)).status).toBe(
      "not-found",
    );
  });

  it("leaves a second marriage between the same two people alone until it is asked", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");

    const first = await marry(rose, walter, { endReason: "divorce" });
    const second = await marry(rose, walter);

    /**
     * The criterion the whole ticket turns on: a couple who divorced and
     * remarried each other must stay expressible. Nothing merges on its own —
     * both rows are still there after a merge of an *unrelated* pair, and the
     * only thing that ever removes one is an author pressing the button.
     */
    expect(await unionRow(first)).toBeDefined();
    expect(await unionRow(second)).toBeDefined();
    expect((await unionsFor(rose)).length).toBe(2);
  });
});
