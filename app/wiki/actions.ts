"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { deleteCategory } from "@/lib/categories";
import { createPage } from "@/lib/create-page";
import { restorePage, retirePage } from "@/lib/retire-page";
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
    (edit.hatnote !== undefined && typeof edit.hatnote !== "string") ||
    /**
     * And the categories (E11-T8, `YEO-78`), on the same terms: absent means
     * "no opinion" and is allowed, anything that is not an array of strings is
     * refused. The shapes a caller might send instead — one string, an array
     * of objects, `null` — are each a caller that thinks this field means
     * something else. This decides only that they are names; `savePage`
     * decides what the names mean.
     */
    (edit.categories !== undefined &&
      (!Array.isArray(edit.categories) ||
        edit.categories.some((name) => typeof name !== "string")))
  ) {
    throw new TypeError(
      "savePageAction expects a slug, title and bodyHtml, all strings, an " +
        "optional hatnote string, and optional categories as an array of " +
        "strings.",
    );
  }

  const result = await savePage({
    slug: edit.slug,
    title: edit.title,
    bodyHtml: edit.bodyHtml,
    hatnote: edit.hatnote,
    categories: edit.categories,
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

    /**
     * And every category listing (E11-T8, `YEO-78`) — the *pattern*, with the
     * `"page"` type Next requires for a path holding a dynamic segment, which
     * clears all of them at once.
     *
     * The pattern rather than the specific categories, because this action
     * cannot name them: a save can file an entry under a category *and* unfile
     * it from another, and only the removal makes the list it left stale. The
     * result carries no such list, and inventing one would mean returning the
     * before-and-after filing from `savePage` for the sole purpose of clearing
     * a client cache. There are a handful of categories in a family wiki and
     * these routes are all dynamic, so what this discards is a handful of RSC
     * payloads, once per save.
     */
    revalidatePath("/wiki/category/[slug]", "page");

    /**
     * And the index of every category, which a save can genuinely add a row
     * to: filing an entry under a name nothing used before *creates* the
     * category. The same argument as `/wiki` two blocks up — an author who
     * invents a category and then opens "All categories" would otherwise be
     * served the payload fetched before they invented it.
     */
    revalidatePath("/wiki/category");
  }

  return result;
}

/**
 * What the create form renders while it waits, and after a refusal.
 *
 * There is no success member: a successful creation ends in a `redirect`,
 * which throws, so the only state this action ever returns to the form is one
 * in which the author is still standing in front of it.
 *
 * ## Why a union since `YEO-122`
 *
 * It was `{ error: string | null }` until §4 of E1-T10 gave the form a second
 * thing to say — that a *retired* entry already holds this title's address,
 * and that restoring it is one link away. That is not a sentence: it is a
 * sentence plus an address to link to, and threading it through an `error`
 * string would mean either printing a bare URL into prose or teaching the form
 * to parse one back out of a message.
 *
 * A discriminated union rather than adding nullable members beside `error`, on
 * `lib/removal-state.ts`'s argument for exactly this shape: the states are
 * genuinely exclusive — the form is never showing a refusal and an offer at
 * once — and the nullable-members version would make `error !== null &&
 * retired !== null` representable, which is two states spelled four ways.
 *
 * It stays in this `"use server"` module because a type is erased at compile
 * time and exports nothing at runtime. A frozen *constant* for the idle state
 * could not live here, which is the whole reason `lib/removal-state.ts` is its
 * own file; `NewEntryForm` writes its initial value inline instead, as it
 * already did.
 */
