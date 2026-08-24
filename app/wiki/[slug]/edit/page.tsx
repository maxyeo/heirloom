import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { EntryEditForm } from "@/components/EntryEditForm";
import { getPageBySlug, listPages } from "@/lib/pages";
import { sanitizeHtml } from "@/lib/sanitize-html";
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

export default async function EntryEditPage({ params }: EntryEditPageProps) {
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

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <EntryEditForm
        slug={entry.slug}
        title={entry.title}
        entries={entries}
        /**
         * Sanitised on the way out, as the read route does. The editor sets
         * this as its starting document, so it is markup heading for a
         * browser — and a row written before E1-T4, by `db:seed`, or by hand
         * in a SQL console has never been through the sanitiser on write.
         */
        initialHtml={sanitizeHtml(entry.bodyHtml)}
      />
    </main>
  );
}
