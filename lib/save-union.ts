import { eq, inArray, max, or } from "drizzle-orm";

import { db, schema } from "@/db";
import { authorColumns, type IndividualAuthor } from "@/lib/individual-author";
import type { ValidationIssue } from "@/lib/individual-input";
import { isRowId } from "@/lib/row-id";
import { individualExists } from "@/lib/save-individual";
import type { Transaction } from "@/lib/save-page";
import {
  type AddSpouseInput,
  EDITABLE_UNION_FIELD_NAMES,
  type EditableUnionField,
  type EditableUnionInput,
  type UnionFields,
  type UnionValidationIssue,
  validateAddSpouse,
  validateUnionEdit,
} from "@/lib/union-input";

/**
 * The write half of the add-spouse flow (E3-T4, `YEO-32`): raw input becomes a
 * `unions` row — and, when the partner is new, an `individuals` row beside it
 * — or it becomes a list of problems.
 *
 * ## Why validation happens in here rather than in the caller
 *
 * `app/tree/actions.ts` is the `"use server"` entry point: it authenticates
 * and revalidates, and it is one of several doors onto this operation. E6-T2's
 * GEDCOM import will write unions without ever passing through it. So this
 * function takes *untrusted* input and validates it itself, exactly as
 * `lib/save-individual.ts` does — there is no way to reach the insert without
 * passing the rules.
 *
 * ## Why one transaction
 *
 * Creating a partner inline is two writes that mean one thing. Half of it is
 * worse than none: an `individuals` insert that commits without its union
 * leaves a stranger floating on the canvas with nothing to explain who they
 * are or why they are there, and no record of the marriage that was the
 * author's actual intention. Inside one transaction there is no such state —
 * either the family gained a couple or it gained nothing.
 *
 * This is also why the inline person is inserted here rather than through
 * `createIndividual`. That function opens its own statement against `db` and
 * cannot join a transaction this one owns; what it holds that is worth reusing
 * is `validateIndividual`, and `validateAddSpouse` already calls it. The
 * insert itself is one statement over a value that has already been checked.
 *
 * ## Why there is no duplicate check
 *
 * Two unions between the same pair of people is not evidence of a mistake —
 * couples who divorced and remarried each other are a real and unremarkable
 * genealogical case, and refusing the second would make it unrecordable.
 * `lib/save-individual.ts` declines to check for duplicate *people* for the
 * same kind of reason. What guards against a double-clicked button is the
 * form disabling its own submit while the action is in flight, which is the
 * protection `NewEntryForm` already relies on for an equally non-idempotent
 * create.
 *
 * That is still true here, and E3-T10 (`YEO-82`) did not change it. What that
 * ticket added is a *prompt* one door along: `lib/set-parents.ts` creates a
 * union from the child's end, where the author is naming two parents rather
 * than recording a marriage, and has no way to see that those two already have
 * a family. It therefore names the existing one and asks. This function is the
 * other door — the author is on somebody's panel, adding a spouse, looking at
 * the marriages already listed there — so the question would be answering
 * itself. `lib/union-merge.ts` cleans up the duplicates either door leaves.
 */

/**
 * Every way adding a spouse can end.
 *
 * `person-not-found` and `partner-not-found` are not exceptions: the ordinary
 * way to reach either is a panel left open in one tab while E3-T8 deleted
 * somebody in another. Both are states the form renders. A genuine fault — the
 * database unreachable, a constraint violated — still throws and rolls the
 * transaction back with it, exactly as in `lib/save-page.ts`.
 */
export type AddSpouseResult =
  | {
      status: "added";
      unionId: string;
      /** The partner's id, or null when the partner was recorded as unknown. */
      partnerId: string | null;
    }
  | {
      status: "invalid";
      unionIssues: UnionValidationIssue[];
      partnerIssues: ValidationIssue[];
    }
  | { status: "person-not-found" }
  | { status: "partner-not-found" };

