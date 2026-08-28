import { and, eq, ne, sql } from "drizzle-orm";

import { db, schema } from "@/db";
import { readEntryCategories } from "@/lib/categories";
import { getEntryPerson } from "@/lib/entry-person";
import { LIVE_PAGES } from "@/lib/live-pages";
import { formatPersonName } from "@/lib/person-format";
import {
  type EntryText,
  previewRetirement,
  type RetirementPreview,
} from "@/lib/retirement-preview";

/**
 * Retiring an entry, and putting it back (E1-T10, `YEO-122`).
 *
 * ## Why a module rather than two lines in the action
 *
 * The reason `lib/save-page.ts` and `lib/remove-from-tree.ts` are modules:
 * `app/wiki/actions.ts` is `"use server"`, so it authenticates and
 * revalidates, and everything below it is plain TypeScript over Drizzle that
 * `lib/retire-page.db.test.ts` can call against a real Postgres with no
 * session to fake. The behaviour worth proving here — the lock, the two
 * idempotent outcomes, that the revisions and `individuals.page_id` are
 * untouched — lives in SQL, so a test that mocked the database would prove
 * nothing (docs/testing.md).
 *
 * ## What a retirement writes, and the two things it deliberately does not
 *
 * One `UPDATE`, setting `deleted_at` and `deleted_by`. That is the whole
 * write, and the two omissions are decisions rather than oversights.
 *
 * **It does not append a revision.** `revisions` is the history of what an
 * entry *said*, and a retirement changes nothing about what it says — the
 * title, the body, the hatnote and the filing are byte for byte what they were
 * a moment before. A revision recording them again would be a history row
 * saying an edit happened that did not, which is the exact thing `savePage`'s
 * no-op rule exists to keep out of the list. The acceptance criterion is that
 * the revisions are untouched, and the way to satisfy it is not to touch them.
 * The retirement has its own two-column audit trail, which is what
 * `deleted_by` is for.
 *
 * **It does not move `updated_at`.** That column means "when the content last
 * changed", `pages_updated_at_idx` is ordered on it, and the recently-changed
 * feed reads it — so bumping it here would have two consequences and neither
 * is wanted. While the entry is retired it is filtered out of the feed
 * anyway, so the bump would be invisible; the moment somebody restored it, it
 * would arrive at the top of "recently changed" as though it had just been
 * rewritten, which is a claim about the content that is not true. A
 * retirement appearing in the feed *as an event of its own* is a reasonable
 * thing to want and is explicitly out of this ticket's scope, because it is a
 * change to the feed's schema rather than a timestamp to reuse.
 *
 * Restoring is the same write with nulls in it, and the same two omissions for
 * the same reasons — which is what makes "put it back where it was" literally
 * true rather than approximately.
 *
 * ## Why the preview is computed again in here
 *
 * `lib/remove-from-tree.ts`'s pattern, and its argument. The confirmation
 * screen renders `previewRetirement` against one read; this recomputes it
 * inside the writing transaction and hands the result back, so what the reader
 * is told afterwards describes what actually happened rather than echoing a
 * preview that may have gone stale while they read it. Somebody adding a link
 * to this entry from another tab in between is the ordinary way that happens.
 *
 * It costs one whole-table read of `slug`, `title`, `body_html` and `hatnote`
 * — the same read `lib/image-references.ts` performs on every sweep and a
 * fraction of what `lib/export-full.ts` does — for a corpus that is a family's
 * few hundred entries (docs/architecture.md). The row lock held while it runs
 * is on the single row being retired, and nothing else in the codebase takes
 * that lock and then reads every page, so there is no ordering here to
 * deadlock against.
 */

/** Which entry, and who is retiring it. */
export type RetirePageInput = {
  /** The URL-facing identifier, as the route knows it. */
  slug: string;
  /** The signed-in member's email. Written to `deleted_by`. */
  retiredBy: string;
};

/**
 * Every way a retirement can end, as a value rather than an exception — the
 * same shape and the same reasoning as `SavePageResult`.
 *
 * `already-retired` is not a failure. It is a second tab, a double-press, or a
 * back button onto a confirmation for an entry somebody has already retired,
 * and the honest answer is that the entry is in the state the reader asked
 * for. It carries no preview, because there is no consequence left to report:
 * whatever turned red, turned red the first time.
 */
