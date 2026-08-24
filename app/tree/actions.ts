"use server";

import { revalidatePath } from "next/cache";

import {
  failedFormState,
  type IndividualFormState,
  invalidFormState,
  savedFormState,
} from "@/lib/individual-form-state";
import { individualInputFromFormData } from "@/lib/individual-input";
import { createIndividual, updateIndividual } from "@/lib/save-individual";
import { requireSession } from "@/lib/session";

/**
 * Server actions for editing the tree (E3-T1, `YEO-29`).
 *
 * The `"use server"` directive makes every export here a POST endpoint that is
 * reachable directly, not only through a form — so the `requireSession()` call
 * at the top of each one is the security boundary, and rendering a form behind
 * a session is not. There is no row-level security under this database to fail
 * safe if an action forgets; see `lib/session.ts`.
 *
 * Validation lives one layer down, in `lib/save-individual.ts`, so the flows
 * that never come through here — E3-T4's add-spouse, E6-T2's GEDCOM import —
 * cannot skip it. What stays here is the pair of things only a request can do:
 * check the session, and revalidate the routes the write moved. See
 * `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`.
 *
 * Every export is an async function, which a `"use server"` module requires —
 * the form state type, its empty value and its constructors therefore live in
 * `lib/individual-form-state.ts`.
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
