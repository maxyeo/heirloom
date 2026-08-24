import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getFamilyGraph } from "@/lib/family-graph";
import type { SetParentsInput } from "@/lib/parents-input";
import { derivePersonDetail } from "@/lib/person-detail";
import { addChild } from "@/lib/save-child";
import { createIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";
import { setParents } from "@/lib/set-parents";

/**
 * Database tests for the set-parents write path (E3-T6, `YEO-34`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * The *rules* are pure and are tested without a database: the submission in
 * `lib/parents-input.test.ts`, the cycle walk in `lib/ancestry.test.ts`, and
 * the form's two lists in `lib/parent-options.test.ts`. What is left here is
 * only what is a property of Postgres rather than of TypeScript, and this
 * ticket has more of it than most:
 *
 * - **the union is created inline**, in the same transaction as the link, from
 *   two people who were never recorded as a couple;
 * - **one known parent and one unknown** is a nullable column and *not* a
 *   placeholder person, which is asserted by counting individuals;
 * - **the cycle guard runs against a fresh read inside the transaction**, so
 *   it refuses a link the client had no way to know was impossible;
 * - **a move is one write.** Both halves land or neither does — the assertion
 *   that matters most here, because a half-landed move is a person left with
 *   no parents at all and nothing about the record looks damaged.
 *
 * Isolated by given name rather than by fixed ids, exactly as
 * `lib/save-child.db.test.ts` is: these functions insert the rows and Postgres
 * chooses their ids. `unions` and `union_children` both cascade from
 * `individuals`, so deleting the people takes everything with them.
 */

const PREFIX = "set-parents-fixture";

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
  const result = await createIndividual({ givenName: name(suffix) });
  if (result.status !== "created") {
    throw new Error(`Expected created, got ${result.status}.`);
  }
  return result.id;
}

/** Pair two fixture people, returning the union's id. */
async function makeUnion(
  personId: string,
  partnerId: string | null,
): Promise<string> {
  const result = await addSpouse({
    personId,
    partnerMode: partnerId === null ? "unknown" : "existing",
    partnerId: partnerId ?? "",
    partner: {},
    union: {},
  });
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
  return result.unionId;
}

/** Record an existing person as a child of a union. */
async function makeChild(unionId: string, childId: string): Promise<void> {
  const result = await addChild({
    childMode: "existing",
    childId,
    child: {},
    link: { unionId, relation: "biological" },
  });
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
}

function submission(overrides: Partial<SetParentsInput>): SetParentsInput {
  return {
    childId: "",
    familyMode: "existing",
    unionId: "",
    fromUnionId: null,
    relation: "biological",
    parentAId: null,
    parentBId: null,
    ...overrides,
  };
}

/** Set parents, failing loudly rather than returning a union of statuses. */
async function set(input: SetParentsInput) {
  const result = await setParents(input);
  if (result.status !== "set") {
    throw new Error(`Expected set, got ${result.status}.`);
  }
  return result;
}

/** Every family a person is recorded as a child of. */
async function familiesOf(childId: string): Promise<string[]> {
  const rows = await db
    .select({ unionId: schema.unionChildren.unionId })
    .from(schema.unionChildren)
    .where(eq(schema.unionChildren.childId, childId));
  return rows.map((row) => row.unionId).sort();
}

async function unionRow(unionId: string) {
  const [row] = await db
    .select()
    .from(schema.unions)
    .where(eq(schema.unions.id, unionId));
  return row;
}

async function countFixturePeople(): Promise<number> {
  const rows = await db
    .select({ id: schema.individuals.id })
    .from(schema.individuals)
    .where(like(schema.individuals.givenName, `${PREFIX}%`));
  return rows.length;
}

beforeEach(removeFixture);
afterAll(removeFixture);

