/**
 * Who added a person to the tree (E8-T4 follow-up, `YEO-104`) — the values
 * the `individuals` author columns can hold, and the rules for reading and
 * writing them, as plain functions over plain values.
 *
 * ## Why the author is not part of `IndividualFields`
 *
 * Because it is not a field. Everything in `lib/individual-input.ts` arrives
 * as `unknown` from a `FormData`, a GEDCOM record or a hand-made POST, and
 * `validateIndividual`'s whole job is deciding what of that is fit to store.
 * An author that travelled the same road would be a column any direct POST
 * could set to anybody's email — authorship claimed by the caller rather than
 * observed by the server, which is worse than no authorship at all.
 *
 * So the author is a *second* argument to every write path, sourced from the
 * session (`lib/session.ts`) or from the fact that a file wrote the row, and
 * it never passes through validation because it never came from the client.
 *
 * ## Why this module is pure
 *
 * The same split `lib/recent-changes-feed.ts` makes and for the same reason:
 * `npm test` — the suite CI's `check` job runs — has no `DATABASE_URL`, so a
 * module that imports `@/db` cannot be loaded there (docs/testing.md). The
 * mapping from "who did this" to "what goes in the two columns" is the part
 * worth checking, and it is checked by the suite that gates a merge.
 *
 * `db/schema.ts` imports {@link INDIVIDUAL_AUTHOR_SOURCES} from here rather
 * than repeating the labels, so the Postgres enum and the TypeScript union
 * cannot drift — the rule `test/route-inventory.ts` states for its own shared
 * lists ("derived rather than written out, so the two halves cannot fail to
 * add up"). The dependency points that way round because this is the module
 * with no imports at all.
 */

/**
 * Every value `individuals.created_by_source` can hold.
 *
 * The column exists because a nullable `created_by` on its own cannot say
 * *why* it is null, and the three reasons are genuinely different facts:
 *
 * - `member` — somebody signed in typed this person in, and
 *   `individuals.created_by` holds their email. This is the only value that
 *   comes with an author.
 * - `import` — a GEDCOM file wrote the row. `created_by` is null and that is
 *   not a gap: `individuals.import_id` names the file, and
 *   `gedcom_imports.imported_by` records who ran it, so the author is
 *   *derivable* rather than missing. See {@link authorColumns} for why it is
 *   derived rather than copied.
 * - `legacy` — the row predates this column. Nothing in this application can
 *   write it: {@link IndividualAuthor} has no arm that produces it, so it is
 *   reachable only from the backfill in `drizzle/0011_individual_author.sql`.
 *   That is what keeps its meaning exactly "written before `YEO-104`" instead
 *   of accumulating a second one.
 *
 * The distinction that last value preserves is the ticket's, and it is worth
 * restating: a null that means "before we recorded this" is not the same as a
 * null that means anything else, and neither may be rendered as a name that
 * went missing.
 *
 * A tuple rather than an array so `pgEnum` accepts it and so
 * {@link IndividualAuthorSource} is the three labels rather than `string`.
 */
export const INDIVIDUAL_AUTHOR_SOURCES = [
  "member",
  "import",
  "legacy",
] as const;

/** One of {@link INDIVIDUAL_AUTHOR_SOURCES}. */
export type IndividualAuthorSource = (typeof INDIVIDUAL_AUTHOR_SOURCES)[number];

/**
 * Who is creating a person, as the write paths are told it.
 *
 * A discriminated union rather than a nullable email, for the reason
 * `RecentChange` is one: "a signed-in member, and here is their address" and
 * "a file, whose runner is recorded elsewhere" are two different facts, and
 * `string | null` is one field in which they are indistinguishable. The union
 * also makes the impossible state unrepresentable — there is no way to
 * describe a member without an email — so no caller has to remember that the
 * two travel together.
 *
 * There is deliberately **no arm for `legacy`**. Rows that predate the column
 * are the migration's business and nothing else's; leaving the arm out is
 * what stops a write path reaching for it as an easy way past a required
 * argument.
 */
export type IndividualAuthor =
  { source: "member"; email: string } | { source: "import" };

/**
 * The two columns every insert into `individuals` must carry.
 *
 * Returned as an object to be spread into the values, so a write path adds
 * `...authorColumns(author)` and cannot set one column without the other.
 */
export type IndividualAuthorColumns = {
  createdBySource: IndividualAuthorSource;
  createdBy: string | null;
};

/**
 * A signed-in member, by their email.
 *
 * @param email the session's email — already established as present by
 *   `requireSession`, and passed rather than read here so this module stays
 *   loadable without Auth.js
 */
export function memberAuthor(email: string): IndividualAuthor {
  return { source: "member", email };
}

/**
 * A GEDCOM import.
 *
 * A constant rather than a function because there is nothing to parameterise:
 * *which* import is already recorded on the row, by `individuals.import_id`.
 */
export const IMPORT_AUTHOR: IndividualAuthor = { source: "import" };

/**
 * What to write in `created_by_source` and `created_by`.
 *
 * ## The GEDCOM import stores no email, deliberately
 *
 * This is the ticket's explicit question, and the answer is *derive*. An
 * imported row already carries `import_id`, and the row it points at already
 * carries `imported_by` — written from the session by the import endpoint,
 * exactly as `pages.updated_by` is. Copying that email onto every one of the
 * few hundred individuals a file writes would be a second copy of a fact the
 * schema already holds once, free to disagree with the first the moment
 * anything corrects the ledger, and it would answer a question nobody asks of
 * an individual row: "who added this person" is answered for imported people
 * by the import, which is why the feed reports the file as one line
 * (`RecentChange`'s `people-imported` arm) rather than reporting three
 * hundred arrivals.
 *
 * `import` is therefore an author *source* with no author *email*, and the
 * pair reads as "a file wrote this; ask the ledger who ran it". The feed
 * never has to: `listRecentlyAddedPeople` filters imported people out
 * entirely, because they are already reported by the line about the file.
 *
 * @param author who is creating the row
 * @returns the two columns, ready to spread into an insert
 */
export function authorColumns(
  author: IndividualAuthor,
): IndividualAuthorColumns {
  switch (author.source) {
    case "member":
      return { createdBySource: "member", createdBy: author.email };

    case "import":
      // See the docblock: null is the answer, not a gap. `import_id` and
      // `gedcom_imports.imported_by` hold the author of an imported row.
      return { createdBySource: "import", createdBy: null };
  }
}

/**
 * The email to attribute a person to, or `undefined` when there is nobody to
 * name.
 *
 * `undefined` rather than null, and the difference is the whole point: a
 * caller gets back either an address to print or *no field at all*, so there
 * is no value in between for a renderer to turn into "Unknown". That is the
 * same structural refusal `RecentChange` makes by giving its `person-added`
 * arm an optional author instead of a nullable one.
 *
 * Nobody to name covers three cases and treats them identically, because a
 * reader is owed the same thing in all three — silence rather than a guess:
 *
 * - `legacy`, where the application never recorded an author;
 * - `import`, where the author is the importer and is reported against the
 *   import instead;
 * - `member` with a null email, which this application cannot produce —
 *   `memberAuthor` takes a `string` — and which a hand-written `UPDATE` can.
 *   Returning `undefined` for it is the safe reading rather than an assertion
 *   that it never happens.
 *
 * @param row the two author columns, as read from `individuals`
 * @returns the member's email, or `undefined`
 */
export function individualAuthorEmail(row: {
  createdBySource: IndividualAuthorSource;
  createdBy: string | null;
}): string | undefined {
  if (row.createdBySource !== "member") return undefined;
  return row.createdBy ?? undefined;
}