/**
 * Where a new union goes in a person's order of unions.
 *
 * `unions.sequence` exists because families remember the *order* of marriages
 * long after the years are lost, and `getFamilyGraph` sorts on it before
 * `start_date`. So a union added with no explicit order has to land after the
 * ones already recorded, or a remarriage entered today would sort ahead of the
 * marriage it followed whenever the earlier one has no date.
 *
 * Both partners are considered, not just the person whose panel this was
 * opened from. The number has to make sense from either side of the union: if
 * the *partner* has been married before, this one is their second as well, and
 * a sequence chosen from only one person's history would collide with theirs.
 *
 * Exported for E3-T6's set-parents flow (`YEO-34`), which creates a union from
 * the *child's* end when the parents have never been recorded as a couple. The
 * rule about where that union sorts is the same rule, and a second copy of it
 * would be a second thing to keep in step.
 *
 * @returns one past the highest sequence either partner already has, or 0
 */
export async function nextSequence(
  tx: Transaction,
  partnerIds: readonly string[],
): Promise<number> {
  // Nobody to compare against: an unknown-partner union for a person with no
  // other unions. `inArray` with an empty list is also not valid SQL.
  if (partnerIds.length === 0) return 0;

  const ids = [...partnerIds];
  const [row] = await tx
    .select({ highest: max(schema.unions.sequence) })
    .from(schema.unions)
    .where(
      or(
        inArray(schema.unions.partnerAId, ids),
        inArray(schema.unions.partnerBId, ids),
      ),
    );

  /**
   * `max` over no rows is null, and the first union should be 0 — which is
   * also the column's default, so a row written here and a row written by
   * hand agree.
   *
   * No lock is taken and none is wanted. Two people adding a spouse to the
   * same person in the same second would both read the same maximum and both
   * write the same sequence, and that is harmless: `sequence` is a sort key
   * rather than a constraint, and `compareUnions` in `lib/person-detail.ts`
   * already breaks ties on `start_date` and then on id. A lock would buy a
   * deterministic order between two unions nobody has said the order of.
   */
  return (row?.highest ?? -1) + 1;
}

/**
 * Record a marriage or a partnership.
 *
 * The person is a *reference* the caller is entitled to name; everything else
 * is the caller's change — the split the Next.js server-actions guide asks
 * for. Here it is also all the authorisation there is to do: every signed-in
 * user may edit every person, because `ALLOWED_EMAILS` is the whole membership
 * model (see `lib/session.ts`) and there is no per-row ownership to check.
 *
 * Nothing about an existing union is read for update or written. That is what
 * makes the ticket's "a person can be given a second union without touching
 * the first" a property of the code rather than a promise: a remarriage is one
 * insert, and the earlier marriage is not a party to it. The canvas draws the
 * person once because unions are their own nodes (docs/architecture.md), so a
 * second union adds a second marker rather than a second copy of the person.
 *
 * @param input the submission as it arrived, untrusted and untyped
 * @param author who is adding them, for the partner this flow may create
 *   (`YEO-104`) — sourced from the session rather than from `input`, for the
 *   reason `createIndividual` gives at length
 * @returns the new union's id, or what to fix
 */