export type NewEntryFormState =
  /** Nothing to say — the state the form is mounted in. */
  | { status: "idle" }
  /** A refusal the author can act on, as a sentence. */
  | { status: "refused"; error: string }
  /**
   * A retired entry already holds this title's address (§4 of E1-T10,
   * `YEO-122`).
   *
   * Carries the retired entry's own title and its address as separate fields,
   * so the form can render the second as a link rather than as text. The title
   * is the retired entry's rather than the one just typed, because those can
   * differ — an entry renamed after creation keeps its original address — and
   * which is true is the fact that decides whether the author wants it back.
   */
  | { status: "retired-entry"; slug: string; title: string };

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
    return { status: "refused", error: "Give the entry a title to start it." };
  }

  if (result.status === "retired-entry-exists") {
    /**
     * A retired entry already holds this title's address (§4 of E1-T10,
     * `YEO-122`), so the author is offered it back rather than handed a
     * near-twin at `rose-whitfield-2` that nothing would ever tell them about.
     *
     * A state rather than a redirect, and that is the decision worth stating.
     * Sending the author straight to the tombstone would answer "start an
     * entry called Rose Whitfield" by navigating them away from the form to a
     * page about somebody else's retirement, with the title they typed gone.
     * Returning a state leaves them where they are with the field still filled
     * — `NewEntryForm` uses `defaultValue`, so a refused submission does not
     * throw the text away — free to follow the link, change the title, or
     * think about it.
     *
     * The two fields travel separately rather than as one sentence so the form
     * can render the address as a real link. See `NewEntryFormState`.
     */
    return {
      status: "retired-entry",
      slug: result.slug,
      title: result.title,
    };
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

    case "retired":
      /**
       * The entry has been retired (E1-T10, `YEO-122`), so nothing was
       * written.
       *
       * Reachable by ordinary navigation rather than only by a direct POST,
       * which is why it earns a sentence of its own: the tombstone keeps the
       * history tab working on purpose, and every row of that history links to
       * a restore confirmation. A reader can therefore walk from a retired
       * entry to this form without doing anything unusual, and what they need
       * to be told is which of the two restores they are one step away from.
       *
       * That is the whole message. The two operations share a word and are not
       * the same act — one brings back an entry, the other brings back a
       * version of one — and performing the second without the first would be
       * writing content into a tombstone.
       */
      return {
        error:
          "This entry has been retired, so nothing was changed. Restore the entry itself first, then restore this version.",
      };

    case "restored":
      break;
  }

  /**
   * Everything this write moved, revalidated before the `redirect` below,
   * because `redirect` throws. Named routes rather than `"layout"`, matching
   * `savePageAction`: the layout form would additionally discard every other
   * entry's cached payload. The first five are bare paths, one route each; the
   * last is a *pattern*, for the reason its own note gives — this action
   * cannot name which category listings an entry appears on.
   *
   * Every one of them is a dynamic route that calls `requireSession()`, so
   * nothing server-side is stale — what is being cleared is the *client*
   * router cache, which otherwise serves the reader the payload it fetched on
   * the way in and shows them the restore they just performed as not having
   * happened.
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
   * And every category listing (E11-T8, `YEO-78`), for two reasons now. A
   * restore re-files the entry (`YEO-106`), so it can add the entry to a
   * listing and take it off another in one action; and it can change the
   * entry's *title*, and a category listing renders titles and sorts on them
   * (`listEntriesInCategory` orders by `compareEntriesByTitle`). Without this,
   * restoring a rename leaves the entry listed under its old name, in its old
   * position, on every category page it appears on.
   */
  /**
   * And the index of every category, which a restore can genuinely add a row
   * to (`YEO-106`): the filing it copies forward may name a heading that has
   * since been retired, and `setEntryCategories` re-creates it rather than
   * dropping it — see `lib/restore-revision.ts` for why that is the right
   * outcome. The same argument as `/wiki` above.
   */
  revalidatePath("/wiki/category");
  revalidatePath("/wiki/category/[slug]", "page");

  /**
   * To the entry, which is where "restore" actually finishes: the payoff is
   * seeing the paragraphs back. The slug is encoded rather than interpolated
   * raw, as `createPageAction` does, because a non-Latin title produces a
   * non-Latin slug and the `Location` header of the no-JavaScript response has
   * to be a valid URL.
   */
  redirect(`/wiki/${encodeURIComponent(slug)}`);
}

/**
 * What the delete-category confirmation renders while it waits, and after a
 * refusal.
 *
 * Shaped like `RestoreFormState` above, and for the same reason: a successful
 * deletion ends in a `redirect`, which throws, so the only state this action
 * ever returns is one in which the reader is still standing in front of the
 * confirmation.
 */
export type DeleteCategoryFormState = {
  /** A sentence to show the reader, or null when there is nothing to say. */
  error: string | null;
};

