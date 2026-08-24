import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { detachChild, detachPartner, removePerson } from "@/lib/remove-from-tree";

/**
 * Database tests for removal (E3-T8, `YEO-36`). Run with `npm run test:db`;
 * the `.db.test.ts` suffix is what keeps them out of `npm test` and CI's bare
 * environment. See docs/testing.md.
 *
 * The *rules* — which unions a delete takes, when a union has stopped
 * recording anything, what the dialogue says — are pure and are tested
 * without a database in `lib/removal-preview.test.ts`. What is left here is
 * only what is a property of Postgres rather than of TypeScript, and for this
 * ticket that is unusually load-bearing:
 *
 * - **The cascade itself.** `db/schema.ts` deletes a whole `unions` row when
 *   either partner goes. The confirmation copy is written around that claim,
 *   so the claim is worth proving against a real foreign key rather than
 *   against a comment.
 * - **The absence of a cascade to `pages`.** An acceptance criterion asserted
 *   by something *not* happening is exactly the kind that rots silently, and
 *   the only way to see it is to delete a person and look at the entry.
 * - **The orphan cleanup**, which is two statements that have to agree.
 *
 * Fixed, recognisable ids, per docs/testing.md — the `36...` prefix is this
 * ticket's, so teardown removes exactly what this file created and nothing
 * belonging to a sibling ticket's suite running against the same database.
 */
const PREFIX = "36000000-0000-4000-8000-0000000000";

/** A fixture id: two hex digits under this file's prefix. */
function id(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

const MARY = id("01");
const THOMAS = id("02");
const ROSE = id("03");
const WALTER = id("04");
const ALICE = id("05");
const BRIAN = id("06");
const CLARA = id("07");
const DORA = id("08");
const IVY = id("09");

const U1 = id("11"); // Mary ══ Thomas, child Alice
const U2 = id("12"); // Thomas ══ Rose, children Brian and Clara
const U3 = id("13"); // Rose ══ Walter, child Dora
const U4 = id("14"); // Mary ══ Walter, no children
const U0 = id("10"); // no partners at all, child Ivy

const ROSE_PAGE = id("21");

const PEOPLE = [MARY, THOMAS, ROSE, WALTER, ALICE, BRIAN, CLARA, DORA, IVY];
const UNIONS = [U0, U1, U2, U3, U4];

/**
 * The seed tree from docs/architecture.md, plus two unions that exist to be
 * emptied:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │             │
 *           Alice      Brian, Clara      Dora
 *
 *   [Mary]══(u4)══[Walter]        (u0) ── Ivy
 *      no children            no partners recorded
 */
async function seed() {
  await removeFixture();

  await db.insert(schema.pages).values({
    id: ROSE_PAGE,
    slug: `yeo-36-fixture-rose`,
    title: "Rose Hale",
    bodyHtml: "<p>A life.</p>",
  });

  await db.insert(schema.individuals).values([
    { id: MARY, givenName: "Mary", surname: "Ellis" },
    { id: THOMAS, givenName: "Thomas", surname: "Hale", sex: "male" },
    { id: ROSE, givenName: "Rose", surname: "Hale", pageId: ROSE_PAGE },
    { id: WALTER, givenName: "Walter", surname: "Doyle", sex: "male" },
    { id: ALICE, givenName: "Alice", surname: "Hale" },
    { id: BRIAN, givenName: "Brian", surname: "Hale" },
    { id: CLARA, givenName: "Clara", surname: "Hale" },
    { id: DORA, givenName: "Dora", surname: "Doyle" },
    { id: IVY, givenName: "Ivy", surname: "Unknown" },
  ]);

  await db.insert(schema.unions).values([
    { id: U1, partnerAId: MARY, partnerBId: THOMAS, sequence: 1 },
    { id: U2, partnerAId: THOMAS, partnerBId: ROSE, sequence: 2 },
    { id: U3, partnerAId: ROSE, partnerBId: WALTER, sequence: 3 },
    { id: U4, partnerAId: MARY, partnerBId: WALTER, sequence: 4 },
    { id: U0, sequence: 5 },
  ]);

  await db.insert(schema.unionChildren).values([
    { unionId: U1, childId: ALICE },
    { unionId: U2, childId: BRIAN },
    { unionId: U2, childId: CLARA, relation: "adopted" },
    { unionId: U3, childId: DORA },
    { unionId: U0, childId: IVY },
  ]);
}

async function removeFixture() {
  // Unions first: U0 has no partners, so nothing cascades it away when the
  // people go, and it would survive into the next file's run.
  await db.delete(schema.unions).where(inArray(schema.unions.id, UNIONS));
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PEOPLE));
  await db
    .delete(schema.pages)
    .where(like(schema.pages.slug, "yeo-36-fixture-%"));
}

