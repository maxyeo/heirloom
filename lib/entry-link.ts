/**
 * The seam between a person and their entry (E2-T2, `YEO-25`), as plain
 * functions over plain values.
 *
 * `individuals.page_id` has been in `db/schema.ts` since the beginning and has
 * always been null. This module is the reading side of finally filling it in:
 * which entry a person's panel should link to, and which entries are still
 * free to be linked to somebody.
 *
 * ## Why the lookup is not in `lib/person-detail.ts`
 *
 * Because `derivePersonDetail` derives everything it returns from the graph,
 * and the entry is not in the graph. The alternative — joining `pages` into
 * `getFamilyGraph` — would put a slug and a title on every one of the hundreds
 * of `GraphPerson` rows in order to render one link on the one person whose
 * panel is open, and would widen the type every fixture in the suite builds.
 * The entries arrive as their own small list instead (`listEntryLinks`), and
 * the two are matched here.
 *
 * ## Why it is client-side at all
 *
 * The same reason the layout is: a family tree is hundreds of people and a
 * family wiki is a few hundred entries (docs/architecture.md), so both are
 * loaded once and reasoned about in the browser. The panel already changes
 * person without a request; making the entry link cost one would be the only
 * part of it that did.
 */

/**
 * Enough of an entry to link to it, and to recognise it in a list.
 *
 * `id` is here because that is what `individuals.page_id` holds and therefore
 * what a link or an unlink names; `slug` is what an href is built from; and
 * `title` is what a reader is shown. Nothing else: this list travels to the
 * browser for every person on the tree, so a column nobody renders is a column
 * paid for on every load of `/tree`.
 */
export type EntryLink = {
  id: string;
  slug: string;
  title: string;
};

/**
 * Anything with a `page_id`, which in practice is a `GraphPerson`.
 *
 * Structural rather than an import of `GraphPerson`, for the reason
 * `TitledEntry` in `lib/page-index.ts` gives for its own shape: this module is
 * reached by a Client Component, and `lib/family-graph.ts` exports both the
 * type and a function that queries the database.
 */
export type EntryHolder = {
  pageId: string | null;
};

/**
 * The entry a person is linked to, or null when they have none.
 *
 * Null is also the answer when `pageId` names an entry that is not in the
 * list, which is a real case rather than a defensive one: the tree's data and
 * the entry list are two reads, and an entry deleted between them leaves a
 * dangling id. `pages.id` is `on delete set null` from `individuals`, so the
 * column corrects itself on the next load — until then, "no entry" is the
 * honest thing to show, and the panel then offers to write one.
 *
 * @param entries every entry, as `listEntryLinks` returns them
 * @param pageId the person's `page_id`
 */
export function findEntry(
  entries: readonly EntryLink[],
  pageId: string | null,
): EntryLink | null {
  if (!pageId) return null;
  return entries.find((entry) => entry.id === pageId) ?? null;
}

/**
 * The entries no one on the tree is linked to.
 *
 * This is what the panel offers when it asks "or link an existing entry",
 * and the filter is what keeps that offer honest: `individuals.page_id` has
 * no unique index, so two people *can* point at one entry, and E2-T3's
 * backlink from an entry to the tree would then have two answers. The write
 * refuses it as well (`lib/link-person-entry.ts`) — this is the courtesy that
 * keeps the impossible option off the list, exactly as the tree's own pickers
 * filter out the choices `lib/save-child.ts` would reject.
 *
 * The order is whatever `listEntryLinks` chose, which is alphabetical by
 * title. Filtering preserves it.
 *
 * @param entries every entry, as `listEntryLinks` returns them
 * @param people everyone on the tree, for the ids they hold
 */
export function unlinkedEntries(
  entries: readonly EntryLink[],
  people: readonly EntryHolder[],
): EntryLink[] {
  const taken = new Set(
    people
      .map((person) => person.pageId)
      .filter((pageId): pageId is string => pageId !== null),
  );

  return entries.filter((entry) => !taken.has(entry.id));
}