describe("attaching an existing person to an existing family", () => {
  it("records the link and reads back as a parent", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const dora = await makePerson("Dora");
    const unionId = await makeUnion(rose, thomas);

    const result = await set(
      submission({ childId: dora, unionId, relation: "adopted" }),
    );

    expect(result.unionId).toBe(unionId);
    expect(result.createdUnion).toBe(false);
    expect(result.movedFrom).toBeNull();

    // Read back through the canonical reader of what this file writes, which
    // is what proves the row means what the panel will say it means.
    const detail = derivePersonDetail(await getFamilyGraph(), dora);
    expect(detail?.parents.map((parent) => parent.person.name).sort()).toEqual([
      name("Rose"),
      name("Thomas"),
    ]);
    expect(detail?.parents[0].relation).toBe("adopted");
  });

  it("refuses a family that already records them", async () => {
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");
    const unionId = await makeUnion(rose, null);
    await makeChild(unionId, dora);

    expect(await setParents(submission({ childId: dora, unionId }))).toEqual({
      status: "already-recorded",
    });
  });

  it("refuses a family that already names them as a parent", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const unionId = await makeUnion(rose, thomas);

    expect(await setParents(submission({ childId: rose, unionId }))).toEqual({
      status: "child-is-partner",
    });
  });

  it("reports a person deleted since the panel loaded", async () => {
    const rose = await makePerson("Rose");
    const unionId = await makeUnion(rose, null);
    const dora = await makePerson("Dora");
    await db.delete(schema.individuals).where(eq(schema.individuals.id, dora));

    expect(await setParents(submission({ childId: dora, unionId }))).toEqual({
      status: "child-not-found",
    });
  });

  it("reports a family removed since the panel loaded", async () => {
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");
    const unionId = await makeUnion(rose, null);
    await db.delete(schema.unions).where(eq(schema.unions.id, unionId));

    expect(await setParents(submission({ childId: dora, unionId }))).toEqual({
      status: "union-not-found",
    });
  });
});

describe("creating the family inline", () => {
  it("writes the union and the link in one go", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const dora = await makePerson("Dora");

    const result = await set(
      submission({
        childId: dora,
        familyMode: "new",
        unionId: null,
        parentAId: rose,
        parentBId: thomas,
      }),
    );

    expect(result.createdUnion).toBe(true);

    const union = await unionRow(result.unionId);
    expect([union.partnerAId, union.partnerBId].sort()).toEqual(
      [rose, thomas].sort(),
    );
    expect(await familiesOf(dora)).toEqual([result.unionId]);
  });

  it("records a union of unknown type rather than asserting a marriage", async () => {
    // What the author has said is that these two are somebody's parents. When
    // and whether they married is a separate fact they were not asked for, and
    // the column's own default (`marriage`) would quietly assert it.
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");

    const result = await set(
      submission({
        childId: dora,
        familyMode: "new",
        unionId: null,
        parentAId: rose,
      }),
    );

    expect((await unionRow(result.unionId)).type).toBe("unknown");
  });

  it("supports one known parent and one unknown, with no placeholder person", async () => {
    // The ticket's third criterion, and the assertion that proves it: the
    // people count is unchanged, so nothing was invented to fill the empty
    // column. See docs/architecture.md on why both columns are nullable.
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");
    const before = await countFixturePeople();

    const result = await set(
      submission({
        childId: dora,
        familyMode: "new",
        unionId: null,
        parentAId: rose,
        parentBId: null,
      }),
    );

    const union = await unionRow(result.unionId);
    expect(union.partnerAId).toBe(rose);
    expect(union.partnerBId).toBeNull();
    expect(await countFixturePeople()).toBe(before);
  });

  it("puts the known parent in the first slot whichever picker was filled", async () => {
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");

    const result = await set(
      submission({
        childId: dora,
        familyMode: "new",
        unionId: null,
        parentAId: null,
        parentBId: rose,
      }),
    );

    const union = await unionRow(result.unionId);
    expect(union.partnerAId).toBe(rose);
    expect(union.partnerBId).toBeNull();
  });

  it("sorts the new family after the marriages either parent already has", async () => {
    // `unions.sequence` exists because families remember the order of
    // marriages long after the years are lost, and `getFamilyGraph` sorts on
    // it before `start_date`. A union created from the child's end has to land
    // after the ones already recorded, exactly as one created from a partner's
    // end does — which is why `nextSequence` is shared rather than copied.
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const dora = await makePerson("Dora");
    const first = await makeUnion(rose, null);

    const result = await set(
      submission({
        childId: dora,
        familyMode: "new",
        unionId: null,
        parentAId: rose,
        parentBId: thomas,
      }),
    );

    expect((await unionRow(result.unionId)).sequence).toBeGreaterThan(
      (await unionRow(first)).sequence,
    );
  });

  it("writes nothing at all when a named parent has been deleted", async () => {
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");
    const ghost = await makePerson("Ghost");
    await db.delete(schema.individuals).where(eq(schema.individuals.id, ghost));

    expect(
      await setParents(
        submission({
          childId: dora,
          familyMode: "new",
          unionId: null,
          parentAId: rose,
          parentBId: ghost,
        }),
      ),
    ).toEqual({ status: "parent-not-found" });

    // The refusal happens before the insert, so there is no half-made family
    // left behind for the next author to wonder about.
    const graph = await getFamilyGraph();
    expect(graph.unions.filter((u) => u.partnerAId === rose)).toEqual([]);
  });
});

