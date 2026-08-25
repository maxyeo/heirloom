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
import { getFamilyGraph } from "@/lib/family-graph";
import { isRowId } from "@/lib/row-id";
import type { Transaction } from "@/lib/save-page";
import {
  couplePartnerIds,
  joinNotes,
  previewUnionMerge,
  sameCouple,
  type UnionMergePreview,
} from "@/lib/union-merge";
import { resequenceUnions } from "@/lib/union-order";

/**
 * The write half of merging two unions between the same two people (E3-T10,
 * `YEO-82`): two rows recording one family become one, and nothing recorded
 * against either of them is lost.
 *
 * ## What this is not
 *
 * It is not a duplicate check. `lib/save-union.ts` explains at length why
 * there is no uniqueness rule on the two partner columns — a couple who
 * divorced and remarried each other is ordinary genealogy, and refusing their
 * second marriage would make a real case unrecordable. So a duplicate is
 * something an author *decides* is a duplicate, here, after being shown
 * exactly what merging costs. See `lib/union-merge.ts`.
 *
 * ## Why this one takes a lock, when `lib/remove-from-tree.ts` refuses to
 *
 * That module argues — correctly, for what it does — that a lock would order
 * rather than resolve a race between two people editing one family, and that
 * `returning` plus a re-stated `where` covers everything that matters. Every
 * write it performs is against a row the author named.
 *
 * This one has a failure those two guards cannot see. The merge ends by
 * deleting the union it merged away, and `db/schema.ts` cascades from `unions`
 * to `union_children` — so a child attached to that union in another tab, in
 * the window between reading its children and deleting it, is destroyed
 * silently. There is no revision history under the tree to notice it
 * afterwards, and the acceptance criterion is "no child link is lost".
 *
 * A `for update` on the union being merged away closes it, and closes it
 * exactly: an insert into `union_children` takes a `FOR KEY SHARE` lock on the
 * `unions` row it references, which `FOR UPDATE` conflicts with. So for the
 * length of this transaction that union cannot gain a child. The lock is taken
 * *before* the graph is read, which is also what makes the preview reported
 * back true about which children moved.
 *
 * Nothing else is locked. Two people merging the same pair of unions at once
 * is still last-write-wins between the surviving row's fields, which is the
 * outcome the rest of the tree already settles for.
 *
 * ## Why the sequence work is here rather than in `lib/reorder-unions.ts`
 *
 * Because it is not a reorder: nobody asked for a new order, and the order
 * that comes out is the one the author was already looking at. What a merge
 * owes `sequence` is narrower — the surviving union takes the *earlier* of the
 * two numbers, and both partners' orders are left strictly increasing rather
 * than holding a tie that the merge itself introduced. The arithmetic for the
 * second half is `resequenceUnions`, shared with the reorder rather than
 * copied, for the reason that module's header gives about `nextSequence`.
 */

/**
 * How a merge ends.
 *
 * Neither refusal is an exception. The ordinary way to reach `not-found` is a
 * panel left open in one tab while E3-T8 removed a family in another;
 * `not-a-duplicate` is the guard that keeps this from being a way to move
 * somebody's children under a couple they were never recorded with, and the
 * only way a *reader* reaches it is the same race. A genuine fault — the
 * database unreachable, a constraint violated — still throws and rolls the
 * transaction back with it.
 */
export type MergeUnionsResult =
  | {
      status: "merged";
      /** The family that survived, which is the one the author kept. */
      unionId: string;
      /**
       * What the merge actually did, computed inside the transaction against
       * the rows it operated on rather than echoed back from the browser's
       * view — the same reason `lib/remove-from-tree.ts` returns a preview.
       */
      preview: UnionMergePreview;
    }
  | { status: "not-found" }
  /** The two unions do not both record the same two named people. */
  | { status: "not-a-duplicate" };

/**
 * Merge one union into another.
 *
 * Both ids are *references* the caller is entitled to name and the change is
 * the merge itself — the split the Next.js server-actions guide asks for. Here
 * it is also all the authorisation there is to do: every signed-in user may
 * edit every person, because `ALLOWED_EMAILS` is the whole membership model
 * (see `lib/session.ts`).
 *
 * @param keepUnionId the family that survives, with its own type, dates and
 *   end reason — which is how the author chooses which values live
 * @param mergeUnionId the family whose children, place in the order and notes
 *   move into it, and whose row then goes
 */
