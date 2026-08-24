import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ArticleHeading } from "@/components/ArticleHeading";
import { EntryPersonCard } from "@/components/EntryPersonCard";
import { getEntryPerson } from "@/lib/entry-person";
import { getPageBySlug } from "@/lib/pages";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { requireSession } from "@/lib/session";

/**
 * Reads a session cookie and a database row, so there is nothing to prerender.
 * Stated explicitly, the way the other database-backed routes do, rather than
 * left to be inferred from the first request-time API this happens to touch.
 */
export const dynamic = "force-dynamic";

/**
 * Next 16 generates a `PageProps<"/wiki/[slug]">` helper for this, but only
 * during `next dev`, `next build`, or `next typegen`. CI runs
 * `npm run typecheck` on a fresh checkout *before* `npm run build`, so at that
 * point `.next/types` does not exist and the global is not defined — using it
 * turns the first CI run red with `Cannot find name 'PageProps'`. The prop
 * type is therefore written out, which is also what `app/signin/page.tsx`
 * already does for `searchParams`.
 */
type WikiEntryPageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * The entry, loaded once per request.
 *
 * Next calls into this module twice for a single render — once for
 * `generateMetadata`, once for the page — and React's `cache` collapses that
 * into one session check and one query.
 *
 * `requireSession()` lives *inside* the loader rather than at the two call
 * sites on purpose. `lib/session.ts` is the only access boundary there is (no
 * RLS underneath, one database role for everyone), and `generateMetadata` is a
 * second door onto the same row: guarding only the page would leak an entry's
 * title into the `<title>` tag of a response nobody had to sign in for. Put
 * the check where the data is and neither door can be left open.
 */
const loadEntry = cache(async (slug: string) => {
  await requireSession();
  return getPageBySlug(slug);
});

export async function generateMetadata({
  params,
}: WikiEntryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const entry = await loadEntry(slug);

  // A wiki is read with a dozen tabs open, so the tab needs to say which entry
  // it is holding. `robots: noindex` is inherited from the root layout, and
  // Next adds its own on a 404 response.
  return { title: entry ? entry.title : "Not found" };
}

export default async function WikiEntryPage({ params }: WikiEntryPageProps) {
  const { slug } = await params;
  const entry = await loadEntry(slug);

  // Not an empty page: `notFound()` throws, which stops the render, hands off
  // to `not-found.tsx` in this segment, and — crucially — sets the response
  // status to 404 rather than serving a 200 with nothing in it.
  if (!entry) notFound();

  /**
   * Sanitised again on the way out, having already been sanitised on the way
   * in by the save action (E1-T3). That is deliberate duplication, not a
   * belt-and-braces reflex: sanitising on write alone bets that every row was
   * written by code that had the sanitiser wired in, and that bet loses on the
   * first `db:seed`, the first row that predates E1-T4, and the first manual
   * `UPDATE` in a SQL console. See the header of `lib/sanitize-html.ts`. The
   * function is idempotent, so the second pass costs only the parse.
   */
  const bodyHtml = sanitizeHtml(entry.bodyHtml);

  /**
   * Who this entry is about, or `undefined` when nobody is linked to it
   * (E2-T3). One row out of `individuals`, and the card below renders nothing
   * at all for the entries — places, heirlooms, stories — that are not about a
   * person.
   *
   * Awaited after the entry rather than beside it, because it is keyed by
   * `entry.id`: there is no query to start until the slug has resolved to a
   * row. It is a scan of a table that holds a family (docs/architecture.md),
   * on a route that was already reading the database.
   */
  const person = await getEntryPerson(entry.id);

  return (
    // `max-w-content` is Vector 2022's 46em measure. The padding is the mobile
    // half of "readable on a phone": the measure alone would run the text to
    // both edges of a narrow screen, and 46em is expressed in `em`, so it
    // never exceeds the viewport at any text size. E11-T2's shell sets this
    // column beside the sidebar; the centring and the measure stay here.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <article>
        {/* The title and "From Heirloom, the family wiki" under it, with the
            rule under the pair — E11-T2. */}
        <ArticleHeading title={entry.title} />

        {/*
          No Edit / View history links here any more. E1-T5 and E1-T8 each left
          one behind so their routes were reachable before there was a tab row;
          E11-T7 is that tab row, and it is rendered once by the shell for every
          view of an entry rather than once per route. See
          `components/ArticleTabs.tsx`.
        */}

        {/*
          The backlink to the tree (E2-T3): who this entry is about, when it
          is about somebody. One self-contained component that renders nothing
          for an unlinked entry, so this stays a single line whichever of the
          tickets editing this file lands first.
        */}
        <EntryPersonCard person={person} />

        {bodyHtml ? (
          // `wiki-body` is the article scope — the equivalent of MediaWiki's
          // `.mw-parser-output`, and the same class the editor canvas uses, so
          // what an author types is what a reader gets. `break-words` is the
          // other half of the phone case: the allowlist permits links, and a
          // long unbroken URL would otherwise widen the whole document and
          // leave the reader scrolling sideways through prose.
          <div
            className="wiki-body break-words"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        ) : (
          // An entry can exist with an empty body — the column defaults to ''
          // and E1-T3 creates a row before anyone has typed into it. Say so,
          // rather than rendering a title over nothing and reading as broken.
          <p className="text-caption text-ink-muted">
            This entry has no content yet.
          </p>
        )}
      </article>
    </main>
  );
}
