"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  changedEntryLinkState,
  type EntryLinkState,
  failedEntryLinkState,
} from "@/lib/entry-link-state";
import {
  type ChildFormState,
  childFailedState,
  childInvalidState,
  childSavedState,
} from "@/lib/child-form-state";
import { addChildInputFromFormData } from "@/lib/child-input";
import {
  failedFormState,
  type IndividualFormState,
  invalidFormState,
  savedFormState,
} from "@/lib/individual-form-state";
import { type IndividualAuthor, memberAuthor } from "@/lib/individual-author";
import { individualInputFromFormData } from "@/lib/individual-input";
import { createEntryForPerson, setPersonEntry } from "@/lib/link-person-entry";
import { mergeUnions } from "@/lib/merge-unions";
import {
  failedUnionMergeState,
  mergedUnionState,
  type UnionMergeState,
} from "@/lib/merge-state";
import {
  type ParentsFormState,
  parentsDuplicateState,
  parentsFailedState,
  parentsInvalidState,
  parentsSavedState,
} from "@/lib/parents-form-state";
import { setParentsInputFromFormData } from "@/lib/parents-input";
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
import { reorderUnions } from "@/lib/reorder-unions";
import { addChild } from "@/lib/save-child";
import { setParents } from "@/lib/set-parents";
import { createIndividual, updateIndividual } from "@/lib/save-individual";
import { addSpouse, updateUnion } from "@/lib/save-union";
import { requireSession, UnauthorizedError } from "@/lib/session";
import {
  type SpouseFormState,
  spouseFailedState,
  spouseInvalidState,
  spouseSavedState,
} from "@/lib/spouse-form-state";
import {
  type UnionEditState,
  unionEditFailedState,
  unionInvalidState,
  unionSavedState,
  unionUnchangedState,
} from "@/lib/union-edit-state";
import {
  addSpouseInputFromFormData,
  editUnionInputFromFormData,
} from "@/lib/union-input";
import { reorderInputFromFormData } from "@/lib/union-order";
import {
  failedUnionOrderState,
  movedUnionOrderState,
  type UnionOrderState,
} from "@/lib/union-order-state";
import { entryPath } from "@/lib/wiki-paths";

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
 * The signed-in member, as the author of whatever they are about to create
 * (`YEO-104`).
 *
 * `requireSession` is still the security boundary; this adds the one narrowing
 * every creating action then needs. Its return type is next-auth's `Session`,
 * whose `user.email` is optional, and the compiler cannot see that
 * `requireSession` has already thrown for a session without one — the same
 * gap `createEntryForPersonAction` below and `app/wiki/actions.ts` each
 * re-close in place. Doing it once here is what keeps the four actions that
 * write a person from each having their own copy of a check whose failure
 * would be a person attributed to nobody.
 *
 * Not exported: a `"use server"` module may only export async functions
 * meant to be POST endpoints, and this is neither.
 */
