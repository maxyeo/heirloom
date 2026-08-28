import { and, eq, inArray, notInArray } from "drizzle-orm";

import { db, schema } from "@/db";
import {
  compareCategoriesByName,
  compareCategoriesBySlug,
  type NamedCategory,
  normaliseEntryCategories,
} from "@/lib/category-name";
import { LIVE_PAGES } from "@/lib/live-pages";
import { compareEntriesByTitle, type TitledEntry } from "@/lib/page-index";
import type { Transaction } from "@/lib/save-page";

/**
 * The reads and the one write behind categories (E11-T8, `YEO-78`).
 *
 * Everything that is a decision about *language* — what a name normalises to,
 * which of two names is the same category, what "alphabetical" means — lives
 * in `lib/category-name.ts`, which imports no database and is therefore
 * covered by `npm test`. What is left here is the part that is a property of
 * Postgres: the unique index deciding who creates a category, the join-row
 * diff, and the cascade that makes deleting a category a detachment. Those are
 * asserted in `lib/categories.db.test.ts` against a real database, because a
 * test that mocked Drizzle would only prove the mock returns what it was told
 * to (docs/testing.md).
 *
 * `import type { Transaction }` rather than a plain import: `lib/save-page.ts`
 * calls {@link setEntryCategories}, so a value import in this direction would
 * close a runtime cycle between the two modules. A type-only import erases
 * entirely, which is the same trick docs/testing.md prescribes for
 * `FamilyGraph`.
 */

/**
 * What an entry is filed under, alphabetically (E11-T8).
 *
 * One query with a join rather than a lookup per category: the article page
 * renders this bar on every read, and a version of this that fetched the join
 * rows and then the names would cost a round trip per category on a page that
 * already has its answer in one.
 *
 * Ordered in TypeScript rather than by `ORDER BY name`, which is the exception
 * `lib/pages.ts` makes for `listPages` and makes here for the same reason:
 * alphabetical is a question about language, and answering it in SQL answers
 * it out of the database's collation — which differs between a local
 * `createdb` and Supabase, so the fault would be invisible in production and
 * permanent on the machine the entries are written on. See
 * `compareCategoriesByName`.
 *
 * @param pageId the entry
 * @returns its categories, alphabetically; empty when it has none
 */
export async function readEntryCategories(
  pageId: string,
): Promise<NamedCategory[]> {
  const rows = await db
    .select({
      slug: schema.categories.slug,
      name: schema.categories.name,
    })
    .from(schema.pageCategories)
    .innerJoin(
      schema.categories,
      eq(schema.categories.id, schema.pageCategories.categoryId),
    )
    .where(eq(schema.pageCategories.pageId, pageId));

  // Sorting in place is safe: `rows` is an array Drizzle built for this call,
  // and nothing else holds a reference to it.
  return rows.sort(compareCategoriesByName);
}

/**
 * Every category that exists, for the editor's picker.
 *
 * ## Why the whole table
 *
 * The same judgement `listPages` and `getFamilyGraph` make about theirs: this
 * is a family's categories, and there are fewer of them than there are
 * entries. The picker filters the list in the browser as the author types,
 * which is what makes choosing an existing category cost no request at all —
 * the same shape `PartnerPicker` uses over the tree it already holds, and for
 * the same reason (there is nothing to debounce against when the answer is
 * already in memory).
 *
 * @returns every category, alphabetically
 */
export async function listCategories(): Promise<NamedCategory[]> {
  const rows = await db
    .select({
      slug: schema.categories.slug,
      name: schema.categories.name,
    })
    .from(schema.categories);

  return rows.sort(compareCategoriesByName);
}

/**
 * One category by its address.
 *
 * Carries the `id` that {@link NamedCategory} deliberately omits, because its
 * caller — the listing route — immediately asks {@link listEntriesInCategory} a
 * question keyed by it, and that id never crosses to the browser. Returning `undefined` rather than throwing for the same reason
 * `getPageBySlug` does: a link that has outrun its category is an ordinary
 * outcome, and turning it into a 404 is the route's job.
 *
 * The slug arrives from the URL, so it is untrusted input. `eq` parameterises
 * it — the value never reaches Postgres as SQL text — which matters more here
 * than it usually would, since there is no RLS under this database and the app
 * connects as one role for everybody (docs/architecture.md).
 *
 * @param slug the category's address
 * @returns the category, or `undefined` when nothing is filed at that address
 */
export async function getCategoryBySlug(
  slug: string,
): Promise<{ id: string; slug: string; name: string } | undefined> {
  // `slug` is unique in the schema, so `limit(1)` describes the table rather
  // than truncating a result: it lets Postgres stop at the index hit.
  const [category] = await db
    .select({
      id: schema.categories.id,
      slug: schema.categories.slug,
      name: schema.categories.name,
    })
    .from(schema.categories)
    .where(eq(schema.categories.slug, slug))
    .limit(1);

  return category;
}

