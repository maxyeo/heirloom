import {
  and,
  asc,
  eq,
  inArray,
  or,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";

import { db, schema } from "@/db";
import { isRowId } from "@/lib/row-id";
import type { Transaction } from "@/lib/save-page";
import {
  applyMove,
  readMove,
  readOrder,
  type ReorderUnionsInput,
  resequenceUnions,
} from "@/lib/union-order";

/**
 * The write half of the union sequence editor (E3-T7, `YEO-35`): a person's
 * unions change places, and `unions.sequence` finally gets written by
 * something.
 *
 * ## Why a module of its own
 *
 * `lib/save-union.ts` creates unions and never touches an existing one — that
 * is stated in its header as the property that makes "a second union without
 * touching the first" true, and it is worth keeping true. This is the opposite
 * operation: it writes several existing rows and creates nothing. The two
 * share `lib/union-order.ts`'s arithmetic and nothing else.
 *
 * ## What one transaction buys, and what it does not
 *
 * A reorder is a multi-row write: moving the second marriage above the first
 * renumbers both, and half of that is an order nobody asked for. So it runs in
 * one `db.transaction`, exactly as `lib/remove-from-tree.ts` does, the rows
 * are re-read *inside* it rather than trusted from the client's view, and the
 * renumbering itself is a single `update` rather than one per union — which is
 * what leaves no window between writes to lose a row in.
 *
 * What the transaction does not buy is isolation from a concurrent writer.
 * Postgres runs at READ COMMITTED and nothing here takes a row lock — the same
 * deliberate choice `lib/remove-from-tree.ts` explains at length. Three things
 * cover the gap instead:
 *
 * - the submitted order is compared against the unions the transaction
 *   actually read, so a list with a union added or removed since the page was
 *   rendered is refused as `stale` rather than written as a partial order;
 * - the update re-states *whose* unions these are in SQL, so a partner
 *   detached in another tab cannot have their former union renumbered by this
 *   one;
 * - the update asks for its rows back with `returning`, so a union deleted
 *   between the read and the write is caught — and unwound with
 *   `tx.rollback()`, because postgres.js commits a callback that merely
 *   returns. That is not a hypothetical: it is the bug the first version of
 *   this module shipped with, and `lib/reorder-unions.db.test.ts` now pins
 *   both halves of the semantics.
 *
 * Two people reordering the same person's unions in the same second is still
 * last-write-wins. That is what a lock would order rather than resolve, and it
 * is the outcome `lib/remove-from-tree.ts` already settles for.
 *
 * ## Why there is no validation to speak of
 *
 * Because a reorder carries no author input. Every field is a reference — a
 * person, their unions, and which button was pressed — and the numbers that
 * get written are computed here from the rows themselves rather than typed by
 * anyone. `MAX_UNION_SEQUENCE` is respected by `resequenceUnions` rather than
 * checked after the fact, so there is nothing for `validateUnion` to refuse.
 */

/**
 * How a reorder ends.
 *
 * `unchanged` is a real outcome rather than a defensive one: the ordinary way
 * to reach it is a second click landing before the first one's revalidation
 * repainted the buttons, which asks to move a union off the end of the list.
 * Nothing moved, so — as with `updateIndividual` — nothing is revalidated
 * either.
 *
 * `stale` and `person-not-found` are states the panel renders, not errors. A
 * genuine fault still throws and rolls the transaction back with it.
 */
export type ReorderUnionsResult =
  | { status: "reordered"; unionIds: string[] }
  | { status: "unchanged" }
  | { status: "person-not-found" }
  | { status: "stale" };

/** One of a person's unions, as much of it as the reorder needs. */
type OwnUnion = { id: string; sequence: number };

/**
 * The unions a person is a partner in, read inside the caller's transaction.
 *
 * Ordered the way the tree and the detail panel order them — `sequence`, then
 * `start_date`, then id, which is `getFamilyGraph`'s `ORDER BY` with
 * `compareUnions`'s tie-break added. Postgres sorts ascending nulls last, so
 * an undated union follows a dated one here exactly as `compareNullableDates`
 * puts it last there.
 *
 * Nothing below actually *depends* on that agreement — the order that gets
 * written is the author's, and the numbers come from the multiset — but a read
 * that disagreed with the panel would make every result harder to reason about
 * than it needs to be.
 */
async function ownUnions(
  tx: Transaction,
  personId: string,
): Promise<OwnUnion[]> {
  return tx
    .select({ id: schema.unions.id, sequence: schema.unions.sequence })
    .from(schema.unions)
    .where(
      or(
        eq(schema.unions.partnerAId, personId),
        eq(schema.unions.partnerBId, personId),
      ),
    )
    .orderBy(
      asc(schema.unions.sequence),
      asc(schema.unions.startDate),
      asc(schema.unions.id),
    );
}

/** Whether two id lists name the same unions, in any order. */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inB = new Set(b);
  return a.every((id) => inB.has(id));
}

/**
 * Move one of a person's unions one place in their order.
 *
 * The person is a reference the caller is entitled to name, and so is every
 * union in the list; the *change* is the single adjacent swap the pressed
 * button asked for. That split is the Next.js server-actions guide's, and here
 * it is the whole payload — see `lib/union-order.ts`.
 *
 * Authorisation is the session check in `app/tree/actions.ts` and nothing
 * more: `ALLOWED_EMAILS` is the entire membership model (docs/architecture.md),
 * so every signed-in user may edit every person and there is no per-row
 * ownership to consult.
 *
 * @param input the submission as it arrived, untrusted and untyped
 * @returns the order as written, or why nothing was
 */
