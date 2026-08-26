import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/db";
import { setEntryCategories } from "@/lib/categories";
import { normaliseHatnote } from "@/lib/hatnote";
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
 *
 * ## What a revision is not
 *
 * E11-T8 (`YEO-78`) added a third thing a save can move — which categories the
 * entry is filed under — and deliberately did *not* put it in `revisions`.
 * A revision is what the article said; a category is where it is filed, and
 * the two change for different reasons and are read by different people. So a
 * save that only re-files an entry writes no revision at all, and
 * {@link SavePageResult} carries a null `revisionId` to say so. The filing
 * still lands inside this transaction, under the same row lock, because an
 * entry whose text and whose footer bar came from different saves is exactly
 * the inconsistency the paragraph above exists to prevent.
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
    /**
     * The hatnote as it stands at this revision (E11-T9, `YEO-79`), already
     * through `normaliseHatnote`. Required rather than optional, and that is
     * the point: an optional hatnote here would ship green and quietly write
     * `''` on every save that forgot it, which is a line of authored text
     * disappearing from history without an error anywhere. `lib/create-page.ts`
     * passes `""` explicitly, because a new entry genuinely has none.
     */
    hatnote: string;
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
      hatnote: entry.hatnote,
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
  /**
   * The hatnote, as the field submitted it (E11-T9, `YEO-79`). Normalised
   * here, before it reaches either table, on the same terms as the body.
   *
   * Optional, and it is the one field here that is: `undefined` means "this
   * caller has no opinion", which is what a direct POST written against the
   * older shape of this action sends. It is read as an empty hatnote, so the
   * failure is a visible missing line rather than a silent type error — see
   * `savePageAction`, which is where a caller that *does* have an opinion is
   * required to state it as a string.
   */
  hatnote?: string;
  /**
   * What the entry is filed under (E11-T8, `YEO-78`), as the picker submitted
   * them: names, in the author's own order, normalised and de-duplicated
   * further down by `normaliseEntryCategories`.
   *
   * Optional on the same terms as `hatnote` above, and the distinction matters
   * more here. `undefined` means "this caller has no opinion" and leaves the
   * entry's filing exactly as it was; `[]` means "file this entry under
   * nothing" and un-files it. Collapsing the two would make every direct POST
   * written against the older shape of this action silently strip the
   * categories off the entry it was saving. `savePageAction` is where a caller
   * that does have an opinion is required to state it as an array of strings.
   */
  categories?: readonly string[];
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
  | {
      status: "saved";
      pageId: string;
      /**
       * The revision this save appended, or `null` when it appended none
       * (E11-T8, `YEO-78`).
       *
       * `null` has exactly one cause: the only thing the save changed was
       * which categories the entry is filed under. A revision records what the
       * article *said* — title, body, hatnote — and a category is where it is
       * *filed*, so re-filing an entry writes no revision, and a history that
       * showed one would be showing a version whose text is identical to the
       * one above it.
       *
       * Nullable rather than absent so the compiler makes every consumer say
       * which it means. The alternative — a fourth status, `refiled` — was
       * considered and rejected: every caller that switches on the status
       * wants to treat it exactly as `saved` (revalidate, then show the
       * entry), so a new member would be a new case for each of them to
       * forget, in exchange for a distinction only history-adjacent code
       * cares about.
       */
      revisionId: string | null;
    }
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

  /**
   * Narrowed to text and links here rather than trusted from the field, for
   * exactly the reason `bodyHtml` is sanitised here: this is a server action's
   * argument, and the constrained editor in front of it is a convenience for
   * the author, not a boundary. See `lib/hatnote.ts` — the narrowing is a
   * transform over `sanitizeHtml`'s own output, so there is no second
   * allowlist to keep in step with the first.
   */
  const hatnote = normaliseHatnote(input.hatnote);

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
        hatnote: schema.pages.hatnote,
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
    const contentChanged =
      page.title !== title ||
      page.bodyHtml !== bodyHtml ||
      page.hatnote !== hatnote;

    /**
     * The filing (E11-T8, `YEO-78`), applied inside the same transaction and
     * under the same row lock as everything else — so an entry's text and the
     * bar at the foot of it can never describe two different saves.
     *
     * `undefined` is skipped rather than read as an empty list: see
     * `SavePageEdit.categories` for why absent and `[]` have to stay different
     * requests. `setEntryCategories` reports whether it actually moved a row,
     * which is what lets the no-op rule below cover categories too.
     */
    const categoriesChanged =
      input.categories === undefined
        ? false
        : await setEntryCategories(tx, page.id, input.categories);

    /**
     * Comparison is against the values that would actually be written, after
     * trimming and sanitising, so "no actual change" means "the row would not
     * change" rather than "the author typed the same thing". Two consequences
     * worth stating: pressing save on an untouched page writes nothing at all,
     * not even an `updated_at` bump — a page that nobody edited must not climb
     * the recently-changed feed (E8-T4). And an existing row whose stored HTML
     * predates the sanitiser (a seed, a manual `UPDATE`) does count as changed,
     * because saving it genuinely rewrites it.
     *
     * Re-filing an entry counts as a change for the same reason: somebody did
     * edit it, and a reader looking at what changed recently should find it.
     * That the category write above has already happened by the time this
     * returns `unchanged` is not a leak — it returns `unchanged` only when
     * that write moved nothing.
     */
    if (!contentChanged && !categoriesChanged) {
      return { status: "unchanged", pageId: page.id };
    }

    /**
     * A revision records what the article *said*, so a save that only re-filed
     * the entry appends none — see `SavePageResult`'s `revisionId` for the
     * argument, and for why that is a `null` rather than a fourth status.
     */
    const revisionId = contentChanged
      ? await writeRevision(tx, {
          pageId: page.id,
          title,
          bodyHtml,
          hatnote,
          editedBy: input.editedBy,
        })
      : null;

    /**
     * `now()` rather than a JavaScript `Date`, because `revisions.created_at`
     * defaults to `now()` too and Postgres returns the *transaction's* start
     * time for both. The page and its newest revision therefore carry exactly
     * the same timestamp, so history can be ordered against the page without
     * a millisecond of skew deciding which came first.
     *
     * **That equality is now conditional, and E11-T8 (`YEO-78`) is what made
     * it so.** It holds whenever this save wrote a revision, which is every
     * save that changed the article. It does *not* hold after a save that only
     * re-filed the entry: `updated_at` moves and no revision is appended, so
     * the newest revision is older than the page. Nothing reads the equality —
     * what the history view depends on is the weaker and still-unconditional
     * claim that the newest revision's *content* is byte-identical to the
     * page's, which a category has no part in. Stated rather than left to be
     * discovered, because the paragraph above reads like a promise.
     *
     * The title, body and hatnote are written even when only the filing moved.
     * They are the values already in the row in that case, so the statement is
     * a no-op for them and exists for `updated_at` and `updated_by` — which
     * *have* moved, because re-filing an entry is something somebody did, and
     * a reader looking at what changed recently should find it, attributed to
     * whoever did it.
     */
    await tx
      .update(schema.pages)
      .set({
        title,
        bodyHtml,
        hatnote,
        updatedAt: sql`now()`,
        updatedBy: input.editedBy,
      })
      .where(eq(schema.pages.id, page.id));

    return { status: "saved", pageId: page.id, revisionId };
  });
}