/**
 * The entries filed under one category, alphabetically.
 *
 * This is the read `page_categories_category_id_idx` exists for. The join
 * table's primary key is `(page_id, category_id)`, which serves "what is this
 * entry filed under" and cannot serve this question at all — see
 * `db/schema.ts`.
 *
 * Ordered by the same comparator `listPages` uses, so an entry sits in the
 * same place in a category's list as it does in the index. `bodyHtml` and
 * `updatedAt` are the deliberate omissions: this list links and nothing more.
 *
 * ## Retired entries, and why the filing row is left alone (`YEO-122`)
 *
 * `LIVE_PAGES` rides on the `innerJoin` rather than on the `where`, which for
 * an inner join is the same set of rows and a different sentence: the join is
 * "the live entry this filing points at", so a filing whose entry has been
 * retired matches nothing and the row simply is not here. Written into the
 * `where` it would read as a second thing being asked about the category,
 * which it is not.
 *
 * What is deliberately *not* done is deleting the `page_categories` row when
 * an entry is retired. Retirement is reversible by design — the whole of
 * E1-T10 — and unfiling an entry on the way out would mean restoring it puts
 * back an entry filed under nothing, with no record anywhere of what it used
 * to be filed under. The filing survives the retirement and comes back with
 * it, exactly as `individuals.page_id` does.
 *
 * The count in the tagline above a category's listing is derived from this
 * list, so it agrees with it without being told to.
 *
 * @param categoryId the category
 * @returns its live entries, alphabetically by title; empty when it has none
 */
export async function listEntriesInCategory(
  categoryId: string,
): Promise<TitledEntry[]> {
  const rows = await db
    .select({
      slug: schema.pages.slug,
      title: schema.pages.title,
    })
    .from(schema.pageCategories)
    .innerJoin(
      schema.pages,
      and(eq(schema.pages.id, schema.pageCategories.pageId), LIVE_PAGES),
    )
    .where(eq(schema.pageCategories.categoryId, categoryId));

  return rows.sort(compareEntriesByTitle);
}

/**
 * Find or create the rows for a list of category names, inside the caller's
 * transaction.
 *
 * ## Why insert-then-select rather than select-then-insert
 *
 * A `select` for the existing slugs followed by an `insert` of the rest has a
 * race in the middle, and two authors filing two different entries under a
 * brand-new category name at the same moment is exactly the caller that finds
 * it: both see nothing, both insert, and one gets a unique-violation that
 * rolls back a save which had nothing wrong with it. The same argument
 * `db/schema.ts` makes at length for `gedcom_imports.digest`.
 *
 * `on conflict do nothing` has no such gap. Postgres *waits* on a conflicting
 * insert that has not committed yet, then does nothing once it has — so the
 * `select` below, which takes a fresh snapshot as its own statement under READ
 * COMMITTED, sees the winner's row and this transaction files under it. The
 * loser of the race does not fail; it joins.
 *
 * ## Why the values are sorted
 *
 * Two concurrent saves inserting the same two new categories in opposite
 * orders can deadlock on the unique index — each holding the speculative lock
 * the other is waiting for. Inserting in a deterministic order (by slug) means
 * every writer takes those locks in the same sequence, which is the standard
 * way to make that deadlock unreachable rather than merely rare.
 *
 * ## Why it hands back the stored name and not only the id
 *
 * Because the stored name is the one the entry is actually filed under, and
 * `YEO-106` put that name in `revisions.categories`. They differ whenever the
 * category already exists under a different spelling: "Whitfield Family" typed
 * into the picker resolves to the "Whitfield family" row and deliberately does
 * not rename it (see {@link setEntryCategories}), so a revision that recorded
 * the typed spelling would record a filing the entry has never had — and the
 * next save, comparing against the real one, would look like a change.
 *
 * @param tx the transaction the caller's other writes are in
 * @param wanted the categories to resolve, already normalised and de-duplicated
 * @returns the id and stored name of each, keyed by slug
 */
async function resolveCategories(
  tx: Transaction,
  wanted: readonly { name: string; slug: string }[],
): Promise<Map<string, { id: string; name: string }>> {
  if (wanted.length === 0) return new Map();

  // `compareCategoriesBySlug` rather than a comparator written here: it is
  // already the order `revisions.categories` is stored in (`YEO-106`), and it
  // is *consistent* — 0 for equal slugs rather than 1 —which an inconsistent
  // comparator would not be, and which is a poor foundation for a line whose
  // entire job is a deterministic lock order.
  const ordered = [...wanted].sort(compareCategoriesBySlug);

  await tx
    .insert(schema.categories)
    .values(ordered.map(({ name, slug }) => ({ name, slug })))
    .onConflictDoNothing({ target: schema.categories.slug });

  const rows = await tx
    .select({
      id: schema.categories.id,
      slug: schema.categories.slug,
      name: schema.categories.name,
    })
    .from(schema.categories)
    .where(
      inArray(
        schema.categories.slug,
        ordered.map(({ slug }) => slug),
      ),
    );

  return new Map(rows.map((row) => [row.slug, { id: row.id, name: row.name }]));
}

