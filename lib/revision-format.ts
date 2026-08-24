/**
 * Formatting and small validation for revisions, pulled out of the history
 * routes so it can be unit-tested with no database.
 *
 * `lib/revisions.ts` is the data access and imports `@/db`; this module must
 * not, because `npm test` — what CI runs — has no `DATABASE_URL` at all (see
 * docs/testing.md), and importing a module that reaches `@/db`, even only for
 * a type, drags postgres.js into a test that had no business loading it. A
 * `Date` and a `string | null` are plain values, so nothing here needs the
 * schema or the query layer to decide how they should look on the page.
 */

import { isRowId } from "@/lib/row-id";

/**
 * A revision's timestamp, rendered as an unambiguous absolute moment.
 *
 * Pinned to UTC on purpose, and the rendered string says so. This runs in a
 * server component, on a host whose own clock is UTC, but a reader can be
 * anywhere — an unpinned format (`timeZone` left to the runtime) would render
 * the *server's* zone, which is not the reader's and not even guaranteed to
 * stay the same host to host. A locale-dependent format has the same problem
 * one layer up: `Intl`'s locale defaults to the environment's, so the exact
 * same `Date` could read differently on the machine that builds this and the
 * machine that serves it. Fixing both the zone and the locale (`en-GB`) is
 * what makes this deterministic — the property `revision-format.test.ts`
 * checks by formatting under more than one ambient `process.env.TZ`.
 */
export function formatRevisionTimestamp(when: Date): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(when);

  return `${formatted} UTC`;
}

/**
 * The same instant, as the machine-readable string `<time dateTime>` wants.
 * Kept alongside the human-readable formatter above because both routes that
 * render a timestamp need both: the `dateTime` attribute for anything that
 * parses the page, and `formatRevisionTimestamp` for what a reader sees.
 */
export function revisionTimestampIso(when: Date): string {
  return when.toISOString();
}

/**
 * A revision's author, or a fallback for the rows that have none.
 *
 * `revisions.created_by` is nullable in the schema — `text("created_by")`,
 * no `.notNull()` — which is not a hole in the save path so much as an
 * honest acknowledgement that not every row goes through it: `db/seed.ts`
 * inserts pages with no revisions at all, and a revision inserted by hand in
 * a SQL console (a data fix, a migration backfill) has no signed-in author to
 * attribute. Rendering an empty string for those would read as a rendering
 * bug rather than as the true state of the data.
 */
export function formatRevisionAuthor(email: string | null): string {
  return email ?? "Unknown";
}

/**
 * Whether a string is shaped like a revision id.
 *
 * `revisions.id` is a Postgres `uuid` column, and `revisionId` in
 * `app/wiki/[slug]/history/[revisionId]/page.tsx` comes straight from the
 * URL — untrusted, and under no obligation to look like a UUID at all.
 * Handing a non-UUID string to `eq(schema.revisions.id, revisionId)` reaches
 * Postgres, which raises `invalid input syntax for type uuid` — a thrown
 * error, not a query that returns no rows, so it would otherwise surface as a
 * 500 for what is really just a bad link. Checking the shape first turns
 * that into an ordinary 404.
 *
 * The check itself is `isRowId` (`lib/row-id.ts`), because it is a property
 * of the schema rather than of this table — `individuals.id` needs the
 * identical guard (E3-T1). This name stays because it is what the history
 * routes read as, and because a caller asking "is this a revision id?" should
 * not have to know that the answer is the same for every table.
 */
export function isRevisionId(value: string): boolean {
  return isRowId(value);
}
