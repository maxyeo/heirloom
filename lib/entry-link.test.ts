import { describe, expect, it } from "vitest";

import { type EntryLink, findEntry, unlinkedEntries } from "@/lib/entry-link";

/**
 * The two questions the detail panel asks about entries (E2-T2, `YEO-25`),
 * both of them plain functions over plain values — which is why they are here
 * rather than proven by mounting anything. See docs/testing.md.
 */

const ROSE_ENTRY: EntryLink = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "rose-hale",
  title: "Rose Hale",
};

const THOMAS_ENTRY: EntryLink = {
  id: "00000000-0000-4000-8000-000000000002",
  slug: "thomas-hale",
  title: "Thomas Hale",
};

const ENTRIES = [ROSE_ENTRY, THOMAS_ENTRY];

describe("findEntry", () => {
  it("finds the entry a person is linked to", () => {
    expect(findEntry(ENTRIES, THOMAS_ENTRY.id)).toEqual(THOMAS_ENTRY);
  });

  it("returns null for a person with no entry", () => {
    expect(findEntry(ENTRIES, null)).toBeNull();
  });

  it("returns null for an id no entry has", () => {
    /**
     * The tree's data and the entry list are two reads, so an entry deleted
     * between them leaves a dangling id. `on delete set null` corrects the
     * column on the next load; until then "no entry" is the honest answer,
     * and the panel offers to write one.
     */
    expect(
      findEntry(ENTRIES, "00000000-0000-4000-8000-00000000ffff"),
    ).toBeNull();
  });

  it("returns null when there are no entries at all", () => {
    expect(findEntry([], ROSE_ENTRY.id)).toBeNull();
  });
});

describe("unlinkedEntries", () => {
  it("leaves out the entries people are already linked to", () => {
    const free = unlinkedEntries(ENTRIES, [
      { pageId: ROSE_ENTRY.id },
      { pageId: null },
    ]);

    expect(free).toEqual([THOMAS_ENTRY]);
  });

  it("offers every entry when nobody is linked", () => {
    expect(unlinkedEntries(ENTRIES, [{ pageId: null }])).toEqual(ENTRIES);
  });

  it("offers nothing when every entry is taken", () => {
    const free = unlinkedEntries(ENTRIES, [
      { pageId: ROSE_ENTRY.id },
      { pageId: THOMAS_ENTRY.id },
    ]);

    expect(free).toEqual([]);
  });

  it("ignores a link to an entry that no longer exists", () => {
    // A dangling `page_id` must not remove a real entry from the list by
    // coincidence, and must not throw.
    const free = unlinkedEntries(ENTRIES, [
      { pageId: "00000000-0000-4000-8000-00000000ffff" },
    ]);

    expect(free).toEqual(ENTRIES);
  });

  it("keeps the order it was given", () => {
    // `listEntryLinks` has already sorted these alphabetically by title, and
    // the picker renders them in that order. Filtering must not reshuffle it.
    const free = unlinkedEntries([THOMAS_ENTRY, ROSE_ENTRY], []);

    expect(free.map((entry) => entry.slug)).toEqual([
      THOMAS_ENTRY.slug,
      ROSE_ENTRY.slug,
    ]);
  });
});
