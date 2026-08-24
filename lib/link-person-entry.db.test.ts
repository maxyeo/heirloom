import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { createEntryForPerson, setPersonEntry } from "@/lib/link-person-entry";
import { raceWriters } from "@/test/db-concurrency";

/**
 * Database tests for the person↔entry link (E2-T2, `YEO-25`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * Everything asserted here is a property of Postgres rather than of
 * TypeScript: the transaction that has to write a page, its first revision and
 * `individuals.page_id` together or not at all; the `on delete set null` that
 * lets an entry outlive the link to it; and the re-reads that decide whether
 * a link is already taken. Mocking Drizzle would prove none of it.
 *
 * The people have fixed, recognisable ids so teardown can delete exactly what
 * this file created. The pages cannot — `createEntryForPerson` inserts them
 * and chooses their ids — so they are isolated by title prefix instead, the
 * same way `lib/create-page.db.test.ts` isolates its own.
 */

const PREFIX = "link-person-entry-fixture";
const AUTHOR = "author@fixture.test";

const ROSE = "00000000-0000-4000-8000-0000e2520001";
const THOMAS = "00000000-0000-4000-8000-0000e2520002";
const LOOSE_PAGE = "00000000-0000-4000-8000-0000e2520003";

const PEOPLE = [ROSE, THOMAS];

/** Revisions cascade with their page, so deleting the pages is enough. */
async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PEOPLE));
  await db.delete(schema.pages).where(eq(schema.pages.id, LOOSE_PAGE));
  await db.delete(schema.pages).where(like(schema.pages.slug, `${PREFIX}%`));
}

beforeEach(async () => {
  await removeFixture();

  await db.insert(schema.individuals).values([
    { id: ROSE, givenName: `${PREFIX} Rose`, surname: "Hale" },
    { id: THOMAS, givenName: `${PREFIX} Thomas`, surname: "Hale" },
  ]);

  await db.insert(schema.pages).values({
    id: LOOSE_PAGE,
    slug: `${PREFIX}-loose`,
    title: `${PREFIX} an entry nobody claims`,
    bodyHtml: "<p>Written before anyone was linked to it.</p>",
    updatedBy: AUTHOR,
  });
});

afterAll(removeFixture);

async function readPerson(id: string) {
  const [person] = await db
    .select()
    .from(schema.individuals)
    .where(eq(schema.individuals.id, id));
  return person;
}

async function readRevisions(pageId: string) {
  return db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.pageId, pageId));
}

