import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { getPageBySlug } from "@/lib/pages";
import {
  formatRevisionAuthor,
  formatRevisionTimestamp,
  revisionTimestampIso,
} from "@/lib/revision-format";
import { listRevisionsForPage } from "@/lib/revisions";
import { requireSession } from "@/lib/session";

/**
 * Reads a session cookie and two database queries, so — as with the read
 * route this sits beside — there is nothing here to prerender.
 */
export const dynamic = "force-dynamic";

/**
 * Written out rather than taken from the generated `PageProps<"/wiki/[slug]/
 * history">` helper, for the same reason `app/wiki/[slug]/page.tsx` writes
 * its own: that helper exists only after `next dev`/`next build`/`next
 * typegen` have run, and CI's `npm run typecheck` runs on a fresh checkout
 * before `npm run build`, when `.next/types` does not exist yet.
 */
type HistoryPageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * The page and its history, loaded once per request.
 *
 * `requireSession()` lives inside this `cache()`-wrapped loader rather than
 * at the two call sites below (`generateMetadata` and the page itself) for
 * the same reason `app/wiki/[slug]/page.tsx` documents: `lib/session.ts` is
 * the only access boundary this app has — there is no RLS underneath, and one
 * database role serves every signed-in user — so `generateMetadata` is a
 * second door onto the same rows. Checking only the page component would
 * leak an entry's title, and the fact that it has history at all, into the
 * `<title>` tag of a response nobody had to sign in for.
 */
const loadHistory = cache(async (slug: string) => {
  await requireSession();

  const page = await getPageBySlug(slug);
  if (!page) return undefined;

  const revisions = await listRevisionsForPage(page.id);
  return { page, revisions };
});

export async function generateMetadata({
  params,
}: HistoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const loaded = await loadHistory(slug);

  return {
    title: loaded ? `Revision history: ${loaded.page.title}` : "Not found",
  };
}

export default async function RevisionHistoryPage({
  params,
}: HistoryPageProps) {
  const { slug } = await params;
  const loaded = await loadHistory(slug);

  // Same reasoning as the read route: `notFound()` stops the render and
  // hands off to this segment's `not-found.tsx` with a real 404 status,
  // rather than rendering an empty page as if it were a 200.
  if (!loaded) notFound();

  const { page, revisions } = loaded;

  // One revision cannot be compared with anything, and zero certainly cannot.
  // The same count decides whether the "saved once" notice appears below.
  const canCompare = revisions.length > 1;

  /**
   * The history rows themselves.
   *
   * Hoisted out of the markup below because they are rendered from two
   * places — bare when there is nothing to compare, and wrapped in the
   * compare picker (E1-T6, `YEO-20`) when there is. Writing them out twice
   * would be two places to change the next time the list gains a column.
   */
  const revisionList = (
    <ul className="border-t border-rule-soft">
      {revisions.map((revision, index) => {
        const isCurrent = index === 0;

        return (
          <li
            key={revision.id}
            className="flex flex-wrap items-baseline gap-x-2 border-b border-rule-soft py-2"
          >
            {canCompare ? (
              /*
                Two radios per row, each carrying its own visible word.
                MediaWiki draws these as two unlabelled columns under a pair of
                headers — compact, but it asks a sighted reader to remember
                which column was which all the way down a long list, and it
                asks the headers to stay aligned with rows that wrap. Labelling
                every radio where it sits costs a few characters a row, cannot
                be misread, and makes the accessible name real text rather than
                an `aria-label` restating what is already on screen.
              */
              <span className="flex shrink-0 items-baseline gap-x-3 text-note text-ink-muted">
                <label className="flex items-baseline gap-x-1">
                  <input
                    type="radio"
                    name="from"
                    value={revision.id}
                    // The default pair is the last change made: second-newest
                    // against newest. That is the comparison somebody opening
                    // this page almost always wants, so the button does
                    // something useful without a radio being touched.
                    defaultChecked={index === 1}
                  />
                  older
                </label>
                <label className="flex items-baseline gap-x-1">
                  <input
                    type="radio"
                    name="to"
                    value={revision.id}
                    defaultChecked={isCurrent}
                  />
                  newer
                </label>
              </span>
            ) : null}

            <Link href={`/wiki/${slug}/history/${revision.id}`}>
              <time dateTime={revisionTimestampIso(revision.createdAt)}>
                {formatRevisionTimestamp(revision.createdAt)}
              </time>
            </Link>
            <span className="text-ink-muted">
              {formatRevisionAuthor(revision.createdBy)}
            </span>
            {isCurrent ? (
              // The newest revision is byte-identical to the live page —
              // `lib/save-page.ts` writes both inside one transaction from the
              // same values — so this is not a guess about which row is
              // current, it is a restatement of that invariant.
              <span className="text-note text-ink-muted">
                (current version)
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Revision history: {page.title}</h1>

      <p className="mb-6 text-caption">
        <Link href={`/wiki/${slug}`}>Return to the current version</Link>
      </p>

      {revisions.length === 0 ? (
        /**
         * A true empty state: no list, because there is nothing to list. This
         * is what a page looks like outside the save path entirely — a
         * `db/seed.ts` fixture (which inserts pages but writes no revisions)
         * or a manual `INSERT` into `pages`. It is not the same situation as
         * "one revision", below, and the two are given different copy on
         * purpose: this one has no author or date to report at all.
         */
        <p className="text-caption text-ink-muted">
          No history has been recorded for this entry yet.
        </p>
      ) : (
        <>
          {revisions.length === 1 ? (
            /**
             * The ticket asks for "an empty state for an entry saved only
             * once". Read literally as "hide the list when there is one
             * revision", that would throw away the one thing the criteria
             * elsewhere insist on — timestamp, author and a link, per row —
             * for the only row there is. The reading applied here is that
             * what is empty is the set of *earlier* versions, not the list
             * itself: the single row still renders below, with its
             * timestamp, author and link intact, and this notice is the
             * empty state — there is nothing older to compare with or
             * restore to.
             */
            <p className="mb-4 text-caption text-ink-muted">
              This entry has been saved once, with no earlier version to
              compare with or restore.
            </p>
          ) : null}

          {canCompare ? (
            /*
              A plain `method="get"` form, not a client component. The two
              radio groups become `?from=…&to=…` on the compare route, which is
              exactly the shape that route reads — so the picker works with no
              JavaScript, the comparison it produces is a real URL somebody can
              bookmark or paste into a message, and the back button behaves.
              `action` is written out rather than left to default to the
              current URL, because the target is a different route.
            */
            <form
              method="get"
              action={`/wiki/${encodeURIComponent(slug)}/history/compare`}
            >
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <button
                  type="submit"
                  className="rounded-panel border border-rule px-4 py-1.5 font-medium transition hover:bg-panel"
                >
                  Compare selected revisions
                </button>
                <p className="text-caption text-ink-muted">
                  Any two will do — the comparison is always read oldest to
                  newest, whichever order they are picked in.
                </p>
              </div>

              {revisionList}
            </form>
          ) : (
            revisionList
          )}
        </>
      )}
    </main>
  );
}
