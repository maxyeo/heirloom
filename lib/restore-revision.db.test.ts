import { asc, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { deleteCategory, getCategoryBySlug } from "@/lib/categories";
import { restoreRevision } from "@/lib/restore-revision";
import { savePage } from "@/lib/save-page";
import { raceWriters } from "@/test/db-concurrency";
import { backdatePages } from "@/test/db-timestamps";

/**
 * Database tests for one-click restore (E1-T7). Run with `npm run test:db`;
 * the `.db.test.ts` suffix is what keeps them out of `npm test` and CI's bare
 * environment. See docs/testing.md.
 *
 * The property the whole ticket rests on — that restore is a copy forward and
 * never a delete or an in-place rewrite — is a property of what is in the
 * `revisions` table after the call. It cannot be asserted against a mock,
 * because a mock would only report what it was told to report: the interesting
 * question is whether rows that existed before the restore are still there,
 * unmodified, afterwards. So most of this file takes a snapshot of history and
 * compares it with the same rows read back.
 */

// Explicit ids, so teardown deletes precisely what this file created and
// assertions can ignore whatever else the database already holds.
const PAGE = "00000000-0000-4000-8000-00000000e011";
const OTHER_PAGE = "00000000-0000-4000-8000-00000000e012";
const SLUG = "restore-revision-fixture";
const OTHER_SLUG = "restore-revision-fixture-other";
const AUTHOR = "author@fixture.test";
const RESTORER = "restorer@fixture.test";

const V1 = { title: "Rose Hall", bodyHtml: "<p>One. Two. Three.</p>" } as const;
const V2 = { title: "Rose Hall", bodyHtml: "<p>One.</p>" } as const;

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

/** Oldest first, which is the order these tests reason about. */
async function readRevisions(id = PAGE) {
  return db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.pageId, id))
    .orderBy(asc(schema.revisions.createdAt));
}

afterAll(removeFixture);

/**
 * Rebuilt before every test, as `lib/save-page.db.test.ts` explains: these
 * tests write, and a shared fixture would make each assertion depend on which
 * ones ran before it — including the "nothing was removed" assertions, which
 * would then start passing for the wrong reason.
 *
 * The fixture is built through `savePage` rather than by inserting revisions
 * directly, so what is restored is a history the application actually wrote.
 * Two saves, so there is a genuine earlier version to go back to: V1 has three
 * sentences, V2 has one — the ticket's "I accidentally deleted three
 * paragraphs", in miniature.
 */
beforeEach(async () => {
  await removeFixture();
  await db.insert(schema.pages).values([
    { id: PAGE, slug: SLUG, title: "Rose Hall", bodyHtml: "" },
    { id: OTHER_PAGE, slug: OTHER_SLUG, title: "Untouched", bodyHtml: "<p>." },
  ]);

  await savePage({ slug: SLUG, ...V1, editedBy: AUTHOR });
  await savePage({ slug: SLUG, ...V2, editedBy: AUTHOR });

  // Last, because the two saves above each set `updated_at` to their own
  // `now()` — so the timestamp that has to be older than the restore is one
  // the code under test just wrote, and pinning it at insert time would not
  // survive them. See `test/db-timestamps.ts` for why it has to be older by
  // more than a rounding error. The revisions keep their real timestamps:
  // `readRevisions` orders on them.
  await backdatePages(PAGE, OTHER_PAGE);
});

