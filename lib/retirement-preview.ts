import { compareCategoriesByName, type NamedCategory } from "./category-name";
import { scanEntryImages } from "./entry-images";
import { compareEntriesByTitle, type TitledEntry } from "./page-index";
import { entryLinkSlugs } from "./red-links";

/**
 * What retiring an entry actually costs (E1-T10, `YEO-122`).
 *
 * ## Why this module exists at all
 *
 * The same reason `lib/removal-preview.ts` exists, arrived at from the other
 * direction. There the confirmation had to be honest because a delete is
 * *irreversible* and its blast radius is larger than the button suggests;
 * here the confirmation has to be honest because a retirement is
 * **reversible**, and a reader who does not believe that will not press the
 * button at all — or, worse, will reach for `delete from pages` in a SQL
 * console, which is precisely the operation this whole ticket exists to make
 * unnecessary.
 *
 * So the copy has two halves and both of them are claims about data:
 *
 *   - what goes: the entry leaves the index, leaves search, leaves the
 *     category listings it is filed under, and every link pointing at it turns
 *     red;
 *   - what stays: its whole history, its photographs, and the person in the
 *     tree whose entry it is.
 *
 * Nothing below guesses at either. "Three entries link here" is three entries
 * this module found by scanning their stored HTML for links to this slug, and
 * the confirmation names them, because a reader who can see *which* three is a
 * reader who does not have to take the sentence on trust.
 *
 * ## Run on both sides, so the two cannot disagree
 *
 * `lib/retire-page.ts` calls `previewRetirement` again inside the transaction
 * that does the write, against a fresh read, and hands the result back — the
 * pattern `lib/remove-from-tree.ts` established. The confirmation and the
 * report are then the same function of the same shape of data, so what a
 * reader is told afterwards cannot be an echo of a preview that went stale
 * while they were reading it. Somebody adding a link to this entry from
 * another tab between the two is the ordinary way that happens, and it is a
 * change the reader would want to know about rather than one to paper over.
 *
 * ## Why it is pure, and why that is the point
 *
 * Same argument as `lib/removal-preview.ts` and `lib/person-detail.ts` before
 * it: a plain function over plain values takes a literal in a test and returns
 * something to assert on. The cases that are easy to get wrong — an entry that
 * links to itself, an entry linked from a hatnote rather than a body, the same
 * entry linking here nine times, a link written with a percent-encoded slug —
 * are all reachable from `lib/retirement-preview.test.ts` with no database.
 */

/** An entry's text, as much of it as can hold a link to somewhere else. */
export type EntryText = TitledEntry & {
  bodyHtml: string;
  /**
   * Scanned alongside the body, and not only for completeness. A hatnote is
   * where one entry most often points at another — "not to be confused with
   * Rose Whitfield (1902-1975)" is the whole reason the column exists
   * (E11-T9) — so an incoming-link count that read bodies alone would miss the
   * links most likely to be pointing at the entry somebody is retiring.
   */
  hatnote: string;
};

/**
 * Everything a retirement preview is computed from, as plain values.
 *
 * Spelled out rather than taken as database rows, so that this module can be
 * exercised with literals and so that widening what the confirmation says and
 * widening what `lib/retire-page.ts` reads are the same edit — the same
 * narrow-input rule `lib/pages.ts` applies to its selects.
 */
export type RetirementFacts = {
  /** The entry being retired. */
  entry: EntryText;
  /**
   * Every **live** entry other than this one, with the text a link can hide
   * in.
   *
   * Live only, and the exclusion is not tidiness: a link from an entry that
   * has itself been retired does not turn red anywhere a reader can see,
   * because nothing renders that entry's body. Counting it would inflate the
   * one number in this preview a reader might act on.
   *
   * This one is free to hold the entry being retired as well — `previewRetirement`
   * filters it out by slug — because the caller reading "every live entry" out
   * of the database is reading a set this entry is still a member of at the
   * moment it asks.
   */
  otherEntries: readonly EntryText[];
  /** How many rows this entry's history holds. All of them are kept. */
  revisionCount: number;
  /** What it is filed under. It comes off each of these listings. */
  categories: readonly NamedCategory[];
  /**
   * The person this entry is about, formatted, or null when it is about a
   * place, an heirloom or a story.
   *
   * A name rather than a row, because the only thing the confirmation does
   * with it is say it: `individuals.page_id` is left alone by a retirement, so
   * this is the reassuring half — the person keeps their link, and gets the
   * entry back with it.
   */
  subjectName: string | null;
};

