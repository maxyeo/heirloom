import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import {
  readRetirementPreview,
  restorePage,
  retirePage,
} from "@/lib/retire-page";
import { listRevisionsForPage } from "@/lib/revisions";
import { savePage } from "@/lib/save-page";
import { backdatePages, LAST_WRITTEN } from "@/test/db-timestamps";
import { addedByHand } from "@/test/people-fixtures";

/**
 * Retiring an entry and putting it back (E1-T10, `YEO-122`) — the half only a
 * real Postgres can answer.
 *
 * `lib/retirement-preview.test.ts` owns the arithmetic, which is pure and runs
 * under `npm test` where CI's `check` job can see it. What is left for this
 * file is what lives in SQL and in the transaction:
 *
 *   - the two columns are written and cleared together;
 *   - retiring twice is `already-retired` rather than a second write, and the
 *     first retirement's author survives it;
 *   - **`updated_at` does not move**, across a retire *and* a restore. This is
 *     the assertion nothing else in the suite would catch, and the one whose
 *     absence would be invisible for months — see below;
 *   - **the revisions are untouched**, byte for byte, across the round trip;
 *   - the entry comes back at the slug it never gave up.
 *
 * ## Why `updated_at` gets its own strict assertion
 *
 * Because bumping it is the natural implementation and it is wrong in a way
 * nothing on screen shows. While the entry is retired it is filtered out of
 * the recently-changed feed, so a bump is invisible; the cost lands on the
 * *restore*, months later, when a years-old entry arrives at the top of
 * "recently changed" as though somebody had just rewritten it. That is a
 * retirement appearing as an event in the feed by the back door, which E1-T10
 * puts out of scope, and `savePage` already refuses to do the same thing for a
 * no-op save in as many words.
 *
 * `backdatePages` is what lets the assertion be an equality rather than a
 * comparison. See `test/db-timestamps.ts`: Postgres records `now()` to
 * microseconds and `Date` carries milliseconds, so a fixture written moments
 * earlier could compare equal to a bump and pass by accident.
 */

/** Explicit, recognisable ids. `122` is the ticket. */
const ENTRY_ID = "00000000-0000-4000-8000-000000012201";
const LINKER_ID = "00000000-0000-4000-8000-000000012202";
const PERSON_ID = "00000000-0000-4000-8000-000000012203";

const SLUG = "retire-page-fixture-rose";
const LINKER_SLUG = "retire-page-fixture-walter";

const PAGE_IDS = [ENTRY_ID, LINKER_ID];

const RETIRED_BY = "rose@example.com";

async function removeFixture() {
  // The person first: `individuals.page_id` is `on delete set null`, so the
  // order does not matter for the constraint — it matters for the assertion
  // that a retirement left the link alone, which a half-torn-down fixture
  // could not make.
  await db
    .delete(schema.individuals)
    .where(eq(schema.individuals.id, PERSON_ID));
  await db.delete(schema.pages).where(inArray(schema.pages.id, PAGE_IDS));
}

/** The entry's `deleted_at` / `deleted_by` / `updated_at`, straight from SQL. */
async function readRow() {
  const [row] = await db
    .select({
      deletedAt: schema.pages.deletedAt,
      deletedBy: schema.pages.deletedBy,
      updatedAt: schema.pages.updatedAt,
      slug: schema.pages.slug,
    })
    .from(schema.pages)
    .where(eq(schema.pages.id, ENTRY_ID));

  return row;
}

beforeEach(async () => {
  // Also before, not just after: an interrupted run skips the teardown and
  // would otherwise greet the next one with a duplicate key on a unique slug.
  await removeFixture();

  await db.insert(schema.pages).values([
    {
      id: ENTRY_ID,
      slug: SLUG,
      title: "Rose Hall",
      bodyHtml: '<p>Rose lived here. <img src="/api/images/entries/a.jpg"></p>',
    },
    {
      id: LINKER_ID,
      slug: LINKER_SLUG,
      title: "Walter Hall",
      bodyHtml: `<p>He married <a href="/wiki/${SLUG}">Rose</a>.</p>`,
    },
  ]);

  // A person pointing at the entry, so the "left alone" criterion has
  // something to be true of.
  await db
    .insert(schema.individuals)
    .values(
      addedByHand([
        { id: PERSON_ID, givenName: "Rose", surname: "Hall", pageId: ENTRY_ID },
      ]),
    );

  // Two revisions, through the real write path, so the history this file
  // asserts is untouched is history the application actually wrote.
  await savePage({
    slug: SLUG,
    title: "Rose Hall",
    // The photograph stays in the body across the save, so `imageCount` is a
    // count of what the entry currently shows rather than of what the fixture
    // happened to insert first.
    bodyHtml:
      '<p>Rose lived here, and later in Toronto. <img src="/api/images/entries/a.jpg"></p>',
    editedBy: "walter@example.com",
  });

  // Last, and after the saves, because `savePage` moves `updated_at` itself.
  await backdatePages(...PAGE_IDS);
});

afterAll(removeFixture);

