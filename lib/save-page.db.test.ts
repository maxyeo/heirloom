import { asc, desc, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { savePage } from "@/lib/save-page";
import { raceWriters } from "@/test/db-concurrency";
import { backdatePages } from "@/test/db-timestamps";

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
// A second author, for the assertions about who a save is attributed to.
const OTHER_EDITOR = "other-editor@fixture.test";

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
 *
 * Both rows are then backdated, which is what makes the `updatedAt` assertions
 * below deterministic rather than a race against the clock's resolution — see
 * `test/db-timestamps.ts`.
 */
beforeEach(async () => {
  await removeFixture();
  await db.insert(schema.pages).values([
    { id: PAGE, slug: SLUG, ...ORIGINAL },
    { id: OTHER_PAGE, slug: OTHER_SLUG, title: "Untouched", bodyHtml: "<p>." },
  ]);
  await backdatePages(PAGE, OTHER_PAGE);
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

    // Strictly greater, which is only deterministic because the fixture was
    // backdated. Compared against the row read back rather than against
    // `LAST_WRITTEN` directly, so this still fails if `beforeEach` ever stops
    // applying the date it thinks it is applying.
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
   * revisions and two `saved` results — provided the two calls genuinely
   * overlap, which is what `raceWriters` is for (`test/db-concurrency.ts`).
   */
  it("writes one revision when two identical saves race", async () => {
    const edit = {
      slug: SLUG,
      title: "Raced",
      bodyHtml: "<p>Raced.</p>",
      editedBy: EDITOR,
    };

    const results = await raceWriters([
      () => savePage(edit),
      () => savePage(edit),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["saved", "unchanged"]);
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

  /**
   * The hatnote (E11-T9, `YEO-79`), which is authored text and therefore has
   * to travel with the rest of it — into the row, into history, and into the
   * no-op rule that decides whether an edit happened at all.
   */
  describe("the hatnote", () => {
    it("writes it to the page and to the revision together", async () => {
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        hatnote: '<p>Not the <a href="/wiki/ship">ship</a>.</p>',
        editedBy: EDITOR,
      });

      const page = await readPage();
      const revisions = await readRevisions();

      // Narrowed on the way in: the wrapper `<p>` is gone and the link is not.
      expect(page.hatnote).toBe('Not the <a href="/wiki/ship">ship</a>.');
      expect(revisions).toHaveLength(1);
      expect(revisions[0].hatnote).toBe(page.hatnote);
    });

    it("counts a hatnote-only edit as a change", async () => {
      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        hatnote: "For the house, see elsewhere.",
        editedBy: EDITOR,
      });

      // Nothing else moved, so without the hatnote in the comparison this
      // would report `unchanged` and the line would never reach the row.
      expect(result).toMatchObject({ status: "saved" });
      expect(await readRevisions()).toHaveLength(1);
    });

    it("counts re-saving the same hatnote as no change at all", async () => {
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        hatnote: "For the house, see elsewhere.",
        editedBy: EDITOR,
      });

      // The comparison is against the value that *would be written*, so a
      // hatnote that only differs by a wrapper the narrowing removes is the
      // same hatnote — and pressing save must not append a history row.
      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        hatnote: "<p>For the house, see elsewhere.</p>",
        editedBy: EDITOR,
      });

      expect(result).toMatchObject({ status: "unchanged" });
      expect(await readRevisions()).toHaveLength(1);
    });

    it("clears one when the field comes back empty", async () => {
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        hatnote: "Temporary.",
        editedBy: EDITOR,
      });

      // What the editor posts for an emptied field: `<p></p>`, not `""`. It
      // has to reach the column as the empty string, or the line above the
      // lead never goes away.
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        hatnote: "<p></p>",
        editedBy: EDITOR,
      });

      expect((await readPage()).hatnote).toBe("");
    });

    it("stores nothing for a caller that does not mention it", async () => {
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: "<p>No opinion about hatnotes.</p>",
        editedBy: EDITOR,
      });

      expect((await readPage()).hatnote).toBe("");
    });
  });
  describe("the categories (E11-T8)", () => {
    /**
     * `savePage` writes the filing inside its own transaction, so what is
     * asserted here is the *interaction* with the rest of the save — the no-op
     * rule, and which of `pages` and `revisions` a re-filing is allowed to
     * touch. What filing an entry does to `page_categories` is asserted in
     * `lib/categories.db.test.ts`, against `setEntryCategories` directly.
     */
    const CATEGORY = "Save Page Fixture Category";
    const CATEGORY_SLUG = "save-page-fixture-category";
    const OTHER_CATEGORY = "Save Page Fixture Second";

    afterAll(async () => {
      await db
        .delete(schema.categories)
        .where(like(schema.categories.slug, "save-page-fixture-%"));
    });

    async function categoryNames(pageId = PAGE) {
      const rows = await db
        .select({ name: schema.categories.name })
        .from(schema.pageCategories)
        .innerJoin(
          schema.categories,
          eq(schema.categories.id, schema.pageCategories.categoryId),
        )
        .where(eq(schema.pageCategories.pageId, pageId));
      return rows.map((row) => row.name).sort();
    }

    it("files the entry as part of the same save", async () => {
      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: "<p>Filed.</p>",
        categories: [CATEGORY],
        editedBy: EDITOR,
      });

      expect(result).toMatchObject({ status: "saved" });
      expect(await categoryNames()).toEqual([CATEGORY]);
    });

    it("appends a revision for a re-filing, and records the filing in it", async () => {
      /**
       * The decision `YEO-106` made, and the reversal of what E11-T8 left. A
       * save that moves only the filing is an edit like any other: it appends
       * one revision, that revision holds the new filing, and the entry climbs
       * the recently-changed feed with the person who did it on it — so the
       * feed has a revision behind every row it shows.
       */
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: EDITOR,
      });
      const before = await readPage();
      const revisionsBefore = await readRevisions();

      await backdatePages(PAGE);

      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY, OTHER_CATEGORY],
        editedBy: OTHER_EDITOR,
      });

      expect(result.status).toBe("saved");
      const revisions = await readRevisions();
      expect(revisions).toHaveLength(revisionsBefore.length + 1);

      const newest = revisions.at(-1);
      expect(newest?.categories).toEqual(
        [CATEGORY, OTHER_CATEGORY].sort((a, b) => (a < b ? -1 : 1)),
      );
      // The body did not move, so the revision is a copy of the text plus the
      // new filing — which is what makes a restore of it total.
      expect(newest?.bodyHtml).toBe(ORIGINAL.bodyHtml);
      expect(newest?.createdBy).toBe(OTHER_EDITOR);

      const after = await readPage();
      expect(after.updatedBy).toBe(OTHER_EDITOR);
      expect(after.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );
      expect(await categoryNames()).toEqual([OTHER_CATEGORY, CATEGORY].sort());
    });

    it("carries a revision id when the article changed too", async () => {
      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: "<p>Both moved.</p>",
        categories: [CATEGORY],
        editedBy: EDITOR,
      });

      expect(result).toMatchObject({ status: "saved" });
      if (result.status !== "saved") return;
      expect(result.revisionId).toEqual(expect.any(String));
    });

    it("records the filing a caller said nothing about", async () => {
      /**
       * The other half of "a revision is the entry's whole state" (`YEO-106`).
       * This save moves the body and expresses no opinion about the filing, so
       * the filing does not move — but the revision still has to record it, or
       * restoring this revision later would quietly un-file the entry.
       */
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: EDITOR,
      });

      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: "<p>Body only.</p>",
        editedBy: EDITOR,
      });

      expect((await readRevisions()).at(-1)?.categories).toEqual([CATEGORY]);
    });

    it("gives the recently-changed feed a revision to attribute it to", async () => {
      /**
       * The invariant `YEO-106` restored, asserted for the save that used to
       * break it — and the ticket's acceptance criterion about the feed, which
       * is the same fact read from the other end.
       *
       * `listRecentlyChangedEntries` selects exactly `pages.updated_at` and
       * `pages.updated_by` and joins nothing (see `lib/recent-changes.ts` for
       * why it must not join `revisions`). So "the feed does not present a
       * change it cannot attribute" is precisely the claim that those two
       * columns always have a revision standing behind them: same instant,
       * same author. Between E11-T8 and `YEO-106` a re-filing broke it — the
       * page moved and history did not — which is what this asserts is over.
       *
       * The sibling assertion near the top of this file makes the same check
       * for a save that changed the article.
       */
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: EDITOR,
      });

      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY, OTHER_CATEGORY],
        editedBy: OTHER_EDITOR,
      });

      const page = await readPage();
      const newest = (await readRevisions()).at(-1);

      expect(newest?.createdAt).toEqual(page.updatedAt);
      expect(newest?.createdBy).toBe(page.updatedBy);
      expect(page.updatedBy).toBe(OTHER_EDITOR);
    });

    it("writes nothing at all when neither the article nor the filing moved", async () => {
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: EDITOR,
      });
      const before = await readPage();

      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: OTHER_EDITOR,
      });

      // Not even an `updated_at` bump — an entry nobody edited must not climb
      // the recently-changed feed (E8-T4).
      expect(result).toEqual({ status: "unchanged", pageId: PAGE });
      expect(await readPage()).toEqual(before);
    });

    it("leaves the filing alone for a caller that does not mention it", async () => {
      /**
       * The difference between `undefined` and `[]`, which is the whole reason
       * the field is optional rather than defaulted. A direct POST written
       * against the older shape of this action sends neither, and reading that
       * as "file this entry under nothing" would silently strip the categories
       * off every entry such a caller saved.
       */
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: EDITOR,
      });

      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: "<p>No opinion about categories.</p>",
        editedBy: EDITOR,
      });

      expect(await categoryNames()).toEqual([CATEGORY]);
    });

    it("un-files the entry when the picker sends an empty list", async () => {
      await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [CATEGORY],
        editedBy: EDITOR,
      });

      const result = await savePage({
        slug: SLUG,
        title: ORIGINAL.title,
        bodyHtml: ORIGINAL.bodyHtml,
        categories: [],
        editedBy: EDITOR,
      });

      expect(result).toMatchObject({ status: "saved" });
      // Un-filing is a change like any other, so it is a revision like any
      // other — and the revision records the empty filing, which is what lets
      // a later restore of an earlier revision put the categories back.
      expect((await readRevisions()).at(-1)?.categories).toEqual([]);
      expect(await categoryNames()).toEqual([]);
      // And the category itself survives being emptied — see
      // `lib/categories.db.test.ts`.
      const [category] = await db
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.slug, CATEGORY_SLUG));
      expect(category).toBeDefined();
    });
  });
});