/**
 * Retire a category (E11-T8, `YEO-78`).
 *
 * ## What this deletes, and what it deliberately cannot
 *
 * The category row, and — by `on delete cascade` on
 * `page_categories.category_id` — the rows saying which entries were filed
 * under it. **No entry is reachable from either.** That is the ticket's last
 * acceptance criterion, and it is a property of the schema rather than of the
 * code below: there is no foreign key running from `pages` to `categories`, so
 * there is no statement this action could write that would take an entry with
 * it. See `db/schema.ts` and `lib/categories.ts`.
 *
 * The confirmation in front of this says how many entries will lose a line
 * from their footer bar, because that is the only consequence, and a reader
 * who can see it is a reader who does not have to guess.
 *
 * ## Why the category is named rather than identified
 *
 * The form posts the slug, which is the address the reader is standing on and
 * is entitled to name, rather than the primary key. `getCategoryBySlug` does
 * read the id — the listing route needs it to ask what is filed here — but
 * nothing hands it onward: the route passes `category.slug` to
 * `CategoryRemoval` and stops, and the type every *rendering* path uses
 * (`NamedCategory`, in `lib/category-name.ts`) has no `id` field to pass. So
 * the id stays on the server, which is the "send a reference plus the user's
 * change" shape the Next.js server-actions guide asks for.
 *
 * Shaped for `useActionState`, so it takes the previous state and the form's
 * own `FormData`, which also means the confirmation works as a plain form POST
 * before any JavaScript has loaded.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields — `slug`, and nothing else
 * @returns a state to render, or never, when the redirect fires
 */
export async function deleteCategoryAction(
  _previous: DeleteCategoryFormState,
  form: FormData,
): Promise<DeleteCategoryFormState> {
  await requireSession();

  // A hidden field on a form the browser posts; `File` and null are what a
  // direct POST can send instead, and neither is a reference to anything.
  const slug = form.get("slug");
  if (typeof slug !== "string") {
    throw new TypeError("deleteCategoryAction expects a slug field, as text.");
  }

  const deleted = await deleteCategory(slug);

  if (!deleted) {
    /**
     * Not an error the reader caused. The likeliest cause by far is a second
     * tab, or a back button onto a confirmation for a category somebody has
     * already retired — so it is said as a fact about the world rather than as
     * a failure, and the reader is left where they can navigate away.
     */
    return {
      error:
        "That category no longer exists. It may have been deleted in another tab.",
    };
  }

  /**
   * Everything this write moved, revalidated before the `redirect` below,
   * because `redirect` throws.
   *
   * The entry pattern with the `"page"` type, rather than the entries by name:
   * every entry that was filed here has lost a line from its footer bar, and
   * this action deliberately did not read which ones (the cascade did the
   * detaching, in the database, without returning a list). A family wiki's
   * entries are a few hundred dynamic routes, so what this discards is the
   * client router cache — nothing server-side was stale, since every one of
   * them calls `requireSession()`.
   */
  revalidatePath("/wiki/[slug]", "page");
  revalidatePath(`/wiki/category/${slug}`);
  // And the index of every category, which has just lost a row — the page the
  // redirect below sends the reader to.
  revalidatePath("/wiki/category");
  /**
   * And every editor, which is the one route here where a stale payload is
   * more than cosmetic.
   *
   * `app/wiki/[slug]/edit/page.tsx` renders `listCategories()` into the
   * picker's suggestions and `readEntryCategories()` into its chips. An editor
   * opened before this retirement still holds both, so saving from it sends
   * the retired name back through `setEntryCategories` — which finds no row,
   * creates one, and quietly resurrects the category somebody just retired.
   * Every other stale route here shows an old answer; this one writes one.
   *
   * The pattern rather than the entries by name, matching the line above: the
   * cascade did the detaching in the database and returned no list of which
   * entries it touched.
   */
  revalidatePath("/wiki/[slug]/edit", "page");

  /**
   * To the list of categories, which is where "the category is gone" is
   * actually legible: the reader arrived from a category page and the payoff
   * is seeing the heading absent from the set. The address they were standing
   * on no longer answers, so sending them back to it would be a 404 as the
   * reward for a successful action, and `/wiki` — the *entry* index — would
   * answer a question they were not asking.
   */
  redirect("/wiki/category");
}

/**
 * What the retire confirmation renders while it waits, and after a refusal.
 *
 * Shaped like `RestoreFormState` and `DeleteCategoryFormState` above, and for
 * the same reason: a successful retirement ends in a `redirect`, which throws,
 * so the only state this action ever returns is one in which the reader is
 * still standing in front of the confirmation.
 */
export type RetireEntryFormState = {
  /** A sentence to show the reader, or null when there is nothing to say. */
  error: string | null;
};

