import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { EntryRetirement } from "@/components/EntryRetirement";
import { readRetirementPreview } from "@/lib/retire-page";
import { requireSession } from "@/lib/session";
import { entryPath } from "@/lib/wiki-paths";

/**
 * The confirmation step of retiring an entry (E1-T10, `YEO-122`).
 *
 * Structurally the restore confirmation two directories over
 * (`history/[revisionId]/restore/page.tsx`): the same session-inside-the-loader
 * rule, the same hand-written prop type, the same `undefined`-folds-into-404.
 * What it adds is the *arithmetic* — which entries link here, how many versions
 * are kept, how many photographs stay — because retiring is the one operation
 * on an entry whose consequences are spread across pages the reader cannot see
 * from here.
 *
 * ## Why the preview lives on this route rather than at the foot of the article
 *
 * `components/EntryRetirement.tsx` makes the argument: the preview costs a read
 * of every live entry's body and hatnote, and the article route is rendered on
 * every visit while this one is rendered by somebody who has decided to look.
 * The link at the foot of the article is one anchor and no query.
 *
 * ## Why there is no tab row above this page
 *
 * `lib/article-tabs.ts` returns `null` for a sub-route below `/wiki/<slug>` it
 * does not recognise, and `retire` is deliberately not added to it. That is
 * chosen rather than overlooked, and both halves of the reason are in that
 * module's own docblock: marking "Read" current on a page that is not the read
 * view is the lie it refuses ("a row that renders with 'Read' wrongly marked
 * current is a row that lies about where you are"), and a confirmation is the
 * last page that should carry Edit and View history in a row above it. The two
 * links below are the navigation this page needs, and they are the two places
 * a reader might actually want to go.
 */
export const dynamic = "force-dynamic";

/**
 * Written out rather than taken from the generated `PageProps` helper, for the
 * reason all five sibling routes give: Next only generates it during `next
 * dev`, `next build` or `next typegen`, and CI runs `npm run typecheck` on a
 * fresh checkout before `npm run build`, when `.next/types` does not exist.
 */
type RetirePageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * What retiring this entry would cost, loaded once per request.
 *
 * `requireSession()` lives inside this `cache()`-wrapped loader rather than at
 * the two call sites, for the reason every route in this segment documents:
 * `lib/session.ts` is the only access boundary there is, and
 * `generateMetadata` is a second door onto the same rows. Guarding only the
 * page would leak an entry's title — and, here, the titles of every entry that
 * links to it — into the `<title>` of a response nobody had to sign in for.
 *
 * `readRetirementPreview` answers `null` for both "no such entry" and "already
 * retired", and folding the two into one 404 is right rather than merely
 * convenient: there is no retirement to confirm in either case, and the second
 * is reached by a back button onto a confirmation somebody has already used.
 * A reader who lands here that way is one link from the tombstone, which is
 * where the entry actually is and what it actually says.
 */
const loadPreview = cache(async (slug: string) => {
  await requireSession();
  return readRetirementPreview(slug);
});

export async function generateMetadata({
  params,
}: RetirePageProps): Promise<Metadata> {
  const { slug } = await params;
  const preview = await loadPreview(slug);

  return {
    title: preview ? `Retire ${preview.title}` : "Not found",
  };
}

export default async function RetireEntryPage({ params }: RetirePageProps) {
  const { slug } = await params;
  const preview = await loadPreview(slug);

  // Same reasoning as every route in this segment: `notFound()` stops the
  // render and hands off to `not-found.tsx` with a real 404 status, rather
  // than serving a 200 with a confirmation for nothing.
  if (!preview) notFound();

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Retire an entry</h1>

      <p className="mb-6 text-caption">
        <Link href={entryPath(slug)}>Return to the entry</Link>
        {" · "}
        <Link href={entryPath(slug, "history")}>View revision history</Link>
      </p>

      <EntryRetirement preview={preview} />
    </main>
  );
}
