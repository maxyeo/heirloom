import { describe, expect, it } from "vitest";

import {
  compareEntriesByTitle,
  formatUpdatedAt,
  type TitledEntry,
} from "@/lib/page-index";

/**
 * These are the index's two acceptance criteria — alphabetical by title, and a
 * last-updated date per entry — and this file is the only place either can be
 * checked by `npm test`. That is why they are plain functions: the route that
 * uses them is an `async` Server Component, which is not unit-testable, and
 * the query that feeds them lives behind `@/db`. See the header of
 * `lib/page-index.ts`.
 */

function entry(title: string, slug = title.toLowerCase()): TitledEntry {
  return { title, slug };
}

function titlesInOrder(...titles: string[]): string[] {
  return titles
    .map((title) => entry(title))
    .sort(compareEntriesByTitle)
    .map((e) => e.title);
}

describe("compareEntriesByTitle", () => {
  it("orders titles alphabetically", () => {
    expect(titlesInOrder("Walter Hale", "Ada Byron", "Rose Hale")).toEqual([
      "Ada Byron",
      "Rose Hale",
      "Walter Hale",
    ]);
  });

  it("ignores case when deciding which title comes first", () => {
    // The reason this module exists. Postgres answers `ORDER BY title` out of
    // the database's collation, and a `createdb` on macOS gives you `C`, where
    // every capital sorts before every lowercase: this list comes back as
    // "Ada Byron, Zoe, alice". `lower(title)` would fix this case and not the
    // next one.
    expect(titlesInOrder("Zoe", "alice", "Ada Byron")).toEqual([
      "Ada Byron",
      "alice",
      "Zoe",
    ]);
  });

  it("files an accented letter with its unaccented one", () => {
    // The half `lower(title)` cannot reach. Under `C`, "Émile" is not a letter
    // with an accent, it is a pair of bytes above every ASCII character, so it
    // sorts after "Zoe" — and a family wiki is exactly the corpus full of
    // names like it.
    expect(titlesInOrder("Zoe", "Émile Lefèvre", "Edmund Hale")).toEqual([
      "Edmund Hale",
      "Émile Lefèvre",
      "Zoe",
    ]);
  });

  it("compares a run of digits as a number, not as text", () => {
    expect(titlesInOrder("Farm 10", "Farm 2", "Farm 1")).toEqual([
      "Farm 1",
      "Farm 2",
      "Farm 10",
    ]);
  });

  it("breaks a tie on the slug, so the order is total", () => {
    // Two entries may share a title; the slug is what the schema makes unique.
    // Without this the sort would be free to return either order, and the list
    // could reshuffle between two requests that read identical rows.
    const sorted = [
      { title: "Rose Hale", slug: "rose-hale-2" },
      { title: "Rose Hale", slug: "rose-hale" },
    ].sort(compareEntriesByTitle);

    expect(sorted.map((e) => e.slug)).toEqual(["rose-hale", "rose-hale-2"]);
  });

  it("reports equal entries as equal", () => {
    expect(compareEntriesByTitle(entry("Rose Hale"), entry("Rose Hale"))).toBe(
      0,
    );
  });
});

describe("formatUpdatedAt", () => {
  it("writes the date day-month-year, the way Wikipedia does", () => {
    expect(formatUpdatedAt(new Date("2026-08-23T09:41:00.000Z"))).toBe(
      "23 August 2026",
    );
  });

  it("does not pad the day", () => {
    expect(formatUpdatedAt(new Date("2026-08-05T09:41:00.000Z"))).toBe(
      "5 August 2026",
    );
  });

  it("reads the instant in UTC rather than in the server's zone", () => {
    // Both instants are the same UTC day and must render as it, whatever
    // `TZ` the machine running this happens to have. Late-evening and
    // early-morning UTC are where a host-local formatter would drift onto the
    // neighbouring date and put an entry under yesterday or tomorrow.
    expect(formatUpdatedAt(new Date("2026-08-23T23:30:00.000Z"))).toBe(
      "23 August 2026",
    );
    expect(formatUpdatedAt(new Date("2026-08-23T00:30:00.000Z"))).toBe(
      "23 August 2026",
    );
  });
});
