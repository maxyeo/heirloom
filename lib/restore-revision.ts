import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/db";
import { setEntryCategories } from "@/lib/categories";
import { normaliseHatnote } from "@/lib/hatnote";
import { isRevisionId } from "@/lib/revision-format";
import { getRevisionById } from "@/lib/revisions";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { writeRevision } from "@/lib/save-page";

/**
 * One-click restore (E1-T7, `YEO-21`): put an entry back the way an older
 * revision had it, by *appending* that content rather than by reaching back
 * for it.
 *
 * ## Why this is a copy forward and never a rewind
 *
 * docs/product.md promises that "nothing is ever destroyed", and offers
 * one-click restore as the recovery story that replaces a database backup.
 * That promise only holds if restore itself cannot destroy anything — so this
 * module does exactly what a save does: it writes a new `revisions` row and
 * updates `pages` to match. It never deletes a revision, never edits one in
 * place, and never truncates history back to a chosen point.
 *
 * Three consequences fall out of that, and all three are the ticket's
 * acceptance criteria rather than side effects:
 *
 *   - the revision being restored *from* is untouched, so restoring the same
 *     version twice, or restoring the wrong one, costs nothing;
 *   - the state the page was in immediately before the restore is still the
 *     second-newest revision, with a restore control of its own — which is
 *     what "restoring is itself undoable" means concretely. Undoing a restore
 *     is not a special operation; it is a restore;
 *   - the new row is attributed to whoever clicked restore, not to the author
 *     of the old revision. They are the person who decided the entry should
 *     say this again, and history should name the person who made the
 *     decision, not the one whose words were chosen.
 *
 * ## What a restore puts back (`YEO-106`)
 *
 * All of it: the title, the body, the hatnote, **and the categories the entry
 * was filed under at that revision.**
 *
 * That last one is new, and it was not new by accident. Between E11-T8
 * (`YEO-78`) and `YEO-106` categories lived only in `page_categories`, so a
 * restore returned the words and left the filing wherever the last edit had
 * put it. There was a case for that — the filing is a decision about where an
 * entry belongs rather than about what it says, and it is not obvious that
 * winding the prose back should wind that decision back too — but nobody had
 * made it, and "arguably correct, decided by nobody" is what `YEO-106` exists
 * to end. The decision is: a revision is the entry's whole state, so a restore
 * restores the whole of it, and an entry after a restore is indistinguishable
 * from the entry as it stood at the revision restored from.
 *
 * A category the revision names but that has since been retired is re-created,
 * by the ordinary find-or-create in `setEntryCategories`. That falls out of
 * storing names rather than ids (`db/schema.ts`) and it is the right outcome:
 * the alternative is a restore that silently drops one of the headings the
 * entry used to sit under, which is the lossiness this section is about.
 *
 * ## Why it is not `savePage`
 *
 * The same reason `lib/create-page.ts` gives for its own existence: `savePage`
 * takes an edit from a browser, and this takes a reference to a row. Routing
 * restore through it would mean the content made a round trip out to a client
 * and back — the one path on which it could be altered in transit, which is
 * precisely what a restore must not allow. Here the content is read from the
 * database and written back to the database; the caller never supplies it, and
 * a direct POST to the server action cannot substitute its own.
 *
 * What *is* shared is the part worth sharing: `writeRevision` appends the
 * history row here exactly as it does for a save and for a creation, inside
 * one transaction, so a restored revision is written by the same code and
 * follows the same rule as every other revision.
 */

export type RestoreRevisionInput = {
  /** Which entry. The URL-facing identifier, as the route knows it. */
  slug: string;
  /** Which revision to copy forward. Untrusted; shape-checked here. */
  revisionId: string;
  /** The signed-in restorer's email. Written to both rows. */
  restoredBy: string;
};

/**
 * Every way a restore can end, as a value rather than an exception — the same
 * shape and the same reasoning as `SavePageResult`: `unchanged` and
 * `not-found` are outcomes a UI renders, not faults.
 *
 * There is no separate `wrong-page` member. A revision belonging to another
 * entry is folded into `not-found` deliberately, exactly as the history detail
 * route folds it into a 404: the caller is asking about a revision that, as
 * far as this entry is concerned, does not exist, and a distinct status would
 * confirm to an unauthorised prober that the id they guessed is real.
 */