/**
 * Retire an entry (E1-T10, `YEO-122`).
 *
 * ## What this writes, and what it deliberately cannot
 *
 * Two columns on one row. **No revision is deleted, no image is dereferenced,
 * and `individuals.page_id` is not touched** — those are the ticket's
 * acceptance criteria and every one of them is a property of the write rather
 * than of care taken here: `lib/retire-page.ts` issues a single `UPDATE`
 * against `pages`, and nothing else in the schema hangs off `deleted_at`. See
 * that module for why it does not append a revision and does not move
 * `updated_at`.
 *
 * The confirmation in front of this names the entries whose links turn red,
 * the versions that are kept and the photographs that stay in storage, and
 * every one of those numbers comes from `previewRetirement` — the same
 * function `retirePage` runs again inside the writing transaction, so the
 * screen and the write cannot come to different conclusions.
 *
 * ## Why the entry is named rather than identified
 *
 * The form posts the slug, which is the address the reader is standing on and
 * is entitled to name, rather than the primary key — the "send a reference
 * plus the user's change" shape the Next.js server-actions guide asks for, and
 * the same choice `deleteCategoryAction` makes. Every signed-in member may
 * retire every entry, because `ALLOWED_EMAILS` is the entire membership model
 * and there is no per-entry ownership to check against (`lib/session.ts`).
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields — `slug`, and nothing else
 * @returns a state to render, or never, when the redirect fires
 */
export async function retireEntryAction(
  _previous: RetireEntryFormState,
  form: FormData,
): Promise<RetireEntryFormState> {
  const session = await requireSession();

  // As in every action above: `requireSession` has already thrown if there is
  // no email, but its return type is next-auth's `Session`, whose `user.email`
  // is optional, and the compiler cannot see that narrowing across the call.
  const retiredBy = session.user?.email;
  if (!retiredBy) throw new UnauthorizedError();

  // A hidden field on a form the browser posts; `File` and null are what a
  // direct POST can send instead, and neither is a reference to anything.
  const slug = form.get("slug");
  if (typeof slug !== "string") {
    throw new TypeError("retireEntryAction expects a slug field, as text.");
  }

  const result = await retirePage({ slug, retiredBy });

  switch (result.status) {
    case "not-found":
      /**
       * No row at this address at all — a confirmation left open while the
       * slug was changed by hand, or a direct POST. Said as a fact about the
       * world rather than as a failure, matching `deleteCategoryAction`.
       */
      return {
        error: "There is no entry at that address, so nothing was retired.",
      };

    case "already-retired":
      /**
       * A second tab, a double-press, or a back button onto a confirmation
       * for an entry somebody has already retired. Not a failure — the entry
       * is in the state the reader asked for — so the redirect below is
       * skipped only because there is a sentence worth reading first, and the
       * tombstone they would be sent to is one link away.
       */
      return {
        error: "That entry has already been retired.",
      };

    case "retired":
      break;
  }

  /**
   * Everything this write moved, revalidated before the `redirect` below,
   * because `redirect` throws. This is a longer list than any other action in
   * this file, and that is the honest measure of what retiring an entry does:
   * it leaves six surfaces at once.
   *
   * Every one of these routes is dynamic and calls `requireSession()`, so
   * nothing server-side is stale — what is being cleared is the *client*
   * router cache, which would otherwise show the reader the entry they just
   * retired still sitting in the index they navigate to next.
   */
  revalidatePath(`/wiki/${slug}`);
  // The entry's own route, which now renders a tombstone rather than an
  // article — and the history views around it, whose chrome names the entry.
  revalidatePath(`/wiki/${slug}/history`);
  // The index (E1-T9), which has lost a row.
  revalidatePath("/wiki");
  // The front page, which renders the recently-changed feed (E8-T4) this entry
  // has just dropped out of.
  revalidatePath("/");
  /**
   * And every *other* entry (`/wiki/[slug]` as a pattern, with the `"page"`
   * type Next requires for a path holding a dynamic segment). This is the one
   * line here that is more than housekeeping: every link to the retired entry
   * has just turned red, and those links are in other entries' bodies and
   * hatnotes. The confirmation named which ones, and this action could
   * therefore clear them by name — but the preview is computed inside the
   * transaction and the pattern costs the same client-cache discard for a
   * family wiki's few hundred dynamic routes, so the simpler line is the one
   * that cannot fall out of step with the preview.
   */
  revalidatePath("/wiki/[slug]", "page");
  /**
   * And every category listing, which this entry has just come off. The
   * pattern rather than the listings by name, matching `savePageAction`: the
   * filing rows are untouched by a retirement, so nothing was deleted from
   * which to derive a list, and the entry's categories are on the preview
   * rather than on this action's arguments.
   */
  revalidatePath("/wiki/category/[slug]", "page");
  /**
   * And the tree, whose panels link to entries: `listEntryLinks` no longer
   * offers this one, and a person linked to it now shows a red link where a
   * blue one was. `/tree` is a single route, so it is named rather than
   * patterned.
   */
  revalidatePath("/tree");

  /**
   * To the tombstone, which is where "the entry is retired" is actually
   * legible: it names who retired it and when, keeps the history tab working,
   * and carries the Restore button. That is deliberately *not* `/wiki` — the
   * index would answer a question the reader was not asking and would show
   * them nothing at all about the thing they just did, which for a reversible
   * operation is exactly the wrong reward.
   *
   * The slug is encoded rather than interpolated raw, as every redirect in
   * this file is: a non-Latin title produces a non-Latin slug
   * (`lib/entry-slug.ts`) and the `Location` header of the no-JavaScript
   * response has to be a valid URL.
   */
  redirect(`/wiki/${encodeURIComponent(slug)}`);
}