async function requireAuthor(): Promise<IndividualAuthor> {
  const session = await requireSession();
  const email = session.user?.email;
  if (!email) throw new UnauthorizedError();
  return memberAuthor(email);
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
  const author = await requireAuthor();

  const result = await createIndividual(
    individualInputFromFormData(form),
    author,
  );

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
  const author = await requireAuthor();

  const result = await addSpouse(addSpouseInputFromFormData(form), author);

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
 * Correct a union that is already recorded (for the edit-union form).
 *
 * The union is named by a hidden `unionId` field — a reference the form is
 * entitled to send, exactly as the edit-person form sends an `id`. Everything
 * else is the author's change. The id's shape is checked, and the row looked
 * up, inside `updateUnion` rather than here, for the same reason validation
 * is: a guard on one door is a guard somebody forgets to fit to the next.
 *
 * No author is required, unlike the three actions above it: this writes no
 * `individuals` row, and `unions` records no authorship of its own. The
 * session is still checked, because a `"use server"` export is a POST endpoint
 * whether or not a form is rendered in front of it.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields, including the hidden `unionId`
 * @returns a state to render: the union's id, or what to fix
 */
export async function updateUnionAction(
  _previous: UnionEditState,
  form: FormData,
): Promise<UnionEditState> {
  await requireSession();

  const { unionId, union } = editUnionInputFromFormData(form);

  // A form field is a `File` when the form posts one and null when the field
  // is absent. Neither is a reference to a union, and neither comes from this
  // form — so this is a caller error rather than something to show an author.
  if (typeof unionId !== "string") {
    throw new TypeError("updateUnionAction expects a unionId field, as text.");
  }

  const result = await updateUnion(unionId, union);

  switch (result.status) {
    case "invalid":
      return unionInvalidState(result.issues);

    case "not-found":
      /**
       * One message for both "no such union" and "that is not a union id at
       * all", matching the single status `updateUnion` folds them into. Said
       * as a fact about the tree rather than as an error, and it names the two
       * ordinary ways to reach it: a form left open in one tab while E3-T8
       * detached a partner or E3-T10 merged this union into another.
       */
      return unionEditFailedState(
        "That union is no longer in the tree. It may have been removed, or merged into another.",
      );

    case "unchanged":
      /**
       * Not a failure, and deliberately not revalidated: nothing moved, so
       * discarding a good cache entry would buy a refetch of the same diagram.
       * The id comes back exactly as for `updated`, so a form that closes on
       * success needs no special case for the author who pressed save twice.
       */
      return unionUnchangedState(result.unionId);

    case "updated":
      revalidateTree();
      return unionSavedState(result.unionId);
  }
}

/**
 * Record a birth into a union (for E3-T5's add-child form).
 *
 * The same shape as the actions above and for the same reasons: it takes the
 * previous state and the form's own `FormData`, so the form works as a plain
 * POST before any JavaScript has loaded, and it returns a state rather than
 * redirecting, so the canvas decides where the author ends up.
 *
 * Note what it does *not* take: a parent. The submission names a union, and
 * the union names its own partners — which is what leaves `addChild` reusable
 * by E3-T6's set-parents, and what makes it impossible for a submission to
 * disagree with itself about who the parents are.
 *
 * Everything this writes goes through `addChild`, which validates and — when
 * the child is being created inline — writes both rows in one transaction.
 * None of that lives here, because E6-T2's GEDCOM import will write child
 * links without ever reaching this action, and a rule that lives on one door
 * is a rule somebody forgets to fit to the next.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields, including the hidden `unionId`
 * @returns a state to render: the child's id, or what to fix
 */
export async function addChildAction(
  _previous: ChildFormState,
  form: FormData,
): Promise<ChildFormState> {
  const author = await requireAuthor();

  const result = await addChild(addChildInputFromFormData(form), author);

  switch (result.status) {
    case "invalid":
      return childInvalidState(result.linkIssues, result.childIssues);

    case "union-not-found":
      /**
       * Said as a fact about the tree rather than as an error, because the
       * ordinary way to reach it is a panel left open in one tab while E3-T8
       * removed the union in another — including as the side effect of
       * detaching its last child.
       */
      return childFailedState(
        "That family is no longer recorded. It may have been removed.",
      );

    case "child-not-found":
      return childFailedState(
        "The person you chose is no longer in the tree. Search again, or add them as a new person.",
      );

    case "child-is-partner":
      return childFailedState(
        "That person is one of this family's parents, so they cannot also be its child.",
      );

    case "already-recorded":
      return childFailedState(
        "That person is already recorded as a child of this family.",
      );

    case "child-is-ancestor":
      /**
       * E3-T6's cycle guard, reached from this door too (`YEO-34`). Refused
       * in `lib/save-child.ts` rather than here, because the add-child form,
       * the set-parents form and E6-T2's import all write the same row and a
       * rule that lives on one door is a rule somebody forgets to fit to the
       * next.
       */
      return childFailedState(
        "That person is an ancestor of this family's parents, so they cannot also be its child.",
      );

    case "added":
      /**
       * A child changes the canvas — a new edge, and possibly a whole new
       * person — so there is always something to revalidate.
       */
      revalidateTree();
      return childSavedState(result.childId);
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

/**
 * Say who somebody's parents are (for E3-T6's set-parents form).
 *
 * The flow for "I added them standalone and now want to connect them", and the
 * one action here that can write three rows: it may create the family from two
 * people who were never recorded as a couple, and it may move the person out of
 * the family they were wrongly recorded in — all in one transaction, because a
 * move whose halves could land separately is a person left with no parents at
 * all. None of that lives here; see `lib/set-parents.ts`.
 *
 * The same shape as the actions above and for the same reasons: it takes the
 * previous state and the form's own `FormData`, so the form works as a plain
 * POST before any JavaScript has loaded, and it returns a state rather than
 * redirecting, so the canvas decides where the author ends up.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields, including the hidden `childId`
 * @returns a state to render: the family they are now in, or what to fix
 */
export async function setParentsAction(
  _previous: ParentsFormState,
  form: FormData,
): Promise<ParentsFormState> {
  const author = await requireAuthor();

  const result = await setParents(setParentsInputFromFormData(form), author);

  switch (result.status) {
    case "invalid":
      return parentsInvalidState(result.issues);

    case "child-not-found":
      /**
       * Said as a fact about the tree rather than as an error, because the
       * ordinary way to reach every case below is a panel left open in one tab
       * while E3-T8 removed somebody — or a whole family — in another.
       */
      return parentsFailedState(
        "That person is no longer in the tree. They may have been deleted.",
      );

    case "union-not-found":
      return parentsFailedState(
        "That family is no longer recorded. It may have been removed.",
      );

    case "parent-not-found":
      return parentsFailedState(
        "One of the people you named is no longer in the tree. Search again.",
      );

    case "not-recorded-there":
      return parentsFailedState(
        "They are no longer recorded in the family you asked to move them out of. Nothing was changed.",
      );

    case "child-is-partner":
      return parentsFailedState(
        "That family already records them as one of its parents, so they cannot also be its child.",
      );

    case "already-recorded":
      return parentsFailedState(
        "They are already recorded as a child of that family.",
      );

    case "union-exists":
      /**
       * Not a failure, and deliberately not worded as one. The two people
       * named already have a family recorded, which the author could not have
       * known from the pickers, so the form is handed the families and asks
       * the question. Answering "they were married more than once" resubmits
       * and writes the second one — see `lib/set-parents.ts`.
       */
      return parentsDuplicateState(result.unionIds);

    case "child-is-ancestor":
      /**
       * The cycle guard, and the only refusal here whose consequence would not
       * be a wrong record but an unrenderable page — `lib/tree-layout.ts` walks
       * this graph as though it were acyclic. Worded as a fact about the family
       * rather than as a rule about graphs, because what the author has done is
       * pick the wrong family from a list.
       */
      return parentsFailedState(
        "That family descends from this person, so recording them as its child would make them their own ancestor.",
      );

    case "set":
      /**
       * Parents change the canvas — a new edge at least, and a whole new union
       * marker when the family was created here — so there is always something
       * to revalidate.
       */
      revalidateTree();
      return parentsSavedState(result.unionId);
  }
}

/**
 * Merge two families recorded between the same two people (for E3-T10's
 * confirmation dialogue).
 *
 * The counterpart to the prompt in `setParentsAction` above: that one keeps a
 * duplicate from being created, and this one clears up the ones already there.
 * Everything it does — moving the child links, choosing the surviving row's
 * place in both partners' orders, keeping both sets of notes — lives in
 * `lib/merge-unions.ts`, because all of it belongs in one transaction and a
 * `"use server"` module is the wrong place to own one.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `keepUnionId` and `mergeUnionId`
 * @returns a state to render, or the fact that there was nothing to merge
 */
export async function mergeUnionsAction(
  _previous: UnionMergeState,
  form: FormData,
): Promise<UnionMergeState> {
  await requireSession();

  const result = await mergeUnions(
    rowReference(form, "keepUnionId"),
    rowReference(form, "mergeUnionId"),
  );

  switch (result.status) {
    case "not-found":
      // Said as a fact about the tree rather than as an error: the ordinary
      // way to reach it is a panel left open in one tab while E3-T8 removed
      // one of these two families in another.
      return failedUnionMergeState(
        "One of those families is no longer recorded. It may already have been removed. Nothing was changed.",
      );

    case "not-a-duplicate":
      /**
       * The guard that keeps this from being a way to move somebody's children
       * under a couple they were never recorded with. Worded as a fact about
       * the two families rather than as a rule, because what the author is
       * looking at is a list that has gone stale.
       */
      return failedUnionMergeState(
        "Those two families no longer record the same two people, so there is nothing to merge. Reload the tree.",
      );

    case "merged":
      revalidateTree();
      return mergedUnionState(result.unionId);
  }
}

/**
 * Change the order of a person's unions (for E3-T7's sequence editor).
 *
 * The one action here that writes several rows at once, which is why
 * everything it does lives in `lib/reorder-unions.ts`: the read of the current
 * order and the updates that follow it belong in the same transaction, and a
 * `"use server"` module is the wrong place to own one. What stays here is the
 * pair of things only a request can do.
 *
 * `unchanged` is deliberately not revalidated, matching `updateIndividual`'s
 * branch above. A second click that lands before the first one's revalidation
 * repaints the buttons asks to move a union off the end of the list; nothing
 * moved, so discarding a good cache entry would buy a refetch of the same
 * diagram.
 *
 * @param _previous the last state; unused, since each press stands alone
 * @param form the submitted fields: `personId`, the `unionIds` order, and the
 *   `move` naming the button that was pressed
 * @returns a state to render, or the fact that there was nothing to move
 */
export async function reorderUnionsAction(
  _previous: UnionOrderState,
  form: FormData,
): Promise<UnionOrderState> {
  await requireSession();

  const result = await reorderUnions(reorderInputFromFormData(form));

  switch (result.status) {
    case "person-not-found":
      // Said as a fact about the tree rather than as an error, for the reason
      // the actions above give: the ordinary way to reach it is a panel left
      // open in one tab while E3-T8 deleted the person in another.
      return failedUnionOrderState(
        "That person is no longer in the tree. They may have been deleted.",
      );

    case "stale":
      /**
       * The unions this person has are not the ones the panel was showing, so
       * the move has nowhere to land. The message asks for the one thing that
       * fixes it rather than explaining the race.
       */
      return failedUnionOrderState(
        "The unions recorded for this person have changed. Reload the tree and try again.",
      );

    case "unchanged":
      return movedUnionOrderState;

    case "reordered":
      revalidateTree();
      return movedUnionOrderState;
  }
}

/**
 * Start an entry about a person, from their panel (E2-T2, `YEO-25`).
 *
 * The title is not a field. It is read from the `individuals` row inside
 * `createEntryForPerson`, which is what makes this "write about *this
 * person*" rather than a create-page form with a name typed into it — a
 * direct POST can name a person, and cannot name what the entry about them is
 * called. Creation itself goes through E1-T8's code (`createPageIn`), so the
 * entry's first revision is written by the same function that writes every
 * other one and history starts correctly.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `personId`
 * @returns a state to render, or never, when the redirect fires
 */
export async function createEntryForPersonAction(
  _previous: EntryLinkState,
  form: FormData,
): Promise<EntryLinkState> {
  const session = await requireSession();

  // As in `app/wiki/actions.ts`: `requireSession` has already thrown if there
  // is no email, but its return type is next-auth's `Session`, whose
  // `user.email` is optional, and the compiler cannot see that narrowing.
  const createdBy = session.user?.email;
  if (!createdBy) throw new UnauthorizedError();

  const result = await createEntryForPerson({
    personId: rowReference(form, "personId"),
    createdBy,
  });

  if (result.status === "person-not-found") {
    // Said as a fact about the tree rather than as an error, for the reason
    // every action above gives: the ordinary way to reach it is a panel left
    // open in one tab while E3-T8 deleted the person in another.
    return failedEntryLinkState(
      "That person is no longer in the tree. They may have been deleted.",
    );
  }

  if (result.status === "no-name") {
    /**
     * Unreachable through this application — `given_name` is `not null` and
     * `validateIndividual` refuses a blank one — so this is the row that a
     * hand-written `UPDATE` left with nothing to title an entry after.
     */
    return failedEntryLinkState(
      "That person has no name recorded, so there is nothing to title an entry with.",
    );
  }

  if (result.status === "retired-entry-exists") {
    /**
     * A retired entry already holds the address this person's name derives
     * (§4 of E1-T10, `YEO-122`), so nothing was created.
     *
     * Reported rather than redirected to, which is the opposite of the
     * `already-linked` branch below, and the difference is who the entry is
     * about. There, the entry *is* this person's and going to it is what the
     * author asked for. Here it may be about a different Rose Whitfield
     * entirely — three generations of one name is the ordinary shape of a
     * family tree — so the author is told what is there, by title, and left to
     * decide. `lib/link-person-entry.ts` sets out why guessing would be worse
     * than asking.
     *
     * The title is named because it is the fact that decides: an entry
     * retired under a name that has since been edited is the case where "there
     * is already an entry at that address" would otherwise be baffling.
     */
    return failedEntryLinkState(
      `A retired entry, "${result.title}", already has that address. Open /wiki/${result.slug} to restore it, then link this person to it.`,
    );
  }

  if (result.status === "already-linked") {
    /**
     * The panel was open in another tab, or the button was pressed twice.
     * What the author asked for is an entry about this person and there is
     * one, so they go to it rather than being told about a race they did not
     * cause. The tree is revalidated because the panel they came from is
     * showing the wrong half of this.
     */
    revalidateTree();
    redirect(entryPath(result.slug));
  }

  /**
   * Both routes this moved, revalidated before the `redirect` below, because
   * `redirect` throws. The tree, whose panel now has an entry to link to, and
   * the index (E1-T9), which has a new row on it. Bare paths rather than
   * `"layout"`, matching `app/wiki/actions.ts`.
   */
  revalidateTree();
  revalidatePath("/wiki");

  /**
   * Into the editor, which is where "write about this person" actually
   * finishes: the entry that exists now is titled and empty. The same
   * destination `createPageAction` sends an author to, and the slug is encoded
   * for the same reason — a non-Latin name produces a non-Latin slug, and the
   * `Location` header of the no-JavaScript response has to be a valid URL.
   */
  redirect(entryPath(result.slug, "edit"));
}

/**
 * Point a person at an entry that already exists (E2-T2).
 *
 * Both fields are references — which person, which entry — which is the split
 * the Next.js server-actions guide asks for, and here it is the whole payload.
 * The rules that make it safe live in `lib/link-person-entry.ts` rather than
 * here, because this is one of two doors onto the same column.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `personId` and `pageId`
 * @returns a state to render, or what stopped it
 */
export async function linkPersonEntryAction(
  _previous: EntryLinkState,
  form: FormData,
): Promise<EntryLinkState> {
  await requireSession();

  const result = await setPersonEntry({
    personId: rowReference(form, "personId"),
    pageId: rowReference(form, "pageId"),
  });

  switch (result.status) {
    case "person-not-found":
      return failedEntryLinkState(
        "That person is no longer in the tree. They may have been deleted.",
      );

    case "entry-not-found":
      /**
       * Two situations, one sentence — and since `YEO-122` the second is the
       * likely one. An entry cannot be deleted any more: E1-T10 made removing
       * one a *retirement*, so the ways to reach this branch are an id for a
       * row that was never there, and an entry somebody has retired since this
       * panel was opened. The copy names retirement rather than deletion
       * because that is the one a reader can do something about — the entry is
       * still at its address, with a Restore button on it — and because
       * "deleted" is no longer something that happens to an entry.
       */
      return failedEntryLinkState(
        "That entry is not one you can link to. It may have been retired.",
      );

    case "entry-taken":
      /**
       * One entry, one person — see `lib/link-person-entry.ts`. Named, because
       * the useful thing to say is whose entry it already is: the author has
       * almost certainly picked the wrong row out of a list of similar titles.
       */
      return failedEntryLinkState(
        `That entry is already about ${result.personName}. Unlink it there first, or write a new one.`,
      );

    case "unchanged":
      // Not a failure, and deliberately not revalidated: nothing moved, so
      // discarding a good cache entry would buy a refetch of the same diagram.
      return changedEntryLinkState;

    case "unlinked":
    // Unreachable: this action never sends a null. Folded in with `linked`
    // so the compiler can see the switch is total.
    case "linked":
      revalidateTree();
      return changedEntryLinkState;
  }
}

/**
 * Cut a person loose from their entry, without touching the entry (E2-T2).
 *
 * A separate endpoint rather than a mode of the action above, so that the one
 * which clears the column is never a missing field away from the one which
 * sets it — the same reason `detachPartnerAction` is not a flag on
 * `removePersonAction`.
 *
 * Nothing is deleted: `individuals.page_id` is `on delete set null` precisely
 * because an entry is expected to outlive the link to it. The entry keeps its
 * address, its content and its whole history, and `linkPersonEntryAction` can
 * put it back.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields: `personId`
 * @returns a state to render, or what stopped it
 */
export async function unlinkPersonEntryAction(
  _previous: EntryLinkState,
  form: FormData,
): Promise<EntryLinkState> {
  await requireSession();

  const result = await setPersonEntry({
    personId: rowReference(form, "personId"),
    pageId: null,
  });

  if (result.status === "person-not-found") {
    return failedEntryLinkState(
      "That person is no longer in the tree. They may have been deleted.",
    );
  }

  // `unchanged` — the person had no entry to begin with — is not revalidated,
  // for the reason the actions above give. Everything else moved the column.
  if (result.status !== "unchanged") revalidateTree();

  return changedEntryLinkState;
}
