"use server";

import { revalidatePath } from "next/cache";

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
  }

  return result;
}
