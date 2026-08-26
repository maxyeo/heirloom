import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { EntryEditForm } from "@/components/EntryEditForm";
import { readArticleOutline } from "@/lib/article-outline";
import { listCategories, readEntryCategories } from "@/lib/categories";
import { normaliseHatnote } from "@/lib/hatnote";
import { getPageBySlug, listPages } from "@/lib/pages";
import { sanitizeHtml } from "@/lib/sanitize-html";
import {
  SECTION_PARAM,
  sectionHeadingIndex,
  sectionParam,
} from "@/lib/section-edit";
import { requireSession } from "@/lib/session";

/**
 * The editor, at `/wiki/[slug]/edit`.
 *
 * Added by E1-T8 (`YEO-22`) because its last acceptance criterion — redirect
 * to the editor on the new entry — had nowhere to point: `EntryEditor`
 * (E1-T2) was mounted in no route and `savePageAction` (E1-T3) was called by
 * nothing. See `components/EntryEditForm.tsx` for what is deliberately left
 * out, and which later tickets own it.
 *
 * Structurally a copy of the read route next door, and intentionally so: the
 * same session-inside-the-loader rule, the same explicit prop type, the same
 * `notFound()` on a slug no row holds.
 */
export const dynamic = "force-dynamic";

/**
 * Written out rather than using the generated `PageProps<"/wiki/[slug]/edit">`
 * helper, for the reason the read route gives: Next only generates it during
 * `next dev`, `next build` or `next typegen`, and CI runs `npm run typecheck`
 * on a fresh checkout before `npm run build`.
 */
type EntryEditPageProps = {
  params: Promise<{ slug: string }>;
  /**
   * `?section=<heading id>` — which section the author pressed `[edit]` on
   * (E11-T4, `YEO-74`). Absent when they opened the editor from the tab row,
   * which is the ordinary case.
   */
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * `requireSession()` sits inside the loader rather than at the two call
 * sites, exactly as on the read route: `generateMetadata` is a second door
 * onto the same row, and guarding only the page would leak an entry's title
 * into the `<title>` of a response nobody had to sign in for.
 */
const loadEntry = cache(async (slug: string) => {
  await requireSession();
  return getPageBySlug(slug);
});

export async function generateMetadata({
  params,
}: EntryEditPageProps): Promise<Metadata> {
  const { slug } = await params;
  const entry = await loadEntry(slug);

  // Distinguishable from the entry's own tab, because editing it is exactly
  // the situation in which both are open at once.
  return { title: entry ? `Editing ${entry.title}` : "Not found" };
}

export default async function EntryEditPage({
  params,
  searchParams,
}: EntryEditPageProps) {
  const { slug } = await params;
  const entry = await loadEntry(slug);

  // An entry cannot be edited into existence here — creating one is
  // `/wiki/new`, and `savePage` refuses an unknown slug for the same reason.
  if (!entry) notFound();

  /**
   * The link button's entry list (E2-T5, `YEO-28`).
   *
   * Read here rather than in the editor because the editor is a Client
   * Component: one that imported `@/lib/pages` would drag postgres.js into
   * the browser bundle and into every suite that mounts it (docs/testing.md).
   * A Server Component fetching and passing down is the framework's own
   * pattern for this, and the same shape `app/tree/page.tsx` uses to hand the
   * canvas its graph.
   *
   * After the `notFound()` above, deliberately: a request for an entry that
   * does not exist has no reason to read the whole index. `listPages` already
   * returns them ordered, and only `title` and `slug` cross to the client —
   * `updatedAt` is index chrome the picker never shows, and every byte here
   * is in the RSC payload of a page somebody is about to type into.
   */
  const entries = (await listPages()).map(({ slug, title }) => ({
    slug,
    title,
  }));

  /**
   * Sanitised on the way out, as the read route does. The editor sets this as
   * its starting document, so it is markup heading for a browser — and a row
   * written before E1-T4, by `db:seed`, or by hand in a SQL console has never
   * been through the sanitiser on write.
   */
  const initialHtml = sanitizeHtml(entry.bodyHtml);

  /**
   * And the hatnote (E11-T9, `YEO-79`), narrowed on the way out for exactly
   * the reason the body is sanitised on the way out: this value becomes an
   * editor's starting document, so it is markup heading for a browser, and a
   * row written by `db:seed` or by hand has been through nothing. Handing the
   * field the same value the article renders is also what makes the round trip
   * closed — an author who opens the editor and saves without typing writes
   * back what was already there, and `savePage` correctly reports no change.
   */
  const initialHatnote = normaliseHatnote(entry.hatnote);

  /**
   * The picker's two lists (E11-T8, `YEO-78`): what this entry is filed under,
   * and everything it *could* be filed under.
   *
   * Read here for the reason `entries` above is read here — the picker is a
   * Client Component, and one that imported `@/lib/categories` would drag
   * postgres.js into the browser bundle and into every suite that mounts it.
   *
   * Both are small and both cross the wire whole, which is what makes choosing
   * an existing category cost no request at all: the filtering happens in the
   * browser against a list it already holds. Neither carries an `id` — see
   * `NamedCategory` in `lib/category-name.ts`.
   */
  const [initialCategories, categories] = await Promise.all([
    readEntryCategories(entry.id),
    listCategories(),
  ]);

  /**
   * Which heading the author pressed `[edit]` on, as a position in the
   * document (E11-T4, `YEO-74`).
   *
   * Resolved here rather than in the browser, and handed down as an *index*
   * rather than as the id it arrived as. The editor's document has no ids in
   * it — the sanitiser allows none — so the client would otherwise need
   * `readArticleOutline`, and behind it `sanitize-html` and its parser, in the
   * bundle to answer a question this render can answer for free. The nth
   * heading of the outline is the nth heading of the editor's document; see
   * `lib/section-edit.ts`.
   *
   * The outline is only read when a section was actually asked for, which is
   * the minority of visits: the tab row's Edit link carries no parameter.
   *
   * A heading id that matches nothing resolves to `null` and the editor opens
   * normally, at the top, saying nothing about it. That is the common case
   * rather than a corner — ids are derived from heading text, so renaming a
   * section invalidates every `[edit]` link an open tab is still showing.
   */
  const section = sectionParam((await searchParams)[SECTION_PARAM]);
  const headingIndex =
    section === null
      ? null
      : sectionHeadingIndex(readArticleOutline(initialHtml).headings, section);

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <EntryEditForm
        slug={entry.slug}
        title={entry.title}
        entries={entries}
        initialHtml={initialHtml}
        initialHatnote={initialHatnote}
        initialHeadingIndex={headingIndex}
        initialCategories={initialCategories}
        categories={categories}
      />
    </main>
  );
}
