"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createPage } from "@/lib/create-page";
import { restoreRevision } from "@/lib/restore-revision";
import {
  savePage,
  type SavePageEdit,
  type SavePageResult,
} from "@/lib/save-page";
import { requireSession, UnauthorizedError } from "@/lib/session";

/**
 * Server actions for the wiki.
 *
 * The `"use server"` directive makes every export here a POST endpoint that is
 * reachable directly, not only through the editor — so the checks below are
 * the security boundary, and rendering the edit UI behind a session is not.
 * See `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`.
 */

/**
 * Save an edit to an existing page.
 *
 * Takes the change and nothing else: the author is read from the session
 * rather than accepted from the caller, so a direct POST cannot attribute an
 * edit to somebody else. The slug is a reference the client is entitled to
 * name; every signed-in user may edit every page, because `ALLOWED_EMAILS` is
 * the entire membership model (see `lib/session.ts`) and there is no
 * per-page ownership to check against.
 *
 * @param edit the slug to save to, with the new title and body
 * @returns the outcome, safe to render — ids only, no database rows
 */
export async function savePageAction(
  edit: SavePageEdit,
): Promise<SavePageResult> {
  const session = await requireSession();

  // `requireSession` has already thrown if there is no email; this repeats the
  // check because its return type is next-auth's `Session`, whose `user.email`
  // is optional, and the compiler cannot see the narrowing across the call.
  const editedBy = session.user?.email;
  if (!editedBy) throw new UnauthorizedError();

  // The parameter type describes the editor's call, not the request. A direct
  // POST can send anything, so the shape is checked rather than trusted.
  if (
    typeof edit?.slug !== "string" ||
    typeof edit.title !== "string" ||
    typeof edit.bodyHtml !== "string" ||
    // Absent is allowed and anything-but-a-string is not (E11-T9, `YEO-79`).
    // The editor always sends it; a caller that omits it is saying "no
    // hatnote", which `savePage` reads as the empty one. A number or an object
    // arriving here is a caller that thinks this field means something else,
    // and that is worth refusing rather than coercing.
    (edit.hatnote !== undefined && typeof edit.hatnote !== "string")
  ) {
    throw new TypeError(
      "savePageAction expects a slug, title and bodyHtml, all strings, and an optional hatnote.",
    );
  }

  const result = await savePage({
    slug: edit.slug,
    title: edit.title,
    bodyHtml: edit.bodyHtml,
    hatnote: edit.hatnote,
    editedBy,
  });

  /**
   * The read route (E1-T1) is dynamic — it calls `requireSession()`, so it is
   * never in the full route cache and nothing server-side is stale. What this
   * clears is the *client* router cache, which would otherwise let a
   * navigation back to the entry the author just saved re-use the RSC payload
   * fetched before the edit and show them their own change missing.
   *
   * Only on a real write: revalidating after a no-op would throw away a good
   * cache entry for a request that changed nothing.
   */
  if (result.status === "saved") {
    revalidatePath(`/wiki/${edit.slug}`);

    /**
     * And the index (E1-T9), which shows this entry's title and the date it
     * last changed — both of which this save just moved. Without it, an author
     * who edits an entry and navigates back to `/wiki` is served the cached
     * RSC payload and sees the old title under the old date.
     *
     * A bare path, not `"layout"`: the entry route above is revalidated by
     * name, and the layout form would additionally throw away every *other*
     * entry's cached payload to fix one row on one list.
     */
    revalidatePath("/wiki");
  }

  return result;
}

/**
 * What the create form renders while it waits, and after a refusal.
 *
 * There is no success member: a successful creation ends in a `redirect`,
 * which throws, so the only state this action ever returns to the form is one
 * in which the author is still standing in front of it.
 */
export type NewEntryFormState = {
  /** A sentence to show the author, or null when there is nothing to say. */
  error: string | null;
};

/**
 * Start an entry from a title (E1-T8).
 *
 * Shaped for `useActionState`, so it takes the previous state and the form's
 * own `FormData` — which also means it works as a plain form POST when
 * JavaScript has not loaded, and the author still lands in the editor.
 *
 * The address is not a parameter. It is derived from the title inside
 * `createPage`, so a direct POST cannot choose where an entry lives any more
 * than the form can, and the author never has to think about URLs.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields — `title` and nothing else
 * @returns a state to render, or never, when the redirect fires
 */
export async function createPageAction(
  _previous: NewEntryFormState,
  form: FormData,
): Promise<NewEntryFormState> {
  const session = await requireSession();

  // As in `savePageAction`: `requireSession` has already thrown if there is no
  // email, but its return type is next-auth's `Session`, whose `user.email` is
  // optional, and the compiler cannot see the narrowing across the call.
  const createdBy = session.user?.email;
  if (!createdBy) throw new UnauthorizedError();

  // A form field is a `File` when the form posts one, and null when the field
  // is absent — neither is a title, and neither comes from this form.
  const title = form.get("title");
  if (typeof title !== "string") {
    throw new TypeError("createPageAction expects a title field, as text.");
  }

  const result = await createPage({ title, createdBy });

  if (result.status === "empty-title") {
    // The input is `required`, so this is the no-JavaScript path or a direct
    // POST. Said as a request rather than as an error, because an author who
    // pressed a button on an empty form has not done anything wrong.
    return { error: "Give the entry a title to start it." };
  }

  /**
   * The index (E1-T9) lists every entry, so it is stale the moment one is
   * created. Revalidated before the redirect rather than after, because
   * `redirect` throws — and a bare path rather than `"layout"`, matching
   * `savePageAction` above: the entry's own route has nothing cached to
   * clear, since it has only just started existing.
   */
  revalidatePath("/wiki");

  /**
   * Into the editor, which is where "create an entry" actually finishes — the
   * page that exists now has a title and an empty body. `redirect` throws, so
   * nothing below runs and the function's return type is never reached.
   *
   * The slug is encoded rather than interpolated raw: a title in a non-Latin
   * script produces a non-Latin slug (see `lib/entry-slug.ts`), and the
   * `Location` header of the no-JavaScript response has to be a valid URL.
   */
  redirect(`/wiki/${encodeURIComponent(result.slug)}/edit`);
}