describe("retirePage", () => {
  it("writes both columns and reports what it cost", async () => {
    const result = await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    expect(result.status).toBe("retired");
    if (result.status !== "retired") return;

    // The preview comes from inside the writing transaction, so this is what
    // the database actually did rather than an echo of the confirmation.
    expect(result.preview).toMatchObject({
      slug: SLUG,
      title: "Rose Hall",
      subjectName: "Rose Hall",
      imageCount: 1,
    });
    expect(result.preview.incomingLinks).toEqual([
      { slug: LINKER_SLUG, title: "Walter Hall" },
    ]);
    expect(result.preview.revisionCount).toBeGreaterThan(0);

    const row = await readRow();
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.deletedBy).toBe(RETIRED_BY);
  });

  it("does not move updated_at", async () => {
    // The assertion nothing else would catch. See the file docblock: the cost
    // of getting this wrong lands on a restore months later, as an entry
    // nobody edited climbing the recently-changed feed.
    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    expect((await readRow()).updatedAt).toEqual(LAST_WRITTEN);
  });

  it("appends no revision", async () => {
    // A retirement changes nothing the entry says, so a history row recording
    // it would be the no-op revision `savePage` refuses to write. The
    // acceptance criterion is that the revisions are untouched, and the way to
    // satisfy it is not to touch them.
    const before = await listRevisionsForPage(ENTRY_ID);

    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    expect(await listRevisionsForPage(ENTRY_ID)).toEqual(before);
  });

  it("leaves individuals.page_id alone", async () => {
    // The last acceptance criterion, and it is a property of the write: one
    // `UPDATE` against two columns of `pages` cannot reach `individuals`.
    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    const [person] = await db
      .select({ pageId: schema.individuals.pageId })
      .from(schema.individuals)
      .where(eq(schema.individuals.id, PERSON_ID));

    expect(person.pageId).toBe(ENTRY_ID);
  });

  it("refuses a second retirement without overwriting the first", async () => {
    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });
    const first = await readRow();

    const again = await retirePage({
      slug: SLUG,
      retiredBy: "someone-else@example.com",
    });

    expect(again).toEqual({ status: "already-retired", pageId: ENTRY_ID });

    // The point of the `FOR UPDATE` lock, stated as an assertion: without it
    // the second write lands and the tombstone credits the wrong person for a
    // decision they did not make.
    const after = await readRow();
    expect(after.deletedBy).toBe(RETIRED_BY);
    expect(after.deletedAt).toEqual(first.deletedAt);
  });

  it("answers not-found for a slug no row holds", async () => {
    await expect(
      retirePage({ slug: `${SLUG}-nonexistent`, retiredBy: RETIRED_BY }),
    ).resolves.toEqual({ status: "not-found" });
  });
});

describe("restorePage", () => {
  it("clears both columns and returns the original address", async () => {
    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    await expect(restorePage(SLUG)).resolves.toEqual({
      status: "restored",
      pageId: ENTRY_ID,
      // The acceptance criterion, and it is satisfied by there being nothing
      // to do about it: the tombstone kept the address the whole time.
      slug: SLUG,
    });

    const row = await readRow();
    expect(row.deletedAt).toBeNull();
    // Cleared alongside, not kept: a `deleted_by` with no `deleted_at` beside
    // it is a half-fact nothing reads. See `lib/retire-page.ts`.
    expect(row.deletedBy).toBeNull();
    expect(row.slug).toBe(SLUG);
  });

  it("refuses to restore an entry that is not retired", async () => {
    await expect(restorePage(SLUG)).resolves.toEqual({
      status: "not-retired",
      pageId: ENTRY_ID,
    });
  });

  it("answers not-found for a slug no row holds", async () => {
    await expect(restorePage(`${SLUG}-nonexistent`)).resolves.toEqual({
      status: "not-found",
    });
  });
});

describe("the round trip", () => {
  it("leaves the entry exactly as it found it", async () => {
    const revisionsBefore = await listRevisionsForPage(ENTRY_ID);

    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });
    await restorePage(SLUG);

    const row = await readRow();

    // Back at its original slug, with its history intact — the two halves of
    // the acceptance criterion, and `updated_at` unmoved so the entry returns
    // to the position in the recently-changed feed it left from rather than
    // to the top of it.
    expect(row).toEqual({
      slug: SLUG,
      deletedAt: null,
      deletedBy: null,
      updatedAt: LAST_WRITTEN,
    });
    expect(await listRevisionsForPage(ENTRY_ID)).toEqual(revisionsBefore);
  });
});

describe("readRetirementPreview", () => {
  it("reads the same facts the write reports", async () => {
    // One function on both sides is the property `lib/removal-preview.ts`
    // established; this is it asserted rather than claimed. Nothing changes
    // between the two calls, so anything but equality here is the confirmation
    // and the result disagreeing about an entry nobody touched.
    const shown = await readRetirementPreview(SLUG);
    const written = await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    expect(written.status).toBe("retired");
    if (written.status !== "retired") return;

    expect(shown).toEqual(written.preview);
  });

  it("answers null for an entry that is already retired", async () => {
    // Folded together with "no such entry" on purpose: there is no retirement
    // to confirm in either case, and the route turns both into one 404.
    await retirePage({ slug: SLUG, retiredBy: RETIRED_BY });

    await expect(readRetirementPreview(SLUG)).resolves.toBeNull();
  });

  it("answers null for a slug no row holds", async () => {
    await expect(
      readRetirementPreview(`${SLUG}-nonexistent`),
    ).resolves.toBeNull();
  });

  it("does not count a link from an entry that is itself retired", async () => {
    // A link in a retired entry's body turns red nowhere a reader can see,
    // because nothing renders that entry. Counting it would inflate the one
    // number on the confirmation somebody might act on.
    await retirePage({ slug: LINKER_SLUG, retiredBy: RETIRED_BY });

    const preview = await readRetirementPreview(SLUG);

    expect(preview?.incomingLinks).toEqual([]);
  });
});