export type RetirePageResult =
  | { status: "retired"; pageId: string; preview: RetirementPreview }
  | { status: "already-retired"; pageId: string }
  | { status: "not-found" };

/**
 * Every way a restore can end.
 *
 * `not-retired` is `already-retired`'s mirror and is an outcome rather than a
 * fault for the same reason: two people pressing Restore on one tombstone
 * should produce one restore and one "it is already back", not an error.
 */
export type RestorePageResult =
  | { status: "restored"; pageId: string; slug: string }
  | { status: "not-retired"; pageId: string }
  | { status: "not-found" };

/**
 * Retire an entry: it leaves the index, search, the category listings and the
 * link graph, and everything about it stays in the database.
 *
 * @param input which entry, and the email to attribute the retirement to
 * @returns what happened, with the consequences as they were at the moment of
 *   the write
 */
export async function retirePage(
  input: RetirePageInput,
): Promise<RetirePageResult> {
  return db.transaction(async (tx): Promise<RetirePageResult> => {
    /**
     * `FOR UPDATE`, for the reason `savePage` takes it: it is what makes the
     * "is it already retired" check below trustworthy under concurrency. Two
     * people confirming the same retirement at the same moment must produce
     * one retirement and one `already-retired` — without the lock both
     * transactions read a live row, both write, and the second silently
     * overwrites the first's `deleted_by` with its own, so the entry records
     * the wrong person as having retired it.
     */
    const [page] = await tx
      .select({
        id: schema.pages.id,
        slug: schema.pages.slug,
        title: schema.pages.title,
        bodyHtml: schema.pages.bodyHtml,
        hatnote: schema.pages.hatnote,
        deletedAt: schema.pages.deletedAt,
      })
      .from(schema.pages)
      .where(eq(schema.pages.slug, input.slug))
      .for("update");

    if (!page) return { status: "not-found" };
    if (page.deletedAt !== null) {
      return { status: "already-retired", pageId: page.id };
    }

    // Read before the write, so `otherEntries` is the set of entries that were
    // live when this entry still was — which is what "these links turn red"
    // is a statement about.
    const preview = await readRetirementPreviewIn(tx, page);

    /**
     * `sql\`now()\`` rather than a JavaScript `Date`, matching `savePage` and
     * `restoreRevision`: Postgres evaluates it once per transaction, so the
     * timestamp is the instant of the write as the database understands it
     * rather than whenever this process happened to build the statement.
     *
     * `updatedAt` is deliberately absent from this `set`, and the module
     * docblock says why — it is the *restore* that makes bumping it wrong,
     * not the retirement.
     */
    await tx
      .update(schema.pages)
      .set({ deletedAt: sql`now()`, deletedBy: input.retiredBy })
      .where(eq(schema.pages.id, page.id));

    return { status: "retired", pageId: page.id, preview };
  });
}

/**
 * Put a retired entry back at the address it never left.
 *
 * "Its original slug" is the acceptance criterion and it is satisfied by there
 * being nothing to do about it: the `slug` unique constraint stayed, the
 * tombstone kept the address the whole time, and `lib/create-page.ts` refuses
 * to mint a near-twin at it (see `retiredEntryAt`). So a restore is two nulls,
 * and the entry comes back into the index, into search and into every link
 * that had turned red.
 *
 * @param slug which entry, as the route knows it
 * @returns what happened, with the address to send the reader to
 */