export async function mergeUnions(
  keepUnionId: string,
  mergeUnionId: string,
): Promise<MergeUnionsResult> {
  if (!isRowId(keepUnionId) || !isRowId(mergeUnionId)) {
    return { status: "not-found" };
  }
  /**
   * One union merged into itself would delete the row it was asked to keep.
   * Reported as "not a duplicate" rather than as a missing row, because that
   * is what it is: one family is not two.
   */
  if (keepUnionId === mergeUnionId) return { status: "not-a-duplicate" };

  try {
    return await db.transaction(async (tx): Promise<MergeUnionsResult> => {
      /**
       * The lock, and the first statement of the transaction. See this
       * module's header: it is what stops the delete at the end from
       * cascading away a child link written between here and there.
       */
      const [locked] = await tx
        .select({ id: schema.unions.id, notes: schema.unions.notes })
        .from(schema.unions)
        .where(eq(schema.unions.id, mergeUnionId))
        .for("update");
      if (locked === undefined) return { status: "not-found" };

      /**
       * `unions.notes` on the surviving row, which `FamilyGraph` does not
       * carry — nothing on the canvas renders it, and widening that type for
       * one write would put a column in every literal graph in the test suite.
       * Read here instead, beside the other row's notes above.
       */
      const [kept] = await tx
        .select({ notes: schema.unions.notes })
        .from(schema.unions)
        .where(eq(schema.unions.id, keepUnionId));
      if (kept === undefined) return { status: "not-found" };
      const keptNotes = kept.notes;

      const graph = await getFamilyGraph(tx);
      const keep = graph.unions.find((union) => union.id === keepUnionId);
      const merge = graph.unions.find((union) => union.id === mergeUnionId);
      if (keep === undefined || merge === undefined) {
        return { status: "not-found" };
      }
      if (!sameCouple(keep, merge)) return { status: "not-a-duplicate" };

      const preview = previewUnionMerge(graph, keepUnionId, mergeUnionId);
      if (preview === null) {
        // Both unions came out of this graph and record the same couple, which
        // is every reason `previewUnionMerge` has to return null.
        throw new Error("unreachable: a mergeable pair with no preview");
      }

      const partnerIds = couplePartnerIds(keep);
      if (partnerIds === null) {
        // `sameCouple` above is exactly this question, asked of both rows.
        throw new Error("unreachable: a couple with an unnamed partner");
      }

      /**
       * The children moving across, written as `union_children` rows against
       * the surviving union.
       *
       * `onConflictDoNothing` rather than a check, for the one row this could
       * collide on: a child recorded in *both* unions, whose link on the
       * surviving side already exists and already carries the relation the
       * author has chosen to keep. The preview lists those separately and the
       * conflict clause is the belt to its braces — another tab may have
       * attached the same child to the surviving union since the graph was
       * read, and that is not a reason to fail a merge.
       */
      if (preview.moving.length > 0) {
        await tx
          .insert(schema.unionChildren)
          .values(
            preview.moving.map(({ child, relation }) => ({
              unionId: keepUnionId,
              childId: child.id,
              relation,
            })),
          )
          .onConflictDoNothing();
      }

      /**
       * The row itself. Its remaining `union_children` rows go with it by
       * cascade — every one of them either moved above or is a duplicate of a
       * link the surviving union already holds, which the lock is what makes
       * true.
       */
      const [removed] = await tx
        .delete(schema.unions)
        .where(eq(schema.unions.id, mergeUnionId))
        .returning({ id: schema.unions.id });
      // Impossible while the lock is held, and checked anyway: this is the one
      // statement whose failure would leave the children copied and both rows
      // still standing.
      if (removed === undefined) tx.rollback();

      /**
       * The surviving row, restated.
       *
       * `sequence` is the earlier of the two, because these rows describe one
       * family and its place in each partner's order is the earlier of the two
       * claims about it — see `UnionMergePreview`. `notes` is both, joined:
       * the one field a merge does not make the author choose about, because
       * prose somebody typed cannot contradict other prose and the tree keeps
       * no history to recover it from. See `joinNotes`.
       *
       * Nothing else is written. The whole of "which values survive" is which
       * row the author kept, and this row already holds them.
       */
      const [survivor] = await tx
        .update(schema.unions)
        .set({
          sequence: preview.sequence,
          notes: joinNotes(keptNotes, locked.notes),
        })
        .where(eq(schema.unions.id, keepUnionId))
        .returning({ id: schema.unions.id });
      /**
       * The surviving union was deleted in another tab between the graph read
       * and here — the one row this transaction did not lock, because locking
       * it would buy nothing else. Everything above is unwound rather than
       * left as a half-merge with no family at the end of it.
       */
      if (survivor === undefined) tx.rollback();

      await resequencePartners(tx, partnerIds);

      return { status: "merged", unionId: keepUnionId, preview };
    });
  } catch (error) {
    /**
     * The only rollback this module asks for, and the only one it catches —
     * the same shape `lib/reorder-unions.ts` uses. Anything else is a fault
     * rather than a state a dialogue renders, and is left to throw.
     */
    if (error instanceof TransactionRollbackError)
      return { status: "not-found" };
    throw error;
  }
}

