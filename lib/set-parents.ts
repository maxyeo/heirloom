import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import {
  type ParentsValidationIssue,
  type SetParentsInput,
  validateSetParents,
} from "@/lib/parents-input";
import { deleteEmptyUnion } from "@/lib/remove-from-tree";
import { attachChild } from "@/lib/save-child";
import { individualExists } from "@/lib/save-individual";
import { nextSequence } from "@/lib/save-union";

/**
 * The write half of the set-parents flow (E3-T6, `YEO-34`): connecting a
 * person who was added on their own to the family they belong to.
 *
 * ## What this adds that `addChild` does not
 *
 * Nothing about the link itself. The `union_children` row is written by
 * `attachChild`, which validates it, refuses a child who is one of the union's
 * own partners, refuses a duplicate, and — since this ticket — refuses one
 * that would make somebody their own ancestor. Reimplementing any of that here
 * would be a second copy of the rules to keep in step.
 *
 * What this owns is the *other* two thirds of the ticket, both of which are
 * work either side of that link:
 *
 * - **the family may not exist yet.** Two people who have never been recorded
 *   as a couple have no union between them, and a flow that made the author go
 *   and record a marriage first would be asking them to assert something they
 *   may not know. So the union is created here, from the parents named, with
 *   `type: "unknown"` — the honest value, because what has been said is that
 *   these two are somebody's parents and nothing at all about their
 *   relationship.
 * - **the child may already be recorded somewhere.** Correcting that is a
 *   move, and a move is one operation rather than two: the ticket asks for it
 *   to be possible "without deleting and re-adding them".
 *
 * ## Why one transaction, and why it matters more here than elsewhere
 *
 * `addSpouse` and `addChild` use a transaction to keep an inline person from
 * committing without their link. This one has a harder failure to prevent: a
 * move that committed its detach and then failed its attach would leave a
 * person with *no parents at all* — worse than either half not happening, and
 * silently so, because nothing about the resulting record looks damaged. The
 * detach, the union insert and the link insert are one write.
 *
 * That is also why `attachChild` exists as something separable from
 * `addChild`. Calling `addChild` here would open a second, independent
 * transaction that this one could not roll back with it.
 *
 * ## The order the steps run in
 *
 * Detach first, then create the union, then attach. That is not arbitrary: the
 * cycle check inside `attachChild` reads the graph, and reading it *after* the
 * detach and the insert is what makes the answer describe the tree as it will
 * actually be. A union created a statement earlier is visible to that read
 * because it is the same transaction.
 *
 * The vacated union is swept up last, for the reason `detachChild` sweeps: a
 * union left holding no partners and no children is unreachable from anybody's
 * panel and could never be removed through the application again.
 */

/**
 * Every way setting a person's parents can end.
 *
 * None of the refusals is an exception. The ordinary way to reach any of the
 * "not found" cases is a panel left open in one tab while E3-T8 deleted
 * somebody in another, and every one of them is a state the form renders. A
 * genuine fault — the database unreachable, a constraint violated — still
 * throws and rolls the transaction back with it, exactly as in
 * `lib/save-union.ts`.
 */
export type SetParentsResult =
  | {
      status: "set";
      /** The family they are now recorded in, created or chosen. */
      unionId: string;
      childId: string;
      /** True when this write created the union as well as the link. */
      createdUnion: boolean;
      /** The family they were moved out of, or null when nothing was moved. */
      movedFrom: string | null;
    }
  | { status: "invalid"; issues: ParentsValidationIssue[] }
  | { status: "child-not-found" }
  /** The chosen family is no longer on the tree. */
  | { status: "union-not-found" }
  /** One of the people named as a parent is no longer on the tree. */
  | { status: "parent-not-found" }
  /** They were not recorded in the family this asked to move them out of. */
  | { status: "not-recorded-there" }
  /** The chosen family already names them as one of its parents. */
  | { status: "child-is-partner" }
  /** They are already recorded as a child of the chosen family. */
  | { status: "already-recorded" }
  /**
   * The chosen family's parents descend from this person, so recording them
   * as its child would make them their own ancestor. See `lib/ancestry.ts`.
   */
  | { status: "child-is-ancestor" };

