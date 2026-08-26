import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { RevisionCategories } from "@/components/RevisionCategories";
import { categorySlug, compareCategoriesByName } from "@/lib/category-name";
import { getPageBySlug } from "@/lib/pages";
import {
  formatRevisionAuthor,
  formatRevisionTimestamp,
  isRevisionId,
  revisionTimestampIso,
} from "@/lib/revision-format";
import { getRevisionById } from "@/lib/revisions";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { requireSession } from "@/lib/session";

/**
 * Reads a session cookie and two database rows, so — as with the two routes
 * this one sits beside — there is nothing to prerender.
 */
export const dynamic = "force-dynamic";

/**
 * Hand-written for the reason both sibling routes give theirs: the generated
 * `PageProps<"/wiki/[slug]/history/[revisionId]">` helper does not exist
 * until `next dev`/`build`/`typegen` has run once, and CI's `npm run
 * typecheck` runs before `npm run build` on a fresh checkout.
 */
type RevisionPageProps = {
  params: Promise<{ slug: string; revisionId: string }>;
};

/**
 * The page and the one revision this route renders, loaded once per request.
 *
 * `requireSession()` lives inside this loader, not at its two call sites
 * (`generateMetadata` and the page), for the reason `app/wiki/[slug]/
 * page.tsx` documents at length: it is the only access boundary this app has,
 * and leaving `generateMetadata` unguarded would put a second, unchecked door
 * onto the same row — here, one that would leak the revision's title (which
 * may differ from the live one) and timestamp into a `<title>` tag nobody had
 * to sign in to see.
 *
 * Three ways this can miss, all folded into one `undefined`, all turned into
 * the same 404 by the caller:
 *
 *   - the slug resolves to no page (an entry that never existed, or was
 *     removed since the link was followed);
 *   - the id resolves to no revision (a stale or mistyped link);
 *   - the revision exists, but belongs to a *different* page —
 *     `revision.pageId !== page.id`. This is the cross-entry guard: a
 *     revision id is a database-wide identifier, and nothing in the URL
 *     otherwise stops `/wiki/rose/history/<some-other-entrys-revision-id>`
 *     from resolving. Without this check that URL would render someone else's
 *     history under Rose's slug and Rose's "back to current version" link —
 *     a wrong answer confidently presented, which is worse than a 404.
 *
 * `revisionId`'s shape is checked before any of that, in the caller, because
 * an unchecked one reaches Postgres's `uuid` column and raises rather than
 * returning no rows — see `isRevisionId`'s doc comment.
 */
const loadRevision = cache(async (slug: string, revisionId: string) => {
  await requireSession();

  if (!isRevisionId(revisionId)) return undefined;

  const page = await getPageBySlug(slug);
  if (!page) return undefined;

  const revision = await getRevisionById(revisionId);
  if (!revision || revision.pageId !== page.id) return undefined;

  /**
   * If this revision was written by a restore (E1-T7), the revision it was
   * copied forward from — so the banner below can say where the content came
   * from and link back to it.
   *
   * A second query, but only for the rows that have a source, which is a small
   * minority of any history. The same cross-entry check applies to it as to
   * the revision above: `restored_from_id` is a foreign key within one table,
   * so a source belonging to another page should be impossible, and treating
   * "impossible" as "need not be checked" is how the check that mattered gets
   * left out of the next caller. A source that fails it is dropped rather than
   * 404ing — the revision being viewed is still perfectly valid; only the note
   * about where it came from is not.
   */
  const source = revision.restoredFromId
    ? await getRevisionById(revision.restoredFromId)
    : undefined;
  const restoredFrom = source?.pageId === page.id ? source : undefined;

  return { page, revision, restoredFrom };
});

export async function generateMetadata({
  params,
}: RevisionPageProps): Promise<Metadata> {
  const { slug, revisionId } = await params;
  const loaded = await loadRevision(slug, revisionId);

  if (!loaded) return { title: "Not found" };

  // The historical status belongs in the tab, not only in the page body — a
  // wiki is read with a dozen tabs open, and a stale one left open overnight
  // should not read as identical to the live entry.
  const { revision } = loaded;
  return {
    title: `${revision.title} (old revision, ${formatRevisionTimestamp(revision.createdAt)})`,
  };
}

