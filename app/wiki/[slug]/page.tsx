import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ArticleContents } from "@/components/ArticleContents";
import { ArticleHatnote } from "@/components/ArticleHatnote";
import { ArticleHeading } from "@/components/ArticleHeading";
import { PersonInfobox } from "@/components/PersonInfobox";
import { readArticleOutline } from "@/lib/article-outline";
import { readEntryInfobox } from "@/lib/entry-infobox";
import { getEntryPerson } from "@/lib/entry-person";
import { normaliseHatnote } from "@/lib/hatnote";
import { findNamesakes, NO_NAMESAKES } from "@/lib/namesakes";
import { findExistingSlugs, getPageBySlug } from "@/lib/pages";
import { formatPersonName } from "@/lib/person-format";
import { infoboxEntrySlugs } from "@/lib/person-infobox";
import {
  entryLinkSlugs,
  markMissingEntryLinks,
  resolveEntryLinks,
} from "@/lib/red-links";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { insertSectionEditLinks } from "@/lib/section-edit";
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
   * The author's hatnote (E11-T9, `YEO-79`), narrowed on the way out for the
   * same reason and by the same rule as the body above: `lib/save-page.ts`
   * normalised it on the way in, and normalising again is what stops a row
   * written by `db:seed` or by hand in a SQL console from being trusted. It is
   * `""` when the entry has none, and `""` is what makes the element vanish
   * rather than merely empty — see `components/ArticleHatnote.tsx`.
   *
   * This is not a second sanitisation path: `normaliseHatnote` *is*
   * `sanitizeHtml`, run twice with a structural flatten between the passes.
   * See `lib/hatnote.ts`.
   */
  const hatnoteHtml = normaliseHatnote(entry.hatnote);

  /**
   * The section structure, and the same body with an `id` on every heading —
   * derived here, never stored, so that renaming a heading cannot leave a
   * stale anchor behind. E11-T3 (`YEO-73`); E11-T4 (`YEO-74`) hangs its
   * section `[edit]` links off the same ids. See `lib/article-outline.ts`,
   * which runs the body back through the sanitiser to write them, so
   * `outline.html` rather than `bodyHtml` is what the red-link pass below
   * consumes, and its output is what goes into the document.
   */
  const outline = readArticleOutline(bodyHtml);

  /**
   * Who this entry is about, if anybody (E2-T3) — read **once**, here, and
   * handed to everything that needs it.
   *
   * It used to be read inside `readEntryInfobox`. E11-T9 (`YEO-79`) moved it
   * out, because the automatic hatnote asks the same question and a second
   * call would be a second scan of `individuals` to re-derive a row this
   * render already has. `getEntryPerson` also owns the tie-break for the case
   * where two rows claim one entry, and one caller means one answer.
   *
   * ## The infobox (E11-T5)
   *
   * Null when nobody is linked to this entry — places, heirlooms and stories
   * render no box and leave no gap.
   *
   * Every fact in it is derived from `individuals` / `unions` /
   * `union_children` at this moment; none of it is stored, and none of it is
   * anything the author typed. See `lib/person-infobox.ts` for why that is the
   * whole point of the feature, and `lib/entry-infobox.ts` for the reads.
   *
   * Awaited after the entry rather than beside it, because it is keyed by
   * `entry.id`: there is no query to start until the slug has resolved to a
   * row.
   */
  const subject = await getEntryPerson(entry.id);
  const infobox = await readEntryInfobox(subject);

  /**
   * Who else in the tree is called this (E11-T9, `YEO-79`) — the automatic
   * half of the hatnote, and the answer to "am I reading about the right
   * Thomas".
   *
   * One query, and one that `individuals_surname_idx` serves: the predicate is
   * the exact `(surname, given_name)` pair the index leads on, and the entry
   * addresses come back through a `left join` rather than through a lookup per
   * name. `lib/namesakes.ts` argues both, and why the match is exact when
   * people search is not.
   *
   * Skipped entirely for an entry that is not about a person, which is most of
   * them — a place, an heirloom, a story has no name to collide.
   */
  const namesakes = subject
    ? await findNamesakes(subject, entry.id)
    : NO_NAMESAKES;

  /**
   * The section `[edit]` links (E11-T4): one inside every heading, pointing at
   * the editor opened on that section, built from the ids the outline above
   * just wrote. See `lib/section-edit.ts`.
   *
   * **Between the outline and the red links, and that is the whole of the
   * ordering.** It is not a sanitiser pass — it copies the document and
   * inserts a fixed shape of markup before each closing heading tag — so it
   * cannot strip the `class` and `title` the rewrite below adds. Running it
   * here rather than after keeps that rewrite the last thing to touch the
   * document, which is the invariant `lib/red-links.test.ts` guards.
   */
  const bodyWithEditLinks = insertSectionEditLinks(
    outline.html,
    outline.headings,
    entry.slug,
  );

  /**
   * Red links (E11-T6): every internal link in the body is resolved against
   * `pages.slug` here, and the ones that lead nowhere are rendered red with an
   * invitation to write the entry. One query for the whole article, however
   * many links it holds — and none at all when it holds none. See
   * `lib/red-links.ts`.
   *
   * **After the sanitiser, never before.** The rewrite adds `class` and
   * `title` to the anchors it marks, and the allowlist permits neither on an
   * `a`; sanitising this value again would quietly strip the feature back out.
   * That is why this runs on the outline's html — by now with the `[edit]`
   * links in it — and not on `bodyHtml`: `readArticleOutline` is itself a
   * sanitiser pass, so ordering it after this one would undo the red links.
   * It splices opening tags by byte offset, so the heading ids and the
   * `[edit]` links written above survive untouched.
   */
  const { html: articleHtml, existingSlugs } = await resolveEntryLinks(
    bodyWithEditLinks,
    findExistingSlugs,
    [
      // The infobox links to entries too (E11-T5), and its slugs join the
      // body's in *this* question rather than asking a second one.
      // `entryLinkProps` then decides blue or red for the prose and the box
      // from one set, so the two cannot disagree about whether an entry
      // exists.
      ...infoboxEntrySlugs(infobox),
      // And so does the hatnote, on both of its halves (E11-T9): the links
      // the author wrote into it, and the namesakes the lookup above found.
      // Same argument, same one query — a page that resolved its hatnote
      // separately would be a second round trip to answer a question already
      // being asked.
      ...entryLinkSlugs(hatnoteHtml),
      ...namesakes.people.flatMap((person) =>
        person.slug === null ? [] : [person.slug],
      ),
    ],
  );

  /**
   * The author's hatnote, with the links that lead nowhere painted red — the
   * same treatment the body gets, applied synchronously against the set the
   * one query above already returned. No `await`, so there is nowhere for a
   * per-link query to hide; see `markMissingEntryLinks`.
   *
   * The automatic half needs no equivalent: it renders as React elements
   * through `entryLinkProps`, which is the same decision expressed the other
   * way round (`components/ArticleHatnote.tsx`).
   */
  const hatnoteWithLinks = markMissingEntryLinks(hatnoteHtml, existingSlugs);

  return (
    // `max-w-content` is Vector 2022's 46em measure. The padding is the mobile
    // half of "readable on a phone": the measure alone would run the text to
    // both edges of a narrow screen, and 46em is expressed in `em`, so it
    // never exceeds the viewport at any text size. E11-T2's shell sets this
    // column beside the sidebar; the centring and the measure stay here.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/*
        The clearfix the infobox needs (E11-T5). It floats, and a float taller
        than the prose beside it would otherwise hang out of the bottom of the
        article and over whatever the shell puts below — the ordinary case for
        a short entry about a person with a long family. MediaWiki does exactly
        this on `.mw-parser-output`; here it is one variant on the element that
        holds both.
      */}
      <article className="after:block after:clear-both after:content-['']">
        {/* The title and "From Heirloom, the family wiki" under it, with the
            rule under the pair — E11-T2. */}
        <ArticleHeading title={entry.title} />

        {/*
          The hatnote (E11-T9): the indented italic line that says which Rose
          this is. Above the infobox in source order — which is where Wikipedia
          puts it, and it is also the order it should be read in, since the box
          floats and this line is the first thing after the title.

          Renders *nothing at all* when the entry has no hatnote and shares its
          subject's name with nobody: no wrapper, no margin, no whitespace
          above the lead.
        */}
        <ArticleHatnote
          hatnoteHtml={hatnoteWithLinks}
          subjectName={
            subject
              ? formatPersonName(subject.givenName, subject.surname)
              : null
          }
          namesakes={namesakes.people}
          extraNamesakes={namesakes.extra}
          existingSlugs={existingSlugs}
        />

        {/*
          No Edit / View history links here any more. E1-T5 and E1-T8 each left
          one behind so their routes were reachable before there was a tab row;
          E11-T7 is that tab row, and it is rendered once by the shell for every
          view of an entry rather than once per route. See
          `components/ArticleTabs.tsx`.
        */}

        {/*
          The infobox (E11-T5): the bordered summary box, floated top right,
          generated from the tree rather than typed. One self-contained
          component that renders nothing for an unlinked entry, so this stays a
          single line whichever of the tickets editing this file lands first.

          It replaces E2-T3's `EntryPersonCard`, which stated the same person's
          name, lifespan, birth and death in a full-width card immediately
          above the article. Two boxes repeating one set of facts at the top of
          one page is a bug rather than a feature, so the card is gone and its
          one affordance the box did not already have — E2-T4's "View in
          family tree" link — moved into the box's footer.
        */}
        <PersonInfobox infobox={infobox} existingSlugs={existingSlugs} />

        {bodyHtml ? (
          // `wiki-body` is the article scope — the equivalent of MediaWiki's
          // `.mw-parser-output`, and the same class the editor canvas uses, so
          // what an author types is what a reader gets. `break-words` is the
          // other half of the phone case: the allowlist permits links, and a
          // long unbroken URL would otherwise widen the whole document and
          // leave the reader scrolling sideways through prose.
          <div
            className="wiki-body break-words"
            dangerouslySetInnerHTML={{ __html: articleHtml }}
          />
        ) : (
          // An entry can exist with an empty body — the column defaults to ''
          // and E1-T3 creates a row before anyone has typed into it. Say so,
          // rather than rendering a title over nothing and reading as broken.
          <p className="text-caption text-ink-muted">
            This entry has no content yet.
          </p>
        )}

        {/* The pinned contents panel (E11-T3). It renders into the shell's
            sidebar rather than here — see `components/ArticleContents.tsx` —
            and to nothing at all when the entry has no headings. */}
        <ArticleContents headings={outline.headings} />
      </article>
    </main>
  );
}
