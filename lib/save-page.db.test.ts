import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { savePage } from "@/lib/save-page";

/**
 * Database tests for the save action's write path. Run with `npm run test:db`;
 * the `.db.test.ts` suffix is what keeps them out of `npm test` and CI's bare
 * environment. See docs/testing.md.
 *
 * Everything asserted here is a property of Postgres rather than of
 * TypeScript — a transaction, a row lock, a `now()` default, an `ORDER BY`.
 * Mocking Drizzle would leave all of it unproven, which is exactly the case
 * docs/testing.md reserves this project for.
 */

// Explicit ids, so teardown deletes precisely what this file created and
// assertions can ignore whatever else the database already holds.
const PAGE = "00000000-0000-4000-8000-00000000e001";
const OTHER_PAGE = "00000000-0000-4000-8000-00000000e002";
const SLUG = "save-page-fixture";
const OTHER_SLUG = "save-page-fixture-untouched";
const EDITOR = "editor@fixture.test";

const ORIGINAL = { title: "Rose Fixture", bodyHtml: "<p>Before.</p>" } as const;

/** Revisions cascade with their page, so deleting the pages is enough. */
async function removeFixture() {
  await db
    .delete(schema.pages)
    .where(inArray(schema.pages.id, [PAGE, OTHER_PAGE]));
}

async function readPage(id = PAGE) {
  const [page] = await db
    .select()
    .from(schema.pages)
    .where(eq(schema.pages.id, id));
  return page;
}

/**
 * Force a second pool connection open before a test needs two at once.
 *
 * postgres.js opens connections on demand, and opening one costs an order of
 * magnitude more than a whole transaction against a local Postgres. So two
 * saves fired at a cold pool do not actually overlap: the first finishes while
 * the second is still shaking hands, and the race test below then passes
 * whether or not `savePage` locks anything. Two deliberately slow queries in
 * parallel leave both connections open and idle, after which concurrency in
 * the test means concurrency in the database.
 */
async function warmPool() {
  await Promise.all([
    db.execute(sql`select pg_sleep(0.05)`),
    db.execute(sql`select pg_sleep(0.05)`),
  ]);
}

async function readRevisions(id = PAGE) {
  return db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.pageId, id))
    .orderBy(asc(schema.revisions.createdAt));
}

afterAll(removeFixture);

/**
 * Rebuilt before every test rather than once for the file, because these tests
 * write. A shared fixture would make each assertion depend on the order the
 * ones before it ran in — and the "no revision was written" assertions would
 * silently start passing for the wrong reason.
 *
 * Cleaning up before inserting (as well as after) also means an interrupted
 * run, which skips `afterAll`, does not greet the next one with a duplicate
 * key on these fixed ids.
 */
beforeEach(async () => {
  await removeFixture();
  await db.insert(schema.pages).values([
    { id: PAGE, slug: SLUG, ...ORIGINAL },
    { id: OTHER_PAGE, slug: OTHER_SLUG, title: "Untouched", bodyHtml: "<p>." },
  ]);
});