/** Which of this file's people are still in the table. */
async function livingPeople(): Promise<string[]> {
  const rows = await db
    .select({ id: schema.individuals.id })
    .from(schema.individuals)
    .where(inArray(schema.individuals.id, PEOPLE));
  return rows.map((row) => row.id).sort();
}

/** Which of this file's unions are still in the table. */
async function livingUnions(): Promise<string[]> {
  const rows = await db
    .select({ id: schema.unions.id })
    .from(schema.unions)
    .where(inArray(schema.unions.id, UNIONS));
  return rows.map((row) => row.id).sort();
}

/** Every surviving child link of this file's unions, as `union/child`. */
async function livingChildLinks(): Promise<string[]> {
  const rows = await db
    .select({
      unionId: schema.unionChildren.unionId,
      childId: schema.unionChildren.childId,
    })
    .from(schema.unionChildren)
    .where(inArray(schema.unionChildren.unionId, UNIONS));
  return rows.map((row) => `${row.unionId}/${row.childId}`).sort();
}

async function readUnion(unionId: string) {
  const [union] = await db
    .select()
    .from(schema.unions)
    .where(eq(schema.unions.id, unionId));
  return union;
}

beforeEach(seed);
afterAll(removeFixture);

describe("removePerson", () => {
  it("deletes every union they were a partner in, not just their slot", async () => {
    // The claim the whole confirmation dialogue is written around. Thomas is
    // a partner in U1 and U2; both rows go, and U3 — which he is not in — is
    // untouched.
    const result = await removePerson(THOMAS);

    expect(result.status).toBe("removed");
    expect(await livingUnions()).toEqual([U0, U3, U4].sort());
  });

  it("takes the child links of those unions with them", async () => {
    // Alice, Brian and Clara are all still people. What they have lost is the
    // row recording whose children they were, and nothing in the tree can
    // reconstruct it.
    await removePerson(THOMAS);

    expect(await livingChildLinks()).toEqual(
      [`${U3}/${DORA}`, `${U0}/${IVY}`].sort(),
    );
  });

  it("deletes nobody but the person named", async () => {
    await removePerson(THOMAS);

    expect(await livingPeople()).toEqual(
      PEOPLE.filter((person) => person !== THOMAS).sort(),
    );
  });

  it("leaves their wiki entry, and the link is simply dropped", async () => {
    // The acceptance criterion asserted by an absence: `individuals.page_id`
    // is the foreign key and it points *at* `pages`, so there is no cascade
    // in this direction for anything to trip over. The `set null` on that
    // column fires the other way round — when a *page* is deleted.
    await removePerson(ROSE);

    const [page] = await db
      .select()
      .from(schema.pages)
      .where(eq(schema.pages.id, ROSE_PAGE));

    expect(page).toBeDefined();
    expect(page.title).toBe("Rose Hale");
    expect(page.bodyHtml).toBe("<p>A life.</p>");
  });

  it("reports what it removed, read from the rows it removed them from", async () => {
    // The preview comes back from inside the deleting transaction, so this is
    // the database's account of the cascade rather than the browser's guess
    // at it.
    const result = await removePerson(THOMAS);
    if (result.status !== "removed") throw new Error("expected a removal");

    expect(result.preview.unions.map((union) => union.unionId).sort()).toEqual(
      [U1, U2].sort(),
    );
    const withRose = result.preview.unions.find(
      (union) => union.unionId === U2,
    );
    expect(withRose?.partner?.name).toBe("Rose Hale");
    expect(withRose?.children.map((child) => child.name).sort()).toEqual([
      "Brian Hale",
      "Clara Hale",
    ]);
  });

  it("cleans up the union their departure leaves with nobody in it", async () => {
    // U0 records no partners and Ivy is its only child. The cascade takes
    // Ivy's link but not the union — so without the cleanup this leaves a row
    // that no panel can reach and nobody can ever remove.
    const result = await removePerson(IVY);
    if (result.status !== "removed") throw new Error("expected a removal");

    expect(result.preview.orphanedUnionIds).toEqual([U0]);
    expect(await livingUnions()).not.toContain(U0);
  });

  it("leaves the union that recorded their parents when it still records them", async () => {
    // Alice is U1's only child, but Mary and Thomas are still a pair — so U1
    // goes on being a fact about them.
    const result = await removePerson(ALICE);
    if (result.status !== "removed") throw new Error("expected a removal");

    expect(result.preview.orphanedUnionIds).toEqual([]);
    expect(await livingUnions()).toContain(U1);
  });

  it("reports a person who is already gone rather than throwing", async () => {
    await removePerson(THOMAS);

    expect(await removePerson(THOMAS)).toEqual({ status: "not-found" });
  });

  it("reports an id that is not a uuid rather than letting Postgres raise", async () => {
    // Without the `isRowId` guard this reaches Postgres as `invalid input
    // syntax for type uuid`, which is a thrown error rather than a query
    // matching nothing. See `lib/row-id.ts`.
    expect(await removePerson("not-a-uuid")).toEqual({ status: "not-found" });
  });
});

