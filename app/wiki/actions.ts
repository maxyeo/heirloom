"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createPage } from "@/lib/create-page";
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
    typeof edit.bodyHtml !== "string"
  ) {
    throw new TypeError(
      "savePageAction expects a slug, title and bodyHtml, all strings.",
    );
  }

  const result = await savePage({
    slug: edit.slug,
    title: edit.title,
    bodyHtml: edit.bodyHtml,
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
