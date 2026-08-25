import { eq, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import type { AddChildInput } from "@/lib/child-input";
import { getFamilyGraph } from "@/lib/family-graph";
import { derivePersonDetail } from "@/lib/person-detail";
import { addChild } from "@/lib/save-child";
import { createIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";

/**
 * Database tests for the add-child write path (E3-T5, `YEO-33`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * The *rules* are pure and are tested without a database in
 * `lib/child-input.test.ts`. What is left here is only what is a property of
 * Postgres rather than of TypeScript:
 *
 * - creating a child inline is one transaction, so a refused link leaves no
 *   stranger behind;
 * - a person deleted between the picker loading and the form submitting is a
 *   status rather than a foreign-key violation;
 * - the `(union_id, child_id)` primary key means the same child cannot be
 *   recorded into the same family twice;
 * - and, the one this ticket is really about: **half-siblings fall out of the
 *   rows written here with nothing stored to say so.** That is asserted by
 *   reading them back through `derivePersonDetail`, which is the canonical
 *   reader of what this file writes.
 *
 * Isolated by given name rather than by fixed ids, exactly as
 * `lib/save-union.db.test.ts` is: these functions insert the rows and Postgres
 * chooses their ids. `unions` and `union_children` both cascade from
 * `individuals`, so deleting the people takes everything with them.
 */

const PREFIX = "save-child-fixture";

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

/** Marry two fixture people, returning the union's id. */
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

function submission(overrides: Partial<AddChildInput>): AddChildInput {
  return {
    childMode: "existing",
    childId: "",
    child: {},
    link: {},
    ...overrides,
  };
}

/** Add a child, failing loudly rather than returning a union of statuses. */
async function add(input: AddChildInput) {
  const result = await addChild(input);
  if (result.status !== "added") {
    throw new Error(`Expected added, got ${result.status}.`);
  }
  return result;
}

/** Every child link recorded against a union. */
async function childrenOf(unionId: string) {
  return db
    .select()
    .from(schema.unionChildren)
    .where(eq(schema.unionChildren.unionId, unionId));
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

describe("addChild", () => {
  it("records an existing person as a child of a union", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const clara = await makePerson("Clara");
    const unionId = await makeUnion(rose, thomas);

    const result = await add(
      submission({
        childId: clara,
        link: { unionId, relation: "adopted" },
      }),
    );

    expect(result.childId).toBe(clara);

    const [row] = await childrenOf(unionId);
    // `importId` is null: this link was typed through the form, not imported
    // (`YEO-89`) — see `union_children.import_id` in `db/schema.ts`.
    expect(row).toEqual({
      unionId,
      childId: clara,
      relation: "adopted",
      importId: null,
    });
  });

  it("creates the child and the link in one go", async () => {
    const rose = await makePerson("Rose");
    const unionId = await makeUnion(rose, null);

    const { childId } = await add(
      submission({
        childMode: "new",
        child: { givenName: name("Dora"), birthDate: "1936-04-02" },
        link: { unionId },
      }),
    );

    const [row] = await childrenOf(unionId);
    expect(row.childId).toBe(childId);
    expect(row.relation).toBe("biological");
  });

  /**
   * Half of an inline creation is worse than none: a person written without
   * their link is a stranger on the canvas with nothing to say who they are.
   * The refusal here comes from the union being gone, which is the ordinary
   * race — a panel left open while somebody removed the family in another tab.
   */
  it("writes no person at all when the link cannot be made", async () => {
    const rose = await makePerson("Rose");
    const unionId = await makeUnion(rose, null);
    await db.delete(schema.unions).where(eq(schema.unions.id, unionId));

    const before = await countFixturePeople();
    const result = await addChild(
      submission({
        childMode: "new",
        child: { givenName: name("Dora") },
        link: { unionId },
      }),
    );

    expect(result.status).toBe("union-not-found");
    expect(await countFixturePeople()).toBe(before);
  });

  it("reports a child deleted since the picker loaded", async () => {
    const rose = await makePerson("Rose");
    const clara = await makePerson("Clara");
    const unionId = await makeUnion(rose, null);
    await db.delete(schema.individuals).where(eq(schema.individuals.id, clara));

    const result = await addChild(
      submission({ childId: clara, link: { unionId } }),
    );

    // A status the form can render, rather than a foreign-key violation
    // thrown out of the driver and into an error boundary.
    expect(result.status).toBe("child-not-found");
  });

  it("refuses to make somebody their own family's child", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const unionId = await makeUnion(rose, thomas);

    expect(
      (await addChild(submission({ childId: rose, link: { unionId } }))).status,
    ).toBe("child-is-partner");
    expect(
      (await addChild(submission({ childId: thomas, link: { unionId } })))
        .status,
    ).toBe("child-is-partner");
  });

  it("refuses to record the same child into the same family twice", async () => {
    const rose = await makePerson("Rose");
    const clara = await makePerson("Clara");
    const unionId = await makeUnion(rose, null);

    await add(submission({ childId: clara, link: { unionId } }));
    const again = await addChild(
      submission({ childId: clara, link: { unionId, relation: "adopted" } }),
    );

    expect(again.status).toBe("already-recorded");
    expect(await childrenOf(unionId)).toHaveLength(1);
  });

  /**
   * The same person in two families is not a duplicate — it is exactly how a
   * child adopted out of one family and into another is recorded, and the
   * relation differs per link because the relation belongs to the link.
   */
  it("allows the same person to be a child of two different families", async () => {
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");
    const clara = await makePerson("Clara");
    const born = await makeUnion(rose, null);
    const adoptedInto = await makeUnion(walter, null);

    await add(submission({ childId: clara, link: { unionId: born } }));
    await add(
      submission({
        childId: clara,
        link: { unionId: adoptedInto, relation: "adopted" },
      }),
    );

    expect((await childrenOf(born))[0].relation).toBe("biological");
    expect((await childrenOf(adoptedInto))[0].relation).toBe("adopted");
  });

  it("refuses a submission the rules already reject, without touching the database", async () => {
    const rose = await makePerson("Rose");
    await makeUnion(rose, null);

    const before = await countFixturePeople();
    const result = await addChild(
      submission({
        childMode: "new",
        child: { givenName: "" },
        link: { unionId: "not-a-uuid" },
      }),
    );

    expect(result.status).toBe("invalid");
    expect(await countFixturePeople()).toBe(before);
  });
});

/**
 * The acceptance criterion that is really a claim about the *whole* pipeline:
 * write two children into two of one parent's unions, read the graph back, and
 * find half-siblings — without anything in either row saying "half".
 */
describe("half-siblings", () => {
  it("fall out of the rows with no relationship type stored", async () => {
    const rose = await makePerson("Rose");
    const thomas = await makePerson("Thomas");
    const walter = await makePerson("Walter");

    const first = await makeUnion(rose, thomas);
    const second = await makeUnion(rose, walter);

    const { childId: brian } = await add(
      submission({
        childMode: "new",
        child: { givenName: name("Brian"), birthDate: "1934-01-01" },
        link: { unionId: first },
      }),
    );
    const { childId: dora } = await add(
      submission({
        childMode: "new",
        child: { givenName: name("Dora"), birthDate: "1936-01-01" },
        link: { unionId: second },
      }),
    );

    const graph = await getFamilyGraph();
    const detail = derivePersonDetail(graph, rose);
    if (detail === null) throw new Error("expected Rose to be in the graph");

    // Both are Rose's children, and which family each came through is the only
    // thing that distinguishes them — which is exactly what makes them half
    // rather than full siblings.
    const mine = detail.children.filter((child) =>
      [brian, dora].includes(child.person.id),
    );
    expect(mine).toHaveLength(2);
    expect(mine.map((child) => child.otherParent?.id)).toEqual([
      thomas,
      walter,
    ]);

    // Nothing was stored to say so. Every link written here is `biological`;
    // the half-sibling relationship is derived, and there is no column for it.
    expect(mine.map((child) => child.relation)).toEqual([
      "biological",
      "biological",
    ]);

    // Read from the other end, each child has exactly the two parents their
    // own union names — and no sibling relation of any kind is recorded.
    const brianDetail = derivePersonDetail(graph, brian);
    expect(
      brianDetail?.parents.map((parent) => parent.person.id).sort(),
    ).toEqual([rose, thomas].sort());
  });
});

/**
 * The ancestor guard (E3-T6, `YEO-34`), reached through this door.
 *
 * It lives in `lib/save-child.ts` rather than in the set-parents flow that
 * needed it, because both forms and E6-T2's import write the same
 * `union_children` row and a rule fitted to one door is a rule somebody
 * forgets to fit to the next. This is the assertion that the add-child form
 * cannot be used to put a cycle in the graph either.
 *
 * The walk itself is pure and is tested exhaustively without a database in
 * `lib/ancestry.test.ts`; what is checked here is only that the transaction
 * actually consults it, against rows it read for itself.
 */
describe("nobody becomes their own ancestor", () => {
  it("refuses a grandmother recorded as a child of her descendants' union", async () => {
    const gran = await makePerson("Gran");
    const rose = await makePerson("Rose");
    const walter = await makePerson("Walter");

    const granUnion = await makeUnion(gran, null);
    await add(submission({ childId: rose, link: { unionId: granUnion } }));
    const roseUnion = await makeUnion(rose, walter);

    // Neither partner of `roseUnion` is Gran, so the `child-is-partner` check
    // that predates this ticket sees nothing wrong. The walk is what finds
    // Rose one rank below her.
    expect(
      await addChild(
        submission({ childId: gran, link: { unionId: roseUnion } }),
      ),
    ).toEqual({ status: "child-is-ancestor" });

    expect(await childrenOf(roseUnion)).toEqual([]);
  });

  it("still allows a descendant to be recorded under an ancestor's union", async () => {
    // Downwards is the direction families run in, and a guard that refused it
    // would refuse every tree where two lines of descent rejoin.
    const gran = await makePerson("Gran");
    const rose = await makePerson("Rose");
    const dora = await makePerson("Dora");

    const granUnion = await makeUnion(gran, null);
    await add(submission({ childId: rose, link: { unionId: granUnion } }));
    const roseUnion = await makeUnion(rose, null);
    await add(submission({ childId: dora, link: { unionId: roseUnion } }));

    const result = await add(
      submission({ childId: dora, link: { unionId: granUnion } }),
    );

    expect(result.status).toBe("added");
  });
});