/** What retiring this entry does, and what it leaves alone. */
export type RetirementPreview = {
  slug: string;
  title: string;
  /**
   * The entries whose links to this one turn red, alphabetically by title.
   *
   * Named rather than counted because the reader can act on the list and
   * cannot act on the number: "Walter Whitfield and Rose Hall link here" tells
   * somebody where to go and fix the prose, and "2 entries link here" tells
   * them there is something to find.
   */
  incomingLinks: TitledEntry[];
  /** How many saved versions are kept. Never zero for an entry this app made. */
  revisionCount: number;
  /** The listings it leaves, alphabetically by name. */
  categories: NamedCategory[];
  /** The person whose entry this is, or null. Their link survives. */
  subjectName: string | null;
  /**
   * How many distinct photographs the entry's text refers to.
   *
   * Every one of them stays in storage, which is the claim worth being able to
   * make out loud: `lib/image-references.ts` deliberately goes on counting a
   * retired entry's body as a reference, so `npm run db:images-sweep` has
   * nothing new to reclaim after a retirement. Counted from the *current* text
   * rather than from every revision, because the sentence it supports is
   * "the photographs in it", and a count that included pictures taken out of
   * the entry years ago would be a larger number answering a question nobody
   * asked.
   */
  imageCount: number;
};

/**
 * What retiring this entry costs, from facts already read.
 *
 * @param facts the entry, every other live entry, and the counts around it
 * @returns the preview, with its two lists already in reading order
 */
export function previewRetirement(facts: RetirementFacts): RetirementPreview {
  const { entry } = facts;

  return {
    slug: entry.slug,
    title: entry.title,
    incomingLinks: facts.otherEntries
      /**
       * By slug rather than by object identity, and this is the one filter
       * here that is load-bearing rather than defensive. An entry linking to
       * *itself* is ordinary — a section link written by hand, a link left
       * behind by a rename — and it must not be reported as a link that turns
       * red, because after the retirement there is nobody it could turn red
       * for: nothing renders this entry's body any more.
       */
      .filter((other) => other.slug !== entry.slug)
      .filter((other) => linksTo(other, entry.slug))
      .map((other) => ({ slug: other.slug, title: other.title }))
      // The same comparator the index and every category listing use, so an
      // entry appears in the same place in this list as it does in those.
      // See `lib/page-index.ts` for why the order is the application's rather
      // than the database's collation.
      .sort(compareEntriesByTitle),
    revisionCount: facts.revisionCount,
    categories: [...facts.categories].sort(compareCategoriesByName),
    subjectName: facts.subjectName,
    imageCount: imageKeysIn(entry).size,
  };
}

/**
 * Whether this entry links to `slug`, in either of the two places it could.
 *
 * `entryLinkSlugs` is the same parser the red links themselves go through
 * (`lib/red-links.ts`), which is what makes this count agree with what a
 * reader will actually see turn red. A regular expression looking for the
 * address here would be a second opinion about what an internal link is, and
 * the two would drift the first time `lib/entry-links.ts` learned about a new
 * shape of href — leaving a confirmation that under-reports, which is the
 * direction that matters.
 */
function linksTo(entry: EntryText, slug: string): boolean {
  return (
    entryLinkSlugs(entry.bodyHtml).has(slug) ||
    entryLinkSlugs(entry.hatnote).has(slug)
  );
}

/**
 * Every distinct image key the entry's own text refers to.
 *
 * A set, because an entry that shows one photograph twice refers to one
 * photograph. Through `scanEntryImages`, which is the parser
 * `lib/image-references.ts` uses for the same job — so the number the
 * confirmation shows and the number the sweep would count are the same number.
 */
function imageKeysIn(entry: EntryText): Set<string> {
  return new Set([
    ...scanEntryImages(entry.bodyHtml),
    ...scanEntryImages(entry.hatnote),
  ]);
}