/**
 * Record who somebody's parents are.
 *
 * The child, the family and the parents are *references* the caller is
 * entitled to name; the relation and the choice of family are the caller's
 * change. That is the split the Next.js server-actions guide asks for, and
 * here it is also all the authorisation there is to do: every signed-in user
 * may edit every person, because `ALLOWED_EMAILS` is the whole membership
 * model (see `lib/session.ts`) and there is no per-row ownership to check.
 *
 * @param input the submission as it arrived, untrusted and untyped
 * @returns the family they are now recorded in, or what to fix
 */
export async function setParents(
  input: SetParentsInput,
): Promise<SetParentsResult> {
  const checked = validateSetParents(input);
  if (!checked.ok) return { status: "invalid", issues: checked.issues };

  const { mode, value } = checked;

  return db.transaction(async (tx): Promise<SetParentsResult> => {
    /**
     * Checked rather than left to the foreign key, and checked first: every
     * later step is about a person, so there is nothing worth doing if they
     * are gone. A constraint violation would surface as a thrown error and an
     * error boundary, where this is a sentence the panel can render.
     */
    if (!(await individualExists(tx, value.childId))) {
      refuse({ status: "child-not-found" });
    }

    /**
     * The move, before anything else. Doing it first is what lets the cycle
     * check further down reason about the tree this write is producing rather
     * than the one it started from.
     *
     * `returning` for the reason `removePerson` uses it: a bare delete reports
     * success whether or not it matched anything, so a link already removed in
     * another tab would be reported as moved when nothing moved at all.
     */
    if (value.fromUnionId !== null) {
      const [detached] = await tx
        .delete(schema.unionChildren)
        .where(
          and(
            eq(schema.unionChildren.unionId, value.fromUnionId),
            eq(schema.unionChildren.childId, value.childId),
          ),
        )
        .returning({ childId: schema.unionChildren.childId });

      if (detached === undefined) refuse({ status: "not-recorded-there" });
    }

    let unionId = value.unionId;
    let createdUnion = false;

    if (mode === "new") {
      /**
       * A family named by its parents rather than chosen from the tree. Both
       * ids are optional and at least one is present — `validateSetParents`
       * settled that — so this loop checks whichever were given and leaves the
       * other column null. That null is the ticket's "one known parent and one
       * unknown", and it is why no placeholder person is invented anywhere in
       * this flow.
       */
      const parentIds = [value.parentAId, value.parentBId].filter(
        (id): id is string => id !== null,
      );

      for (const parentId of parentIds) {
        /**
         * Refused with a throw like every other refusal in here, and this one
         * is the reason the rule is "every refusal, without exception" rather
         * than "the ones that obviously need it". The detach above has already
         * run by the time this loop does — a move into a family being created
         * inline is an ordinary combination, and the form offers both controls
         * at once — so a plain `return` would commit the detach, create
         * nothing, attach nothing, and leave the child with no parents at all.
         */
        if (!(await individualExists(tx, parentId))) {
          refuse({ status: "parent-not-found" });
        }
      }

      const [created] = await tx
        .insert(schema.unions)
        .values({
          /**
           * The known parent lands in the first slot whichever picker the
           * author filled in. The two columns carry no meaning of their own —
           * neither is "the mother" — so a row that leaves the *first* one
           * empty says nothing extra and only makes every reader of this table
           * handle a shape it never needs to see.
           */
          partnerAId: parentIds[0] ?? null,
          partnerBId: parentIds[1] ?? null,
          /**
           * `unknown`, and deliberately not `marriage`. What the author has
           * said is that these two people are somebody's parents; whether they
           * married, and when, is a separate fact they have not been asked
           * for. The column's own default is `marriage`, which is exactly the
           * kind of quietly-asserted value `lib/child-input.ts` warns about —
           * fine until somebody exports it.
           */
          type: "unknown",
          sequence: await nextSequence(tx, parentIds),
        })
        .returning({ id: schema.unions.id });

      unionId = created.id;
      createdUnion = true;
    }

    if (unionId === null) {
      // `existing` mode validated a union id and `new` mode has just minted
      // one, so this is unreachable — and cheaper than widening the type.
      throw new Error("unreachable: no family to record the child in");
    }

    /**
     * The link itself, written by the module that owns `union_children` and
     * every rule about it — including the ancestor walk, run here against a
     * read taken inside this transaction and therefore after the detach and
     * the insert above.
     *
     * `childMode: "existing"` always. Creating a person inline is the
     * add-child form's flow; this one starts from somebody who is already on
     * the tree, which is the entire premise of "I added them standalone and
     * now want to connect them".
     */
    const attached = await attachChild(tx, {
      childMode: "existing",
      childId: value.childId,
      child: {},
      link: { unionId, relation: value.relation },
    });

    switch (attached.status) {
      case "invalid":
        /**
         * Not reachable through this door: every field `attachChild`
         * re-validates was already checked by `validateSetParents`, and the
         * two share `isRowId` and `CHILD_RELATIONS`. Refused the same way as
         * everything else all the same, rather than being reasoned about — a
         * rule added to one validator and not the other should show up as a
         * refused submission, and it must not show up as a committed detach.
         */
        refuse({ status: "invalid", issues: attached.linkIssues });
        break;

      case "union-not-found":
      case "child-not-found":
      case "child-is-partner":
      case "already-recorded":
      case "child-is-ancestor":
        refuse({ status: attached.status });
        break;

      case "added":
        break;
    }

    if (value.fromUnionId !== null) {
      /**
       * The family they left may now be holding nothing at all — it recorded
       * one parent and an unknown partner, and this was its only child. That
       * union is unreachable from every panel in the application, so leaving
       * it would leave a row nothing can ever see or remove.
       *
       * `deleteEmptyUnion` re-states the condition in SQL rather than trusting
       * anything read earlier, so a family that gained a child in another tab
       * between the detach and here is not swept up with it.
       */
      await deleteEmptyUnion(tx, value.fromUnionId);
    }

    return {
      status: "set",
      unionId,
      childId: value.childId,
      createdUnion,
      movedFrom: value.fromUnionId,
    };
  }).catch((error: unknown) => {
    if (error instanceof Refusal) return error.result;
    throw error;
  });
}