describe("savePage", () => {
  it("writes a revision and updates the page together", async () => {
    const result = await savePage({
      slug: SLUG,
      title: "Rose Fixture, née Hall",
      bodyHtml: "<p>After.</p>",
      editedBy: EDITOR,
    });

    expect(result).toMatchObject({ status: "saved", pageId: PAGE });

    const page = await readPage();
    const revisions = await readRevisions();

    expect(page).toMatchObject({
      title: "Rose Fixture, née Hall",
      bodyHtml: "<p>After.</p>",
    });
    expect(revisions).toHaveLength(1);
    // The design note the whole ticket turns on: the newest revision holds the
    // state that was saved, so it and the page agree. E1-T7's restore is a copy
    // of one of these rows onto the page precisely because of this.
    expect(revisions[0]).toMatchObject({
      pageId: PAGE,
      title: page.title,
      bodyHtml: page.bodyHtml,
    });
  });

  it("attributes both rows to the session email", async () => {
    await savePage({
      slug: SLUG,
      title: ORIGINAL.title,
      bodyHtml: "<p>Attributed.</p>",
      editedBy: EDITOR,
    });

    const page = await readPage();
    const [revision] = await readRevisions();

    expect(page.updatedBy).toBe(EDITOR);
    expect(revision.createdBy).toBe(EDITOR);
  });

  it("bumps updatedAt to the same instant the revision records", async () => {
    const before = await readPage();

    await savePage({
      slug: SLUG,
      title: ORIGINAL.title,
      bodyHtml: "<p>Later.</p>",
      editedBy: EDITOR,
    });

    const after = await readPage();
    const [revision] = await readRevisions();

    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
    // Both are `now()` inside one transaction, which Postgres evaluates once
    // per transaction — so E8-T4's feed and the history list cannot disagree
    // about when this edit happened.
    expect(after.updatedAt).toEqual(revision.createdAt);
  });

  it("sanitises the body before it reaches either table", async () => {
    await savePage({
      slug: SLUG,
      title: ORIGINAL.title,
      bodyHtml: '<p>Safe.</p><script>alert(1)</script><img src="x">',
      editedBy: EDITOR,
    });

    const page = await readPage();
    const [revision] = await readRevisions();

    expect(page.bodyHtml).toBe("<p>Safe.</p>");
    // Sanitising on write is only worth anything if history is sanitised too:
    // a payload preserved in a revision comes straight back on restore.
    expect(revision.bodyHtml).toBe("<p>Safe.</p>");
  });

  it("trims the title", async () => {
    await savePage({
      slug: SLUG,
      title: "  Rose Fixture, trimmed  ",
      bodyHtml: ORIGINAL.bodyHtml,
      editedBy: EDITOR,
    });

    const page = await readPage();
    expect(page.title).toBe("Rose Fixture, trimmed");
  });

  it("writes nothing when the save changes nothing", async () => {
    const before = await readPage();

    const result = await savePage({
      slug: SLUG,
      ...ORIGINAL,
      editedBy: EDITOR,
    });

    expect(result).toEqual({ status: "unchanged", pageId: PAGE });
    expect(await readRevisions()).toHaveLength(0);

    // Not even a timestamp: a page nobody edited must not climb E8-T4's
    // recently-changed feed just because someone opened it and pressed save.
    const after = await readPage();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toBeNull();
  });

  it("treats a title that differs only in whitespace as no change", async () => {
    const result = await savePage({
      slug: SLUG,
      title: `\n  ${ORIGINAL.title}  `,
      bodyHtml: ORIGINAL.bodyHtml,
      editedBy: EDITOR,
    });

    expect(result).toMatchObject({ status: "unchanged" });
    expect(await readRevisions()).toHaveLength(0);
  });

  it("still saves when only the body changed", async () => {
    await savePage({
      slug: SLUG,
      title: ORIGINAL.title,
      bodyHtml: "<p>Body only.</p>",
      editedBy: EDITOR,
    });

    expect(await readRevisions()).toHaveLength(1);
    expect((await readPage()).title).toBe(ORIGINAL.title);
  });

  it("rejects an empty title without touching the page", async () => {
    const result = await savePage({
      slug: SLUG,
      title: "   ",
      bodyHtml: "<p>Would have been saved.</p>",
      editedBy: EDITOR,
    });

    expect(result).toEqual({ status: "empty-title" });
    expect(await readRevisions()).toHaveLength(0);
    expect((await readPage()).bodyHtml).toBe(ORIGINAL.bodyHtml);
  });

  it("reports an unknown slug rather than creating a page", async () => {
    const result = await savePage({
      slug: "save-page-fixture-no-such-slug",
      title: "New",
      bodyHtml: "<p>New.</p>",
      editedBy: EDITOR,
    });

    expect(result).toEqual({ status: "not-found" });
    const [orphan] = await db
      .select()
      .from(schema.pages)
      .where(eq(schema.pages.slug, "save-page-fixture-no-such-slug"));
    expect(orphan).toBeUndefined();
  });

  it("leaves other pages alone", async () => {
    await savePage({
      slug: SLUG,
      title: "Only this one",
      bodyHtml: "<p>Only this one.</p>",
      editedBy: EDITOR,
    });

    expect(await readPage(OTHER_PAGE)).toMatchObject({ title: "Untouched" });
    expect(await readRevisions(OTHER_PAGE)).toHaveLength(0);
  });

  /**
   * The reason `savePage` selects `FOR UPDATE`. Two saves of the same content
   * arriving at once — a double-clicked button, a retried request — must not
   * each read the pre-edit row, each decide something changed, and each append
   * a revision. The lock makes the second transaction wait and then re-read,
   * at which point its no-op check is answering the right question.
   *
   * Remove the `.for("update")` from `savePage` and this fails with two
   * revisions and two `saved` results — provided the pool is warm, which is
   * the only reason `warmPool` exists.
   */
  it("writes one revision when two identical saves race", async () => {
    await warmPool();

    const edit = {
      slug: SLUG,
      title: "Raced",
      bodyHtml: "<p>Raced.</p>",
      editedBy: EDITOR,
    };

    const results = await Promise.all([savePage(edit), savePage(edit)]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "saved",
      "unchanged",
    ]);
    expect(await readRevisions()).toHaveLength(1);
    expect((await readPage()).bodyHtml).toBe("<p>Raced.</p>");
  });

  /**
   * Append-only history: consecutive edits each get their own row, and the
   * newest one is the page. This is what makes E1-T5's list and E1-T7's
   * restore straightforward reads rather than reconstructions.
   */
  it("appends a row per edit, newest agreeing with the page", async () => {
    for (const n of [1, 2, 3]) {
      await savePage({
        slug: SLUG,
        title: `Rose Fixture v${n}`,
        bodyHtml: `<p>Version ${n}.</p>`,
        editedBy: EDITOR,
      });
    }

    const revisions = await readRevisions();
    expect(revisions.map((r) => r.title)).toEqual([
      "Rose Fixture v1",
      "Rose Fixture v2",
      "Rose Fixture v3",
    ]);

    const [newest] = await db
      .select()
      .from(schema.revisions)
      .where(eq(schema.revisions.pageId, PAGE))
      .orderBy(desc(schema.revisions.createdAt))
      .limit(1);
    const page = await readPage();

    expect(newest).toMatchObject({
      title: page.title,
      bodyHtml: page.bodyHtml,
    });
  });
});
