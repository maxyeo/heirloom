import { asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { createPage } from "@/lib/create-page";
import { RESERVED_SLUGS, slugFromTitle } from "@/lib/entry-slug";

/**
 * Database tests for the create path (E1-T8). Run with `npm run test:db`; the
 * `.db.test.ts` suffix is what keeps them out of `npm test` and CI's bare
 * environment. See docs/testing.md.
 *
 * The slug *derivation* is a pure function and is tested without a database
 * in `lib/entry-slug.test.ts`. What is left here is everything that is a
 * property of Postgres rather than of TypeScript: the transaction, the unique
 * index deciding which address is free, and the `now()` default that ties a
 * page to its first revision. Mocking Drizzle would leave all of it unproven.
 *
 * These tests cannot use fixed ids the way `lib/save-page.db.test.ts` does —
 * `createPage` inserts the rows and chooses their ids. They are isolated by
 * title instead: every title below derives to a slug under one recognisable
 * prefix, and teardown deletes exactly that prefix.
 */

const PREFIX = "create-page-fixture";
const AUTHOR = "author@fixture.test";

/** A title whose slug is guaranteed to sit under the fixture prefix. */
function title(suffix: string): string {
  return `${PREFIX} ${suffix}`;
}

/**
 * The one test that cannot use the fixture prefix: proving a reserved slug is
 * skipped means asking for the address `new` itself, which by definition does
 * not start with anything. Cleaned up by exact slug instead.
 */
const RESERVED_CASE_SLUGS = ["new", "new-2"];

/** Revisions cascade with their page, so deleting the pages is enough. */
async function removeFixture() {
  await db
    .delete(schema.pages)
    .where(
      or(
        like(schema.pages.slug, `${PREFIX}%`),
        inArray(schema.pages.slug, RESERVED_CASE_SLUGS),
      ),
    );
}

async function readPage(id: string) {
  const [page] = await db
    .select()
    .from(schema.pages)
    .where(eq(schema.pages.id, id));
  return page;
}

async function readRevisions(pageId: string) {
  return db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.pageId, pageId))
    .orderBy(asc(schema.revisions.createdAt));
}

/**
 * Force a second pool connection open before the race test needs two at once.
 * Copied from `lib/save-page.db.test.ts`, for the reason spelled out there:
 * postgres.js opens connections on demand, so two calls fired at a cold pool
 * do not actually overlap and the race test would pass either way.
 */
async function warmPool() {
  await Promise.all([
    db.execute(sql`select pg_sleep(0.05)`),
    db.execute(sql`select pg_sleep(0.05)`),
  ]);
}

afterAll(removeFixture);

// Before as well as after: an interrupted run skips `afterAll`, and these
// tests are about which addresses are free.
beforeEach(removeFixture);

