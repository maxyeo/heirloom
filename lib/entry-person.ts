import { asc, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import type { DatePrecision, DateQualifier } from "@/lib/family-graph";

/**
 * The link from an entry back to the person it is about (E2-T3, `YEO-26`).
 *
 * ## Why this reads the column backwards
 *
 * E2-T2 (`YEO-25`) filled `individuals.page_id` in, and everything built on it
 * so far reads it person-first: the panel knows who is open and asks which
 * entry they have. An entry has the opposite problem — it knows its own id and
 * nothing else — so this is the same column read from the other end, `where
 * page_id = <entry>`.
 *
 * ## Why it is a query and not the graph
 *
 * `getFamilyGraph` would answer this too, and it is what `/tree` already does.
 * It is the wrong tool here: it reads every individual, every union and every
 * child link in the family in order to answer one question about one person.
 * The question is one row, so this asks for one row.
 *
 * E11-T5's infobox does go on to load the graph (`lib/entry-infobox.ts`
 * explains why: a stepchild is two hops out), and it starts from *this* answer
 * rather than searching the graph for a matching `pageId`. There is one
 * reverse lookup, with one opinion about the tie-break below, and everything
 * that needs to know who an entry is about asks it.
 *
 * ## Why the columns are spelled out
 *
 * The same reason `WikiEntry` in `lib/pages.ts` gives for its own narrow
 * select: widening the query and widening the type are then one edit. `notes`
 * and `sex` are the deliberate omissions — this states who somebody is and
 * when they lived, and `notes` in particular is authored prose that belongs in
 * the entry body rather than duplicated above it.
 */

/**
 * The person an entry is about, and the dates that place them.
 *
 * Each date arrives as the three columns that are only meaningful together —
 * the day, how far the source can be trusted (`qualifier`), and how much of it
 * was actually known (`precision`). Dropping either sibling here is how a year
 * read off a headstone becomes "1 January 1890" on the page; see
 * `formatQualifiedDate` in `lib/format-date.ts`, whose `precision` argument
 * exists for precisely that.
 */
export type EntryPerson = {
  id: string;
  givenName: string;
  surname: string | null;
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  birthDatePrecision: DatePrecision;
  birthPlace: string | null;
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
  deathDatePrecision: DatePrecision;
  deathPlace: string | null;
};

/**
 * The person this entry is about, or `undefined` when nobody claims it.
 *
 * `undefined` is the ordinary case rather than a failure: most entries are
 * about a place, an heirloom or a story, and the surfaces keyed off this — the
 * E11-T5 infobox today — simply render nothing for them.
 *
 * ## Why `limit(1)` needs an `order by` to mean anything
 *
 * `individuals.page_id` has no unique index — `lib/link-person-entry.ts`
 * explains why the rule lives in the write path instead, and enforces it there
 * with a row lock. So two people claiming one entry is not reachable through
 * the application, but it is reachable through a manual `UPDATE`, and this
 * read should not become the place that notices by flickering between two
 * names as Postgres changes its mind about scan order. Oldest claim first,
 * with the id as the tie-break, so the same database always answers the same
 * way.
 *
 * @param pageId the entry's `pages.id`
 */
export async function getEntryPerson(
  pageId: string,
): Promise<EntryPerson | undefined> {
  const [person] = await db
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      birthDate: schema.individuals.birthDate,
      birthDateQualifier: schema.individuals.birthDateQualifier,
      birthDatePrecision: schema.individuals.birthDatePrecision,
      birthPlace: schema.individuals.birthPlace,
      deathDate: schema.individuals.deathDate,
      deathDateQualifier: schema.individuals.deathDateQualifier,
      deathDatePrecision: schema.individuals.deathDatePrecision,
      deathPlace: schema.individuals.deathPlace,
    })
    .from(schema.individuals)
    .where(eq(schema.individuals.pageId, pageId))
    .orderBy(asc(schema.individuals.createdAt), asc(schema.individuals.id))
    .limit(1);

  return person;
}
