"use server";

import { revalidatePath } from "next/cache";

import {
  failedFormState,
  type IndividualFormState,
  invalidFormState,
  savedFormState,
} from "@/lib/individual-form-state";
import { individualInputFromFormData } from "@/lib/individual-input";
import {
  detachChild,
  detachPartner,
  removePerson,
} from "@/lib/remove-from-tree";
import {
  failedRemovalState,
  type RemovalState,
  removedState,
} from "@/lib/removal-state";
import { createIndividual, updateIndividual } from "@/lib/save-individual";
import { addSpouse } from "@/lib/save-union";
import { requireSession } from "@/lib/session";
import {
  type SpouseFormState,
  spouseFailedState,
  spouseInvalidState,
  spouseSavedState,
} from "@/lib/spouse-form-state";
import { addSpouseInputFromFormData } from "@/lib/union-input";

/**
 * Server actions for editing the tree (E3-T1, `YEO-29`).
 *
 * The `"use server"` directive makes every export here a POST endpoint that is
 * reachable directly, not only through a form — so the `requireSession()` call
 * at the top of each one is the security boundary, and rendering a form behind
 * a session is not. There is no row-level security under this database to fail
 * safe if an action forgets; see `lib/session.ts`.
 *
 * Validation lives one layer down, in `lib/save-individual.ts` and
 * `lib/save-union.ts`, so the flows that never come through here — E6-T2's
 * GEDCOM import above all — cannot skip it. What stays here is the pair of
 * things only a request can do: check the session, and revalidate the routes
 * the write moved. See
 * `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`.
 *
 * Every export is an async function, which a `"use server"` module requires —
 * the form state types, their empty values and their constructors therefore
 * live in `lib/individual-form-state.ts` and `lib/spouse-form-state.ts`.
 */

/**
 * Everything a write to `individuals` moves, revalidated together.
 *
 * `/tree` is `force-dynamic` and calls `requireSession()`, so it is never in
 * the full route cache and nothing server-side is stale. What this clears is
 * the *client* router cache, which would otherwise let a navigation back to
 * the tree re-use the RSC payload fetched before the write — showing the
 * author the person they just added as missing, or the name they just
 * corrected as unchanged.
 *
 * A bare path rather than `"layout"`, matching `app/wiki/actions.ts`: this is
 * one route by name, and the layout form would additionally discard every
 * other route's cached payload to fix one diagram.
 *
 * Not exported, because a `"use server"` module may only export async
 * functions and this has no business being a POST endpoint of its own.
 */
function revalidateTree() {
  revalidatePath("/tree");
}

/**
 * Add a person to the tree (for E3-T2's form).
 *
 * Shaped for `useActionState`, so it takes the previous state and the form's
 * own `FormData` — which also means the form works as a plain POST before any
 * JavaScript has loaded. The input names are the property names of
 * `IndividualFields`; see `individualInputFromFormData`.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields
 * @returns a state to render: the new person's id, or what to fix
 */
export async function createIndividualAction(
  _previous: IndividualFormState,
  form: FormData,
): Promise<IndividualFormState> {
  await requireSession();

  const result = await createIndividual(individualInputFromFormData(form));

  if (result.status === "invalid") return invalidFormState(result.issues);

  revalidateTree();
  return savedFormState(result.id);
}

/**
 * Change a person already on the tree (for E3-T3's form).
 *
 * The person is named by a hidden `id` field — a reference the form is
 * entitled to send, exactly as `restoreRevisionAction` sends a `revisionId`.
 * Everything else is the author's change. The id's shape is checked, and the
 * row looked up, inside `updateIndividual` rather than here, for the same
 * reason validation is: this action is one of several doors onto the same
 * operation, and a guard on one door is a guard somebody forgets to fit to
 * the next.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields, including the hidden `id`
 * @returns a state to render: the person's id, or what to fix
 */
export async function updateIndividualAction(
  _previous: IndividualFormState,
  form: FormData,
): Promise<IndividualFormState> {
  await requireSession();

  // A form field is a `File` when the form posts one and null when the field
  // is absent. Neither is a reference to a person, and neither comes from this
  // form — so this is a caller error rather than something to show an author.
  const id = form.get("id");
  if (typeof id !== "string") {
    throw new TypeError("updateIndividualAction expects an id field, as text.");
  }

  const result = await updateIndividual(id, individualInputFromFormData(form));

  switch (result.status) {
    case "invalid":
      return invalidFormState(result.issues);

    case "not-found":
      /**
       * One message for both "no such person" and "that is not a person id at
       * all", matching the single status `updateIndividual` folds them into.
       * Said as a fact about the tree rather than as an error, because the
       * ordinary way to reach it is an edit form left open in one tab while
       * E3-T8 deleted the person in another.
       */
      return failedFormState(
        "That person is no longer in the tree. They may have been deleted.",
      );

    case "unchanged":
      /**
       * Not a failure, and deliberately not revalidated: nothing moved, so
       * discarding a good cache entry would buy a refetch of the same diagram.
       * The id comes back exactly as for `updated`, so a form that navigates
       * on success needs no special case for the author who pressed save twice.
       */
      return savedFormState(result.id);

    case "updated":
      revalidateTree();
      return savedFormState(result.id);
  }
}

