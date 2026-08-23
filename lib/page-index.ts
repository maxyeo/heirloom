/**
 * The two presentation decisions the page index (E1-T9) makes — what
 * "alphabetical" means, and how a last-updated date is written — as plain
 * functions over plain values.
 *
 * They live in a module of their own rather than in `lib/pages.ts` or in the
 * route, for one reason: this is the only shape either decision can be tested
 * in. `lib/pages.ts` imports `@/db`, so a comparator defined there would drag
 * postgres.js into a suite CI runs with no `DATABASE_URL` — docs/testing.md
 * names that exact trap — and an `async` Server Component is not unit-testable
 * at all. Kept apart, both of the index's acceptance criteria are checked by
 * `npm test`, which is the suite CI actually runs.
 */

/**
 * Enough of an entry to order it. Structural rather than a re-export of
 * `WikiEntrySummary`, so importing this module never reaches for `@/lib/pages`
 * and the database behind it.
 */
export type TitledEntry = {
  title: string;
  slug: string;
};

/**
 * The collator, built once. Constructing an `Intl.Collator` is the expensive
 * part; comparing with it is not, and a sort over a few hundred titles calls
 * `compare` a few thousand times.
 *
 * The locale is pinned rather than left to the runtime default. `undefined`
 * would resolve out of the host's environment, so the same corpus could order
 * one way on a laptop and another way in a serverless function — a difference
 * nobody would think to look for. Heirloom's entries are English.
 *
 * `numeric` so a digit run compares as a number: without it "Farm 10" sorts
 * between "Farm 1" and "Farm 2", which is the one ordering surprise a reader
 * notices immediately.
 */
const collator = new Intl.Collator("en", { numeric: true });

/**
 * Order two entries the way a reader expects to find them in a list.
 *
 * @param a an entry
 * @param b another entry
 * @returns negative if `a` sorts first, positive if `b` does, 0 if neither
 */
export function compareEntriesByTitle(a: TitledEntry, b: TitledEntry): number {
  const byTitle = collator.compare(a.title, b.title);
  if (byTitle !== 0) return byTitle;

  // Nothing stops two entries sharing a title — the slug is what is unique in
  // the schema. Breaking the tie on it makes the order *total*, so a list does
  // not quietly reshuffle between two requests that read the same rows.
  return collator.compare(a.slug, b.slug);
}

/**
 * Wikipedia writes its dates day-month-year, and so does this.
 *
 * `timeZone` is pinned to UTC deliberately. This string is produced while
 * rendering on the server, where "local" is the host's zone — UTC in a
 * serverless function, whatever the laptop is set to in development — and
 * never the reader's. Pinning it makes the displayed date one stated zone
 * rather than an accident of where the render happened. The exact instant is
 * not lost: the route puts the full ISO timestamp in the `<time>` element's
 * `dateTime` attribute, which is the machine-readable half.
 *
 * Built once, for the same reason as the collator above.
 */
const updatedAtFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Render the date an entry last changed.
 *
 * @param updatedAt the instant of the last edit
 * @returns the date it fell on in UTC, e.g. `23 August 2026`
 */
export function formatUpdatedAt(updatedAt: Date): string {
  return updatedAtFormat.format(updatedAt);
}
