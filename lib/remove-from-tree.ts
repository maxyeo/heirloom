import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, schema } from "@/db";
import type { FamilyGraph } from "@/lib/family-graph";
import { getFamilyGraph } from "@/lib/family-graph";
import {
  type ChildDetachmentPreview,
  type PartnerDetachmentPreview,
  type PersonRemovalPreview,
  previewChildDetachment,
  previewPartnerDetachment,
  previewPersonRemoval,
} from "@/lib/removal-preview";
import { isRowId } from "@/lib/row-id";
import type { Transaction } from "@/lib/save-page";

/**
 * The write half of removing things from the tree (E3-T8, `YEO-36`): three
 * operations, in descending order of how much they destroy.
 *
 * ## Why one module rather than three
 *
 * `lib/save-individual.ts` splits nothing because create and update share
 * their validation. These three share more than that: the same id guard, the
 * same read-inside-the-transaction, the same preview functions, and the same
 * rule for when a union has stopped recording anything. Three files would be
 * three copies of `withRemoval` below, which is exactly the drift the note in
 * `lib/row-id.ts` argues against.
 *
 * ## What the transaction does and does not guarantee
 *
 * Every operation here reads the graph and then writes based on what it read,
 * and all of it runs in one `db.transaction`. What that buys is **atomicity**:
 * a detach and the cleanup that follows it either both land or neither does,
 * so no removal can half-happen.
 *
 * What it does *not* buy is isolation from a concurrent writer. Postgres runs
 * at READ COMMITTED by default and nothing here takes a row lock, so another
 * transaction can commit between the read and the write. Two things cover
 * that gap, deliberately, instead of a lock:
 *
 * - every write asks for its rows back with `returning`, so acting on a row
 *   that has vanished is reported as `not-found` rather than as success;
 * - the orphan cleanup re-states its condition in SQL (`deleteEmptyUnion`),
 *   so it cannot delete a union that stopped being empty in the meantime.
 *
 * Deliberately no `FOR UPDATE`, unlike `lib/save-page.ts`. That lock exists
 * there to stop two identical saves from both appending to an append-only
 * history. There is no history table under the tree, so the only race left is
 * last-write-wins between two people editing one family at once — which a
 * lock would order rather than resolve, at the cost of a lock on every
 * removal.
 *
 * ## Why the reads happen inside the transaction anyway
 *
 * Because it makes the returned preview *true*. The browser rendered its
 * confirmation from the graph the page was built with, which may be minutes
 * old; what comes back from here was computed from the rows the delete
 * actually operated on. When the two differ, the one from here is the one to
 * believe, and it is the one the panel reports.
 *
 * ## Why validation is not a concern here
 *
 * There is nothing to validate. A removal carries no author input at all —
 * only references to rows, which are checked for shape by `isRowId` and then
 * looked up. That is the split `node_modules/next/dist/docs/01-app/02-guides/
 * server-actions.md` asks for, in its purest form: the client says *which*,
 * never *what*.
 *
 * ## Why there is no soft delete
 *
 * Because `db/schema.ts` has no column for one, and adding it is a migration
 * plus a filter on every existing read — the tree layout, the panel, the
 * index. The ticket says so out loud: if deletes turn out to be common,
 * soft-delete is the follow-up. What this ticket buys instead is that nobody
 * reaches a delete without being told exactly what it takes with it.
 */

/**
 * How a removal ends.
 *
 * `not-found` rather than a throw, matching `updateIndividual`: the ordinary
 * way to reach it is a panel left open in one tab while the same person was
 * deleted in another, which is a state to render rather than an error
 * boundary to trip. A genuine fault — the database unreachable, a constraint
 * violated — still throws.
 *
 * There is no `unchanged`. Unlike an edit, a removal that finds its row
 * always moves something.
 */
export type RemovalResult<Preview> =
  | { status: "removed"; preview: Preview }
  | { status: "not-found" };

export type RemovePersonResult = RemovalResult<PersonRemovalPreview>;
export type DetachPartnerResult = RemovalResult<PartnerDetachmentPreview>;
export type DetachChildResult = RemovalResult<ChildDetachmentPreview>;