export async function reorderUnions(
  input: ReorderUnionsInput,
): Promise<ReorderUnionsResult> {
  const personId =
    typeof input.personId === "string" && isRowId(input.personId.trim())
      ? input.personId.trim()
      : null;
  if (personId === null) return { status: "person-not-found" };

  /**
   * A malformed order or an unreadable button did not come from these
   * controls. Folded into `stale` rather than thrown, because the one way a
   * *reader* can produce it is the same race `stale` already describes, and a
   * hand-made POST is not owed a distinct answer.
   */
  const submitted = readOrder(input.order);
  const move = readMove(input.move);
  if (submitted === null || move === null) return { status: "stale" };

  try {
    return await db.transaction(async (tx): Promise<ReorderUnionsResult> => {
      const [person] = await tx
        .select({ id: schema.individuals.id })
        .from(schema.individuals)
        .where(eq(schema.individuals.id, personId));
      if (person === undefined) return { status: "person-not-found" };

      const current = await ownUnions(tx, personId);

      /**
       * The client's list has to describe the same unions the transaction just
       * read. When it does not, a union was added or removed — or a partner
       * detached — since the page was rendered, and the author is looking at a
       * list that no longer exists. Writing their move into it would silently
       * place the union they could not see.
       *
       * Membership rather than exact order: a *reordering* by somebody else in
       * the meantime is the last-write-wins case this module's header accepts,
       * and refusing it would mean two people tidying the same family both being
       * told to reload, forever.
       */
      if (
        !sameMembers(
          submitted,
          current.map((union) => union.id),
        )
      ) {
        return { status: "stale" };
      }

      const desired = applyMove(submitted, move);
      if (desired === null) return { status: "unchanged" };

      const sequences = resequenceUnions(
        current.map((union) => union.sequence),
      );
      const held = new Map(current.map((union) => [union.id, union.sequence]));

      /**
       * Which rows actually move. Usually two on a tree that has been ordered
       * before, and most of them on one where every union still sits at the
       * column's default — the first reorder is also what turns a table full of
       * zeroes into an order that survives.
       */
      const moving = desired
        .map((unionId, index) => ({ unionId, sequence: sequences[index] }))
        .filter(({ unionId, sequence }) => held.get(unionId) !== sequence);

      /**
       * Nothing differs: the author asked for the order the rows were already
       * in. Reported rather than dressed up as success, so that
       * `app/tree/actions.ts` can skip discarding a good cache entry for a
       * diagram that did not change — and so that no statement runs at all.
       */
      if (moving.length === 0) return { status: "unchanged" };

      /**
       * One statement, not one per union.
       *
       * The first version of this was a loop, and it was wrong in a way worth
       * recording. `db.transaction` is postgres.js's `begin`, which rolls back
       * only when its callback *throws*: a `return { status: "stale" }` from
       * inside the loop resolves normally, so Postgres commits whatever earlier
       * iterations had already written. The function reported a refusal and left
       * the tree half-reordered — the exact state the paragraph above promises
       * cannot happen. `lib/remove-from-tree.ts` is safe from the same trap only
       * because every one of its early returns happens before its single write.
       *
       * A `case` over the ids collapses the whole reorder into one `update`, so
       * there is no window between writes to lose a row in and nothing to
       * unwind by hand. What is left is the `returning` count, and the one
       * honest way out of a transaction that has already written is
       * `tx.rollback()` — which throws, which is what actually rolls back.
       */
      const assignment = sql.join(
        moving.map(
          ({ unionId, sequence }) =>
            sql`when ${eq(schema.unions.id, unionId)} then ${sequence}::integer`,
        ),
        sql` `,
      );

      const written = await tx
        .update(schema.unions)
        .set({
          sequence: sql`case ${assignment} else ${schema.unions.sequence} end`,
        })
        .where(
          and(
            inArray(
              schema.unions.id,
              moving.map(({ unionId }) => unionId),
            ),
            /**
             * Re-stated rather than trusted from the read above, the way
             * `deleteEmptyUnion` re-states its own condition: between the select
             * and this update another tab may have detached this person from
             * one of these unions, and renumbering a union that is no longer
             * theirs would move a row on the strength of a relationship that
             * has gone.
             */
            or(
              eq(schema.unions.partnerAId, personId),
              eq(schema.unions.partnerBId, personId),
            ),
          ),
        )
        .returning({ id: schema.unions.id });

      /**
       * Fewer rows than the order named: one was deleted or detached between the
       * select above and this update, which READ COMMITTED allows within a
       * single transaction because every statement takes a fresh snapshot.
       *
       * `tx.rollback()` rather than a plain return, because a plain return is
       * what commits. It throws `TransactionRollbackError`, which is caught
       * below and turned back into a status; any other error is a genuine fault
       * and keeps propagating, exactly as it would from `lib/save-page.ts`.
       */
      if (written.length !== moving.length) tx.rollback();

      return { status: "reordered", unionIds: desired };
    });
  } catch (error) {
    /**
     * The only rollback this module asks for, and the only one it catches.
     * Anything else — the database unreachable, a constraint violated — is a
     * fault rather than a state the panel renders, and is left to throw.
     */
    if (error instanceof TransactionRollbackError) return { status: "stale" };
    throw error;
  }
}
