import {
  type NamedCategory,
  normaliseEntryCategories,
} from "@/lib/category-name";

/**
 * The question the restore confirmation asks before it offers the button
 * (E1-T7, `YEO-21`): would restoring this revision change anything at all?
 *
 * ## Why it is here and not in `lib/restore-revision.ts`
 *
 * That module imports `@/db`, and docs/testing.md's rule is that `npm test` —
 * the suite gating the `check` job — runs with no `DATABASE_URL`. The route
 * that needs this answer is an `async` Server Component and is not unit
 * testable at all, so a predicate defined in either place would be a decision
 * no test in CI could reach. Over plain values it is checked on every push.
 * The pairing is `lib/removal-preview.ts`'s, for the same reason: what a
 * destructive-looking action *would* do is a decision, and decisions live
 * where they can be asserted.
 *
 * ## This is a courtesy, not the boundary
 *
 * `restoreRevision` asks the same question authoritatively — inside the
 * transaction, under the `pages` row lock, against the values it is actually
 * about to write — and refuses with `unchanged`. This is the cheap version,
 * and its only job is to keep a reader from pressing a button that was always
 * going to decline.
 *
 * The two can therefore disagree, and the direction matters. This compares the
 * stored values rather than the ones a restore would write: no `trim`, no
 * `sanitizeHtml` pass, no `normaliseHatnote`. So for a row that predates the
 * sanitiser this can report "something would change" when the write turns out
 * to rewrite only the stored markup — which is a real change, and does get
 * recorded. It errs towards offering a restore that turns out to be small,
 * never towards hiding one that would have worked.
 *
 * The filing is the one field where that gap is closed rather than tolerated,
 * and not because closing it is cheap — `sanitizeHtml` is a pure function too,
 * and could be applied here just as easily. It is that the canonicalisation
 * hides nothing. Sanitising here would suppress a difference the write goes on
 * to *record*, because rewritten markup is a real change; whereas
 * `setEntryCategories` resolves recorded names to `categories` rows before it
 * compares anything, so a difference that same resolution erases is a
 * difference no restore could ever record. See {@link recordedFilingOf}.
 *
 * **That direction is the whole reason this function exists as a shared
 * definition.** `YEO-106` made a filing-only difference something a restore
 * acts on, and the confirmation page's old inline check — title and body only
 * — silently answered "nothing to restore" for exactly that case, hiding the
 * form for the operation the ticket is about. A second, narrower copy of a
 * predicate is how that happens; there is now one, and adding a column to
 * {@link RestorableContent} is a type error at both ends.
 */

/**
 * Everything about an entry that a restore puts back.
 *
 * The four things `writeRevision` records, which is not a coincidence: a
 * revision is the entry's whole state (`lib/save-page.ts`), so "would a
 * restore change anything" is exactly "do these four fields differ". A fifth
 * revisioned column added later has to be added here too, and the compiler
 * says so at both call sites.
 */
export type RestorableContent = {
  title: string;
  bodyHtml: string;
  hatnote: string;
  /**
   * What the entry is filed under (`YEO-106`), as category **slugs**
   * (`YEO-117`).
   *
   * Slugs rather than the names `revisions.categories` stores, because the
   * slug is a category's identity — `lib/category-name.ts` states that as its
   * single underlying rule, and `db/schema.ts` enforces it by putting
   * `.unique()` on `slug` and deliberately not on `name`. Identity is what a
   * restore moves rows by, so identity is what this has to compare.
   *
   * Neither side arrives in this form: the live filing is adapted by
   * {@link filingOf} and the recorded one by {@link recordedFilingOf}, so the
   * one place that knows how each becomes a set of slugs is this file rather
   * than a route.
   *
   * Order is not significant; see {@link restoreWouldChangeNothing}.
   */
  categories: readonly string[];
};

/**
 * An entry's live filing as this module compares it, from the rows
 * `readEntryCategories` hands back.
 *
 * The row's stored `slug`, not a slug re-derived from its `name`. The entry is
 * filed under the *row*, so the row's own address is what identifies it here —
 * and that is the only reading under which this module agrees with
 * `setEntryCategories` for a `categories` row whose `slug` is not
 * `categorySlug(name)`.
 *
 * A named adapter rather than a `.map` at the call site, so the one place that
 * knows a live filing is `NamedCategory[]` is this file rather than a route.
 *
 * @param categories the entry's live filing, as `readEntryCategories` returns
 * @returns the slug of each, in the order given
 */