describe("detachPartner", () => {
  it("clears their slot and leaves the union standing", async () => {
    // The gentle action, and the reason it is gentle: Rose keeps U2, so she
    // keeps Brian and Clara. Deleting Thomas would have taken all of it.
    const result = await detachPartner(U2, THOMAS);

    expect(result.status).toBe("removed");

    const union = await readUnion(U2);
    expect(union.partnerAId).toBeNull();
    expect(union.partnerBId).toBe(ROSE);
    expect(await livingChildLinks()).toContain(`${U2}/${BRIAN}`);
    expect(await livingChildLinks()).toContain(`${U2}/${CLARA}`);
  });

  it("deletes nobody, and leaves their other unions alone", async () => {
    await detachPartner(U2, THOMAS);

    expect(await livingPeople()).toEqual([...PEOPLE].sort());
    expect((await readUnion(U1)).partnerBId).toBe(THOMAS);
  });

  it("removes a childless union rather than leaving half of one", async () => {
    // U4 records Mary and Walter and no children. With Mary out of it the row
    // would state that Walter was in a relationship with nobody and had no
    // children by them — which is not a fact, and which the detail panel
    // would render as an "Unknown partner" who was never unknown.
    const result = await detachPartner(U4, MARY);

    expect(result.status).toBe("removed");
    if (result.status !== "removed") throw new Error("expected a removal");
    expect(result.preview.removesUnion).toBe(true);
    expect(await livingUnions()).not.toContain(U4);
    expect(await livingPeople()).toEqual([...PEOPLE].sort());
  });

  it("refuses a person who is not a partner in that union", async () => {
    expect(await detachPartner(U2, WALTER)).toEqual({ status: "not-found" });
    expect((await readUnion(U2)).partnerAId).toBe(THOMAS);
  });

  it("reports a union that is not there rather than throwing", async () => {
    expect(await detachPartner(id("99"), THOMAS)).toEqual({
      status: "not-found",
    });
    expect(await detachPartner("not-a-uuid", THOMAS)).toEqual({
      status: "not-found",
    });
  });
});

describe("detachChild", () => {
  it("removes one link and nothing else", async () => {
    const result = await detachChild(U2, CLARA);

    expect(result.status).toBe("removed");
    expect(await livingChildLinks()).not.toContain(`${U2}/${CLARA}`);
    expect(await livingChildLinks()).toContain(`${U2}/${BRIAN}`);
    expect(await livingPeople()).toEqual([...PEOPLE].sort());
    expect(await livingUnions()).toEqual([...UNIONS].sort());
  });

  it("cleans up the union it empties", async () => {
    // U0 records no partners — the "we know there were children, we do not
    // know the parents" case — so once Ivy's link goes there is nothing left
    // in it, and nothing in the application could ever reach that row again.
    const result = await detachChild(U0, IVY);

    expect(result.status).toBe("removed");
    if (result.status !== "removed") throw new Error("expected a removal");
    expect(result.preview.removesUnion).toBe(true);
    expect(await livingUnions()).not.toContain(U0);
    expect(await livingPeople()).toContain(IVY);
  });

  it("keeps a union whose partners are still recorded", async () => {
    // Dora is U3's only child, but Rose and Walter are still married — a
    // childless marriage is a fact about a family, so the row stays.
    await detachChild(U3, DORA);

    expect(await livingUnions()).toContain(U3);
  });

  it("reports a link that is not there rather than throwing", async () => {
    expect(await detachChild(U2, DORA)).toEqual({ status: "not-found" });
    expect(await detachChild(U2, "not-a-uuid")).toEqual({
      status: "not-found",
    });
  });
});
