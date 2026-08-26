import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { ancestryCycle } from "@/lib/ancestry";
import {
  type AddChildInput,
  type ChildValidationIssue,
  validateAddChild,
} from "@/lib/child-input";
import { getFamilyGraph } from "@/lib/family-graph";
import { authorColumns, type IndividualAuthor } from "@/lib/individual-author";
import type { ValidationIssue } from "@/lib/individual-input";
import { individualExists } from "@/lib/save-individual";
import type { Transaction } from "@/lib/save-page";

/**
 * The write half of the add-child flow (E3-T5, `YEO-33`): raw input becomes a
 * `union_children` row — and, when the child is new, an `individuals` row
 * beside it — or it becomes a list of problems.
 *
 * ## Why validation happens in here rather than in the caller
 *
 * `app/tree/actions.ts` is the `"use server"` entry point: it authenticates
 * and revalidates, and it is one of several doors onto this operation. E3-T6's
 * set-parents attaches an existing person to an existing union, and E6-T2's
 * GEDCOM import writes `CHIL` lines with no request at all. So this function
 * takes *untrusted* input and validates it itself, exactly as
 * `lib/save-union.ts` does — there is no way to reach the insert without
 * passing the rules.
 *
 * ## Why one transaction
 *
 * Creating a child inline is two writes that mean one thing, and the failure
 * mode is the one `addSpouse` describes: an `individuals` insert that commits
 * without its link leaves a stranger floating on the canvas with nothing to
 * say who they are or why they are there. Inside one transaction there is no
 * such state — either the family gained a child or it gained nothing.
 *
 * This is also why the inline person is inserted here rather than through
 * `createIndividual`: that function opens its own statement against `db` and
 * cannot join a transaction this one owns. What it holds that is worth reusing
 * is `validateIndividual`, and `validateAddChild` already calls it.
 *
 * For the same reason in reverse, the work itself lives in `attachChild` and
 * `addChild` is that function plus a transaction (E3-T6, `YEO-34`). The
 * set-parents flow has a union to create and an old link to remove either side
 * of this one, all of which have to land together — so it opens the
 * transaction and calls the core, rather than calling `addChild` and getting a
 * second transaction it cannot roll back with its own.
 *
 * ## What this deliberately does not write
 *
 * Nothing on `individuals`. The relation — biological, adopted, step, foster —
 * is a column on the link, because it describes how this child came into
 * *this* family rather than what kind of person they are. A boy adopted by his
 * stepfather is biological to one union and adopted into another; on the
 * person that is a contradiction, and on the link it is two ordinary rows.
 *
 * And nothing about half-siblings, because there is nothing to write. Two
 * children of two unions sharing one partner are half-siblings by virtue of
 * the rows themselves, and `lib/person-detail.ts` reads that back out without
 * either row being marked. No relationship type is stored anywhere in this
 * file, which is the property the union model exists for.
 */

/**
 * Every way adding a child can end.
 *
 * `union-not-found` and `child-not-found` are not exceptions: the ordinary way
 * to reach either is a panel left open in one tab while E3-T8 deleted
 * somebody in another. All five refusals are states the form renders. A
 * genuine fault — the database unreachable, a constraint violated — still
 * throws and rolls the transaction back with it, exactly as in
 * `lib/save-union.ts`.
 */
export type AddChildResult =
  | {
      status: "added";
      unionId: string;
      /** The child's id, whether they were chosen or created just now. */
      childId: string;
    }
  | {
      status: "invalid";
      linkIssues: ChildValidationIssue[];
      childIssues: ValidationIssue[];
    }
  | { status: "union-not-found" }
  | { status: "child-not-found" }
  /** The chosen person is one of that union's own partners. */
  | { status: "child-is-partner" }
  /** That person is already recorded as a child of that union. */
  | { status: "already-recorded" }
  /**
   * The chosen person already stands *above* one of that union's partners, so
   * the link would make them their own ancestor (E3-T6, `YEO-34`).
   *
   * The only refusal here that is about the shape of the whole graph rather
   * than about two rows, and the only one whose consequence is not a wrong
   * record but an unrenderable page — see `lib/ancestry.ts`.
   */
  | { status: "child-is-ancestor" };

/**
 * Record a birth — or an adoption, or a fostering — into a union.
 *
 * The union and, in `existing` mode, the child are *references* the caller is
 * entitled to name; the relation is the caller's change. That is the split the
 * Next.js server-actions guide asks for, and here it is also all the
 * authorisation there is to do: every signed-in user may edit every person,
 * because `ALLOWED_EMAILS` is the whole membership model (see
 * `lib/session.ts`) and there is no per-row ownership to check.
 *
 * Keyed on the union rather than on a parent, which is what makes it reusable:
 * a child belongs to a union, the union names its own partners, and nothing
 * here needs to know whose panel the flow was opened from.
 *
 * @param input the submission as it arrived, untrusted and untyped
 * @param author who is adding them, for the child this flow may create
 *   (`YEO-104`) — sourced from the session rather than from `input`, for the
 *   reason `createIndividual` gives at length
 * @returns the child's id, or what to fix
 */
export async function addChild(
  input: AddChildInput,
  author: IndividualAuthor,
): Promise<AddChildResult> {
  return db.transaction((tx) => attachChild(tx, input, author));
}

