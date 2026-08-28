import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { RESERVED_SLUGS, slugCandidate, slugFromTitle } from "@/lib/entry-slug";
import { RETIRED_PAGES } from "@/lib/live-pages";
import { type Transaction, writeRevision } from "@/lib/save-page";

/**
 * Starting an entry (E1-T8, `YEO-22`): a title becomes a `pages` row, its
 * address, and the first line of its history — all three or none of them.
 *
 * ## Why this is not `savePage`
 *
 * `lib/save-page.ts` locks an existing row and returns `not-found` when there
 * is none, which is the correct contract for an edit and the wrong one for a
 * creation. Inserting the page first and then calling `savePage` would mean
 * two transactions where the whole point is one, and its no-op check would
 * then compare the new row against itself and decline to write the very
 * revision this ticket exists to write.
 *
 * What *is* shared is the part worth sharing: `writeRevision` appends the
 * history row here exactly as it does there, so revision 1 is written by the
 * same code and follows the same rule as every revision after it.
 *
 * ## Why the body starts empty
 *
 * Creation takes a title and nothing else, because the author is about to be
 * dropped into the editor and there is no second field on the form. The first
 * revision therefore records an empty body, which is not a placeholder: it is
 * the state the page was genuinely in at that moment, and E1-T6's diff
 * against it is what makes the author's first paragraph show up as something
 * they wrote rather than as content that was always there.
 */

export type CreatePageInput = {
  /** Plain text, as typed. Trimmed here. */
  title: string;
  /** The signed-in author's email. Written to the page and its revision. */
  createdBy: string;
};

/**
 * Every way creating an entry can end.
 *
 * There is no `slug-taken` case, deliberately — E1-T8 is explicit that a URL
 * needing disambiguation is disambiguated silently, so an ordinary collision
 * is not an outcome the author is ever shown.
 */
export type CreatePageResult =
  | { status: "created"; pageId: string; slug: string; revisionId: string }
  | { status: "empty-title" }
  | {
      /**
       * There is a **retired** entry at the address this title derives (§4 of
       * E1-T10, `YEO-122`), so nothing was created, and the author is offered
       * that entry back instead.
       *
       * This is the one exception to the rule above, and it is an exception
       * because it is not really a collision. An ordinary one is two different
       * subjects wanting one address — Rose Hall the house and Rose Hall the
       * person — and disambiguating silently is right, because both entries
       * should exist and both will. A retired entry at the address is the
       * *same subject*, already written, one press away from coming back with
       * its whole history. Minting `rose-whitfield-2` beside it would hand the
       * author a near-twin of something they cannot see, were never told
       * about, and would go on not knowing about while they wrote the entry a
       * second time.
       *
       * It carries the retired entry's own title rather than the one just
       * typed, so the offer can name what is actually there. Those two can
       * differ — an entry renamed after it was created keeps its original
       * address — and which of them is true is exactly the fact that decides
       * whether the author wants it back.
       */
      status: "retired-entry-exists";
      slug: string;
      title: string;
    };

/**
 * How many addresses to try before giving up.
 *
 * Past `NUMBERED_CANDIDATES` the suffixes are random (see `slugCandidate`), so
 * the attempts after that are lottery tickets rather than a queue: each one is
 * overwhelmingly likely to be free. A bound is still here because an unbounded
 * loop against a database is never the right shape, and reaching it means
 * something is wrong that a retry will not fix.
 */
const MAX_ATTEMPTS = 30;

/**
 * Create an entry from a title.
 *
 * The address is derived, never supplied: there is no slug parameter, because
 * there is no slug field, because "slug" is not a word this product's author
 * should have to learn.
 *
 * @param input the title, plus the email to attribute the entry to
 * @returns the outcome, including the slug to send the author to
 */
export async function createPage(
  input: CreatePageInput,
): Promise<CreatePageResult> {
  return db.transaction((tx) => createPageIn(tx, input));
}

/**
 * The same creation, inside a transaction the caller already has.
 *
 * Split out for E2-T2 (`YEO-25`), where starting an entry *for a person* has
 * to write a third row — `individuals.page_id` — and all three have to land
 * together. A version of that flow which called `createPage` and then updated
 * the person would be two transactions, and the window between them is an
 * entry that exists while nothing points at it: the panel that asked for it
 * still offers to write one, and the author gets a second entry about the same
 * person rather than a retry of the first.
 *
 * `createPage` above is now this function plus a transaction, so the ordinary
 * create-page flow (E1-T8) is unchanged and there is exactly one description
 * of how an entry comes into existence.
 *
 * @param tx the caller's transaction; everything below joins it
 * @param input the title, plus the email to attribute the entry to
 * @returns the outcome, including the slug to send the author to
 */