describe("createPage", () => {
  it("creates the page and its first revision together", async () => {
    const result = await createPage({
      title: title("rose hall"),
      createdBy: AUTHOR,
    });

    expect(result).toMatchObject({
      status: "created",
      slug: `${PREFIX}-rose-hall`,
    });
    if (result.status !== "created") return;

    const page = await readPage(result.pageId);
    const revisions = await readRevisions(result.pageId);

    expect(page).toMatchObject({
      slug: `${PREFIX}-rose-hall`,
      title: title("rose hall"),
      // Creation takes a title and nothing else; the body is what the editor
      // the author is about to land in is for.
      bodyHtml: "",
      updatedBy: AUTHOR,
    });

    // The acceptance criterion, stated as an assertion: history starts at
    // revision 1, so nothing the author does next is the first thing that was
    // ever recorded about this entry.
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: result.revisionId,
      title: page.title,
      bodyHtml: page.bodyHtml,
      createdBy: AUTHOR,
    });
  });

  it("stamps the page and its first revision with one instant", async () => {
    const result = await createPage({
      title: title("one instant"),
      createdBy: AUTHOR,
    });
    if (result.status !== "created") throw new Error("expected a page");

    const page = await readPage(result.pageId);
    const [revision] = await readRevisions(result.pageId);

    // Both columns default to `now()`, which Postgres evaluates once per
    // transaction — so E1-T5's history and E8-T4's recently-changed feed
    // cannot disagree about when this entry started.
    expect(page.updatedAt).toEqual(revision.createdAt);
    expect(page.createdAt).toEqual(revision.createdAt);
  });

  it("trims the title", async () => {
    const result = await createPage({
      title: `  ${title("trimmed")}  `,
      createdBy: AUTHOR,
    });
    if (result.status !== "created") throw new Error("expected a page");

    expect((await readPage(result.pageId)).title).toBe(title("trimmed"));
    expect(result.slug).toBe(`${PREFIX}-trimmed`);
  });

  it("refuses an empty title without writing anything", async () => {
    const result = await createPage({ title: "   ", createdBy: AUTHOR });

    expect(result).toEqual({ status: "empty-title" });
    const pages = await db
      .select()
      .from(schema.pages)
      .where(like(schema.pages.slug, `${PREFIX}%`));
    expect(pages).toEqual([]);
  });

  describe("collisions", () => {
    it("suffixes the address rather than failing", async () => {
      const same = { title: title("twice"), createdBy: AUTHOR };

      const first = await createPage(same);
      const second = await createPage(same);
      const third = await createPage(same);

      // Nothing here is an error the author sees. The ticket is explicit:
      // if a URL needs disambiguating, do it silently.
      expect(first).toMatchObject({ slug: `${PREFIX}-twice` });
      expect(second).toMatchObject({ slug: `${PREFIX}-twice-2` });
      expect(third).toMatchObject({ slug: `${PREFIX}-twice-3` });
    });

    it("gives the second entry its own history, starting at one", async () => {
      const same = { title: title("own history"), createdBy: AUTHOR };

      const first = await createPage(same);
      const second = await createPage(same);
      if (first.status !== "created" || second.status !== "created") {
        throw new Error("expected two pages");
      }

      expect(first.pageId).not.toBe(second.pageId);
      expect(await readRevisions(first.pageId)).toHaveLength(1);
      expect(await readRevisions(second.pageId)).toHaveLength(1);
    });

    it("collides two spellings of one name onto one address", async () => {
      // `O'Brien` and `OBrien` derive to the same slug by design — see
      // `lib/entry-slug.ts`. What matters is that the second one is still
      // created, at its own address, rather than refused.
      const first = await createPage({
        title: title("O'Brien"),
        createdBy: AUTHOR,
      });
      const second = await createPage({
        title: title("OBrien"),
        createdBy: AUTHOR,
      });

      expect(first).toMatchObject({ slug: `${PREFIX}-obrien` });
      expect(second).toMatchObject({ slug: `${PREFIX}-obrien-2` });
    });

    it("keeps a non-Latin title's characters in its address", async () => {
      const result = await createPage({
        title: title("日本語"),
        createdBy: AUTHOR,
      });

      // Stored as the characters themselves, so the exact-match lookup in
      // `getPageBySlug` finds it once Next has decoded the URL segment.
      expect(result).toMatchObject({ slug: `${PREFIX}-日本語` });
      expect(slugFromTitle(title("日本語"))).toBe(`${PREFIX}-日本語`);
    });

    /**
     * The `RESERVED_SLUGS` branch, proved end to end rather than only as a
     * property of the set. `lib/entry-slug.test.ts` checks that the set names
     * every static directory under `app/wiki`; nothing there would notice if
     * `createPage` stopped consulting it, and the symptom would be an entry
     * whose address silently renders the create form instead of the entry.
     *
     * This is the one case that cannot wear the fixture prefix — the address
     * under test is `new` itself.
     */
    it("skips an address a static route already answers", async () => {
      const result = await createPage({ title: "New", createdBy: AUTHOR });

      expect(RESERVED_SLUGS.has(slugFromTitle("New"))).toBe(true);
      expect(result).toMatchObject({ status: "created", slug: "new-2" });

      // And it is a real entry, with a real history, rather than a row that
      // merely dodged the collision.
      if (result.status !== "created") throw new Error("expected a page");
      expect(await readRevisions(result.pageId)).toHaveLength(1);
    });

    /**
     * The reason `createPage` inserts with `on conflict do nothing` inside a
     * loop rather than checking whether a slug is free and then taking it.
     * Two family members starting an entry with the same title at the same
     * moment must end up with two entries at two addresses — not one crash,
     * and not one silently lost.
     *
     * Worth being honest about what this proves. The guarantee itself comes
     * from Postgres: `on conflict` uses a speculative insertion, so the loser
     * of a race waits for the winner to commit and then reliably sees the
     * conflict. This test demonstrates that rather than enforcing it — a
     * select-then-insert version would usually fail here, given the warmed
     * pool, but it is two round trips racing rather than one, so failing is a
     * matter of timing. That makes it a weaker guarantee than the `for update`
     * race test in `lib/save-page.db.test.ts`, where the row lock forces the
     * interleaving no matter how the two calls line up.
     */
    it("gives two racing authors two addresses", async () => {
      await warmPool();

      const same = { title: title("raced"), createdBy: AUTHOR };
      const results = await Promise.all([createPage(same), createPage(same)]);

      const slugs = results
        .map((result) => (result.status === "created" ? result.slug : null))
        .sort();
      expect(slugs).toEqual([`${PREFIX}-raced`, `${PREFIX}-raced-2`]);

      for (const result of results) {
        if (result.status !== "created") throw new Error("expected a page");
        expect(await readRevisions(result.pageId)).toHaveLength(1);
      }
    });
  });
});
