import { asc } from "drizzle-orm";

import { db, schema } from "@/db";
import { searchPeople, type PersonMatch } from "@/lib/people-search";

/**
 * The database half of people search (E8-T2, `YEO-56`) — the read, and
 * nothing about how it is ranked. `lib/pages.ts` is the model this mirrors:
 * a narrow select, in an order Postgres can serve efficiently, handed to a
 * pure module that decides everything about the result.
 *
 * ## The narrow select
 *
 * Exactly the seven columns `lib/people-search.ts`'s `PersonSearchRow` names
 * — never `select()`. `lib/pages.ts`'s `getPageBySlug` and `listPages` make
 * the same argument for themselves: widening the query and widening the type
 * are then the same edit, and a column nobody asked for cannot drift into
 * the payload unnoticed. There are a few hundred people in this schema at
 * the outside (see `getFamilyGraph`), so the saving is not about row count —
 * it is that a select that says exactly what it needs is the select a
 * reviewer can check against the type it feeds, and a `select()` here is not.
 *
 * ## Why `individuals_surname_idx` is enough, honestly
 *
 * `db/schema.ts` defines `individuals_surname_idx` as `(surname,
 * given_name)`, and the `orderBy` below is `asc(surname), asc(given_name)` —
 * exactly that pair, in that order. That is what lets Postgres serve the
 * ordering from the index instead of sorting the result — and this is the
 * only read in the codebase that asks for it. `getFamilyGraph` selects the
 * same table with no `orderBy` at all, because the canvas ranks people by
 * generation rather than by name, so until this ticket that index was
 * carrying nothing but the uniqueness of nobody's query. On a few hundred
 * rows the planner may well still choose a sequential scan and a sort, and
 * that is fine: the point of matching the index is that the ordering *can*
 * come from it, and goes on being able to as the table grows, without a
 * schema change or a second index to maintain.
 *
 * The load-bearing half of the argument is what this ticket does *not* add:
 * no new index, no `pg_trgm`, no `fuzzystrmatch`, no stored phonetic column.
 * Spelling tolerance — "Catherine" finding a recorded "Katharine" — cannot be
 * expressed as a `WHERE` predicate against `individuals_surname_idx` or any
 * index like it: `nameKey`'s substitutions are folk etymology applied in
 * TypeScript, not a comparison Postgres's B-tree or trigram machinery has any
 * native way to perform. Making it one would mean adding the `pg_trgm` or
 * `fuzzystrmatch` extension, a generated column carrying the phonetic key,
 * and a GIN or B-tree index over it — a migration, for a corpus the ticket's
 * own numbers put at a few hundred people, that `getFamilyGraph` already
 * reads whole into the browser on every visit to `/tree`. Computing tolerance
 * in the application instead costs exactly what reading every row already
 * costs, and buys back the migration.
 *
 * This is the same trade `lib/pages.ts`'s `listPages` documents for its own
 * `ORDER BY`: read the small table whole, and do the part Postgres cannot be
 * trusted or asked to do — there, collation-aware sorting; here, spelling
 * tolerance — in TypeScript, where `npm test` can see it.
 *
 * What would change the answer: thousands of individuals rather than
 * hundreds. At that size reading every row to rank it in memory stops being
 * free, and the honest fix is the one sketched above — a stored phonetic key
 * and an index over it, computed at write time rather than at every read.
 * Nothing about `lib/people-search.ts`'s ranking would need to change; only
 * where the narrowing happens would move from this function to a `WHERE`
 * clause ahead of it.
 */
export async function searchPeopleByName(
  query: string,
  options: { limit?: number } = {},
): Promise<PersonMatch[]> {
  const rows = await db
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      birthDate: schema.individuals.birthDate,
      birthDateQualifier: schema.individuals.birthDateQualifier,
      deathDate: schema.individuals.deathDate,
      deathDateQualifier: schema.individuals.deathDateQualifier,
    })
    .from(schema.individuals)
    .orderBy(
      asc(schema.individuals.surname),
      asc(schema.individuals.givenName),
    );

  return searchPeople(rows, query, options);
}
