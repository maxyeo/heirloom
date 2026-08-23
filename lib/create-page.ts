import { db, schema } from "@/db";
import { RESERVED_SLUGS, slugCandidate, slugFromTitle } from "@/lib/entry-slug";
import { writeRevision } from "@/lib/save-page";

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
 * There is no `slug-taken` case, deliberately — the ticket is explicit that a
 * URL needing disambiguation is disambiguated silently, so a collision is not
 * an outcome the author is ever shown. `empty-title` is the only refusal, and
 * it is one the form can prevent.
 */
export type CreatePageResult =
  | { status: "created"; pageId: string; slug: string; revisionId: string }
  | { status: "empty-title" };

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
  // Trimmed and rejected on the same rule `savePage` uses, so "  " is not a
  // title in one half of the wiki and a title in the other.
  const title = input.title.trim();
  if (!title) return { status: "empty-title" };

  const base = slugFromTitle(title);

  return db.transaction(async (tx): Promise<CreatePageResult> => {
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
  });
}