export async function addSpouse(
  input: AddSpouseInput,
  author: IndividualAuthor,
): Promise<AddSpouseResult> {
  /**
   * The one field checked before validation rather than by it. `personId`
   * comes from a hidden input naming whose panel the flow was opened from, so
   * a value that is not even shaped like a row id is a caller error rather
   * than something to show an author — and it belongs with the "that person is
   * gone" case, which is the only way a *reader* can cause it.
   */
  const personId =
    typeof input.personId === "string" && isRowId(input.personId.trim())
      ? input.personId.trim()
      : null;
  if (personId === null) return { status: "person-not-found" };

  const checked = validateAddSpouse({ ...input, personId });
  if (!checked.ok) {
    return {
      status: "invalid",
      unionIssues: checked.unionIssues,
      partnerIssues: checked.partnerIssues,
    };
  }

  const { mode, partner, union } = checked;

  return db.transaction(async (tx): Promise<AddSpouseResult> => {
    if (!(await individualExists(tx, personId))) {
      return { status: "person-not-found" };
    }

    let partnerId = union.partnerBId;

    if (mode === "existing") {
      /**
       * Checked rather than left to the foreign key. The id arrives from a
       * picker built out of a graph the browser loaded some time ago, so a
       * partner deleted since then is an ordinary race — and a constraint
       * violation would surface as a thrown error and an error boundary,
       * where this is a sentence the form can render beside the picker.
       */
      if (partnerId === null || !(await individualExists(tx, partnerId))) {
        return { status: "partner-not-found" };
      }
    }

    if (mode === "new" && partner) {
      /**
       * Already validated by `validateAddSpouse`, which called the same
       * `validateIndividual` that `createIndividual` calls. The insert is
       * repeated here rather than delegated because `createIndividual` opens
       * its own statement against `db` and could not be rolled back with the
       * union below it.
       */
      const [created] = await tx
        .insert(schema.individuals)
        .values({ ...partner, ...authorColumns(author) })
        .returning({ id: schema.individuals.id });
      partnerId = created.id;
    }

    const sequence =
      union.sequence ??
      (await nextSequence(
        tx,
        [personId, partnerId].filter((id): id is string => id !== null),
      ));

    const [created] = await tx
      .insert(schema.unions)
      .values({
        ...union,
        partnerAId: personId,
        partnerBId: partnerId,
        sequence,
      })
      .returning({ id: schema.unions.id });

    return { status: "added", unionId: created.id, partnerId };
  });
}

/**
 * Every way correcting a union can end.
 *
 * The same four `updateIndividual` has, and for the same reasons:
 * `unchanged` is not a failure, and `not-found` covers both "no such union"
 * and "that is not a union id at all" — the ordinary way to reach either is a
 * form left open in one tab while the union was deleted or merged in another.
 */
export type UpdateUnionResult =
  | { status: "updated"; unionId: string }
  | { status: "unchanged"; unionId: string }
  | { status: "not-found" }
  | { status: "invalid"; issues: UnionValidationIssue[] };

/**
 * Correct a union that already exists.
 *
 * ## Why this could not be `addSpouse` with an id
 *
 * `addSpouse` answers "who is this person marrying", and its whole shape is
 * built around that: a partner mode, a person created inline, a sequence
 * chosen from the unions that already exist. None of it applies to a
 * correction. What is being fixed here is a *date*, a kind, an end reason or a
 * note on a row whose partners were settled when it was written — so the id is
 * a reference the caller is entitled to name, and everything else is their
 * change. That is the split the Next.js server-actions guide asks for, and
 * here it is also all the authorisation there is to do: every signed-in member
 * may edit every person, because `ALLOWED_EMAILS` is the whole membership
 * model (see `lib/session.ts`).
 *
 ## Why it writes thirteen columns and not sixteen
 *
 * `partner_a_id`, `partner_b_id` and `sequence` are not this flow's to write,
 * so it does not write them — the statement below sets exactly the columns the
 * form puts on screen. Restating them from the row would look harmless and is
 * not: the read and the write are two statements, Postgres runs at READ
 * COMMITTED, and any value captured by the first can be stale by the second.
 * A correction to a date saved from a tab opened five minutes ago would then
 * quietly revert whatever had happened in between — `reorderUnions` moving
 * this union in the list, `mergeUnions` resequencing it, `detachPartner`
 * removing a partner, none of which the author touched or could see. Not
 * naming a column is the only way to be sure of not moving it.
 *
 * The partners are still *read*, because they are validated: "a union needs at
 * least one partner" has to be asked of the record that would actually exist,
 * and the request does not carry them. That is also what makes "an edit cannot
 * change who is in a union" true of any caller rather than of one form's
 * markup — a hand-made POST naming a different `partnerBId` is overridden by
 * the stored one and then not written at all. Moving a partner is
 * `detachPartner`; merging two unions is `lib/merge-unions.ts`; reordering is
 * `lib/reorder-unions.ts`. Each has a confirmation in front of it because each
 * is destructive in a way correcting a year is not.
 *
 * ## Why it validates rather than trusting the caller
 *
 * The same reason `addSpouse` does, stated once in this module's header: this
 * is one door among several onto the same table, and a rule that lives on one
 * door is a rule somebody forgets to fit to the next.
 *
 * @param id the union to correct, as it arrived — checked, not trusted
 * @param input the new details, untrusted and untyped
 * @returns what happened, including whether anything actually changed
 */