/**
 * An entry's filing after a write, and whether that write moved anything.
 *
 * Two facts rather than one because `lib/save-page.ts` needs both and can
 * compute neither: `changed` decides whether the save is a no-op, and `names`
 * is what goes into `revisions.categories` (`YEO-106`). Reading the filing
 * back with a second query to learn the second fact would be a second query
 * inside the save transaction for something {@link setEntryCategories} had in
 * hand and threw away.
 */
export type EntryFiling = {
  /**
   * The category names the entry is now filed under, in slug order — the
   * canonical form `revisions.categories` stores. See
   * `compareCategoriesBySlug` for why the order is not the display order.
   */
  names: string[];
  /** Whether any `page_categories` row was added or removed. */
  changed: boolean;
};

/**
 * What an entry is filed under, inside a transaction the caller already has,
 * as the canonical snapshot a revision records (`YEO-106`).
 *
 * Not {@link readEntryCategories} above, and the differences are all the
 * reasons this exists. That one runs on the pool, returns `NamedCategory` for
 * a bar the reader looks at, and sorts by name. This one runs on the caller's
 * transaction — so it sees the filing that transaction has just written and
 * not the one committed before it — returns bare names, and sorts by slug.
 *
 * It has exactly one caller and one reason to be called: a save whose
 * `categories` field is `undefined`, meaning the caller has no opinion about
 * the filing. The entry's filing does not move, but the revision still has to
 * record it, because a revision is the entry's whole state and a snapshot
 * missing the filing would make the next restore quietly un-file the entry.
 *
 * @param tx the transaction the caller's other reads and writes are in
 * @param pageId the entry
 * @returns its category names in slug order; empty when it has none
 */
export async function readEntryFiling(
  tx: Transaction,
  pageId: string,
): Promise<string[]> {
  const rows = await tx
    .select({
      slug: schema.categories.slug,
      name: schema.categories.name,
    })
    .from(schema.pageCategories)
    .innerJoin(
      schema.categories,
      eq(schema.categories.id, schema.pageCategories.categoryId),
    )
    .where(eq(schema.pageCategories.pageId, pageId));

  return rows.sort(compareCategoriesBySlug).map(({ name }) => name);
}

/**
 * File an entry under exactly these categories, and under no others.
 *
 * Takes a transaction rather than opening one, which is the point:
 * `lib/save-page.ts` calls this beside its `revisions` insert and its `pages`
 * update, and a helper that opened its own would let an entry's text and its
 * filing land separately — a crash between them leaving the bar at the foot of
 * the article describing a version of it that was never saved.
 *
 * ## Why it returns the filing and not just a boolean
 *
 * The boolean came first, and `savePage`'s no-op rule is still what needs it.
 * An author who opens the editor and presses Save without touching anything
 * must write nothing at all — not even an `updated_at` bump, or the entry
 * climbs the recently-changed feed for an edit nobody made (E8-T4). The
 * categories are part of "anything", and only this function is in a position
 * to know: it is the code that reads what is already there.
 *
 * `YEO-106` added the other half. A revision now records the filing alongside
 * the title, the body and the hatnote, so the save that writes it needs the
 * names the entry ended up filed under — which is again something only this
 * function holds, and holds already. See {@link EntryFiling}.
 *
 * The comparison is against the rows that would actually be written, after
 * normalisation — so re-saving `"Whitfield  family"` as `"Whitfield family"`
 * is correctly *no* change, exactly as re-saving unchanged HTML is.
 *
 * ## What a rename is, and is not
 *
 * Retyping a category's name with different capitalisation does not rename the
 * category: the slug is unchanged, so this resolves to the same row and leaves
 * `categories.name` as whoever created it typed it. That is deliberate — a
 * rename is a decision about every entry filed under a heading, and letting it
 * happen as a side effect of one author's spelling in one editor would make it
 * a change nobody could see coming. There is no rename in this ticket; when
 * there is one it should be its own action, on its own surface.
 *
 * It is also why {@link EntryFiling}'s `names` are the *stored* names rather
 * than the submitted ones: the entry is filed under the row, so the row's name
 * is what a revision has to record.
 *
 * @param tx the transaction the caller's other writes are in
 * @param pageId the entry being filed
 * @param names the category names as submitted, in the author's order
 * @returns the resulting filing, and whether a row moved
 */