/**
 * Refuse, and take everything this transaction has already written with it.
 *
 * Drizzle commits a transaction callback that returns normally, which is
 * exactly right for every other module here: their refusals all happen before
 * any write. This one can refuse *after* the detach, and a committed detach
 * whose attach never happened is the single outcome this whole file exists to
 * prevent — a person left with no parents at all, silently, because nothing
 * about the resulting record looks damaged.
 *
 * So **every** refusal inside the transaction goes through here, including the
 * ones that today happen before anything is written. Deciding case by case
 * which refusals need a rollback is how the one that does gets missed: the
 * dangerous cases are dangerous because of where they sit in the sequence, and
 * that is precisely the thing an edit to this function can change without
 * touching the refusal itself. A rollback of nothing costs nothing.
 *
 * Returns `never`, so the compiler treats a call as an exit and the code after
 * it narrows as though the refusal had returned.
 *
 * @param result what the caller of `setParents` should be told
 */
function refuse(result: SetParentsResult): never {
  throw new Refusal(result);
}

/**
 * The carrier. Only ever thrown by `refuse` and only ever caught by
 * `setParents`, which unwraps it into an ordinary result; a real fault — the
 * database unreachable, a constraint violated — is not an instance of this and
 * goes on propagating untouched.
 */
class Refusal extends Error {
  constructor(readonly result: SetParentsResult) {
    super(`set-parents refused: ${result.status}`);
    this.name = "Refusal";
  }
}