describe("restoreRevision", () => {
  it("copies the old content onto the page", async () => {
    const [v1] = await readRevisions();

    const result = await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    expect(result).toMatchObject({ status: "restored", pageId: PAGE });

    const page = await readPage();
    expect(page.title).toBe(V1.title);
    expect(page.bodyHtml).toBe(V1.bodyHtml);
  });

  /**
   * The heart of the ticket, stated as an assertion rather than as a comment:
   * after a restore, every row that existed before it is still there, byte for
   * byte, and there is exactly one more row than before.
   *
   * Written against a snapshot of the whole history rather than against a
   * count, because a count would pass for an implementation that deleted V2
   * and inserted two rows. What must hold is that the *same* rows survive.
   */
  it("adds a revision and modifies none of the existing ones", async () => {
    const before = await readRevisions();
    expect(before).toHaveLength(2);

    await restoreRevision({
      slug: SLUG,
      revisionId: before[0].id,
      restoredBy: RESTORER,
    });

    const after = await readRevisions();

    expect(after).toHaveLength(3);
    // Not `toMatchObject` and not a field-by-field comparison: the whole row,
    // so a change to a column this test does not know about still fails it.
    expect(after.slice(0, 2)).toEqual(before);
  });

  it("attributes the new revision to whoever clicked restore", async () => {
    const [v1] = await readRevisions();

    await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    const [, , restored] = await readRevisions();
    const page = await readPage();

    // The restorer decided the entry should say this again; the original
    // author's name stays where it is accurate, on the revision they wrote.
    expect(restored.createdBy).toBe(RESTORER);
    expect(page.updatedBy).toBe(RESTORER);
    expect(v1.createdBy).toBe(AUTHOR);
  });

  it("notes which revision the new one came from", async () => {
    const [v1] = await readRevisions();

    const result = await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    const [, , restored] = await readRevisions();

    expect(restored.restoredFromId).toBe(v1.id);
    // The result names the *new* row, not the one restored from — the caller
    // redirects on it and the two are easy to confuse.
    expect(result).toMatchObject({
      status: "restored",
      revisionId: restored.id,
    });
    // And an ordinary save records no source, so the column distinguishes the
    // two rather than merely being present.
    expect(v1.restoredFromId).toBeNull();
  });

  it("bumps updatedAt to the same instant the new revision records", async () => {
    const [v1] = await readRevisions();
    const before = await readPage();

    await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    const after = await readPage();
    const [, , restored] = await readRevisions();

    // Strictly greater, which is only deterministic because `beforeEach`
    // backdated the page after building its history.
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
    // Both are `now()` inside one transaction, which Postgres evaluates once
    // per transaction — the invariant every other write path maintains.
    expect(after.updatedAt).toEqual(restored.createdAt);
  });

  /**
   * "Restoring is itself undoable, because it is just another revision."
   *
   * Proven by doing it: restore V1 over V2, then restore the revision that
   * held V2 and watch the page arrive back where it started — with no special
   * undo path, and with all four rows intact at the end.
   */
  it("can be undone by restoring the version it replaced", async () => {
    const [v1, v2] = await readRevisions();

    await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });
    expect((await readPage()).bodyHtml).toBe(V1.bodyHtml);

    await restoreRevision({
      slug: SLUG,
      revisionId: v2.id,
      restoredBy: RESTORER,
    });

    const page = await readPage();
    expect(page.bodyHtml).toBe(V2.bodyHtml);

    const history = await readRevisions();
    expect(history).toHaveLength(4);
    expect(history.map((r) => r.bodyHtml)).toEqual([
      V1.bodyHtml,
      V2.bodyHtml,
      V1.bodyHtml,
      V2.bodyHtml,
    ]);
    // The undo is a restore like any other, and says where it came from.
    expect(history[3].restoredFromId).toBe(v2.id);
  });

  /**
   * The no-op rule, decided deliberately: restoring the version the page
   * already holds records nothing. Reached most often by clicking restore on
   * the row the history list marks "(current version)".
   */
  it("writes nothing when the page already matches that version", async () => {
    const revisions = await readRevisions();
    const current = revisions[revisions.length - 1];
    const before = await readPage();

    const result = await restoreRevision({
      slug: SLUG,
      revisionId: current.id,
      restoredBy: RESTORER,
    });

    expect(result).toEqual({ status: "unchanged", pageId: PAGE });
    expect(await readRevisions()).toEqual(revisions);

    // Not even a timestamp: an entry nobody changed must not climb E8-T4's
    // recently-changed feed because someone opened its history.
    const after = await readPage();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.updatedBy).toBe(before.updatedBy);
  });

  it("restores the title as well as the body", async () => {
    await savePage({
      slug: SLUG,
      title: "Rose Hall (renamed)",
      bodyHtml: V2.bodyHtml,
      editedBy: AUTHOR,
    });

    const [v1] = await readRevisions();
    await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    // A revision holds the title that was saved alongside its body, so a
    // restore that brought back only the body would leave the entry in a state
    // no revision ever recorded.
    expect((await readPage()).title).toBe(V1.title);
  });

  /**
   * The cross-entry guard, and the reason it is a security boundary rather
   * than a nicety: revision ids are database-wide, so without this check a
   * revision id lifted from one entry's history and posted against another
   * entry's slug would *overwrite* that entry with the first one's content.
   */
  it("refuses a revision belonging to a different entry", async () => {
    const [v1] = await readRevisions();
    const otherBefore = await readPage(OTHER_PAGE);

    const result = await restoreRevision({
      slug: OTHER_SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    expect(result).toEqual({ status: "not-found" });
    expect(await readPage(OTHER_PAGE)).toEqual(otherBefore);
    expect(await readRevisions(OTHER_PAGE)).toHaveLength(0);
  });

  it("reports a revision id that resolves to nothing", async () => {
    const result = await restoreRevision({
      slug: SLUG,
      revisionId: "00000000-0000-4000-8000-0000000000ff",
      restoredBy: RESTORER,
    });

    expect(result).toEqual({ status: "not-found" });
    expect(await readRevisions()).toHaveLength(2);
  });

  /**
   * A malformed id must come back as an ordinary refusal, not as a raised
   * `invalid input syntax for type uuid`. This is the assertion behind
   * `isRevisionId` living in the library rather than only in the route: the
   * server action is a POST endpoint that can be reached without the route.
   */
  it("refuses an id that is not shaped like one, without raising", async () => {
    const result = await restoreRevision({
      slug: SLUG,
      revisionId: "'; drop table revisions; --",
      restoredBy: RESTORER,
    });

    expect(result).toEqual({ status: "not-found" });
    expect(await readRevisions()).toHaveLength(2);
  });

  it("reports an unknown slug rather than restoring anywhere", async () => {
    const [v1] = await readRevisions();

    const result = await restoreRevision({
      slug: "restore-revision-fixture-no-such-slug",
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    expect(result).toEqual({ status: "not-found" });
    expect(await readRevisions()).toHaveLength(2);
  });

  /**
   * Restore sanitises on the way back in, for the same reason the read routes
   * sanitise on the way out: a revision written before E1-T4, by `db/seed.ts`,
   * or by hand in a SQL console has never been through the sanitiser, and
   * restore is precisely the operation that takes such a row and makes it the
   * live page again. Inserted directly here because `savePage` cannot produce
   * one — which is the point.
   */
  it("sanitises a revision that never went through the sanitiser", async () => {
    const [unsafe] = await db
      .insert(schema.revisions)
      .values({
        pageId: PAGE,
        title: "Hand written",
        bodyHtml: "<p>Safe.</p><script>alert(1)</script>",
        createdBy: null,
      })
      .returning({ id: schema.revisions.id });

    await restoreRevision({
      slug: SLUG,
      revisionId: unsafe.id,
      restoredBy: RESTORER,
    });

    const page = await readPage();
    expect(page.bodyHtml).toBe("<p>Safe.</p>");

    // And the row it was restored *from* is left exactly as it was found: the
    // sanitiser cleans what is written, and restore rewrites nothing.
    const [stored] = await db
      .select()
      .from(schema.revisions)
      .where(eq(schema.revisions.id, unsafe.id));
    expect(stored.bodyHtml).toBe("<p>Safe.</p><script>alert(1)</script>");
  });

  /**
   * The reason `restoreRevision` selects `FOR UPDATE`, mirroring the race
   * `lib/save-page.db.test.ts` takes seriously for edits: a double-clicked
   * button must produce one new revision, not two identical ones. The second
   * transaction blocks on the lock, re-reads the row the first committed, and
   * its no-op check then answers the right question.
   *
   * `raceWriters` (`test/db-concurrency.ts`) is what makes the two calls
   * genuinely overlap; fired at a cold pool they do not, and this would pass
   * with the lock removed.
   */
  it("writes one revision when two identical restores race", async () => {
    const [v1] = await readRevisions();
    const restore = {
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    };

    const results = await raceWriters([
      () => restoreRevision(restore),
      () => restoreRevision(restore),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "restored",
      "unchanged",
    ]);
    expect(await readRevisions()).toHaveLength(3);
    expect((await readPage()).bodyHtml).toBe(V1.bodyHtml);
  });

  it("leaves other entries alone", async () => {
    const [v1] = await readRevisions();

    await restoreRevision({
      slug: SLUG,
      revisionId: v1.id,
      restoredBy: RESTORER,
    });

    expect(await readPage(OTHER_PAGE)).toMatchObject({ title: "Untouched" });
    expect(await readRevisions(OTHER_PAGE)).toHaveLength(0);
  });

  /**
   * The hatnote (E11-T9, `YEO-79`). This is the case the column on `revisions`
   * exists for: without it, restore would put the paragraphs back and leave
   * the line above them saying whatever the last save left — succeeding, and
   * being lossy, with nothing anywhere reporting it.
   */
  describe("the hatnote", () => {
    /**
     * The one revision in this entry's history that carries a hatnote.
     *
     * A helper rather than a `find(...)!` at two call sites: the tests below
     * are about restore, and a missing fixture row should fail as a sentence
     * saying the fixture is wrong rather than as a `TypeError` inside the
     * function under test.
     */
    async function revisionCarryingAHatnote() {
      const found = (await readRevisions()).find(
        (revision) => revision.hatnote !== "",
      );
      if (!found) throw new Error("fixture wrote no revision with a hatnote");
      return found;
    }

    it("goes back with the rest of the content", async () => {
      await savePage({
        slug: SLUG,
        ...V2,
        hatnote: "For the house, see elsewhere.",
        editedBy: AUTHOR,
      });
      await savePage({ slug: SLUG, ...V2, hatnote: "", editedBy: AUTHOR });
      expect((await readPage()).hatnote).toBe("");

      const withHatnote = await revisionCarryingAHatnote();

      const result = await restoreRevision({
        slug: SLUG,
        revisionId: withHatnote.id,
        restoredBy: RESTORER,
      });

      expect(result).toMatchObject({ status: "restored" });
      expect((await readPage()).hatnote).toBe("For the house, see elsewhere.");
    });

    it("counts a hatnote-only difference as something to restore", async () => {
      await savePage({
        slug: SLUG,
        ...V2,
        hatnote: "Only the hatnote moved.",
        editedBy: AUTHOR,
      });
      await savePage({ slug: SLUG, ...V2, hatnote: "", editedBy: AUTHOR });

      const target = await revisionCarryingAHatnote();

      // Title and body are identical between the two, so the no-op rule would
      // refuse this restore if it did not look at the hatnote.
      await expect(
        restoreRevision({
          slug: SLUG,
          revisionId: target.id,
          restoredBy: RESTORER,
        }),
      ).resolves.toMatchObject({ status: "restored" });
    });
  });

  /**
   * What a restore does about the filing (`YEO-106`).
   *
   * The ticket's acceptance criterion is that this behaviour be "explicit and
   * tested, not incidental", and before `YEO-106` it was exactly incidental:
   * categories were not in `revisions`, so a restore returned the words and
   * silently left the entry filed wherever the last edit had put it. The
   * decision is now that a revision is the entry's whole state, so a restore
   * puts the whole of it back — and these are the assertions that hold that
   * decision in place rather than a docblock claiming it.
   */
  describe("the categories", () => {
    const FILED = "Restore Fixture Filed";
    const REFILED = "Restore Fixture Refiled";
    const FILED_SLUG = "restore-fixture-filed";

    beforeEach(async () => {
      await db
        .delete(schema.categories)
        .where(like(schema.categories.slug, "restore-fixture-%"));
    });

    afterAll(async () => {
      await db
        .delete(schema.categories)
        .where(like(schema.categories.slug, "restore-fixture-%"));
    });

    /** What the entry is filed under right now, alphabetically. */
    async function filing(pageId = PAGE) {
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

    /**
     * The revision this entry was filed under {@link FILED} at.
     *
     * A helper rather than an index into `readRevisions()`, for the reason the
     * hatnote block above gives for its own: these tests are about restore,
     * and a fixture that did not write the row they need should fail saying so
     * rather than as a `TypeError` inside the function under test.
     */
    async function revisionFiledUnder(name: string) {
      const found = (await readRevisions()).find((revision) =>
        revision.categories.includes(name),
      );
      if (!found)
        throw new Error(`fixture wrote no revision filed under ${name}`);
      return found;
    }

    it("puts the filing back along with the content", async () => {
      await savePage({
        slug: SLUG,
        ...V1,
        categories: [FILED],
        editedBy: AUTHOR,
      });
      await savePage({
        slug: SLUG,
        ...V2,
        categories: [REFILED],
        editedBy: AUTHOR,
      });
      expect(await filing()).toEqual([REFILED]);

      const target = await revisionFiledUnder(FILED);

      const result = await restoreRevision({
        slug: SLUG,
        revisionId: target.id,
        restoredBy: RESTORER,
      });

      expect(result).toMatchObject({ status: "restored" });
      // Both halves, because "total" is the claim: the words *and* where the
      // entry sits, as one revision had them.
      expect((await readPage()).bodyHtml).toBe(V1.bodyHtml);
      expect(await filing()).toEqual([FILED]);
    });

    it("counts a filing-only difference as something to restore", async () => {
      await savePage({
        slug: SLUG,
        ...V2,
        categories: [FILED],
        editedBy: AUTHOR,
      });
      await savePage({ slug: SLUG, ...V2, categories: [], editedBy: AUTHOR });

      const target = await revisionFiledUnder(FILED);

      // Title, body and hatnote are identical between the page and the target,
      // so the no-op rule would refuse this restore if it did not look at the
      // filing — which is the shape the hatnote test above asserts for the
      // hatnote, one column later.
      await expect(
        restoreRevision({
          slug: SLUG,
          revisionId: target.id,
          restoredBy: RESTORER,
        }),
      ).resolves.toMatchObject({ status: "restored" });

      expect(await filing()).toEqual([FILED]);
    });

    it("records the restored filing on the revision it appends", async () => {
      await savePage({
        slug: SLUG,
        ...V1,
        categories: [FILED],
        editedBy: AUTHOR,
      });
      await savePage({ slug: SLUG, ...V2, categories: [], editedBy: AUTHOR });

      const target = await revisionFiledUnder(FILED);
      await restoreRevision({
        slug: SLUG,
        revisionId: target.id,
        restoredBy: RESTORER,
      });

      // The appended row is a full snapshot like any other, so restoring *it*
      // later is as total as restoring its source — which is what "restoring
      // is itself undoable" has to mean once the filing is part of a revision.
      expect((await readRevisions()).at(-1)?.categories).toEqual([FILED]);
    });

    it("re-creates a category that has been retired since", async () => {
      await savePage({
        slug: SLUG,
        ...V1,
        categories: [FILED],
        editedBy: AUTHOR,
      });
      await savePage({ slug: SLUG, ...V2, categories: [], editedBy: AUTHOR });

      const target = await revisionFiledUnder(FILED);

      /**
       * The heading is retired between the edit and the restore, which is the
       * case that decides whether storing *names* in `revisions.categories`
       * was the right call. An id would be dangling here and the restore would
       * have to drop the category — quietly losing one of the headings the
       * entry used to sit under, which is the lossiness this whole block is
       * about. A name can be filed under again, by the same find-or-create any
       * save uses.
       */
      expect(await deleteCategory(FILED_SLUG)).toBe(true);
      expect(await getCategoryBySlug(FILED_SLUG)).toBeUndefined();

      await restoreRevision({
        slug: SLUG,
        revisionId: target.id,
        restoredBy: RESTORER,
      });

      expect(await filing()).toEqual([FILED]);
      expect(await getCategoryBySlug(FILED_SLUG)).toBeDefined();
    });

    it("leaves the page and its newest revision on the same instant", async () => {
      await savePage({
        slug: SLUG,
        ...V1,
        categories: [FILED],
        editedBy: AUTHOR,
      });
      await savePage({ slug: SLUG, ...V2, categories: [], editedBy: AUTHOR });

      const target = await revisionFiledUnder(FILED);
      await restoreRevision({
        slug: SLUG,
        revisionId: target.id,
        restoredBy: RESTORER,
      });

      // The same invariant `lib/save-page.db.test.ts` asserts for a save. A
      // restore is a save by another name, so it keeps it too.
      const page = await readPage();
      expect((await readRevisions()).at(-1)?.createdAt).toEqual(page.updatedAt);
    });
  });
});
