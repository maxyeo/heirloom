/**
 * Whether a string is shaped like one of this schema's primary keys.
 *
 * Every id column in `db/schema.ts` is a Postgres `uuid` filled by
 * `defaultRandom()`, and every id that reaches a lookup arrives from outside —
 * a URL segment, a hidden form field, a direct POST — under no obligation to
 * look like a UUID at all. Handing a non-UUID string to `eq(table.id, value)`
 * reaches Postgres, which raises `invalid input syntax for type uuid`. That is
 * a *thrown error* rather than a query returning no rows, so without a shape
 * check a bad link surfaces as a 500 and a malformed form field surfaces as an
 * error boundary, when both are really just "no such row".
 *
 * A regex rather than a package: the format is fixed and well known, and a
 * dependency for it would be one more thing to update for a string this
 * simple. Any RFC 4122 version and variant is accepted rather than only
 * version 4 — `gen_random_uuid()` produces v4, but nothing here depends on
 * the version bits, and rejecting a v7 id later would be a surprise.
 *
 * This lives in a module of its own because the check is a property of the
 * *schema*, not of any one table: `lib/revision-format.ts` needed it first for
 * `revisions.id`, and `lib/save-individual.ts` needs exactly the same check
 * for `individuals.id`. Two copies of one regex is two places for it to drift.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRowId(value: string): boolean {
  return UUID_PATTERN.test(value);
}
