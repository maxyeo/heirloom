import { db, schema } from "@/db";
import { scanEntryImages } from "@/lib/entry-images";

/**
 * What counts as a reference to a stored image, in one place (E5-T5,
 * `YEO-45`).
 *
 * Two callers ask this question and they ask it in opposite directions.
 * `lib/export-full.ts` asks it forwards — *which photographs does the archive
 * have to carry* — and `db/images-sweep.ts` asks it backwards — *which
 * photographs is nothing using any more*. They have to agree, because a key
 * the export thinks is worth archiving and the sweep thinks is worth deleting
 * is a bug that only shows up as a hole in somebody's backup.
 *
 * ## The three kinds of reference
 *
 * 1. **Current entry bodies** — `pages.body_html`. An `<img src>` inside
 *    authored HTML, so it has to be parsed back out.
 * 2. **Revisions** — `revisions.body_html`. The same shape, and the one the
 *    ticket is actually about. docs/product.md's *"nothing is ever
 *    destroyed"* means an author who takes a photograph out of an entry has
 *    not stopped referring to it: every revision written while it was there
 *    still contains it, and E1-T7 can restore any of them. So "unreferenced"
 *    is much stricter than "not in the current body", and a scan that stopped
 *    at `pages` would delete a picture that a restore then brings a body back
 *    for — silently, months later, with the broken `<img>` baked into an
 *    append-only row that can never be edited.
 * 3. **Portrait columns** — `individuals.portrait_key` and
 *    `individuals.portrait_thumb_key` (`E5-T4`). Keys already, with no HTML
 *    around them to parse, and referenced by no body anywhere. Nothing about
 *    scanning bodies would ever find one, so a sweep that knew only about
 *    bodies would delete **every portrait in the wiki** on its first run.
 *    Both columns, never just the original: reaping thumbnails would leave
 *    the tree fetching several hundred full-resolution photographs to draw
 *    itself, which is the failure `E5-T4` exists to avoid, reintroduced by
 *    the cleanup.
 *
 * Kind 3 is the one that would have gone missing quietly, and it is why this
 * module exists rather than the two callers each writing a loop.
 *
 * ## Retired entries count, and this is the trap E1-T10 is mostly about
 *
 * `YEO-122` gave `pages` a `deleted_at`, and a dozen modules now filter on it
 * through `LIVE_PAGES`. **This one must not**, and it is registered as a named
 * exemption in `lib/pages.call-sites.test.ts` so that adding the filter here
 * fails a test rather than passing review.
 *
 * The reasoning is kind 2's, one level further out. Retiring an entry is
 * reversible — that is the whole of the feature — so a retired entry's body
 * and hatnote refer to their photographs exactly as much as a superseded
 * revision's do. Filter them out and the sequence is: somebody retires an
 * entry; every photograph in it becomes unreferenced; the next `npm run
 * db:images-sweep --delete` reclaims them; months later somebody restores the
 * entry and gets the paragraphs back with broken `<img>` tags in them —
 * baked, by then, into append-only revision rows that can never be edited. The
 * files are not recoverable, because the nightly backup carries the rows that
 * point at images and never the images themselves
 * (docs/backups.md#what-is-not-in-these-backups).
 *
 * Every property of that failure is one this module already exists to prevent:
 * silent, delayed, and landing on the feature the reversibility is for. So the
 * `pages` read below asks for every row, and the acceptance criterion is that
 * `npm run db:images-sweep` reports nothing new to delete after an entry is
 * retired — asserted in `lib/image-sweep.test.ts` rather than left standing as
 * this paragraph.
 *
 * The asymmetry three paragraphs down settles it if the argument ever feels
 * finely balanced: counting a retired entry's images as referenced costs a few
 * kilobytes nobody reclaims until somebody purges the entry properly. Not
 * counting them deletes a family's photographs.
 *
 * ## What is deliberately *not* shared
 *
 * Which keys each caller puts in, because the two want opposite tie-breaks
 * and folding them together would force one of them to be wrong:
 *
 * - The **export** filters portrait values through `isPortraitKey` first. It
 *   is about to fetch each key out of the store, and a malformed one is a
 *   request that cannot succeed.
 * - The **sweep** passes them in raw. It only ever compares a key against a
 *   listed object by exact string match, so a value it does not recognise can
 *   fail to match and nothing worse — while filtering it out is the one
 *   change that could turn a column this code did not anticipate into a
 *   deleted photograph.
 *
 * That asymmetry runs through the whole ticket. A key wrongly counted as
 * referenced costs a few kilobytes nobody reclaims until the next run. A key
 * wrongly left out is a photograph deleted from a family archive — and
 * photographs are the one thing the nightly backup does not carry
 * (docs/backups.md#what-is-not-in-these-backups), so there is nothing to
 * restore it from. The dump has the row that points at the file; the file
 * itself was only ever in the store.
 *
 * ## One parser
 *
 * Bodies go through `scanEntryImages`, which goes through `imageKeyFromHref`
 * — the same function the sanitiser's `img[src]` check uses
 * (docs/architecture.md#the-one-attribute-whose-value-is-checked). A second
 * regular expression matching `/api/images/` here is the specific mistake
 * that would put this set and the sanitiser's opinion out of step, and the
 * direction it would go wrong in is the deleting one.
 */

