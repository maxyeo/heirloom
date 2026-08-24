import { inArray } from "drizzle-orm";

import { db, schema } from "@/db";
import { getEntryPerson } from "@/lib/entry-person";
import { type FamilyGraph, getFamilyGraph } from "@/lib/family-graph";
import { derivePersonInfobox, type PersonInfobox } from "@/lib/person-infobox";

/**
 * Reading what E11-T5's infobox needs out of the database.
 *
 * The split `lib/family-graph.ts` and `lib/person-detail.ts` already draw: the
 * queries live here, the reasoning lives in `lib/person-infobox.ts`, and
 * nothing that decides what the box *says* is in a module a test would need a
 * database to load (docs/testing.md).
 */

/**
 * The box for an entry, or null when the entry is not about a person.
 *
 * ## Why it starts from `getEntryPerson`
 *
 * E2-T3 (`YEO-26`) already reads `individuals.page_id` backwards to answer
 * "who is this entry about", including the tie-break that keeps the answer
 * stable when two rows claim one entry. Finding the subject in the graph by
 * `pageId` here would be a second reverse lookup with a second opinion about
 * that tie, so this asks the existing one and uses the id it returns.
 *
 * ## Why the whole graph, when the header card deliberately did not
 *
 * `getEntryPerson`'s own docblock argues against loading the graph, and it is
 * right about the card it was written for: that card states one row, so it
 * reads one row. The infobox is the case that changes the answer. It names
 * spouses, children, parents *and* stepchildren — and a stepchild is a child
 * of a union the subject's spouse belongs to, which is two hops out from the
 * subject through the same tables `getFamilyGraph` reads in three queries. A
 * hand-rolled two-hop join would be a second implementation of the walk
 * `derivePersonDetail` already does correctly, for a table that holds a
 * family: hundreds of rows at most (docs/architecture.md), which is the same
 * judgement `/tree` makes on every visit.
 *
 * ## The slugs
 *
 * A person's entry address is `pages.slug`, and `individuals` holds only
 * `page_id`, so one more query turns the ids the graph carries into addresses
 * the box can link to. It asks only about the people the graph holds who have
 * an entry at all, and it answers "what address does this person have" —
 * *not* "does it exist". That second question is `entryLinkProps`'s, and the
 * route puts these slugs through the same `findExistingSlugs` call the article
 * body uses so that one set decides blue or red for both.
 *
 * @param pageId the entry's `pages.id`
 * @returns the box, or null when nobody is linked to this entry
 */
export async function readEntryInfobox(
  pageId: string,
): Promise<PersonInfobox | null> {
  const subject = await getEntryPerson(pageId);
  if (!subject) return null;

  // Deliberately sequential, not a `Promise.all`. Most entries in a family
  // wiki are about a place, an heirloom or a story, and starting the graph
  // read beside this one would load the whole family on every one of them to
  // save a round trip on the few that need it.
  const graph = await getFamilyGraph();

  return derivePersonInfobox(graph, subject.id, await readPageSlugs(graph));
}

/**
 * `pages.id` to `pages.slug`, for the people in this graph who have an entry.
 *
 * Narrowed to the ids actually held rather than reading the whole `pages`
 * table: an entry about a place or an heirloom is nobody's address, and a
 * family wiki has more of those than it has people.
 */
async function readPageSlugs(graph: FamilyGraph): Promise<Map<string, string>> {
  const pageIds = [
    ...new Set(
      graph.people.flatMap((person) =>
        person.pageId === null ? [] : [person.pageId],
      ),
    ),
  ];

  // Nobody in the family has an entry yet, which is the state a new wiki
  // starts in. Every name in the box is a red link, and no query is needed to
  // establish that.
  if (pageIds.length === 0) return new Map();

  const rows = await db
    .select({ id: schema.pages.id, slug: schema.pages.slug })
    .from(schema.pages)
    .where(inArray(schema.pages.id, pageIds));

  return new Map(rows.map((row) => [row.id, row.slug]));
}