/**
 * What the confirmation form renders while it waits, and after a refusal.
 *
 * Shaped like `NewEntryFormState`, and for the same reason: a successful
 * restore ends in a `redirect`, which throws, so the only state this action
 * ever returns is one in which the reader is still standing in front of the
 * confirmation.
 */
export type RestoreFormState = {
  /** A sentence to show the reader, or null when there is nothing to say. */
  error: string | null;
};

/**
 * Restore an entry to one of its earlier revisions (E1-T7).
 *
 * Takes only *references* — which entry, which revision — and never the
 * content. That is the security shape the Next.js server-actions guide asks
 * for ("send a reference plus the user's change, and re-read the rest from a
 * trusted source"), and here it is also the correctness shape: the content of
 * a restore is by definition a row that is already in the database, so a
 * version of this action that accepted HTML would be an unauthenticated way to
 * write arbitrary markup into a page while calling it a restore.
 *
 * Both guards that make that safe live in `lib/restore-revision.ts` rather
 * than here — the id's shape, and the check that the revision belongs to this
 * entry — because this action is one of two doors onto the same operation and
 * a check on the door is a check somebody can forget to fit to the next one.
 *
 * Shaped for `useActionState`, so it takes the previous state and the form's
 * own `FormData`, which also means the confirmation page works as a plain form
 * POST before any JavaScript has loaded.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields — `slug` and `revisionId`, both references
 * @returns a state to render, or never, when the redirect fires
 */
export async function restoreRevisionAction(
  _previous: RestoreFormState,
  form: FormData,
): Promise<RestoreFormState> {
  const session = await requireSession();

  // As in the two actions above: `requireSession` has already thrown if there
  // is no email, but its return type is next-auth's `Session`, whose
  // `user.email` is optional, and the compiler cannot see that narrowing.
  const restoredBy = session.user?.email;
  if (!restoredBy) throw new UnauthorizedError();

  // Hidden fields on a form the browser posts; `File` and null are what a
  // direct POST can send instead, and neither is a reference to anything.
  const slug = form.get("slug");
  const revisionId = form.get("revisionId");
  if (typeof slug !== "string" || typeof revisionId !== "string") {
    throw new TypeError(
      "restoreRevisionAction expects a slug and a revisionId, both as text.",
    );
  }

  const result = await restoreRevision({ slug, revisionId, restoredBy });

  switch (result.status) {
    case "not-found":
      /**
       * One message for three situations — no such entry, no such revision,
       * and a revision belonging to a different entry — matching the single
       * `not-found` status the library deliberately folds them into. Naming
       * which of the three happened would tell someone probing revision ids
       * whether the one they guessed exists.
       */
      return {
        error:
          "That version could not be found. It may belong to a different entry, or the entry may have been deleted.",
      };

    case "empty-title":
      // Only reachable for a revision whose title was written by hand; see
      // `restoreRevision`. Said plainly rather than as an internal error.
      return {
        error: "That version has no title, so it cannot be restored as it is.",
      };

    case "unchanged":
      // Not a failure. The reader asked for a state the entry is already in,
      // and the honest response is to say so rather than to append a revision
      // that records nothing. See the no-op reasoning in `restoreRevision`.
      return {
        error:
          "This entry already matches that version, so nothing was changed.",
      };

    case "restored":
      break;
  }

  /**
   * Everything this write moved, revalidated before the `redirect` below,
   * because `redirect` throws. Bare paths rather than `"layout"`, matching
   * `savePageAction`: each of these is one route by name, and the layout form
   * would additionally discard every other entry's cached payload.
   *
   * All four are dynamic routes that call `requireSession()`, so nothing
   * server-side is stale — what is being cleared is the *client* router cache,
   * which otherwise serves the reader the payload it fetched on the way in and
   * shows them the restore they just performed as not having happened.
   */
  revalidatePath(`/wiki/${slug}`);
  revalidatePath(`/wiki/${slug}/history`);
  // The history list has a new row, and the revision that was restored *from*
  // now has a descendant that links back to it.
  revalidatePath(`/wiki/${slug}/history/${revisionId}`);
  // And the index (E1-T9), which shows this entry's title and the date it last
  // changed — a restore can move both.
  revalidatePath("/wiki");

  /**
   * To the entry, which is where "restore" actually finishes: the payoff is
   * seeing the paragraphs back. The slug is encoded rather than interpolated
   * raw, as `createPageAction` does, because a non-Latin title produces a
   * non-Latin slug and the `Location` header of the no-JavaScript response has
   * to be a valid URL.
   */
  redirect(`/wiki/${encodeURIComponent(slug)}`);
}