export type RestoreRevisionResult =
  | {
      status: "restored";
      pageId: string;
      /** The new row, not the one restored from. */
      revisionId: string;
    }
  | { status: "unchanged"; pageId: string }
  | { status: "empty-title" }
  | {
      /**
       * The entry exists and has been retired (E1-T10, `YEO-122`), so this
       * restore wrote nothing. The same member, with the same name and the
       * same argument, as `SavePageResult`'s — the two write paths into an
       * entry refuse the same condition, and refusing it under two different
       * names would be two sentences for the copy to keep in step.
       */
      status: "retired";
    }
  | { status: "not-found" };

/**
 * Restore an entry to the content of one of its own revisions.
 *
 * @param input which entry, which revision, and who to attribute it to
 * @returns what happened, including the ids the caller may want to link to
 */
export async function restoreRevision(
  input: RestoreRevisionInput,
): Promise<RestoreRevisionResult> {
  /**
   * Shape first, for the reason `isRevisionId` documents at length: this value
   * comes from a URL and a form field, is under no obligation to look like a
   * UUID, and handing a non-UUID to `eq(schema.revisions.id, …)` makes
   * Postgres *raise* rather than return no rows. Checking here rather than
   * only in the route means the server action is covered too — it is a POST
   * endpoint anyone can reach, not just a page anyone can load.
   */
  if (!isRevisionId(input.revisionId)) return { status: "not-found" };

  /**
   * Read the source revision *before* opening the transaction, which is safe
   * for one specific reason: revisions are append-only, so this row cannot
   * change under us — there is no writer anywhere in the codebase that updates
   * `revisions`, only inserts. Reading it inside the transaction instead would
   * mean holding the `pages` row lock taken below while checking out a second
   * pool connection, which is the shape that deadlocks a connection pool under
   * load for no benefit here.
   */
  const source = await getRevisionById(input.revisionId);
  if (!source) return { status: "not-found" };

  return db.transaction(async (tx): Promise<RestoreRevisionResult> => {
    /**
     * `FOR UPDATE`, for the same reason `savePage` takes it: it makes the
     * no-op check below trustworthy under concurrency. Two people clicking
     * restore on the same revision at the same moment must produce one new
     * revision, not two identical ones — the second transaction blocks, then
     * re-reads the row the first committed and correctly finds the page
     * already says what it was asked to make it say.
     */
    const [page] = await tx
      .select({
        id: schema.pages.id,
        title: schema.pages.title,
        bodyHtml: schema.pages.bodyHtml,
        hatnote: schema.pages.hatnote,
        deletedAt: schema.pages.deletedAt,
      })
      .from(schema.pages)
      .where(eq(schema.pages.slug, input.slug))
      .for("update");

    // The slug holds no row at all: never written, or POSTed at directly.
    // Since `YEO-122` this no longer covers the case the comment here used to
    // call "deleted" — an entry is retired rather than deleted, so its row is
    // still here and the branch below is the one that catches it.
    if (!page) return { status: "not-found" };

    /**
     * The entry is there and has been retired (E1-T10, `YEO-122`).
     *
     * Inside the lock, beside the branch above, and refusing for the same
     * reason `savePage` refuses: restoring writes a revision and rewrites the
     * live row, so it is a save arrived at from the history rather than from
     * the editor, and neither belongs in a tombstone.
     *
     * The narrow reason this matters more here than the save path's version of
     * it: the tombstone renders the history tab, and the history tab links to
     * every revision, and each of those links to a restore confirmation. So
     * this is not only reachable by a direct POST — it is reachable by
     * ordinary, sensible navigation from the page the retirement itself sends
     * somebody to. Refusing here, and not merely hiding the link, is what
     * makes that navigation safe to leave working.
     *
     * A `retired` status of its own rather than `not-found`, matching
     * `SavePageResult` and unlike the cross-entry guard below it, for the
     * argument `lib/save-page.ts` sets out at length: there is nothing to
     * conceal from a signed-in editor about an entry they are standing on, and
     * the vague answer would hide the one thing they can do about it.
     */
    if (page.deletedAt !== null) return { status: "retired" };

    /**
     * The cross-entry guard, and the reason this function takes a slug as well
     * as a revision id rather than trusting the id alone. Revision ids are
     * database-wide, so without this check a revision id lifted from one
     * entry's history and posted against another entry's slug would overwrite
     * the second entry with the first one's content — a write, not just a
     * misleading read, which is what makes this a genuine security boundary
     * rather than the cosmetic version of the same check on the detail route.
     */
    if (source.pageId !== page.id) return { status: "not-found" };

    /**
     * Cleaned on the way back in, on the same terms as a save. A revision is
     * not automatically safe just because it is already in the database: rows
     * written before E1-T4, by `db/seed.ts`, or by hand in a SQL console have
     * never been through the sanitiser, and restore is the operation that
     * takes such a row and makes it the live page again. `sanitizeHtml` is
     * idempotent, so for every row the app itself wrote this costs a parse and
     * changes nothing.
     *
     * The comparison below is therefore against the values that would actually
     * be written, which is the same rule `savePage` applies — and it has the
     * same useful consequence: restoring a pre-sanitiser revision onto a
     * pre-sanitiser page *does* count as a change, because it genuinely
     * rewrites the stored HTML.
     */
    const title = source.title.trim();
    const bodyHtml = sanitizeHtml(source.bodyHtml);
    /**
     * And the hatnote (E11-T9, `YEO-79`), narrowed on the way back in for the
     * reason the body is sanitised on the way back in: a stored revision is
     * not safe merely for being in the database, and restore is precisely the
     * operation that makes an old row the live page again. `normaliseHatnote`
     * is idempotent, so for every revision this application wrote it costs a
     * parse and changes nothing.
     */
    const hatnote = normaliseHatnote(source.hatnote);

    /**
     * `revisions.title` is `not null` and every writer trims before inserting,
     * so this is unreachable from the application's own history. It is here
     * for the hand-written row — a data fix, a migration backfill — because
     * the alternative is that restore is the one path in the wiki that can
     * leave an entry with a blank title, and the invariant is worth more than
     * the branch costs.
     */
    if (!title) return { status: "empty-title" };

    /**
     * The no-op rule, applied deliberately rather than inherited.
     *
     * Restoring a revision whose content the page already has is a request for
     * a state the page is already in, and the honest answer is to record
     * nothing. Appending here would add a history row that describes no change
     * — indistinguishable in the list from a real edit — and would bump
     * `updated_at`, pushing an entry nobody actually changed to the top of
     * E8-T4's recently-changed feed. That is the same argument `savePage`
     * makes for declining an unchanged save, and it applies with more force
     * here, because the most common way to reach it is a reader clicking
     * restore on the row marked "(current version)".
     *
     * Nothing is lost by refusing: the entry already reads exactly as the
     * reader asked for it to read. The UI says so rather than reporting a
     * failure.
     *
     * Note which revision this compares against — the *page*, not the newest
     * revision. They agree by construction (see `lib/save-page.ts`), but the
     * page is the row being written, so it is the row that decides whether the
     * write would change anything.
     *
     * The filing is part of the comparison because it is part of the restore
     * (`YEO-106`), and it is asked about the same way `savePage` asks: by
     * doing the write and letting `setEntryCategories` report whether it moved
     * a row. That is not a leak when the answer turns out to be `unchanged` —
     * it returns `unchanged` only when nothing moved, and the transaction
     * commits the same rows it would have had this branch not run at all.
     */
    const filing = await setEntryCategories(tx, page.id, source.categories);

    if (
      page.title === title &&
      page.bodyHtml === bodyHtml &&
      page.hatnote === hatnote &&
      !filing.changed
    ) {
      return { status: "unchanged", pageId: page.id };
    }

    /**
     * The append. `restoredFrom` is what distinguishes this row from someone
     * having retyped the old version by hand — the content alone cannot say
     * where it came from, because it is byte-identical to the row it came
     * from.
     */
    const revisionId = await writeRevision(tx, {
      pageId: page.id,
      title,
      bodyHtml,
      hatnote,
      /**
       * `filing.names` rather than `source.categories`, and the two can
       * genuinely differ. The source revision holds the names as they were
       * spelled then; `setEntryCategories` has just filed the entry under the
       * rows those names resolve to, and where such a row already existed
       * under a different spelling it is the existing spelling the entry is
       * now filed under. Recording what was asked for rather than what
       * happened would make the very next save look like a re-filing.
       */
      categories: filing.names,
      editedBy: input.restoredBy,
      restoredFrom: source.id,
    });

    /**
     * `now()` rather than a JavaScript `Date`, matching `savePage`: Postgres
     * evaluates it once per transaction and `revisions.created_at` defaults to
     * the same call, so the page and the revision recording it carry exactly
     * the same timestamp.
     *
     * `updatedBy` is the restorer. The page's "last changed by" is a statement
     * about who last changed it, and that is the person who clicked restore —
     * the original author's name stays where it is accurate, on the revision
     * they actually wrote.
     */
    await tx
      .update(schema.pages)
      .set({
        title,
        bodyHtml,
        hatnote,
        updatedAt: sql`now()`,
        updatedBy: input.restoredBy,
      })
      .where(eq(schema.pages.id, page.id));

    return { status: "restored", pageId: page.id, revisionId };
  });
}
