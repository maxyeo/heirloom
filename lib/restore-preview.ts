import type { NamedCategory } from "@/lib/category-name";

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
   * What the entry is filed under (`YEO-106`) — category names.
   *
   * Order is not significant; see {@link restoreWouldChangeNothing}. Typed as
   * bare names rather than `NamedCategory` because that is what
   * `revisions.categories` holds, and the entry side is adapted by
   * {@link filingOf} rather than the revision side being widened to a shape
   * half of it cannot fill.
   */
  categories: readonly string[];
};

/**
 * An entry's live filing as this module wants it, from the rows
 * `readEntryCategories` hands back.
 *
 * A named adapter rather than a `.map` at the call site, so the one place that
 * knows a live filing is `NamedCategory[]` and a recorded filing is
 * `string[]` is this file rather than a route.
 */
export function filingOf(categories: readonly NamedCategory[]): string[] {
  return categories.map((category) => category.name);
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
 * It is also what `restoreRevision` compares. `setEntryCategories` reports
 * `changed` from the rows it added and removed, which is set difference — so
 * this agrees with the authoritative answer rather than approximating it.
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
 * Set equality over two filings.
 *
 * A `Set` on one side and a length check on the other, rather than sorting
 * both: `normaliseEntryCategories` de-duplicates by slug before either side is
 * written, so neither list can hold the same category twice — which is what
 * makes "same size and every member present" equivalent to set equality here,
 * without a sort whose comparator would be a third opinion about order.
 */
function sameFiling(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const inA = new Set(a);
  return b.every((name) => inA.has(name));
}
