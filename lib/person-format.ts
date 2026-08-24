/**
 * How a person's *name* is rendered as text.
 *
 * Dates used to live here too. E4-T3 (`YEO-40`) moved them to
 * `lib/format-date.ts`, which is now the single formatter every surface that
 * shows a date goes through — the tree node, the detail panel, the removal
 * dialogue, the date field's echo and the edit form's prefill. What is left
 * here is the other half of "how a person reads", and it stays its own module
 * for the reason it always was: several callers need the same string.
 * `lib/tree-layout.ts` puts a name on every node; the detail panel (E2-T1)
 * repeats it in its header and again for every relative it links to. Two
 * copies of "join the names, drop the empty one" is exactly how a node and
 * its own panel end up disagreeing about what somebody is called.
 *
 * Deliberately a plain module with no imports at all: `npm test` — what CI
 * runs — has no `DATABASE_URL` (docs/testing.md), so nothing here may reach
 * anywhere near `@/db`, and nothing here drags postgres.js into the browser
 * bundle when the detail panel imports it.
 */

/**
 * A person's full name.
 *
 * `surname` is nullable in the schema, and for the oldest generations it is
 * routinely unknown, so the join has to drop the empty half rather than leave
 * a trailing space behind the given name.
 */
export function formatPersonName(
  givenName: string,
  surname: string | null,
): string {
  return [givenName, surname].filter(Boolean).join(" ");
}