/**
 * Delete a person, and with them every union they were a partner in.
 *
 * The cascade is the schema's, not this function's: one `delete` against
 * `individuals` is the whole write, and `db/schema.ts` does the rest. What
 * matters is that the preview handed back names everything that went, so the
 * panel can report the real consequences rather than "deleted".
 *
 * Their wiki entry is untouched. The foreign key runs from
 * `individuals.page_id` to `pages`, so there is no cascade in this direction
 * at all — `lib/remove-from-tree.db.test.ts` pins that, because it is the one
 * property here that is asserted by the absence of something.
 *
 * @param personId the person to delete, as it arrived — checked, not trusted
 */
export async function removePerson(
  personId: string,
): Promise<RemovePersonResult> {
  if (!isRowId(personId)) return { status: "not-found" };

  return withRemoval(
    (graph) => previewPersonRemoval(graph, personId),
    async (tx, preview) => {
      /**
       * `returning` for the same reason `updateIndividual` uses it: the
       * answer comes from the statement that did the work. A bare `delete`
       * reports success whether or not it matched anything, so a person
       * already deleted in another tab would be reported as deleted twice —
       * once truthfully and once not.
       */
      const [deleted] = await tx
        .delete(schema.individuals)
        .where(eq(schema.individuals.id, personId))
        .returning({ id: schema.individuals.id });

      if (deleted === undefined) return false;

      /**
       * The one orphan a *delete* can leave, cleaned up in the same
       * transaction that made it.
       *
       * The cascade cannot reach it: it takes every union this person was a
       * partner in, but a union they were merely a child of survives — only
       * their link to it goes. So a union with no partners recorded whose
       * only child was this person is left holding nothing, reachable from
       * nobody's panel, and impossible to remove through the application ever
       * again. `previewPersonRemoval` named it above, from this same
       * snapshot, so the dialogue has already said it was coming.
       */
      for (const unionId of preview.orphanedUnionIds) {
        await deleteEmptyUnion(tx, unionId);
      }

      return true;
    },
  );
}

/**
 * Take one partner out of a union, without deleting anybody.
 *
 * The gentle action, and the reason it is gentle is the `set null`: the union
 * row survives holding the other partner and every child, so the children
 * keep the parent they still have and go on reading as one family. Deleting
 * the union instead — which is what deleting the *person* does — would take
 * the surviving partner's link to those children with it.
 *
 * Both partner columns are re-stated rather than only the one being cleared.
 * It costs nothing, it is the same expression the preview reasons about, and
 * it does the right thing with a malformed row that names one person in both
 * slots.
 *
 * @param unionId the union to edit
 * @param personId the partner to unlink from it
 */
export async function detachPartner(
  unionId: string,
  personId: string,
): Promise<DetachPartnerResult> {
  if (!isRowId(unionId) || !isRowId(personId)) return { status: "not-found" };

  return withRemoval(
    (graph) => previewPartnerDetachment(graph, unionId, personId),
    async (tx, preview) => {
      /**
       * Clearing whichever slots hold this person, said in SQL rather than
       * read back off the snapshot. The statement then means exactly what it
       * says — "they are not a partner here any more" — without the caller
       * needing to know which of the two columns they were in, and without a
       * second lookup that could only ever agree with the first. It is also
       * the reason the malformed row naming one person in both slots needs no
       * special case: both are tested, so both are cleared.
       */
      const clear = (column: AnyPgColumn) =>
        sql<string | null>`case when ${column} = ${personId} then null else ${column} end`;

      const [updated] = await tx
        .update(schema.unions)
        .set({
          partnerAId: clear(schema.unions.partnerAId),
          partnerBId: clear(schema.unions.partnerBId),
        })
        .where(eq(schema.unions.id, unionId))
        .returning({ id: schema.unions.id });

      if (updated === undefined) return false;

      // The union may now hold nobody at all — it recorded this person and an
      // unknown partner, and had no children. `deleteEmptyUnion` re-checks
      // that against the row rather than trusting the preview.
      if (preview.removesUnion) await deleteEmptyUnion(tx, unionId);

      return true;
    },
  );
}

/**
 * Take one child out of a union.
 *
 * The narrowest removal there is: one `union_children` row. Nobody is
 * deleted, no union is edited, and the child keeps every other link they
 * have. What it cannot do is detach them from one parent and not the other —
 * parenthood runs child → union → partners in this schema, so the link is to
 * the union, and there is no half of it to remove.
 *
 * @param unionId the union to remove the child from
 * @param childId the child to remove
 */
