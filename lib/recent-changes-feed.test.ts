import { describe, expect, it } from "vitest";

import {
  changeWhenIso,
  formatChangeAuthor,
  formatChangeWhen,
  formatImportFileName,
  formatPersonCount,
  mergeRecentChanges,
  type RecentChange,
  RECENT_CHANGES_LIMIT,
} from "@/lib/recent-changes-feed";

/**
 * The decisions the feed makes, checked in the suite that gates a merge.
 *
 * This is the whole reason `lib/recent-changes-feed.ts` is a module separate
 * from `lib/recent-changes.ts`: the ordering across three unlike sources is
 * the interesting part of E8-T4, and had the feed been one `UNION ALL` it
 * would live in SQL, where `npm test` — which CI runs with no `DATABASE_URL`
 * at all — could not reach it. See docs/testing.md.
 *
 * What is deliberately *not* here: whether the queries select the right
 * columns, and whether the entries query uses `pages_updated_at_idx`. Both are
 * properties of Postgres rather than of TypeScript, so both live in
 * `lib/recent-changes.db.test.ts`.
 */

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOON = new Date("2026-08-23T12:00:00.000Z");

/** `NOON`, shifted by whole minutes — negative is earlier. */
function minutesFromNoon(minutes: number): Date {
  return new Date(NOON.getTime() + minutes * 60_000);
}

function entry(
  slug: string,
  when: Date,
  editor: string | null = "rose@example.com",
): RecentChange {
  return { kind: "entry-changed", slug, title: `Entry ${slug}`, when, editor };
}

function person(personId: string, when: Date): RecentChange {
  return { kind: "person-added", personId, name: `Person ${personId}`, when };
}

function gedcomImport(importId: string, when: Date): RecentChange {
  return {
    kind: "people-imported",
    importId,
    fileName: "family.ged",
    personCount: 12,
    when,
    importedBy: "walter@example.com",
  };
}

describe("mergeRecentChanges", () => {
  it("interleaves the three sources by time, newest first", () => {
    // Each source is already newest-first on its own, which is what the
    // database hands back. The merge's job is the interleaving between them.
    const merged = mergeRecentChanges([
      [entry("a", minutesFromNoon(-1)), entry("b", minutesFromNoon(-40))],
      [person("p1", minutesFromNoon(-10))],
      [gedcomImport("i1", minutesFromNoon(-25))],
    ]);

    expect(merged.map((change) => change.kind)).toEqual([
      "entry-changed",
      "person-added",
      "people-imported",
      "entry-changed",
    ]);
  });

  it("keeps at most the limit, dropping the oldest rows", () => {
    const sources = [
      [entry("newest", minutesFromNoon(-1))],
      [person("middle", minutesFromNoon(-2))],
      [gedcomImport("oldest", minutesFromNoon(-3))],
    ];

    const merged = mergeRecentChanges(sources, 2);

    expect(merged).toHaveLength(2);
    // The two newest, and the oldest is what fell off — not an arbitrary two.
    expect(merged.map((change) => change.kind)).toEqual([
      "entry-changed",
      "person-added",
    ]);
  });

  it("defaults to RECENT_CHANGES_LIMIT rows", () => {
    // One more than the limit, all at distinct instants, from a single source.
    const many = Array.from({ length: RECENT_CHANGES_LIMIT + 1 }, (_, index) =>
      entry(`entry-${index}`, minutesFromNoon(-index)),
    );

    expect(mergeRecentChanges([many])).toHaveLength(RECENT_CHANGES_LIMIT);
  });

  it("orders simultaneous changes the same way every time", () => {
    /*
      Not hypothetical: an import writes its ledger row and its people in one
      transaction, and `defaultNow()` inside a transaction is the
      transaction's start time — so two arms really can carry the same
      millisecond. Sorting on `when` alone would leave the order up to
      whatever `Array.prototype.sort` did with the input order, and the feed
      could reshuffle between two requests that read identical rows.
    */
    const simultaneous = [
      [entry("zebra", NOON)],
      [person("00000000-0000-4000-8000-000000000001", NOON)],
      [gedcomImport("00000000-0000-4000-8000-000000000002", NOON)],
    ];

    const first = mergeRecentChanges(simultaneous);
    // The same rows, presented to the merge in the opposite order — which is
    // the difference a merely *stable* sort would happily preserve.
    const reversed = mergeRecentChanges([...simultaneous].reverse());

    expect(reversed).toEqual(first);
  });

  it("does not reorder the arrays it was given", () => {
    const source = [entry("older", minutesFromNoon(-9)), entry("newer", NOON)];
    const before = [...source];

    mergeRecentChanges([source]);

    expect(source).toEqual(before);
  });

  it("returns nothing for a wiki where nothing has happened", () => {
    // The state every install starts in, and the one the section renders an
    // invitation for rather than an empty list.
    expect(mergeRecentChanges([[], [], []])).toEqual([]);
  });
});

describe("formatChangeWhen", () => {
  it("renders the day and the time, pinned to UTC", () => {
    // The day alone is too coarse for a feed: three edits on one afternoon
    // would read as three identical strings in an order nothing explained.
    expect(formatChangeWhen(NOON)).toBe("23 August 2026 at 12:00 UTC");
  });

  it("says the same thing whatever the host's zone is", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      expect(formatChangeWhen(NOON)).toContain("23 August 2026");
      expect(formatChangeWhen(NOON)).toContain("UTC");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("changeWhenIso", () => {
  it("is the exact instant, for the dateTime attribute", () => {
    // The machine-readable half, where `formatChangeWhen` rounds to a minute.
    expect(changeWhenIso(new Date("2026-08-23T12:00:30.500Z"))).toBe(
      "2026-08-23T12:00:30.500Z",
    );
  });
});

describe("formatChangeAuthor", () => {
  it("names the author when the column holds one", () => {
    expect(formatChangeAuthor("rose@example.com")).toBe("rose@example.com");
  });

  it("says Unknown rather than nothing when the column is null", () => {
    // `pages.updated_by` and `gedcom_imports.imported_by` are both nullable —
    // seed rows and hand-written SQL have no signed-in author — and an empty
    // string in the byline would read as a rendering fault.
    expect(formatChangeAuthor(null)).toBe("Unknown");
  });
});

describe("formatImportFileName", () => {
  it("uses the uploaded filename", () => {
    expect(formatImportFileName("whitfield.ged")).toBe("whitfield.ged");
  });

  it("falls back to a description when the browser sent no name", () => {
    // `FormData.get()` only promises a `Blob`, and only a `File` carries a
    // `name` — so the column is nullable and the sentence still has to finish.
    expect(formatImportFileName(null)).toBe("a GEDCOM file");
  });
});

describe("formatPersonCount", () => {
  it("does not say 1 people", () => {
    expect(formatPersonCount(1)).toBe("1 person");
  });

  it("pluralises everything else", () => {
    expect(formatPersonCount(2)).toBe("2 people");
    expect(formatPersonCount(312)).toBe("312 people");
  });
});
