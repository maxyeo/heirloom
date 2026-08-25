import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import { db, schema } from "@/db";
import { NAMESAKE_LIMIT, type NamesakePerson } from "@/lib/hatnote";

/**
 * Who else is called this (E11-T9, `YEO-79`) — the read behind the automatic
 * hatnote.
 *
 * The split `lib/entry-infobox.ts` and `lib/person-infobox.ts` already draw,
 * and `lib/people.ts` and `lib/people-search.ts` before them: the query lives
 * here, and everything that decides what the line *says* lives in
 * `lib/hatnote.ts`, which imports nothing with a runtime environment and is
 * therefore checkable under `npm test` (docs/testing.md).
 */

/**
 * The namesakes to name, and how many more there are.
 *
 * `extra` is a count rather than more rows because the line stops naming
 * people at `NAMESAKE_LIMIT` and starts counting them — see
 * `describeExtraNamesakes`. It is zero in every ordinary case: two Marys is
 * the shape of this problem, not fifteen.
 */
export type Namesakes = {
  /** At most `NAMESAKE_LIMIT`, oldest first. */
  people: NamesakePerson[];
  /** How many share the name beyond the ones in `people`. */
  extra: number;
};

/**
 * Nobody else is called this — the answer for most entries, and the value the
 * route uses for an entry that is about no person at all, so that "no
 * namesakes" has one spelling rather than a literal repeated at each site.
 */
export const NO_NAMESAKES: Namesakes = { people: [], extra: 0 };

/**
 * The people who share this person's full name.
 *
 * ## One query, served by `individuals_surname_idx`
 *
 * The predicate is `surname = ? AND given_name = ?`, which is exactly the
 * `(surname, given_name)` pair that index leads on — so this is a seek rather
 * than the scan the collision check would otherwise be, and it stays a seek as
 * the table grows. `lib/people.ts` is the only other read in this codebase
 * that asks that index for anything, and it explains at length why the index
 * being *usable* matters more than whether today's planner picks it over a
 * sequential scan of a few hundred rows.
 *
 * The entry addresses come back in the **same** query, through a `left join`
 * onto `pages`. That is the whole of the N+1 avoidance and it is worth stating
 * as a decision rather than leaving as a shape: the obvious implementation
 * finds the namesakes here and then asks `pages` for each one's slug, which
 * looks identical on screen and costs a round trip per name. The join is left
 * rather than inner because a namesake with no entry is not a namesake to
 * hide — they are exactly the person a red link should invite somebody to
 * write about.
 *
 * ## Why the match is exact, when search is not
 *
 * `lib/people-search.ts` tolerates spelling — "Catherine" finds a recorded
 * "Katharine" — and this deliberately does not. Two reasons, and the second is
 * the load-bearing one:
 *
 *   - A hatnote is a claim, not a suggestion. "For other people named Rose
 *     Whitfield" is false if the other person is a Rosa Whitfield, and a
 *     reader who follows it has been sent somewhere on the strength of a
 *     guess.
 *   - Tolerance cannot be a `WHERE` predicate. `nameKey`'s substitutions are
 *     applied in TypeScript, so a tolerant version of this would have to read
 *     every individual on every entry render — which is the scan this function
 *     exists to avoid. `lib/people.ts` makes that trade the other way for
 *     search, where the user typed a query and is expecting approximation.
 *
 * ## Why there is no `LIMIT`
 *
 * The predicate is an exact match on a *whole name*, so the result is a
 * handful of rows by construction — the case this feature exists for is three
 * generations of Thomas, not three hundred. A `LIMIT NAMESAKE_LIMIT + 1` would
 * bound it, and would then need a second `count(*)` to say "and 3 others"
 * truthfully rather than "and some others". Reading the handful and slicing it
 * here is one query and an honest count, which is the same bargain
 * `listPages` in `lib/pages.ts` strikes for its own unbounded read.
 *
 * @param subject the person this entry is about
 * @param pageId this entry's `pages.id`, so it cannot be its own namesake
 * @returns the namesakes to name, oldest first, and how many more there are
 */
export async function findNamesakes(
  subject: { id: string; givenName: string; surname: string | null },
  pageId: string,
): Promise<Namesakes> {
  const rows = await db
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      birthDate: schema.individuals.birthDate,
      birthDateQualifier: schema.individuals.birthDateQualifier,
      birthDateUpper: schema.individuals.birthDateUpper,
      deathDate: schema.individuals.deathDate,
      deathDateQualifier: schema.individuals.deathDateQualifier,
      deathDateUpper: schema.individuals.deathDateUpper,
      slug: schema.pages.slug,
    })
    .from(schema.individuals)
    .leftJoin(schema.pages, eq(schema.individuals.pageId, schema.pages.id))
    .where(
      and(
        eq(schema.individuals.givenName, subject.givenName),
        // `surname` is nullable, and `= NULL` is never true. A family's oldest
        // generations routinely have no recorded surname, and two of them
        // called Mary are as much a collision as two Mary Whitfields.
        subject.surname === null
          ? isNull(schema.individuals.surname)
          : eq(schema.individuals.surname, subject.surname),
        ne(schema.individuals.id, subject.id),
        /**
         * And nobody else pointing at *this* entry.
         *
         * Only reachable through a hand-run `UPDATE` — `lib/link-person-entry.ts`
         * holds the one-person-per-entry rule with a row lock — but the failure
         * it prevents is a bad one to leave available: a second row claiming
         * this page would produce a hatnote telling the reader that for other
         * people named Rose Whitfield they should see the page they are already
         * on. `getEntryPerson` has its own opinion about which of the two rows
         * is the subject; this makes sure the loser is not then presented as
         * somebody else.
         */
        or(
          isNull(schema.individuals.pageId),
          ne(schema.individuals.pageId, pageId),
        ),
      ),
    )
    /**
     * Oldest first, which is the order a family thinks about three
     * generations of one name in. Postgres sorts nulls last on an ascending
     * order, so the people with no recorded birth date come after the ones
     * who can be placed — which is also the order of how useful they are in a
     * line whose job is to tell people apart. `id` makes it total, so the
     * same database always answers the same way.
     */
    .orderBy(asc(schema.individuals.birthDate), asc(schema.individuals.id));

  if (rows.length === 0) return NO_NAMESAKES;

  return {
    people: rows.slice(0, NAMESAKE_LIMIT),
    extra: Math.max(0, rows.length - NAMESAKE_LIMIT),
  };
}
