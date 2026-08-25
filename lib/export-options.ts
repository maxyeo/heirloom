import {
  FULL_EXPORT_ENDPOINT,
  FULL_EXPORT_TITLE,
  GEDCOM_EXPORT_ENDPOINT,
} from "./export-endpoint";

/**
 * What the settings page offers to download, as data (E7-T3, `YEO-53`).
 *
 * ## Why a list and not two hand-written blocks
 *
 * The same reason `lib/site-nav.ts` is a list, and the interesting case was
 * the same one: **the second entry did not exist yet.** E7-T3 wrote it in as
 * an inert row and predicted that E7-T4 (`YEO-54`) would fill it in by
 * setting an `href` and deleting a `pendingTicket` rather than by reopening
 * the page's markup. That is exactly what E7-T4 did, and this paragraph is
 * kept in the past tense rather than deleted because the prediction coming
 * true is the argument for shaping the next one this way too.
 *
 * It also means the copy is checkable without a DOM. Three of this ticket's
 * four acceptance criteria are *sentences* — what the file leaves out, in
 * plain language, pointing at the ticket that covers it — and sentences buried
 * in JSX can only be tested by rendering. Here they are values, and
 * `lib/export-options.test.ts` reads them directly.
 */

/**
 * The honest half of a download: what is not in the file, and where to go for
 * it.
 *
 * Present on an export that leaves something out, `null` on one that does not.
 * A field rather than a paragraph on the page, because it belongs to a
 * particular file: E7-T4's backup will have a different answer, and "the
 * caveat on this page" would then be a caveat about whichever download the
 * reader was not looking at.
 */
export type ExportCaveat = {
  /** The sentence that says what kind of file this is, and is not. */
  readonly lead: string;
  /** Each thing the file does not contain, named the way a reader would. */
  readonly missing: readonly string[];
  /**
   * Where the missing things are covered. See the GEDCOM entry's own
   * pointer below, which names the download rather than describing it.
   */
  readonly pointer: string;
};

export type ExportOption = {
  /** Stable key for React, and for a test to name one without its prose. */
  readonly id: string;
  readonly title: string;
  /** One sentence: what you get. */
  readonly summary: string;
  /**
   * Where the download is, or `null` while nothing is there to download.
   *
   * `lib/site-nav.ts`'s rule, for its reason: a `null` href renders as inert
   * text rather than as a button that 404s, because something that looks live
   * and is not is worse than something that plainly says "later".
   */
  readonly href: string | null;
  /** The button's words, when there is a button. */
  readonly action: string;
  /**
   * The ticket that fills it in. Only set when `href` is `null`.
   *
   * Nothing sets it today: E7-T4 (`YEO-54`) built the one option that had it,
   * so both offers on the page are live. The field stays because the *rule*
   * it encodes outlives its first use — a download that does not exist yet is
   * listed inertly and says which ticket builds it, rather than being a
   * button that 404s or being left off the page until the day it works. The
   * invariant is asserted in `lib/export-options.test.ts` either way, so a
   * third option added with no destination and no ticket fails there.
   */
  readonly pendingTicket?: string;
  readonly caveat: ExportCaveat | null;
};

export const exportOptions: readonly ExportOption[] = [
  {
    id: "gedcom",
    title: "Family tree (GEDCOM)",
    summary:
      "Everyone in the tree, who they were married to, who their children " +
      "are, and their dates — in the file format every genealogy program " +
      "can open.",
    href: GEDCOM_EXPORT_ENDPOINT,
    action: "Download family tree (GEDCOM)",
    caveat: {
      /**
       * The ticket's own framing: *"Someone will treat this file as a backup.
       * GEDCOM has nowhere to put a wiki, so it isn't one — say so at the
       * point of download, not in documentation."*
       *
       * So this says what the file is before it says what it is missing. A
       * list of absences on its own reads as a defect being apologised for;
       * the point is that the format is doing exactly what the format does.
       */
      lead:
        "This is the family tree, not a copy of this site. GEDCOM is the " +
        "genealogy standard and the standard has nowhere to put a wiki.",
      missing: [
        "what anyone wrote in a wiki entry",
        "the history of edits to those entries",
        "photographs and any other images",
      ],
      /**
       * E7-T3 wrote this sentence in the only tense that was true then —
       * naming E7-T4 and saying plainly that it was *not built yet* — because
       * pointing at a backup in the present tense would have sent somebody
       * off to look for a thing that was not there, having just been told the
       * file in their hand was not it. `lib/export-options.test.ts` asserted
       * that phrase so that nobody could soften the claim before the feature
       * was real.
       *
       * E7-T4 is real, so the sentence now points at the download rather than
       * at a ticket, and that test asserts the opposite: that the reader is
       * sent to something they can click. What it deliberately still does not
       * say is "backup" — see {@link FULL_EXPORT_TITLE}.
       */
      pointer:
        `Everything it leaves out is in the ${FULL_EXPORT_TITLE} below, ` +
        `which has the entries, their history and their images alongside ` +
        `this same tree. Keep this file for the tree; do not keep it ` +
        `instead of the site.`,
    },
  },
  {
    id: "full-export",
    /**
     * "Full export", not "Full backup", and the whole argument is in
     * {@link FULL_EXPORT_TITLE}. The short of it: `docs/backups.md` is the
     * operator's nightly Postgres backup — scheduled, encrypted, kept ninety
     * days, restored every night to prove it works — and this is a file a
     * person clicks for once and then looks after themselves. Using one word
     * for both, on the one page a non-technical reader meets either, would
     * tell them the second is the first.
     */
    title: FULL_EXPORT_TITLE,
    summary:
      "Everything on this site in one ZIP file: the family tree, every entry " +
      "and every past version of it, the photographs, and a page explaining " +
      "how to read it all back.",
    href: FULL_EXPORT_ENDPOINT,
    action: "Download everything (ZIP)",
    /**
     * Nothing to warn about on a download that leaves nothing out — which is
     * the whole distinction this page exists to draw, and the reason
     * {@link ExportCaveat} hangs off the option rather than off the page.
     *
     * Not quite nothing, though, and the honest place for it is the archive
     * rather than the page: an image the store has already swept is listed in
     * the manifest as absent, with the reason. A caveat here would be a
     * sentence about a case that is usually untrue, shown to everybody, in
     * place of a fact about *this* download that the file itself carries.
     */
    caveat: null,
  },
];
