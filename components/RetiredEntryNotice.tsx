import Link from "next/link";

import { entryPath } from "@/lib/wiki-paths";

/**
 * The panel that tells a reader the entry behind this page has been retired
 * (E1-T10, `YEO-122`; `YEO-123`).
 *
 * ## Why a component and not three paragraphs
 *
 * Three pages under `/wiki/<slug>` go on working after a retirement — the
 * history list and the two revision views — and each of them shows an entry's
 * own words under an address whose article is now a tombstone. Every one of
 * them therefore has to say so, and `app/wiki/[slug]/edit/page.tsx` already
 * wrote down the objection to letting each say it in its own words: a redirect
 * was chosen over a refusal rendered in the editor partly because the refusal
 * "would also be a second copy of the 'this entry is retired' sentence, in a
 * second place, to keep true".
 *
 * There are three such places now, so the sentence and the way out live here
 * once. That is the same reasoning `lib/retirement-copy.ts` gives for holding
 * the confirmation's wording as plain strings: the copy is what a reader acts
 * on, and a claim repeated in three files is a claim two of them will stop
 * making.
 *
 * ## Why the second sentence is a slot rather than a prop with a default
 *
 * Because it is the half that is *about this page*, and it differs: the
 * history list says nothing below it has changed, a revision view says the
 * version on it is kept in full. A default would let a route render the
 * general sentence and say nothing about what the reader is actually looking
 * at, which is exactly the silence `YEO-123` was filed about. Required, so
 * that adding the notice makes a route answer the question.
 *
 * ## Why it links to the entry rather than offering a button
 *
 * Retiring is undone from the tombstone, which holds the button and the
 * sentence explaining what pressing it does (`app/wiki/[slug]/page.tsx`).
 * A second control here would be a second copy of that decision, on a page
 * whose subject is the history rather than the entry — and this panel appears
 * on three of them.
 *
 * ## Why it is a Server Component
 *
 * It takes a slug and a sentence and returns markup: no state, no handler,
 * nothing to hydrate. It imports no action either, which is what makes
 * `components/RetiredEntryNotice.test.tsx` possible at all: mounting
 * `components/EntryRetirement.tsx` drags `retireEntryAction`, and behind it
 * Auth.js and `@/db`, into a suite that has no `AUTH_*` and no
 * `DATABASE_URL`. That is docs/testing.md's rule — take the action, do not
 * import it — and `lib/retirement-copy.ts` is what the other half of this
 * feature had to do about breaking it: hold its sentences as plain strings,
 * because the component carrying them cannot be mounted to assert on them.
 */
export interface RetiredEntryNoticeProps {
  /**
   * The entry's slug, as it arrived in the URL — encoded here rather than by
   * the caller, so that the address in this panel cannot differ between the
   * three routes that render it.
   */
  slug: string;

  /**
   * What *this* page is still showing, in one sentence, to follow "This entry
   * has been retired."
   *
   * `string` rather than `ReactNode`, so that "a sentence, not a layout" is
   * enforced rather than asked for. A slot accepting markup would invite a
   * second link or a second paragraph into a panel whose whole value is that
   * a reader meets the same three lines on whichever of the three pages they
   * arrive at.
   */
  children: string;
}

export function RetiredEntryNotice({
  slug,
  children,
}: RetiredEntryNoticeProps) {
  return (
    /*
      The panel language the tombstone and the history banner already use —
      `bg-wash` fill, `border-rule` frame, `rounded-panel` corner — so that a
      reader meeting this on three different pages recognises it as one notice
      rather than three warnings.
    */
    <div className="mb-6 rounded-panel border border-rule bg-wash px-4 py-3 text-caption">
      <p>This entry has been retired. {children}</p>
      <p className="mt-2">
        <Link href={entryPath(slug)}>Go to the entry to restore it</Link>.
      </p>
    </div>
  );
}