export async function setEntryCategories(
  tx: Transaction,
  pageId: string,
  names: readonly string[],
): Promise<EntryFiling> {
  const wanted = normaliseEntryCategories(names);
  const rows = await resolveCategories(tx, wanted);

  /**
   * Every slug resolved above has a row, so a missing entry would mean the
   * `insert` and the `select` disagreed — which cannot happen inside one
   * transaction, but is worth failing loudly on rather than filing the entry
   * under a silently shorter list. Not a `!`: this is a real check.
   *
   * Sorted by slug on the way out, which serves two purposes at once. It is
   * the canonical order `revisions.categories` is stored in, and — because the
   * `insert` below walks this same list — it is also a deterministic lock
   * order, the property `resolveCategories` sorts its own values to get. The
   * author's order is not lost by it: `normaliseEntryCategories` has already
   * used that order to decide whose spelling of a duplicate survives, which is
   * the only thing it decides.
   */
  const filing = wanted
    .map(({ slug }) => {
      const row = rows.get(slug);
      if (row === undefined) {
        throw new Error(`Category "${slug}" was neither found nor created.`);
      }
      // The resolved row's name rather than the submitted one — the entry is
      // filed under that row, so that row's spelling is the filing, whatever
      // the author typed. See `resolveCategories`.
      return { id: row.id, name: row.name, slug };
    })
    .sort(compareCategoriesBySlug);

  const wantedIds = filing.map(({ id }) => id);
  const wantedNames = filing.map(({ name }) => name);

  const current = await tx
    .select({ categoryId: schema.pageCategories.categoryId })
    .from(schema.pageCategories)
    .where(eq(schema.pageCategories.pageId, pageId));

  const currentIds = new Set(current.map((row) => row.categoryId));
  const wantedSet = new Set(wantedIds);
  const added = wantedIds.filter((id) => !currentIds.has(id));
  const removed = current.filter((row) => !wantedSet.has(row.categoryId));

  if (wantedIds.length === 0) {
    // `notInArray` with an empty list is SQL Drizzle has to special-case, and
    // "file this entry under nothing" is the ordinary shape of un-filing the
    // last category rather than a corner of it.
    if (current.length > 0) {
      await tx
        .delete(schema.pageCategories)
        .where(eq(schema.pageCategories.pageId, pageId));
    }
    return { names: [], changed: current.length > 0 };
  }

  if (removed.length > 0) {
    await tx
      .delete(schema.pageCategories)
      .where(
        and(
          eq(schema.pageCategories.pageId, pageId),
          notInArray(schema.pageCategories.categoryId, wantedIds),
        ),
      );
  }

  if (added.length > 0) {
    await tx
      .insert(schema.pageCategories)
      .values(added.map((categoryId) => ({ pageId, categoryId })))
      /**
       * Belt and braces against one shape of concurrency: two saves of the
       * *same* entry can both decide to add the same category. The `pages` row
       * is held `FOR UPDATE` by `savePage`, so in practice the second waits
       * and re-reads — but this insert is reachable from any future caller
       * that does not hold that lock, and a primary-key violation on a link
       * that already says what we wanted it to say is not an error worth
       * raising.
       */
      .onConflictDoNothing();
  }

  return {
    names: wantedNames,
    changed: added.length > 0 || removed.length > 0,
  };
}

/**
 * Delete a category, detaching it from every entry filed under it.
 *
 * The whole of "detaching" is the `on delete cascade` on
 * `page_categories.category_id`: this statement removes the category row, and
 * Postgres removes the rows that said which entries were filed under it. No
 * `pages` row is reachable from either, so no entry can be taken with it — see
 * `db/schema.ts` for why the foreign keys run in this direction and only this
 * one, and `lib/categories.db.test.ts` for the assertion rather than the
 * claim.
 *
 * ## Why there is a delete at all
 *
 * Because the picker creates categories inline, and a surface that can only
 * create is a surface whose mistakes are permanent. A typo filed under one
 * entry, then unfiled, leaves a category nobody can reach and everybody is
 * offered every time they type the first letter of the real one.
 *
 * ## Why it does not ask whether the category is in use
 *
 * Deleting a category that three entries are filed under is the *interesting*
 * case, not the forbidden one: it is how a heading that turned out to be a bad
 * idea is retired. The entries survive with one fewer line in their footer bar
 * — which is what "detaches it from entries rather than deleting them" means —
 * and the confirmation in front of this says how many entries that will be.
 *
 * @param slug the category to remove
 * @returns whether a category was there to remove
 */
export async function deleteCategory(slug: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.categories)
    .where(eq(schema.categories.slug, slug))
    .returning({ id: schema.categories.id });

  return deleted.length > 0;
}
