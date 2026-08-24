import type { Metadata } from "next";

import { NewEntryForm } from "@/components/NewEntryForm";
import { NEW_ENTRY_TITLE_PARAM } from "@/lib/red-links";
import { requireSession } from "@/lib/session";

/**
 * Where an entry begins (E1-T8, `YEO-22`).
 *
 * `/wiki/new` is a static segment, so Next resolves it ahead of the sibling
 * `[slug]` route and no entry can ever be reached at this address. That is
 * also why `new` is in `RESERVED_SLUGS` — an entry titled "New" would derive
 * to it and quietly get this form instead of itself. See `lib/entry-slug.ts`.
 */

/**
 * Reads a session cookie, like the read route, so there is nothing to
 * prerender. Stated rather than inferred from the first request-time API this
 * happens to touch.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Start a new entry" };

/**
 * Written out rather than taken from Next's generated `PageProps` helper, for
 * the reason the read route gives at its own: that global exists only after
 * `next dev`/`next build`/`next typegen`, and CI typechecks a fresh checkout
 * before it builds. `app/signin/page.tsx` spells its `searchParams` out for
 * the same reason.
 */
type NewEntryPageProps = {
  searchParams: Promise<{ [NEW_ENTRY_TITLE_PARAM]?: string | string[] }>;
};

export default async function NewEntryPage({
  searchParams,
}: NewEntryPageProps) {
  // `lib/session.ts` is the only access boundary there is — no RLS underneath,
  // one database role for everyone — so the check goes here as well as inside
  // the action the form posts to. Neither is redundant: this one keeps the
  // form off a stranger's screen, the one in the action is what actually
  // stops a stranger creating an entry.
  await requireSession();

  /**
   * A red link arrives here pre-titled (E11-T6): clicking "Walter" in an
   * entry that mentions him lands on this form with "Walter" already in the
   * field, which is the whole of what makes a red link an invitation rather
   * than a dead end.
   *
   * A suggestion and nothing more. It is pre-filled into a field the author
   * types over, and the address of the entry is still derived from what they
   * finally submit — `createPage` has no slug parameter, so nothing about the
   * result is under the caller's control.
   *
   * A repeated `?title=` gives an array, and there is no sensible answer to
   * "which one"; an empty field is the honest one.
   */
  const params = await searchParams;
  const suggestedTitle =
    typeof params[NEW_ENTRY_TITLE_PARAM] === "string"
      ? params[NEW_ENTRY_TITLE_PARAM]
      : "";

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Start a new entry</h1>

      <div className="wiki-body">
        <p className="text-caption text-ink-muted">
          Give it a title and you will be taken straight into the editor.
        </p>
      </div>

      <NewEntryForm suggestedTitle={suggestedTitle} />
    </main>
  );
}