/**
 * Record a marriage or partnership (for E3-T4's add-spouse form).
 *
 * The same shape as the two actions above and for the same reasons: it takes
 * the previous state and the form's own `FormData`, so the form works as a
 * plain POST before any JavaScript has loaded, and it returns a state rather
 * than redirecting, so the canvas decides where the author ends up.
 *
 * Everything this writes goes through `addSpouse`, which validates and — when
 * the partner is being created inline — writes both rows in one transaction.
 * None of that lives here, because E6-T2's GEDCOM import will create unions
 * without ever reaching this action, and a rule that lives on one door is a
 * rule somebody forgets to fit to the next.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields, including the hidden `personId`
 * @returns a state to render: the new union's id, or what to fix
 */
export async function addSpouseAction(
  _previous: SpouseFormState,
  form: FormData,
): Promise<SpouseFormState> {
  await requireSession();

  const result = await addSpouse(addSpouseInputFromFormData(form));

  switch (result.status) {
    case "invalid":
      return spouseInvalidState(result.unionIssues, result.partnerIssues);

    case "person-not-found":
      /**
       * One message for both "no such person" and "that is not a person id at
       * all", matching the single status `addSpouse` folds them into. Said as
       * a fact about the tree rather than as an error, because the ordinary
       * way to reach it is a panel left open in one tab while E3-T8 deleted
       * the person in another.
       */
      return spouseFailedState(
        "That person is no longer in the tree. They may have been deleted.",
      );

    case "partner-not-found":
      return spouseFailedState(
        "The partner you chose is no longer in the tree. Search again, or add them as a new person.",
      );

    case "added":
      /**
       * A union changes the canvas — a new marker, two new edges, and possibly
       * a whole new person — so unlike the `unchanged` case above there is
       * always something to revalidate.
       */
      revalidateTree();
      return spouseSavedState(result.unionId);
  }
}

/**
 * A row this form is entitled to name.
 *
 * Every field a removal sends is a *reference* rather than content — which is
 * the split the Next.js server-actions guide asks for, and here it is the
 * whole payload. A field that is missing, or that arrived as a `File`, is not
 * a reference and did not come from one of these dialogues, so it is a caller
 * error to throw on rather than something to show an author. Whether the id
 * names a row that exists is `lib/remove-from-tree.ts`'s question, not this
 * one's.
 *
 * Not exported: a `"use server"` module may only export async functions, and
 * this has no business being a POST endpoint of its own.
 */
function rowReference(form: FormData, field: string): string {
  const value = form.get(field);
  if (typeof value !== "string") {
    throw new TypeError(`Expected a ${field} field, as text.`);
  }
  return value;
}

/**
 * Delete a person and everything the cascade takes with them (for E3-T8's
 * confirmation dialogue).
 *
 * The destructive one, and the reason the dialogue in front of it is written
 * as carefully as it is: `db/schema.ts` cascades from `individuals` to every
 * union the person was a partner in, and there is no revision history under
 * the tree to restore from afterwards. The Next.js server-actions guide notes
 * that destructive operations may warrant stronger handling than a read; here
 * that stronger handling is the confirmation, because `ALLOWED_EMAILS` is the
 * entire membership model (docs/architecture.md) and there is no narrower
 * permission to escalate to — everyone who can sign in may edit everyone.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `personId`
 * @returns a state to render, or the fact that there was nothing to remove
 */
export async function removePersonAction(
  _previous: RemovalState,
  form: FormData,
): Promise<RemovalState> {
  await requireSession();

  const result = await removePerson(rowReference(form, "personId"));

  if (result.status === "not-found") {
    // Said as a fact about the tree rather than as an error: the ordinary way
    // to reach it is a panel left open in one tab while the same person was
    // deleted in another.
    return failedRemovalState(
      "That person is no longer in the tree. They may already have been deleted.",
    );
  }

  revalidateTree();
  return removedState;
}

/**
 * Unlink one partner from a union, leaving both people in the tree (for
 * E3-T8's confirmation dialogue).
 *
 * The gentle counterpart to the action above, and a separate endpoint rather
 * than a mode of it, so that the destructive one is never a mistyped field
 * away from the safe one.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `unionId` and `personId`
 * @returns a state to render, or the fact that there was nothing to remove
 */
export async function detachPartnerAction(
  _previous: RemovalState,
  form: FormData,
): Promise<RemovalState> {
  await requireSession();

  const result = await detachPartner(
    rowReference(form, "unionId"),
    rowReference(form, "personId"),
  );

  if (result.status === "not-found") {
    return failedRemovalState(
      "That relationship is no longer recorded. It may already have been removed.",
    );
  }

  revalidateTree();
  return removedState;
}

/**
 * Unlink one child from a union, leaving everybody in the tree (for E3-T8's
 * confirmation dialogue).
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `unionId` and `childId`
 * @returns a state to render, or the fact that there was nothing to remove
 */
export async function detachChildAction(
  _previous: RemovalState,
  form: FormData,
): Promise<RemovalState> {
  await requireSession();

  const result = await detachChild(
    rowReference(form, "unionId"),
    rowReference(form, "childId"),
  );

  if (result.status === "not-found") {
    return failedRemovalState(
      "That child link is no longer recorded. It may already have been removed.",
    );
  }

  revalidateTree();
  return removedState;
}