describe("refusing a link that would make somebody their own ancestor", () => {
  /**
   * Four generations, built through the same flows an author would use:
   *
   *   Gran ══ (granUnion) ══ Grandpa
   *                │
   *             Parent ══ (parentUnion) ══ Spouse
   *                          │
   *                        Child
   */
  async function pedigree() {
    const gran = await makePerson("Gran");
    const grandpa = await makePerson("Grandpa");
    const parent = await makePerson("Parent");
    const spouse = await makePerson("Spouse");
    const child = await makePerson("Child");

    const granUnion = await makeUnion(gran, grandpa);
    await makeChild(granUnion, parent);
    const parentUnion = await makeUnion(parent, spouse);
    await makeChild(parentUnion, child);

    return { gran, grandpa, parent, spouse, child, granUnion, parentUnion };
  }

  it("refuses a grandmother recorded as a child of her own descendants' union", async () => {
    // Neither partner of `parentUnion` is Gran, so the child-is-partner check
    // that predates this ticket sees nothing wrong. The ancestor walk is what
    // finds Parent one rank down — and the row it would otherwise write is a
    // cycle in a graph `lib/tree-layout.ts` walks as though it were acyclic.
    const { gran, parentUnion } = await pedigree();

    expect(
      await setParents(submission({ childId: gran, unionId: parentUnion })),
    ).toEqual({ status: "child-is-ancestor" });

    expect(await familiesOf(gran)).toEqual([]);
  });

  it("refuses a family created inline from the person's own descendant", async () => {
    // The same rule through the other door. The union is inserted first and
    // the check reads the graph afterwards, inside the same transaction, so it
    // sees the family this write is in the middle of making.
    const { gran, child } = await pedigree();
    const before = await getFamilyGraph();

    expect(
      await setParents(
        submission({
          childId: gran,
          familyMode: "new",
          unionId: null,
          parentAId: child,
        }),
      ),
    ).toEqual({ status: "child-is-ancestor" });

    // And rolled the union back with it, rather than leaving an impossible
    // family standing without its link.
    const after = await getFamilyGraph();
    expect(after.unions).toHaveLength(before.unions.length);
  });

  it("allows a descendant to be recorded under an ancestor's union", async () => {
    // Downwards is the direction families run in, and refusing it would refuse
    // every tree where two lines rejoin.
    const { child, granUnion } = await pedigree();

    const result = await set(
      submission({ childId: child, unionId: granUnion }),
    );

    expect(result.status).toBe("set");
  });
});