/**
 * The same operation, inside a transaction somebody else opened.
 *
 * Split out for E3-T6's set-parents flow (`YEO-34`), which has work to do on
 * either side of this one: creating the union the child is being attached to
 * when the parents have never been recorded as a couple, and removing the link
 * to the family they are being moved out of. Both of those and this have to
 * land together or not at all — a move that committed the detach and then
 * failed the attach would leave a child with no parents at all, which is worse
 * than either operation not happening.
 *
 * `addChild` above is now this function plus a transaction, so the add-child
 * form and the set-parents form share one implementation of the rules rather
 * than each having their own copy to keep in step.
 *
 * @param tx the caller's transaction; every read and write here joins it
 * @param input the submission as it arrived, untrusted and untyped
 * @param author who is adding the child, for `new` mode's insert (`YEO-104`).
 *   Required rather than optional even though `lib/set-parents.ts` only ever
 *   reaches the `existing` branch: the argument belongs to the *function*,
 *   which can create a person, not to the caller that happens not to. An
 *   optional one would be a default waiting to be taken, which is the thing
 *   `individuals.created_by_source` has no default in order to prevent.
 * @returns the child's id, or what to fix
 */
export async function attachChild(
  tx: Transaction,
  input: AddChildInput,
  author: IndividualAuthor,
): Promise<AddChildResult> {
  const checked = validateAddChild(input);
  if (!checked.ok) {
    return {
      status: "invalid",
      linkIssues: checked.linkIssues,
      childIssues: checked.childIssues,
    };
  }

  const { mode, child, link } = checked;

  /**
   * The union's partners are read, not just its existence, because they are
   * what the "nobody is their own parent" check below compares against. One
   * select answers both questions.
   */
  const [union] = await tx
    .select({
      id: schema.unions.id,
      partnerAId: schema.unions.partnerAId,
      partnerBId: schema.unions.partnerBId,
    })
    .from(schema.unions)
    .where(eq(schema.unions.id, link.unionId));

  if (union === undefined) return { status: "union-not-found" };

  let childId = link.childId;

  if (mode === "existing") {
    /**
     * Checked rather than left to the foreign key. The id arrives from a
     * picker built out of a graph the browser loaded some time ago, so a
     * person deleted since then is an ordinary race — and a constraint
     * violation would surface as a thrown error and an error boundary, where
     * this is a sentence the form can render beside the picker.
     */
    if (childId === null || !(await individualExists(tx, childId))) {
      return { status: "child-not-found" };
    }

    /**
     * Nobody is their own parent. The form does not offer the union's
     * partners in its picker, so reaching this needs a hand-made POST or a
     * partner added in another tab — but the row it would write is a cycle
     * in a graph the layout treats as acyclic, and it is far easier to
     * refuse than to explain afterwards.
     */
    if (childId === union.partnerAId || childId === union.partnerBId) {
      return { status: "child-is-partner" };
    }

    /**
     * `union_children`'s primary key is `(union_id, child_id)`, so a repeat
     * would raise rather than duplicate. Reading first turns that into a
     * sentence the form can show. It is a check, not a lock: two submissions
     * racing would both find nothing and the second would fail on the key,
     * which is the same protection `addSpouse` relies on and the reason the
     * form disables its own submit while a write is in flight.
     */
    const [already] = await tx
      .select({ childId: schema.unionChildren.childId })
      .from(schema.unionChildren)
      .where(
        and(
          eq(schema.unionChildren.unionId, link.unionId),
          eq(schema.unionChildren.childId, childId),
        ),
      );
    if (already !== undefined) return { status: "already-recorded" };

    /**
     * Nobody is their own ancestor (E3-T6, `YEO-34`).
     *
     * The check above catches a person becoming a child of a union they are
     * a partner in, which is one row deep. This catches every depth: a
     * grandmother attached under her own grandson's marriage leaves both
     * partner columns looking perfectly innocent, and puts a cycle into a
     * graph that `lib/tree-layout.ts` and `lib/person-detail.ts` both walk
     * as though it were acyclic. The result is not a wrong-looking panel; it
     * is `/tree` failing to render, for everybody, until somebody finds the
     * row in SQL.
     *
     * Read *here* rather than trusted from the form, and inside the
     * transaction rather than before it. The form filters its own list with
     * the same function (`unionsWithoutCycle`), but it does so against a
     * graph the browser loaded some time ago — a partner added to this union
     * in another tab in the meantime would walk straight through it. This is
     * the same rule `lib/remove-from-tree.ts` and `lib/save-union.ts`
     * already follow: a write re-reads and re-checks.
     *
     * Only in `existing` mode, because a person created a moment ago by the
     * insert below cannot be anybody's ancestor — which is also what keeps
     * the graph read off the common path.
     */
    if (ancestryCycle(await getFamilyGraph(tx), link.unionId, childId)) {
      return { status: "child-is-ancestor" };
    }
  }

  if (mode === "new" && child) {
    /**
     * Already validated by `validateAddChild`, which called the same
     * `validateIndividual` that `createIndividual` calls. The insert is
     * repeated here rather than delegated because `createIndividual` opens
     * its own statement against `db` and could not be rolled back with the
     * link below it.
     */
    const [created] = await tx
      .insert(schema.individuals)
      .values({ ...child, ...authorColumns(author) })
      .returning({ id: schema.individuals.id });
    childId = created.id;
  }

  if (childId === null) {
    // `existing` returned above without an id, and `new` has just minted
    // one, so this is unreachable — and cheaper than widening the row type.
    throw new Error("unreachable: a child link with no child");
  }

  await tx
    .insert(schema.unionChildren)
    .values({ unionId: link.unionId, childId, relation: link.relation });

  return { status: "added", unionId: link.unionId, childId };
}