/**
 * Leave both partners' orders strictly increasing after the merge.
 *
 * ## What actually needs fixing
 *
 * Deleting a union cannot break a relative order, and a gap in `sequence` is
 * harmless — it is a sort key, not an index. What a merge *can* introduce is a
 * **tie**: the surviving union takes the earlier of the two numbers, and that
 * number may already belong to one of these people's other unions. A tie is
 * the one state `sequence` cannot express an order in, which is precisely the
 * argument `lib/union-order.ts` makes for breaking ties upward.
 *
 * ## Why both partners at once, rather than one pass each
 *
 * Because the acceptance criterion is "`sequence` stays coherent for **both**
 * partners", and one pass per partner cannot deliver that: the second pass
 * reads rows the first has already moved and can re-introduce, for the first
 * partner, the tie it just resolved for the second. One pass over the union of
 * both partners' unions has no such ordering problem — the numbers come out
 * strictly increasing across the whole set, and any subset of a strictly
 * increasing run is itself strictly increasing. So both partners end up with
 * an unambiguous order, and each keeps the relative order they were already
 * being shown.
 *
 * ## What it disturbs
 *
 * A union belonging to one of these two people and some *third* person can be
 * renumbered here, which may re-sort that third person's own list. That is the
 * one-column-two-owners problem `lib/union-order.ts` states as a property of
 * the schema rather than of any function, and this settles for the same bound
 * it does: only these people's rows are written, and only the numbers those
 * rows already hold between them are used, except where a tie forces a lift.
 */
async function resequencePartners(
  tx: Transaction,
  partnerIds: readonly [string, string],
): Promise<void> {
  const ids = [...partnerIds];

  const partnerOf = or(
    inArray(schema.unions.partnerAId, ids),
    inArray(schema.unions.partnerBId, ids),
  );

  /**
   * Read in the order the panel and the canvas show them — `sequence`, then
   * `start_date`, then id, which is `getFamilyGraph`'s `ORDER BY` with
   * `compareUnions`'s tie-break added. That order is the one being preserved,
   * so it has to be the one this reads in.
   */
  const current = await tx
    .select({ id: schema.unions.id, sequence: schema.unions.sequence })
    .from(schema.unions)
    .where(partnerOf)
    .orderBy(
      asc(schema.unions.sequence),
      asc(schema.unions.startDate),
      asc(schema.unions.id),
    );

  const assigned = resequenceUnions(current.map((union) => union.sequence));

  // Only the rows whose number actually changes. `assigned` is positional
  // against `current`, so the number a union holds now is right there beside
  // the one it is being given.
  const moving = current
    .map((union, index) => ({
      unionId: union.id,
      sequence: assigned[index],
      held: union.sequence,
    }))
    .filter(({ sequence, held }) => held !== sequence);

  // The common case by far: no tie was introduced, so nothing is written and
  // no third party's list moves at all.
  if (moving.length === 0) return;

  /**
   * One statement rather than one per union, for the reason
   * `lib/reorder-unions.ts` records at length: a loop inside a transaction
   * whose early exit merely returns is a loop that commits half an order.
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
        // Re-stated rather than trusted from the read above, the way
        // `deleteEmptyUnion` re-states its own condition: a partner detached in
        // another tab must not have their former union renumbered by this one.
        partnerOf,
      ),
    )
    .returning({ id: schema.unions.id });

  // A union deleted between the select and the update, which READ COMMITTED
  // allows within one transaction. Unwound rather than committed as a partial
  // order — and it takes the whole merge with it, which is the honest answer.
  if (written.length !== moving.length) tx.rollback();
}
