import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/db";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * The write half of the wiki: one edit becomes one `revisions` row and one
 * `pages` update, or it becomes nothing at all.
 *
 * ## Why this is not in the server action
 *
 * `app/wiki/actions.ts` is the `"use server"` entry point — it authenticates
 * and revalidates. Everything below it is plain TypeScript over Drizzle, which
 * is what makes it testable: `lib/save-page.db.test.ts` calls `savePage`
 * directly against a real Postgres, with no session to fake and no Next.js
 * request scope to stand up. The behaviour worth proving here (the
 * transaction, the row lock, the no-op rule) lives in SQL, so a test that
 * mocked the database would prove nothing. See docs/testing.md.
 *
 * ## Why one transaction
 *
 * A page's history is only trustworthy if it is complete. Writing the revision
 * and updating the page as two statements leaves a window — a crash, a dropped
 * connection, a deploy — in which the page moved forward and history did not.
 * That gap is invisible until someone tries to restore (E1-T7) and finds the
 * step they wanted was never recorded. Inside one transaction there is no
 * window: both rows land or neither does.
 *
 * ## Why the revision stores the new state
 *
 * The alternative — a revision holding the state being *replaced* — is a
 * common shape and the wrong one here. Storing the state being *saved* means
 * the newest revision and the current page always agree, so restoring an old
 * revision (E1-T7) is a copy of that row's fields onto the page, not a
 * reconstruction from an offset chain. It also means every state the page has
 * ever been in has a row of its own, including the current one.
 */

/**
 * The transaction handle Drizzle hands to a `db.transaction` callback.
 *
 * Derived from `db` rather than imported as `PgTransaction<…>` because that
 * type takes four generic parameters, all of which are already fixed by the
 * database instance — spelling them out again would be a second place for the
 * schema to be named, and the first one to go stale when it changes.
 */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Append one row to a page's history.
 *
 * Takes a transaction rather than opening one, which is the whole point: a
 * revision has to land in the same transaction as the write to `pages` that
 * it records, and a helper that opened its own would reintroduce exactly the
 * gap the module header argues against.
 *
 * Shared with `lib/create-page.ts` (E1-T8) and `lib/restore-revision.ts`
 * (E1-T7), so a page's first revision, its hundredth, and the one a restore
 * appends are all written by the same code — including the rule above it, that
 * a revision holds the state being *saved* rather than the one being replaced.
 * The values arrive already trimmed and sanitised, deliberately: this is the
 * last step rather than a second place content gets cleaned up, so there is
 * one answer to what exactly ends up stored.
 *
 * @returns the new revision's id
 */
export async function writeRevision(
  tx: Transaction,
  entry: {
    pageId: string;
    title: string;
    bodyHtml: string;
    editedBy: string;
    /**
     * The revision this content was copied forward from, when the caller is
     * `lib/restore-revision.ts`. Optional because it is the exception: an
     * ordinary save has no source revision, and `undefined` here stores null.
     *
     * Note what this parameter is *not*: it is not the previous revision, and
     * it does not chain. History is ordered by `created_at` and always has
     * been; this records provenance for the one operation whose content does
     * not say where it came from. See `db/schema.ts`.
     */
    restoredFrom?: string;
  },
): Promise<string> {
  const [revision] = await tx
    .insert(schema.revisions)
    .values({
      pageId: entry.pageId,
      title: entry.title,
      bodyHtml: entry.bodyHtml,
      createdBy: entry.editedBy,
      restoredFromId: entry.restoredFrom ?? null,
    })
    .returning({ id: schema.revisions.id });

  return revision.id;
}

export type SavePageEdit = {
  /** Which page. The URL-facing identifier, not the primary key. */
  slug: string;
  /** Plain text. Not HTML — see `title` handling in `savePage`. */
  title: string;
  /** TipTap output. Sanitised here before it reaches either table. */
  bodyHtml: string;
};