/** Where a reference can come from. */
export interface ImageReferenceSources {
  /**
   * Authored HTML to parse `<img src>` out of — entry bodies, revision
   * bodies, and anything else that holds markup.
   */
  html?: Iterable<string | null | undefined>;
  /**
   * Values that are storage keys already, needing no parsing: the portrait
   * columns. Nulls and blanks are ignored so a caller can hand over a
   * nullable column without filtering it first.
   */
  keys?: Iterable<string | null | undefined>;
}

/**
 * Every image key the given sources refer to.
 *
 * @returns storage keys, deduplicated and unordered — membership is the only
 *   question either caller asks of the result, and `lib/export-full.ts` sorts
 *   its own output for its own reasons
 */
export function collectImageReferences(
  sources: ImageReferenceSources,
): Set<string> {
  const keys = new Set<string>();

  for (const html of sources.html ?? []) {
    if (typeof html !== "string" || html === "") continue;
    for (const key of scanEntryImages(html)) keys.add(key);
  }

  for (const key of sources.keys ?? []) {
    if (typeof key !== "string" || key === "") continue;
    keys.add(key);
  }

  return keys;
}

/** Anything that can run a `select` — the pool, or a transaction. */
type ReferenceReader = Pick<typeof db, "select">;

/**
 * What the sweep found, broken down by where it came from.
 *
 * The provenance is not decoration. The dry-run report prints it, and it is
 * what makes a wrong answer legible: a run reporting zero portrait references
 * against a wiki full of photographs has found a bug, and a bare count would
 * have shown that as a number nobody could interpret. It is also the line an
 * operator reads before typing `--delete`.
 */
export interface ImageReferenceCensus {
  /** Every key the database refers to, however it refers to it. */
  keys: ReadonlySet<string>;
  /** How many distinct keys the current entry bodies use. */
  fromPages: number;
  /** How many the revisions use — the append-only half, usually the largest. */
  fromRevisions: number;
  /** How many are named by a portrait column on `individuals`. */
  fromPortraits: number;
}

/**
 * Every image key the database still refers to, read from all three sources.
 *
 * Three selects rather than one union query, because they are three genuinely
 * different shapes — two of HTML that has to be parsed in JavaScript, and one
 * of bare keys — and expressing that as SQL would move the parsing into
 * Postgres, where `imageKeyFromHref` cannot follow it. Only the columns that
 * can hold a reference are selected; the wiki is a family's, and
 * `lib/export-full.ts` already reads every row of every table for a heavier
 * job than this one.
 *
 * Hatnotes are scanned alongside bodies, and today that finds nothing:
 * `normaliseHatnote` flattens a hatnote to text and anchors, so no `img`
 * survives into the column. It costs one more field in a `select`, and it
 * means the sweep is already right on the day the hatnote allowlist widens
 * rather than becoming a deletion bug that ships with that change.
 * Over-collecting is the cheap direction — see the module docblock.
 * `lib/export-full.ts` scans the same two columns, so the claim that the two
 * ask one question is a property of the code rather than of what hatnotes
 * happen to contain right now.
 *
 * @param reader the pool by default; pass a transaction so that the three
 *   reads describe one instant, which is what `db/images-sweep.ts` does
 */
export async function readReferencedImageKeys(
  reader: ReferenceReader = db,
): Promise<ImageReferenceCensus> {
  const [pageRows, revisionRows, individualRows] = await Promise.all([
    reader
      .select({
        bodyHtml: schema.pages.bodyHtml,
        hatnote: schema.pages.hatnote,
      })
      /**
       * **No `LIVE_PAGES` here, and that is load-bearing** (E1-T10,
       * `YEO-122`). A retired entry's body still refers to its photographs,
       * because the retirement is undoable and the restore would otherwise
       * bring back a body pointing at files the sweep had reclaimed. See the
       * module docblock for the full sequence, and
       * `lib/pages.call-sites.test.ts`, which registers this file as one of
       * the two exemptions from the filter so that adding one here goes red.
       */
      .from(schema.pages),
    reader
      .select({
        bodyHtml: schema.revisions.bodyHtml,
        hatnote: schema.revisions.hatnote,
      })
      .from(schema.revisions),
    reader
      .select({
        portraitKey: schema.individuals.portraitKey,
        portraitThumbKey: schema.individuals.portraitThumbKey,
      })
      .from(schema.individuals),
  ]);

  const html = (rows: { bodyHtml: string; hatnote: string }[]) =>
    rows.flatMap((row) => [row.bodyHtml, row.hatnote]);

  const fromPages = collectImageReferences({ html: html(pageRows) });
  const fromRevisions = collectImageReferences({ html: html(revisionRows) });
  const fromPortraits = collectImageReferences({
    // Raw, not filtered through `isPortraitKey`. See the module docblock:
    // a value this code does not recognise can only fail to match a listed
    // object, while filtering it out is what could delete one.
    keys: individualRows.flatMap((row) => [
      row.portraitKey,
      row.portraitThumbKey,
    ]),
  });

  return {
    keys: new Set([...fromPages, ...fromRevisions, ...fromPortraits]),
    fromPages: fromPages.size,
    fromRevisions: fromRevisions.size,
    fromPortraits: fromPortraits.size,
  };
}
