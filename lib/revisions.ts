import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/db";

/**
 * ## Why this module exists
 *
 * Two primitives, because two future tickets each need a different slice of
 * the same table. YEO-20 (diff view) needs the full body of two revisions by
 * id, to render them side by side. YEO-21 (one-click restore) needs the full
 * body of one revision plus the page it belongs to, to copy the former onto
 * the latter — the same shape `lib/save-page.ts` already writes. This file's
 * job is to hand back exactly those two shapes so neither ticket has to touch
 * this module to get what it needs; they build on `getRevisionById` and, for
 * the list this ticket renders, `listRevisionsForPage`.
 */

/**
 * A row in the history list. Enough to render one line — when, and by whom —
 * and to link onward. Not the content: see `listRevisionsForPage` for why
 * `bodyHtml` is missing on purpose.
 */
export type RevisionSummary = {
  id: string;
  createdAt: Date;
  createdBy: string | null;
};

/**
 * A single revision in full, for the page that renders one (E1-T5's detail
 * view) or diffs/restores one (YEO-20, YEO-21).
 *
 * `pageId` is included even though every caller already knows which page they
 * asked about *by slug* — it is what lets a caller check that the revision it
 * got back actually belongs to that page, rather than to some other entry
 * that happens to share a UUID prefix in a URL someone hand-edited. Without
 * it, a revision id copied from one entry's history and pasted into another
 * entry's URL would render under the wrong title. See
 * `app/wiki/[slug]/history/[revisionId]/page.tsx`, which is the caller that
 * does this check.
 */
export type RevisionDetail = {
  id: string;
  pageId: string;
  title: string;
  bodyHtml: string;
  createdAt: Date;
  createdBy: string | null;
};

/**
 * The reverse-chronological history of one page, newest first.
 *
 * Takes `pageId`, not `slug`. The composite index this query is built to use —
 * `revisions_page_id_created_at_idx`, on `(page_id, created_at)` — leads on
 * `page_id`, and a caller holding only a slug would need a second lookup to
 * get one anyway. That lookup already happens: the caller resolves the slug
 * through `getPageBySlug` first, in order to 404 on a slug no row holds, and
 * that call hands back the id this function wants. Taking the id here keeps
 * this module from repeating a query its caller has already made.
 *
 * The `.where` is equality on the index's leading column and the `.orderBy`
 * is a descending scan of the second — exactly what a composite index on
 * `(page_id, created_at)` serves, satisfied as a single backward index scan
 * with no separate sort step.
 *
 * `bodyHtml` is deliberately not selected. A history list renders a column of
 * dates and names; every revision this page has ever had can be, in
 * aggregate, the entire article rewritten dozens of times over, and pulling
 * each one's full HTML across the wire to render a timestamp would make the
 * list page's cost scale with the article's edit count rather than with the
 * number of rows on screen. `getRevisionById` is where the body lives, loaded
 * one row at a time, for the page that actually renders it.
 */
export async function listRevisionsForPage(
  pageId: string,
): Promise<RevisionSummary[]> {
  return db
    .select({
      id: schema.revisions.id,
      createdAt: schema.revisions.createdAt,
      createdBy: schema.revisions.createdBy,
    })
    .from(schema.revisions)
    .where(eq(schema.revisions.pageId, pageId))
    .orderBy(desc(schema.revisions.createdAt));
}

/**
 * Look up one revision by its id, in full.
 *
 * Returns `undefined` on a miss rather than throwing, mirroring
 * `getPageBySlug`'s documented reasoning: a revision id that no longer
 * resolves — mistyped, or from a link into history that has since been
 * pruned — is an ordinary outcome of following a link, not a fault, and it is
 * the caller's job to turn it into a 404 rather than this module's.
 */
export async function getRevisionById(
  revisionId: string,
): Promise<RevisionDetail | undefined> {
  const [revision] = await db
    .select({
      id: schema.revisions.id,
      pageId: schema.revisions.pageId,
      title: schema.revisions.title,
      bodyHtml: schema.revisions.bodyHtml,
      createdAt: schema.revisions.createdAt,
      createdBy: schema.revisions.createdBy,
    })
    .from(schema.revisions)
    .where(eq(schema.revisions.id, revisionId))
    .limit(1);

  return revision;
}