describe("createEntryForPerson", () => {
  it("creates an entry titled with the person's name and links it", async () => {
    const result = await createEntryForPerson({
      personId: ROSE,
      createdBy: AUTHOR,
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const [page] = await db
      .select()
      .from(schema.pages)
      .where(eq(schema.pages.id, result.pageId));

    expect(page.title).toBe(`${PREFIX} Rose Hale`);
    // Creation takes a title and nothing else; the body starts genuinely empty
    // so E1-T6's diff shows the first paragraph as something somebody wrote.
    expect(page.bodyHtml).toBe("");
    expect((await readPerson(ROSE)).pageId).toBe(result.pageId);
  });

  it("starts the entry's history, through E1-T8's own code", async () => {
    // The acceptance criterion in as many words: creation goes through the
    // create-page flow, so revision 1 is written by `writeRevision` exactly as
    // it is for an entry begun at `/wiki/new`.
    const result = await createEntryForPerson({
      personId: ROSE,
      createdBy: AUTHOR,
    });
    if (result.status !== "created") throw new Error(result.status);

    const revisions = await readRevisions(result.pageId);

    expect(revisions).toHaveLength(1);
    expect(revisions[0].id).toBe(result.revisionId);
    expect(revisions[0].title).toBe(`${PREFIX} Rose Hale`);
    expect(revisions[0].createdBy).toBe(AUTHOR);
  });

  it("returns the entry that exists rather than creating a second one", async () => {
    // The panel open in two tabs, or the button pressed twice. The row lock is
    // what makes the second call see the first one's write.
    const first = await createEntryForPerson({
      personId: ROSE,
      createdBy: AUTHOR,
    });
    if (first.status !== "created") throw new Error(first.status);

    const second = await createEntryForPerson({
      personId: ROSE,
      createdBy: AUTHOR,
    });

    expect(second).toEqual({ status: "already-linked", slug: first.slug });
    expect((await readPerson(ROSE)).pageId).toBe(first.pageId);
  });

  it("creates one entry when two calls race", async () => {
    /**
     * The same double-press, with no round trip between the two. Without
     * `for("update")` on the individual both transactions read a null
     * `page_id` and both create an entry — and the loser's is orphaned at an
     * address nobody linked.
     */
    const [first, second] = await raceWriters([
      () => createEntryForPerson({ personId: ROSE, createdBy: AUTHOR }),
      () => createEntryForPerson({ personId: ROSE, createdBy: AUTHOR }),
    ]);

    const created = [first, second].filter(
      (result) => result.status === "created",
    );
    expect(created).toHaveLength(1);

    const pages = await db
      .select()
      .from(schema.pages)
      .where(like(schema.pages.slug, `${PREFIX}%`));

    // The loose fixture page, and exactly one entry about Rose.
    expect(pages).toHaveLength(2);
  });

  it("refuses a person who is not there", async () => {
    expect(
      await createEntryForPerson({
        personId: "00000000-0000-4000-8000-00000000dead",
        createdBy: AUTHOR,
      }),
    ).toEqual({ status: "person-not-found" });
  });

  it("refuses an id that is not a row id at all", async () => {
    // Reaches Postgres as `invalid input syntax for type uuid`, which throws
    // rather than returning no rows. See `lib/row-id.ts`.
    expect(
      await createEntryForPerson({ personId: "nonsense", createdBy: AUTHOR }),
    ).toEqual({ status: "person-not-found" });
  });
});

describe("setPersonEntry", () => {
  it("links a person to an entry that already exists", async () => {
    const result = await setPersonEntry({
      personId: ROSE,
      pageId: LOOSE_PAGE,
    });

    expect(result).toEqual({
      status: "linked",
      slug: `${PREFIX}-loose`,
      title: `${PREFIX} an entry nobody claims`,
    });
    expect((await readPerson(ROSE)).pageId).toBe(LOOSE_PAGE);
  });

  it("unlinks without deleting the entry", async () => {
    // The acceptance criterion `on delete set null` already models: the link
    // goes, the entry stays — with its address, its content and its history.
    await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE });

    expect(await setPersonEntry({ personId: ROSE, pageId: null })).toEqual({
      status: "unlinked",
    });

    expect((await readPerson(ROSE)).pageId).toBeNull();

    const [page] = await db
      .select()
      .from(schema.pages)
      .where(eq(schema.pages.id, LOOSE_PAGE));

    expect(page.slug).toBe(`${PREFIX}-loose`);
    expect(page.bodyHtml).toContain("Written before anyone was linked to it.");
  });

  it("can put back a link that was cleared", async () => {
    // Which is what makes unlinking a safe thing to offer.
    await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE });
    await setPersonEntry({ personId: ROSE, pageId: null });

    expect(
      await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE }),
    ).toMatchObject({ status: "linked" });
    expect((await readPerson(ROSE)).pageId).toBe(LOOSE_PAGE);
  });

  it("refuses an entry somebody else is already linked to", async () => {
    /**
     * `individuals.page_id` has no unique index, so the rule lives in the only
     * code that writes the column. It is worth having because E2-T3 reads the
     * link from the other end, and an entry two people claim has no single
     * answer to "view in tree".
     */
    await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE });

    expect(
      await setPersonEntry({ personId: THOMAS, pageId: LOOSE_PAGE }),
    ).toEqual({ status: "entry-taken", personName: `${PREFIX} Rose Hale` });
    expect((await readPerson(THOMAS)).pageId).toBeNull();
  });

  it("lets only one of two people win a race for the same entry", async () => {
    /**
     * Rose's panel and Thomas's panel, linking to the same entry in the same
     * moment. These are two transactions holding two *different* individual
     * rows, so the person lock orders neither of them — what serialises them
     * is `for("update")` on the entry itself. Without it both read "nobody has
     * this entry" (READ COMMITTED hides the other's uncommitted row) and both
     * write it, which is the state the check exists to prevent.
     */
    const [first, second] = await raceWriters([
      () => setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE }),
      () => setPersonEntry({ personId: THOMAS, pageId: LOOSE_PAGE }),
    ]);

    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["entry-taken", "linked"]);

    const claimants = await db
      .select()
      .from(schema.individuals)
      .where(eq(schema.individuals.pageId, LOOSE_PAGE));

    expect(claimants).toHaveLength(1);
  });

  it("says nothing changed when the link is already what was asked for", async () => {
    await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE });

    expect(
      await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE }),
    ).toEqual({ status: "unchanged" });
  });

  it("says nothing changed when unlinking a person with no entry", async () => {
    expect(await setPersonEntry({ personId: ROSE, pageId: null })).toEqual({
      status: "unchanged",
    });
  });

  it("refuses an entry that is not there", async () => {
    expect(
      await setPersonEntry({
        personId: ROSE,
        pageId: "00000000-0000-4000-8000-00000000dead",
      }),
    ).toEqual({ status: "entry-not-found" });
  });

  it("refuses ids that are not row ids at all", async () => {
    expect(
      await setPersonEntry({ personId: "nonsense", pageId: LOOSE_PAGE }),
    ).toEqual({ status: "person-not-found" });

    expect(
      await setPersonEntry({ personId: ROSE, pageId: "nonsense" }),
    ).toEqual({ status: "entry-not-found" });
  });

  it("refuses a person who is not there", async () => {
    expect(
      await setPersonEntry({
        personId: "00000000-0000-4000-8000-00000000dead",
        pageId: LOOSE_PAGE,
      }),
    ).toEqual({ status: "person-not-found" });
  });
});

describe("deleting an entry", () => {
  it("leaves the person, with the link cleared", async () => {
    // `on delete set null` is the column's own answer to the other direction:
    // an entry can be deleted without taking a person off the tree with it.
    await setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE });

    await db.delete(schema.pages).where(eq(schema.pages.id, LOOSE_PAGE));

    const person = await readPerson(ROSE);
    expect(person).toBeDefined();
    expect(person.pageId).toBeNull();
  });
});