export async function detachChild(
  unionId: string,
  childId: string,
): Promise<DetachChildResult> {
  if (!isRowId(unionId) || !isRowId(childId)) return { status: "not-found" };

  return withRemoval(
    (graph) => previewChildDetachment(graph, unionId, childId),
    async (tx, preview) => {
      const [removed] = await tx
        .delete(schema.unionChildren)
        .where(
          and(
            eq(schema.unionChildren.unionId, unionId),
            eq(schema.unionChildren.childId, childId),
          ),
        )
        .returning({ childId: schema.unionChildren.childId });

      if (removed === undefined) return false;

      /**
       * The orphan cleanup, and the only place one is reachable. A union that
       * has just lost its last child and never held two partners records
       * nothing and is no longer reachable from anybody's panel, so leaving
       * it would leave a row nothing in the application can ever see or
       * remove. `isUnionOrphaned` decided this above, from the same snapshot.
       *
       * Deliberately scoped to this one union rather than run as a sweep over
       * the table: rows that were already empty — from `db/seed.ts`, or from
       * E6-T2's import — are somebody else's data, and deleting them as a
       * side effect of an unrelated detach would be a surprise rather than a
       * cleanup.
       */
      if (preview.removesUnion) await deleteEmptyUnion(tx, unionId);

      return true;
    },
  );
}

/**
 * Delete a union, but only if it is genuinely holding nothing when the
 * statement runs.
 *
 * The predicate is repeated in SQL rather than trusted from the preview, and
 * that is what makes the cleanup safe without taking a lock. The preview was
 * computed from a read taken earlier in this transaction, and Postgres runs
 * at READ COMMITTED here — so a concurrent commit could add a child to this
 * union in the window between the two. An unconditional delete would then
 * cascade that brand-new child link away, and the author who wrote it would
 * simply never see it again.
 *
 * Expressed as `where` clauses, the statement matches no rows in that case
 * and the union stays. The cleanup can therefore only ever remove a union
 * that is empty *at the moment it is removed*, which is the only claim worth
 * making about it.
 *
 * No `returning`, and nothing checks the result: "the union was not empty
 * after all, so it stays" is a success, not a failure. The operation the
 * author actually asked for has already happened.
 *
 * Exported for E3-T6's set-parents flow (`YEO-34`), which moves a child from
 * one family to another and can vacate the first one in exactly the way
 * `detachChild` can. It takes the caller's transaction rather than opening its
 * own, so a move cleans up inside the same write that made the mess.
 *
 * @param tx the caller's transaction
 * @param unionId the union to remove, if it is empty when the statement runs
 */
export async function deleteEmptyUnion(
  tx: Transaction,
  unionId: string,
): Promise<void> {
  await tx.delete(schema.unions).where(
    and(
      eq(schema.unions.id, unionId),
      isNull(schema.unions.partnerAId),
      isNull(schema.unions.partnerBId),
      notExists(
        tx
          .select({ present: sql`1` })
          .from(schema.unionChildren)
          .where(eq(schema.unionChildren.unionId, unionId)),
      ),
    ),
  );
}

/**
 * The shape all three share: read, preview, write, report.
 *
 * The snapshot the preview reads is a snapshot of the *read*, not a lock on
 * the rows; see the note at the top of this file for what that does and does
 * not rule out.
 *
 * `preview` returning null and `write` returning false are the same outcome —
 * the rows this was asked about are not there — and both land on
 * `not-found`. Nothing is written in either case, so there is nothing to roll
 * back; the transaction simply commits having done no work.
 *
 * @param plan reads the operation's consequences out of the snapshot
 * @param write performs it, and reports whether it matched anything
 */
async function withRemoval<Preview>(
  plan: (graph: FamilyGraph) => Preview | null,
  write: (tx: Transaction, preview: Preview) => Promise<boolean>,
): Promise<RemovalResult<Preview>> {
  return db.transaction(async (tx) => {
    const preview = plan(await getFamilyGraph(tx));
    if (preview === null) return { status: "not-found" as const };

    const written = await write(tx, preview);
    if (!written) return { status: "not-found" as const };

    return { status: "removed" as const, preview };
  });
}
