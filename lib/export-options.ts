import { GEDCOM_EXPORT_ENDPOINT } from "./export-endpoint";

/**
 * What the settings page offers to download, as data (E7-T3, `YEO-53`).
 *
 * ## Why a list and not two hand-written blocks
 *
 * The same reason `lib/site-nav.ts` is a list, and the interesting case is the
 * same one: **the second entry does not exist yet.** E7-T4 (`YEO-54`) is the
 * full backup, and it is being built directly on top of this page. Keeping the
 * offer as data means that ticket sets an `href` and deletes a
 * `pendingTicket`, rather than reopening the page's markup to add a second
 * button beside the first and deciding again where the caveat goes.
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
   * Where the missing things are covered — including when the answer is "not
   * yet". See {@link FULL_BACKUP_TICKET}.
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
  /** The ticket that fills it in. Only set when `href` is `null`. */
  readonly pendingTicket?: string;
  readonly caveat: ExportCaveat | null;
};

/** The ticket that makes a real backup of this site possible (E7-T4). */
export const FULL_BACKUP_TICKET = "E7-T4";

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
       * Written to stay true *before* E7-T4 exists, which is the harder half:
       * pointing at a backup in the present tense would send somebody off to
       * look for a thing that is not there, having just been told the file in
       * their hand is not it. So it names the ticket and says plainly that it
       * is not built — the same "plainly says later" that `lib/site-nav.ts`
       * uses for the sidebar's unbuilt destination.
       *
       * When E7-T4 lands, this sentence and the {@link exportOptions} entry
       * below it are the two things it rewrites, and `lib/export-options.test`
       * fails until both are done.
       */
      pointer:
        `A full backup — this tree plus the entries, their history and ` +
        `their images — is ${FULL_BACKUP_TICKET}, which is not built yet. ` +
        `Keep this file for the tree; do not keep it instead of the site.`,
    },
  },
  {
    id: "full-backup",
    title: "Full backup",
    summary:
      "The family tree together with the wiki around it: entry text, every " +
      "revision of it, and the images.",
    href: null,
    action: "Download full backup",
    pendingTicket: FULL_BACKUP_TICKET,
    /**
     * Nothing to warn about on a download that leaves nothing out — which is
     * the whole distinction this page exists to draw, and the reason
     * {@link ExportCaveat} hangs off the option rather than off the page.
     */
    caveat: null,
  },
];