describe("moving a child from one family to another", () => {
  async function twoFamilies() {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");
    const dora = await makePerson("Dora");

    const wrong = await makeUnion(rose, thomas);
    const right = await makeUnion(rose, walter);
    await makeChild(wrong, dora);

    return { rose, thomas, walter, dora, wrong, right };
  }

  it("removes the old link and writes the new one, leaving everybody in the tree", async () => {
    const { dora, wrong, right, thomas } = await twoFamilies();

    const result = await set(
      submission({ childId: dora, unionId: right, fromUnionId: wrong }),
    );

    expect(result.movedFrom).toBe(wrong);
    expect(await familiesOf(dora)).toEqual([right]);

    // Nobody was deleted and nothing was re-created: the person's id is the
    // same one, and the family they left is still there with its partners.
    const graph = await getFamilyGraph();
    expect(graph.people.some((person) => person.id === dora)).toBe(true);
    expect(graph.unions.some((union) => union.id === wrong)).toBe(true);
    expect(graph.people.some((person) => person.id === thomas)).toBe(true);
  });

  it("moves into a family created in the same write", async () => {
    const { dora, wrong, walter } = await twoFamilies();

    const result = await set(
      submission({
        childId: dora,
        familyMode: "new",
        unionId: null,
        parentAId: walter,
        fromUnionId: wrong,
      }),
    );

    expect(result.createdUnion).toBe(true);
    expect(await familiesOf(dora)).toEqual([result.unionId]);
  });

  it("leaves the other family alone when the author asks to keep it", async () => {
    // Adopted into one family and born into another is a real record, so a
    // blank `fromUnionId` has to add rather than replace.
    const { dora, wrong, right } = await twoFamilies();

    await set(submission({ childId: dora, unionId: right }));

    expect(await familiesOf(dora)).toEqual([wrong, right].sort());
  });

  it("sweeps up a family the move left holding nothing", async () => {
    // The same rule `detachChild` follows: a union with no partners and no
    // children is unreachable from every panel, so leaving it would leave a
    // row nothing in the application can ever see or remove.
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");
    const emptied = await makeUnion(rose, null);
    const destination = await makeUnion(rose, null);
    await makeChild(emptied, dora);

    // Strip the one partner, so the union's only remaining content is Dora.
    await db
      .update(schema.unions)
      .set({ partnerAId: null })
      .where(eq(schema.unions.id, emptied));

    await set(
      submission({ childId: dora, unionId: destination, fromUnionId: emptied }),
    );

    expect(await unionRow(emptied)).toBeUndefined();
  });

  it("leaves a family that still records somebody", async () => {
    // The orphan rule fires only at zero partners *and* zero children. A
    // family that still names a parent is somebody's record, and deleting it
    // as a side effect of an unrelated move would be a surprise.
    const { dora, wrong, right } = await twoFamilies();

    await set(
      submission({ childId: dora, unionId: right, fromUnionId: wrong }),
    );

    expect(await unionRow(wrong)).toBeDefined();
  });

  it("refuses a move out of a family that does not record them", async () => {
    const { dora, wrong, right } = await twoFamilies();
    const stranger = await makePerson("Stranger");

    expect(
      await setParents(
        submission({ childId: stranger, unionId: right, fromUnionId: wrong }),
      ),
    ).toEqual({ status: "not-recorded-there" });

    // And wrote nothing, so the stranger did not quietly gain a family.
    expect(await familiesOf(stranger)).toEqual([]);
    expect(await familiesOf(dora)).toEqual([wrong]);
  });

  it("rolls the detach back when the attach is refused", async () => {
    /**
     * The assertion this whole module exists for. Dora is recorded in both
     * families; a move from one to the other is refused as `already-recorded`
     * — *after* the detach has run. Without the rollback she would be left in
     * neither, which is worse than the move not happening and silently so,
     * because nothing about the resulting record looks damaged.
     */
    const { dora, wrong, right } = await twoFamilies();
    await makeChild(right, dora);

    expect(
      await setParents(
        submission({ childId: dora, unionId: right, fromUnionId: wrong }),
      ),
    ).toEqual({ status: "already-recorded" });

    expect(await familiesOf(dora)).toEqual([wrong, right].sort());
  });

  it("rolls the detach back when a named parent has been deleted", async () => {
    /**
     * The combination the form offers and the first version of this module got
     * wrong: a move *into a family being created inline*. The detach runs
     * before the parents are looked up, so a parent deleted in another tab in
     * the meantime used to commit the detach, create nothing, attach nothing,
     * and leave the child with no parents at all — the exact outcome the whole
     * module exists to prevent, and silently, because nothing about the
     * resulting record looks damaged.
     */
    const { dora, wrong, walter } = await twoFamilies();
    const ghost = await makePerson("Ghost");
    await db.delete(schema.individuals).where(eq(schema.individuals.id, ghost));

    expect(
      await setParents(
        submission({
          childId: dora,
          familyMode: "new",
          unionId: null,
          parentAId: walter,
          parentBId: ghost,
          fromUnionId: wrong,
        }),
      ),
    ).toEqual({ status: "parent-not-found" });

    // Still where she started, and no half-made family left standing.
    expect(await familiesOf(dora)).toEqual([wrong]);
    const graph = await getFamilyGraph();
    expect(
      graph.unions.filter(
        (union) =>
          union.id !== wrong &&
          (union.partnerAId === walter || union.partnerBId === walter),
      ),
    ).toHaveLength(1);
  });

  it("rolls the detach back when the move would create a cycle", async () => {
    // The same atomicity, reached through the check this ticket added. Rose is
    // moved out of a family she really is a child of, into her own daughter's
    // — and has to come back out of the first one intact.
    const gran = await makePerson("Gran");
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");

    const granUnion = await makeUnion(gran, null);
    await makeChild(granUnion, rose);
    const roseUnion = await makeUnion(rose, null);
    await makeChild(roseUnion, dora);
    const doraUnion = await makeUnion(dora, null);

    expect(
      await setParents(
        submission({
          childId: rose,
          unionId: doraUnion,
          fromUnionId: granUnion,
        }),
      ),
    ).toEqual({ status: "child-is-ancestor" });

    expect(await familiesOf(rose)).toEqual([granUnion]);
  });

  it("keeps the relation recorded against the new family, not the person", async () => {
    const { dora, wrong, right } = await twoFamilies();

    await set(
      submission({
        childId: dora,
        unionId: right,
        fromUnionId: wrong,
        relation: "step",
      }),
    );

    const [link] = await db
      .select()
      .from(schema.unionChildren)
      .where(
        and(
          eq(schema.unionChildren.unionId, right),
          eq(schema.unionChildren.childId, dora),
        ),
      );

    expect(link.relation).toBe("step");
  });
});