export async function updateUnion(
  id: string,
  input: EditableUnionInput,
): Promise<UpdateUnionResult> {
  /**
   * `unions.id` is a `uuid` column, and this id came from a hidden form field
   * or a direct POST. Handing a non-UUID to `eq` reaches Postgres, which
   * raises `invalid input syntax for type uuid` — a thrown error rather than a
   * query returning no rows. Checking the shape first turns a bad id into the
   * ordinary `not-found` the caller already handles. See `lib/row-id.ts`.
   */
  if (!isRowId(id)) return { status: "not-found" };

  return db.transaction(async (tx): Promise<UpdateUnionResult> => {
    const [existing] = await tx
      .select()
      .from(schema.unions)
      .where(eq(schema.unions.id, id));

    // Creating a union is `addSpouse`'s job. No row for this id means it was
    // deleted or merged away, or that somebody POSTed here directly.
    if (!existing) return { status: "not-found" };

    /**
     * Validated *after* the row is read, because the anchors are half of what
     * is being validated: "a union needs at least one partner" has to be asked
     * of the record that would actually be written, and the request does not
     * carry the partners at all.
     */
    const checked = validateUnionEdit(input, {
      partnerAId: existing.partnerAId,
      partnerBId: existing.partnerBId,
    });
    if (!checked.ok) return { status: "invalid", issues: checked.issues };

    /**
     * The columns this flow owns, and the only ones it compares or writes.
     * `checked.value` is a whole `UnionFields` because that is what
     * `validateUnion` returns to every caller; narrowing it here is what keeps
     * the three columns above out of both statements below.
     */
    const changes = Object.fromEntries(
      EDITABLE_UNION_FIELD_NAMES.map((field) => [field, checked.value[field]]),
    ) as Pick<UnionFields, EditableUnionField>;

    /**
     * Compared against the values that would actually be written — after
     * trimming, parsing and normalising — so `unchanged` means "the row would
     * not move" rather than "the author retyped the same thing". A cleared
     * note that was already null therefore counts as unchanged, which is what
     * stops a form that was opened and closed from reporting a save and
     * throwing a good cache entry away.
     *
     * Over the same thirteen columns the write covers, necessarily: a
     * comparison wider than the statement it guards would report a row as
     * moved by a column the statement does not touch.
     *
     * `date` columns come back from Drizzle as `YYYY-MM-DD` strings (no
     * `{ mode: "date" }` on the schema), which is exactly what `readDate`
     * produces, so `===` compares like with like on every field here.
     */
    const unchanged = EDITABLE_UNION_FIELD_NAMES.every(
      (field) => existing[field] === changes[field],
    );
    if (unchanged) return { status: "unchanged", unionId: id };

    /**
     * `returning` rather than a bare `update`, so the answer comes from the
     * statement that did the work instead of from the read above it.
     *
     * The transaction does *not* make that check redundant. Postgres runs at
     * READ COMMITTED unless told otherwise and nothing here tells it
     * otherwise, so each statement takes its own snapshot and a delete
     * committed between the two is visible to the second — being inside one
     * transaction buys no more here than `updateIndividual`'s two independent
     * statements do. What the `returning` catches is exactly that: a bare
     * `update` reports success against zero rows, telling the author their
     * correction was saved onto a union that no longer exists.
     *
     * Still no `FOR UPDATE`, and now nothing that wants one. The lock would
     * have been for the columns this used to restate from the row; writing
     * only what the form owns removes the race rather than ordering it, and
     * what is left is last-write-wins between two people correcting the same
     * date at once, which a lock resolves no better.
     */
    const [updated] = await tx
      .update(schema.unions)
      .set(changes)
      .where(eq(schema.unions.id, id))
      .returning({ id: schema.unions.id });

    if (!updated) return { status: "not-found" };

    return { status: "updated", unionId: id };
  });
}
