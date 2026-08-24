import { inArray, max, or } from "drizzle-orm";

import { db, schema } from "@/db";
import type { ValidationIssue } from "@/lib/individual-input";
import { isRowId } from "@/lib/row-id";
import { individualExists } from "@/lib/save-individual";
import type { Transaction } from "@/lib/save-page";
import {
  type AddSpouseInput,
  type UnionValidationIssue,
  validateAddSpouse,
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
 * @returns the new union's id, or what to fix
 */
export async function addSpouse(
  input: AddSpouseInput,
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
        .values(partner)
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
      .values({ ...union, partnerAId: personId, partnerBId: partnerId, sequence })
      .returning({ id: schema.unions.id });

    return { status: "added", unionId: created.id, partnerId };
  });
}