export default async function RevisionDetailPage({
  params,
}: RevisionPageProps) {
  const { slug, revisionId } = await params;
  const loaded = await loadRevision(slug, revisionId);

  if (!loaded) notFound();

  const { revision, restoredFrom } = loaded;

  // Sanitised again on the way out, exactly as the live route does — see the
  // "sanitise on write and read" reasoning in `lib/sanitize-html.ts`'s header
  // and `app/wiki/[slug]/page.tsx`. A stored revision is no more trustworthy
  // than a stored page: both can predate the sanitiser, or have been touched
  // by a manual `UPDATE`.
  const bodyHtml = sanitizeHtml(revision.bodyHtml);

  /**
   * The filing as it stood then (`YEO-106`), alphabetically.
   *
   * Sorted here rather than taken as stored, because the column's order is
   * slug order — canonical for comparing two revisions, and not the order a
   * reader expects to meet names in. `compareCategoriesByName` is the one
   * answer to "alphabetical" this application has, and it wants a slug for its
   * tie-break; the slug a name derives to is exactly what
   * `/wiki/category/[slug]` would address, so deriving it here agrees with the
   * live bar by construction rather than by coincidence.
   *
   * A name with no derivable slug cannot reach this list — the picker drops
   * such names (`normaliseEntryCategories`) — so the `?? name` fallback is for
   * a `revisions` row written by hand, and it keeps such a row rendering
   * rather than sorting it by nothing.
   */
  const filing = revision.categories
    .map((name) => ({ name, slug: categorySlug(name) ?? name }))
    .sort(compareCategoriesByName)
    .map(({ name }) => name);

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/*
        The historical banner. MediaWiki shows the same thing — "This is an
        old revision of this page, as edited by X on Y. It may differ
        significantly from the current version." — above the article, before
        any content, so there is no way to scroll past the title and mistake
        this for the live entry. Built only from theme tokens: `bg-wash` for
        the fill, `border-rule` for the frame, `rounded-panel` for the corner
        radius, matching the panel language the rest of the skin uses for
        anything that is not article prose.
      */}
      <div className="mb-6 rounded-panel border border-rule bg-wash px-4 py-3">
        <p>
          This is an old revision of this entry, saved{" "}
          <time dateTime={revisionTimestampIso(revision.createdAt)}>
            {formatRevisionTimestamp(revision.createdAt)}
          </time>{" "}
          by {formatRevisionAuthor(revision.createdBy)}. It may differ
          significantly from the current version.
        </p>

        {restoredFrom ? (
          /*
            Provenance, for the rows a restore wrote (E1-T7). Without it this
            revision is indistinguishable from someone having retyped an old
            version by hand — the content is byte-identical to its source, so
            only `revisions.restored_from_id` can tell the two apart, and a
            note nobody can read is not a note. Named as an action somebody
            took, with a date, because "restored from an earlier version" on
            its own invites the question this sentence answers.
          */
          <p className="mt-2 text-caption text-ink-muted">
            This version was restored by{" "}
            {formatRevisionAuthor(revision.createdBy)} from{" "}
            <Link href={`/wiki/${slug}/history/${restoredFrom.id}`}>
              the version saved{" "}
              <time dateTime={revisionTimestampIso(restoredFrom.createdAt)}>
                {formatRevisionTimestamp(restoredFrom.createdAt)}
              </time>
            </Link>
            . Restoring copied that content forward; it did not remove anything.
          </p>
        ) : null}

        <p className="mt-2 text-caption">
          <Link href={`/wiki/${slug}`}>View the current version</Link>
          {" · "}
          <Link href={`/wiki/${slug}/history`}>View revision history</Link>
          {" · "}
          {/*
            The restore entry point (E1-T7). Every revision has a page of its
            own, reached from every row of the history list, so a control here
            is a control "on any revision" — and it is the surface MediaWiki
            uses for the same operation, on the same reasoning: the decision to
            bring a version back is made while looking at it, not while
            scanning a column of dates.

            A link to a confirmation route rather than a button that acts,
            because the ticket asks for confirmation and because a `GET` must
            not change anything. The route names the version, states what
            restoring does to the history, and holds the button that posts.
          */}
          <Link href={`/wiki/${slug}/history/${revision.id}/restore`}>
            Restore this version
          </Link>
        </p>
      </div>

      <article>
        {/*
          The title as it was *then*, not the live title — the two can
          differ, and rendering the live title here would misrepresent what
          this revision actually says an entry was called. `revisions.title`
          is exactly the value that was saved alongside this body
          (`lib/save-page.ts`), so this is the historically accurate h1.
        */}
        <h1>{revision.title}</h1>

        {bodyHtml ? (
          <div
            className="wiki-body break-words"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          <p className="text-caption text-ink-muted">
            This revision has no content.
          </p>
        )}

        {/*
          What the entry was filed under *then* (`YEO-106`), on the same
          reasoning as the `h1` above: the live filing may have moved since,
          and rendering it here would misrepresent what this revision records.
          Unlinked — see `RevisionCategories` for why a historical category
          name is not an address that can be trusted to answer.
        */}
        <RevisionCategories categories={filing} />
      </article>
    </main>
  );
}
