import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { RestoreRevisionForm } from "@/components/RestoreRevisionForm";
import { readEntryCategories } from "@/lib/categories";
import { getPageBySlug } from "@/lib/pages";
import { filingOf, restoreWouldChangeNothing } from "@/lib/restore-preview";
import {
  formatRevisionAuthor,
  formatRevisionTimestamp,
  isRevisionId,
  revisionTimestampIso,
} from "@/lib/revision-format";
import { getRevisionById } from "@/lib/revisions";
import { requireSession } from "@/lib/session";

/**
 * The confirmation step of one-click restore (E1-T7, `YEO-21`).
 *
 * Structurally the revision detail route next door, minus the body: the same
 * session-inside-the-loader rule, the same hand-written prop type, the same
 * three-ways-to-miss `undefined` folded into one 404. What it adds is the
 * sentence a reader needs before pressing a button that changes what an entry
 * says — and, deliberately, no preview of the content. The version itself is
 * one link away and is what the reader was just looking at; repeating it here
 * would put a second rendering of stored HTML on the page for no decision it
 * helps with.
 */
export const dynamic = "force-dynamic";

/**
 * Written out rather than taken from the generated `PageProps` helper, for the
 * reason all four sibling routes give: Next only generates it during `next
 * dev`, `next build` or `next typegen`, and CI runs `npm run typecheck` on a
 * fresh checkout before `npm run build`.
 */
type RestorePageProps = {
  params: Promise<{ slug: string; revisionId: string }>;
};

/**
 * The entry and the revision about to be copied forward, loaded once per
 * request.
 *
 * The guards are the detail route's, unchanged and for the same reasons: the
 * id's shape is checked before it can reach a `uuid` column and raise; and the
 * revision must belong to *this* entry, because a revision id is a
 * database-wide identifier and nothing else in the URL ties the two together.
 *
 * These are not the security boundary. `lib/restore-revision.ts` applies both
 * again inside the transaction that does the write, because this page is a
 * render and the server action is a POST endpoint anyone can reach without it.
 * What the checks buy here is that a link nobody should follow 404s instead of
 * rendering a confirmation for a restore that would then be refused.
 */
const loadRestore = cache(async (slug: string, revisionId: string) => {
  await requireSession();

  if (!isRevisionId(revisionId)) return undefined;

  const page = await getPageBySlug(slug);
  if (!page) return undefined;

  const revision = await getRevisionById(revisionId);
  if (!revision || revision.pageId !== page.id) return undefined;

  /**
   * The entry's live filing (`YEO-106`), which the comparison below needs and
   * which `getPageBySlug` deliberately does not carry — it is a join, and the
   * three other routes that call it do not want one.
   *
   * Read after the guards rather than beside the page, so a 404 costs the
   * query it does today. It is inside this `cache()`-wrapped loader, so
   * `generateMetadata` and the render share the one round trip.
   */
  const filing = await readEntryCategories(page.id);

  return { page, revision, filing };
});

export async function generateMetadata({
  params,
}: RestorePageProps): Promise<Metadata> {
  const { slug, revisionId } = await params;
  const loaded = await loadRestore(slug, revisionId);

  if (!loaded) return { title: "Not found" };

  // `requireSession` lives in the loader above rather than here, so this door
  // onto the row is closed too — the same reasoning every route in this
  // segment documents.
  return { title: `Restore an earlier version of ${loaded.page.title}` };
}

export default async function RestoreRevisionPage({
  params,
}: RestorePageProps) {
  const { slug, revisionId } = await params;
  const loaded = await loadRestore(slug, revisionId);

  if (!loaded) notFound();

  const { page, revision, filing } = loaded;

  /**
   * Whether this restore would change anything, answered on the way in.
   *
   * The predicate itself is `lib/restore-preview.ts`, which argues why it is a
   * courtesy rather than a boundary, why it errs towards offering a restore
   * rather than hiding one, and why it is a shared definition instead of the
   * inline title-and-body comparison that used to sit here — that one silently
   * answered "nothing to restore" for a revision whose filing or hatnote
   * differed, hiding the form for a restore that would have worked.
   */
  const alreadyCurrent = restoreWouldChangeNothing(
    {
      title: page.title,
      bodyHtml: page.bodyHtml,
      hatnote: page.hatnote,
      categories: filingOf(filing),
    },
    revision,
  );

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Restore an earlier version</h1>

      <p className="mb-6 text-caption">
        <Link href={`/wiki/${slug}/history/${revision.id}`}>
          Return to this version
        </Link>
        {" · "}
        <Link href={`/wiki/${slug}/history`}>View revision history</Link>
      </p>

      {/*
        The same panel language the detail route's historical banner uses —
        `bg-wash`, `border-rule`, `rounded-panel` — because this is the same
        kind of thing: chrome about an entry rather than the entry itself.
      */}
      <div className="mb-6 rounded-panel border border-rule bg-wash px-4 py-3">
        <p>
          You are about to restore <strong>{page.title}</strong> to the version
          saved{" "}
          <time dateTime={revisionTimestampIso(revision.createdAt)}>
            {formatRevisionTimestamp(revision.createdAt)}
          </time>{" "}
          by {formatRevisionAuthor(revision.createdBy)}.
        </p>

        {/*
          The reassurance is the product's actual promise, not a hedge:
          docs/product.md offers one-click restore *instead of* a backup, which
          is only true if restore cannot destroy anything. Saying so at the
          moment of the decision is what makes the button safe to press, and it
          is worth the two sentences it costs.
        */}
        <p className="mt-2 text-caption text-ink-muted">
          Nothing will be deleted. Restoring saves the old content as a new
          version, credited to you, on top of everything already in the history
          — so the current version stays where it is, and you can undo this
          afterwards by restoring it in turn.
        </p>
      </div>

      {alreadyCurrent ? (
        /**
         * The common way to arrive here by accident: following the restore
         * link on the row the history list marks "(current version)". Refusing
         * up front, with the reason, beats a button that submits and comes
         * back with the same sentence as a refusal.
         */
        <p className="text-caption text-ink-muted">
          This is already what the entry says, so there is nothing to restore.{" "}
          <Link href={`/wiki/${encodeURIComponent(slug)}`}>
            Return to the current version
          </Link>
          .
        </p>
      ) : (
        <RestoreRevisionForm slug={page.slug} revisionId={revision.id} />
      )}
    </main>
  );
}