export type SavePageInput = SavePageEdit & {
  /** The signed-in author's email. Written to both rows. */
  editedBy: string;
};

/**
 * Every way a save can end, as a value rather than an exception.
 *
 * `unchanged` and `not-found` are ordinary outcomes a UI renders, not faults:
 * the first is someone pressing save twice, the second is a page deleted in
 * another tab. Throwing for either would push both into an error boundary and
 * lose the distinction. A genuine fault — the database being unreachable, a
 * constraint violation — still throws, and rolls the transaction back with it.
 */
export type SavePageResult =
  | { status: "saved"; pageId: string; revisionId: string }
  | { status: "unchanged"; pageId: string }
  | { status: "empty-title" }
  | { status: "not-found" };

/**
 * Persist an edit and its history entry together.
 *
 * @param input the edit, plus the email to attribute it to
 * @returns what happened, including the ids the caller may want to link to
 */
export async function savePage(input: SavePageInput): Promise<SavePageResult> {
  /**
   * The title is plain text and is rendered as plain text, so it is trimmed
   * rather than passed through `sanitizeHtml`. Running the sanitiser over it
   * would entity-encode the punctuation in ordinary names — "Tom & Jerry"
   * becomes "Tom &amp; Jerry" — and that stored value is then wrong for every
   * consumer that is not an HTML renderer: the `<title>` tag, a search index,
   * a GEDCOM export. React already escapes text children, which is the actual
   * defence.
   */
  const title = input.title.trim();
  if (!title) return { status: "empty-title" };

  const bodyHtml = sanitizeHtml(input.bodyHtml);

  return db.transaction(async (tx): Promise<SavePageResult> => {
    /**
     * `FOR UPDATE` holds the row until this transaction commits, which is what
     * makes the no-op check below trustworthy under concurrency. Without it,
     * two saves of the same content can both read the old row, both conclude
     * that something changed, and both write a revision — producing a pair of
     * identical history entries from a single edit. With it, the second
     * transaction blocks, then re-reads the row the first one committed (READ
     * COMMITTED re-evaluates the row after the lock is granted) and correctly
     * finds nothing to do.
     */
    const [page] = await tx
      .select({
        id: schema.pages.id,
        title: schema.pages.title,
        bodyHtml: schema.pages.bodyHtml,
      })
      .from(schema.pages)
      .where(eq(schema.pages.slug, input.slug))
      .for("update");

    // Creating a page is E1-T8's job, not this action's. A slug with no row
    // means it was deleted, or that someone POSTed here directly.
    if (!page) return { status: "not-found" };

    /**
     * Comparison is against the values that would actually be written, after
     * trimming and sanitising, so "no actual change" means "the row would not
     * change" rather than "the author typed the same thing". Two consequences
     * worth stating: pressing save on an untouched page writes nothing at all,
     * not even an `updated_at` bump — a page that nobody edited must not climb
     * the recently-changed feed (E8-T4). And an existing row whose stored HTML
     * predates the sanitiser (a seed, a manual `UPDATE`) does count as changed,
     * because saving it genuinely rewrites it.
     */
    if (page.title === title && page.bodyHtml === bodyHtml) {
      return { status: "unchanged", pageId: page.id };
    }

    const revisionId = await writeRevision(tx, {
      pageId: page.id,
      title,
      bodyHtml,
      editedBy: input.editedBy,
    });

    /**
     * `now()` rather than a JavaScript `Date`, because `revisions.created_at`
     * defaults to `now()` too and Postgres returns the *transaction's* start
     * time for both. The page and its newest revision therefore carry exactly
     * the same timestamp, so history can be ordered against the page without
     * a millisecond of skew deciding which came first.
     */
    await tx
      .update(schema.pages)
      .set({
        title,
        bodyHtml,
        updatedAt: sql`now()`,
        updatedBy: input.editedBy,
      })
      .where(eq(schema.pages.id, page.id));

    return { status: "saved", pageId: page.id, revisionId };
  });
}