export async function createPageIn(
  tx: Transaction,
  input: CreatePageInput,
): Promise<CreatePageResult> {
  // Trimmed and rejected on the same rule `savePage` uses, so "  " is not a
  // title in one half of the wiki and a title in the other.
  const title = input.title.trim();
  if (!title) return { status: "empty-title" };

  const base = slugFromTitle(title);

  /**
   * Before the loop, and asked about `base` alone (§4 of E1-T10, `YEO-122`).
   *
   * **Before**, because the loop's whole design is not to look first: the
   * unique index decides whether an address is free, and a `select` in front
   * of an `insert` is the race the note below exists to avoid. That argument
   * is about *whether the insert will succeed*, and this question is a
   * different one — is the author about to write a second copy of an entry
   * that already exists? — with a different answer if it is wrong. A lost race
   * here costs a duplicate that is refused a moment later by the index;
   * the retired row it might miss is not a correctness problem but a missed
   * offer, and the author lands in an editor either way. So this is a plain
   * read, inside the caller's transaction, and the loop's race-free insert is
   * untouched behind it.
   *
   * **`base` alone**, and not each candidate the loop goes on to try. A
   * retired entry at `rose-whitfield-2` is not the entry somebody typing "Rose
   * Whitfield" is about to duplicate — it is a *third* Rose, disambiguated
   * away from two others at some point in the past, and offering to restore it
   * would be offering back something the author has never seen and did not ask
   * about. The collision worth naming is the one at the address the title
   * actually derives.
   *
   * A *live* entry at `base` is the ordinary collision and is not this: it
   * falls through, the insert is refused by the index, and the loop finds the
   * next address exactly as it always has.
   *
   * **The window, stated rather than hidden.** This read takes no lock, so a
   * retirement that commits between it and the insert below still produces
   * `rose-whitfield-2`. That is acceptable, and it is worth writing down why:
   * the offer is a courtesy in the sense `lib/restore-preview.ts` uses the
   * word, and the worst it can do by losing the race is behave exactly as this
   * function behaved before E1-T10 existed. Nothing is corrupted and no
   * constraint is at risk — the insert is still the index's decision. Closing
   * the window would mean locking a row that may not exist, on every creation,
   * to improve a suggestion.
   */
  const [retired] = await tx
    .select({ slug: schema.pages.slug, title: schema.pages.title })
    .from(schema.pages)
    .where(and(eq(schema.pages.slug, base), RETIRED_PAGES))
    .limit(1);

  if (retired) {
    return {
      status: "retired-entry-exists",
      slug: retired.slug,
      title: retired.title,
    };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const slug = slugCandidate(base, attempt);

    // A static route already answers here, so the address is not this
    // entry's to take. See `RESERVED_SLUGS`.
    if (RESERVED_SLUGS.has(slug)) continue;

    /**
     * The unique index on `pages.slug` is what decides whether an address
     * is free, rather than a `select` beforehand. Checking first and then
     * inserting leaves a gap in which another creation can take the same
     * slug, and no amount of care in TypeScript closes it — two family
     * members starting "Rose Hall" at the same moment is exactly the race
     * `lib/save-page.db.test.ts` takes seriously for edits.
     *
     * `on conflict do nothing` rather than catching a unique violation,
     * because a raised error would abort the surrounding transaction and
     * force the whole attempt — including the revision write — to start
     * over from a new connection. Returning no rows is an ordinary result
     * that leaves the transaction healthy, so the loop simply asks for the
     * next address.
     */
    const [page] = await tx
      .insert(schema.pages)
      .values({ slug, title, bodyHtml: "", updatedBy: input.createdBy })
      .onConflictDoNothing({ target: schema.pages.slug })
      .returning({ id: schema.pages.id });

    if (!page) continue;

    /**
     * History starts here, in the same transaction as the row it describes.
     * Both `revisions.created_at` and `pages.updated_at` default to `now()`,
     * which Postgres evaluates once per transaction — so the page and its
     * first revision carry the same timestamp, the same invariant every
     * later save maintains.
     */
    const revisionId = await writeRevision(tx, {
      pageId: page.id,
      title,
      bodyHtml: "",
      // A new entry has no hatnote, and stating that rather than defaulting it
      // is what `writeRevision` requires the field for — see its docblock.
      hatnote: "",
      // Nor any filing (`YEO-106`), for the same reason and stated the same
      // way: creation takes a title and nothing else, so there is no picker to
      // read and `[]` is the truth rather than a placeholder.
      categories: [],
      editedBy: input.createdBy,
    });

    return { status: "created", pageId: page.id, slug, revisionId };
  }

  // Unreachable short of the random suffixes colliding ten times running,
  // which is not a state a retry improves. Throwing rolls the transaction
  // back and surfaces as a 500 rather than as a half-made entry.
  throw new Error(
    `Could not find a free address for "${title}" after ${MAX_ATTEMPTS} attempts.`,
  );
}