export function filingOf(categories: readonly NamedCategory[]): string[] {
  return categories.map((category) => category.slug);
}

/**
 * A revision's recorded filing as this module compares it, from the names
 * `revisions.categories` stores.
 *
 * `normaliseEntryCategories` rather than a `.map` of `categorySlug`, and that
 * is the whole of why this function exists: it is *the* transformation
 * `setEntryCategories` applies to exactly these names when a restore runs, so
 * what comes out is the set of slugs that restore would resolve rows for —
 * whitespace collapsed, unsluggable names dropped, duplicates collapsed by
 * slug, cap applied. Re-deriving any of that here would be a second opinion
 * about what a recorded name means, which is the class of drift this module
 * was extracted to prevent.
 *
 * The names themselves stay stored as names, which was a deliberate `YEO-106`
 * decision (`docs/architecture.md`): `page_categories`' foreign keys cascade
 * on delete, so pointing that cascade at a revision would let retiring a
 * category rewrite history, and a name is the only part of a category that
 * outlives its row. This canonicalises for a comparison and stores nothing.
 *
 * @param names the filing as `revisions.categories` records it
 * @returns the slugs a restore of that revision would file the entry under
 */
export function recordedFilingOf(names: readonly string[]): string[] {
  return normaliseEntryCategories(names).map((category) => category.slug);
}

/**
 * Whether the entry already says exactly what this revision says.
 *
 * ## Why the filing is compared as a set
 *
 * Because a filing *is* a set — an entry is either in a category or it is not,
 * and `db/schema.ts` says as much about `page_categories` holding no ordering
 * column. The two sides also arrive ordered differently by construction: a
 * revision holds them in canonical slug order, while `readEntryCategories`
 * sorts for a reader, by name. Comparing as arrays would report a difference
 * for "Ada" and "émile" filed in either order and offer a restore that changes
 * nothing.
 *
 * ## Why it is a set of *slugs*
 *
 * Because that is what `restoreRevision` compares, and "is" is meant exactly.
 * `setEntryCategories` resolves the recorded names to `categories` rows and
 * reports `changed` from the row ids it added and removed. `categories.slug`
 * is unique, so a slug names a row as precisely as its id does; and both sides
 * here go through the same resolution the write uses — the live filing keeps
 * the slug of the row it is filed under, the recorded filing is put through
 * `normaliseEntryCategories` (see {@link filingOf} and
 * {@link recordedFilingOf}). Set equality over slugs is therefore the same
 * predicate as set difference over ids, not an approximation of it.
 *
 * Comparing the *names* would only be that predicate while every name belongs
 * to one row, and `categories.name` is deliberately not unique — it is display
 * text, and `db/schema.ts` argues at length that making it unique would add a
 * second way to reject a category, one that speaks about capitalisation. The
 * app's own write path cannot produce two rows sharing a name, because a name
 * determines a slug and the slug is unique; a row inserted by hand whose
 * `slug` is not `categorySlug(name)` can. Until `YEO-117` this compared names,
 * and the failure there ran in the unhelpful direction: "there is nothing to
 * restore" for a restore that would in fact re-file the entry — the shape of
 * the bug `YEO-106` fixed, arrived at from the other side.
 *
 * @param entry the entry as it stands, with its live filing
 * @param revision the revision being considered, as stored
 * @returns whether restoring would leave every one of the four fields as it is
 */
export function restoreWouldChangeNothing(
  entry: RestorableContent,
  revision: RestorableContent,
): boolean {
  return (
    entry.title === revision.title &&
    entry.bodyHtml === revision.bodyHtml &&
    entry.hatnote === revision.hatnote &&
    sameFiling(entry.categories, revision.categories)
  );
}

/**
 * Set equality over two filings, each already a list of category slugs.
 *
 * A `Set` on one side and a length check on the other, rather than sorting
 * both: neither list can hold the same slug twice. The live filing joins
 * `page_categories` — whose primary key is `(page_id, category_id)` — to a
 * table with `slug` unique, and the recorded filing has been through
 * `normaliseEntryCategories`, which de-duplicates by slug. That is what makes
 * "same size and every member present" equivalent to set equality here,
 * without a sort whose comparator would be a third opinion about order.
 */
function sameFiling(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inA = new Set(a);
  return b.every((slug) => inA.has(slug));
}