export async function restorePage(slug: string): Promise<RestorePageResult> {
  return db.transaction(async (tx): Promise<RestorePageResult> => {
    // The same lock, for the mirror of the same reason: two presses of one
    // Restore button must produce one restore and one "it is already back".
    const [page] = await tx
      .select({
        id: schema.pages.id,
        slug: schema.pages.slug,
        deletedAt: schema.pages.deletedAt,
      })
      .from(schema.pages)
      .where(eq(schema.pages.slug, slug))
      .for("update");

    if (!page) return { status: "not-found" };
    if (page.deletedAt === null) {
      return { status: "not-retired", pageId: page.id };
    }

    /**
     * Nulls, not a flag flipped back. `deleted_by` is cleared alongside
     * `deleted_at` rather than kept as a record of who once retired this: a
     * `deleted_by` with no `deleted_at` beside it is a state nothing reads and
     * every reader would have to decide what to do with, and the partial index
     * is keyed on `deleted_at` alone. Who retired an entry that has since been
     * restored is a question for a retirement *log*, which is the same
     * feed-schema change the ticket puts out of scope.
     */
    await tx
      .update(schema.pages)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(schema.pages.id, page.id));

    return { status: "restored", pageId: page.id, slug: page.slug };
  });
}

/**
 * The consequences of retiring this entry, for the confirmation screen.
 *
 * The read half of `previewRetirement`, run against the pool rather than
 * inside a transaction — this one is answering a question for a page render,
 * where a slightly stale answer is the ordinary condition of every rendered
 * page and the write path recomputes it anyway.
 *
 * @param slug which entry, as the route knows it
 * @returns the preview, or null when there is no live entry at that address —
 *   which covers both "no such entry" and "already retired", because the
 *   confirmation screen has nothing useful to say about either and the route
 *   turns both into the same 404
 */
export async function readRetirementPreview(
  slug: string,
): Promise<RetirementPreview | null> {
  const [page] = await db
    .select({
      id: schema.pages.id,
      slug: schema.pages.slug,
      title: schema.pages.title,
      bodyHtml: schema.pages.bodyHtml,
      hatnote: schema.pages.hatnote,
    })
    .from(schema.pages)
    .where(and(eq(schema.pages.slug, slug), LIVE_PAGES))
    .limit(1);

  if (!page) return null;

  return readRetirementPreviewIn(db, page);
}

/** Anything that can run a `select` — the pool, or a transaction. */
type Reader = Pick<typeof db, "select">;

/**
 * The four reads behind a preview, against whichever connection the caller
 * has.
 *
 * `Promise.all` rather than sequentially, unlike `readEntryInfobox` next door:
 * every one of these is needed on every call, so there is no common case that
 * pays for a query it does not use. Inside a transaction they still run one
 * after another on the one connection, which is the correct behaviour there —
 * a transaction is a single session — and costs nothing this page's render
 * budget notices.
 */
async function readRetirementPreviewIn(
  reader: Reader,
  entry: { id: string } & EntryText,
): Promise<RetirementPreview> {
  const [otherEntries, revisionCount, categories, subject] = await Promise.all([
    /**
     * Every other live entry, with the two columns a link can be written in.
     *
     * `LIVE_PAGES` here is the preview's own version of the argument
     * `lib/retirement-preview.ts` makes: a link from an entry that has itself
     * been retired turns red nowhere a reader can see it, because nothing
     * renders that entry's body. `ne` excludes this entry as well, which the
     * pure function would do anyway by slug — done here too so the row does
     * not travel for nothing.
     */
    reader
      .select({
        slug: schema.pages.slug,
        title: schema.pages.title,
        bodyHtml: schema.pages.bodyHtml,
        hatnote: schema.pages.hatnote,
      })
      .from(schema.pages)
      .where(and(LIVE_PAGES, ne(schema.pages.id, entry.id))),
    /**
     * How many versions are kept, as a count rather than as the rows.
     *
     * The confirmation says a number and the history tab renders the list, so
     * fetching every revision's title and body here to call `.length` on them
     * would pull an entry's entire prose history across the wire for one
     * integer. This is the one place in the preview where the aggregate is
     * cheaper than the rows, so it is the one place that uses one.
     */
    reader
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.revisions)
      .where(eq(schema.revisions.pageId, entry.id)),
    readEntryCategories(entry.id),
    getEntryPerson(entry.id),
  ]);

  return previewRetirement({
    entry,
    otherEntries,
    revisionCount: revisionCount[0]?.count ?? 0,
    categories,
    subjectName: subject
      ? formatPersonName(subject.givenName, subject.surname)
      : null,
  });
}