/**
 * What the tombstone's Restore control renders while it waits, and after a
 * refusal. Shaped like `RetireEntryFormState` above, and for the same reason.
 */
export type RestoreEntryFormState = {
  /** A sentence to show the reader, or null when there is nothing to say. */
  error: string | null;
};

/**
 * Put a retired entry back (E1-T10, `YEO-122`).
 *
 * ## Why there is no confirmation in front of this one
 *
 * Because it is the *undo*, and asking somebody to confirm an undo is asking
 * them to confirm a decision they have already made twice. Every confirmation
 * in this repository guards an operation whose consequences are hard to see or
 * hard to reverse; this one has neither property. It puts an entry back at the
 * address it never left, with the history it never lost, and if it was pressed
 * by mistake the entry can be retired again through the confirmation that is
 * still there.
 *
 * That asymmetry is the point of the whole feature: retiring is the deliberate
 * act and restoring is the cheap one. A wiki where both cost the same is one
 * where nobody retires anything.
 *
 * @param _previous the last state; unused, since each submission stands alone
 * @param form the submitted fields — `slug`, and nothing else
 * @returns a state to render, or never, when the redirect fires
 */
export async function restoreEntryAction(
  _previous: RestoreEntryFormState,
  form: FormData,
): Promise<RestoreEntryFormState> {
  await requireSession();

  const slug = form.get("slug");
  if (typeof slug !== "string") {
    throw new TypeError("restoreEntryAction expects a slug field, as text.");
  }

  const result = await restorePage(slug);

  switch (result.status) {
    case "not-found":
      return {
        error: "There is no entry at that address, so nothing was restored.",
      };

    case "not-retired":
      /**
       * Two tabs, or a double-press. Not a failure — the entry is live, which
       * is what the reader asked for — and the page they are looking at is
       * about to be re-rendered as the article by the revalidation the
       * redirect below carries.
       */
      return { error: "That entry is not retired." };

    case "restored":
      break;
  }

  /**
   * The same six surfaces `retireEntryAction` clears, for the mirror of each
   * reason: the entry is back in the index, back in the feed, back on its
   * category listings, and every link that had turned red is blue again. The
   * symmetry is deliberate — a restore that revalidated less than the
   * retirement would leave somebody looking at a cached page where the entry
   * is still gone, which is the one thing that would make this feature feel
   * unreliable.
   */
  revalidatePath(`/wiki/${slug}`);
  revalidatePath(`/wiki/${slug}/history`);
  revalidatePath("/wiki");
  revalidatePath("/");
  revalidatePath("/wiki/[slug]", "page");
  revalidatePath("/wiki/category/[slug]", "page");
  revalidatePath("/tree");

  /**
   * To the entry, at its original address — which is where "it is back" is
   * legible, and which is the acceptance criterion stated as a redirect: the
   * slug the reader was standing on is the slug they end up on, because the
   * tombstone never gave it up.
   */
  redirect(`/wiki/${encodeURIComponent(result.slug)}`);
}
