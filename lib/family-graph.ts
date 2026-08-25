import { asc } from "drizzle-orm";

import { db, schema } from "@/db";

/**
 * Mirrors the `date_qualifier` enum in `db/schema.ts`. Declared here as a
 * plain union rather than derived from the Drizzle table so that client
 * components can `import type` it without pulling the schema — and with it
 * postgres.js — into the browser bundle.
 */
export type DateQualifier = "exact" | "about" | "before" | "after";

/**
 * Mirrors the `date_precision` enum in `db/schema.ts` (E4-T2, `YEO-39`),
 * declared here for the same reason `DateQualifier` above is.
 *
 * Read together with the date and the qualifier, always. A year-only date is
 * stored on the first of January with `year` here beside it, so a reader that
 * takes the day and ignores this one is reading a birthday nobody typed.
 */
export type DatePrecision = "day" | "month" | "year";

export type GraphPerson = {
  id: string;
  givenName: string;
  surname: string | null;
  sex: "male" | "female" | "other" | "unknown";
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  birthDatePrecision: DatePrecision;
  birthDateUpper: string | null;
  birthDateUpperPrecision: DatePrecision;
  birthPlace: string | null;
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
  deathDatePrecision: DatePrecision;
  deathDateUpper: string | null;
  deathDateUpperPrecision: DatePrecision;
  deathPlace: string | null;
  notes: string | null;
  pageId: string | null;
};

/**
 * `endDate` used to be absent here, on the grounds that the tree draws a union
 * by its start and nothing client-side read the end. The detail panel (E2-T1)
 * is the view that changed that: it lists a person's spouses, and a marriage
 * is a span rather than a moment — "1912–1938, divorced" is most of what the
 * row has to say. It arrives with its qualifier, as that earlier note said it
 * should, because a date and its `date_qualifier` sibling are only ever
 * meaningful as a pair.
 *
 * `type` comes along for the same reason: the panel has to head the row with
 * a word, and "Marriage" and "Partnership" are recorded facts rather than a
 * choice this component gets to make.
 */
export type GraphUnion = {
  id: string;
  partnerAId: string | null;
  partnerBId: string | null;
  type: "marriage" | "partnership" | "unknown";
  endReason: "ongoing" | "death" | "divorce" | "separation" | "unknown";
  sequence: number;
  startDate: string | null;
  startDateQualifier: DateQualifier;
  startDatePrecision: DatePrecision;
  startDateUpper: string | null;
  startDateUpperPrecision: DatePrecision;
  endDate: string | null;
  endDateQualifier: DateQualifier;
  endDatePrecision: DatePrecision;
  endDateUpper: string | null;
  endDateUpperPrecision: DatePrecision;
};

export type GraphChildLink = {
  unionId: string;
  childId: string;
  relation: "biological" | "adopted" | "step" | "foster";
};

export type FamilyGraph = {
  people: GraphPerson[];
  unions: GraphUnion[];
  childLinks: GraphChildLink[];
};

/**
 * Whatever can run the three selects below: the connection pool, or a
 * transaction on it.
 *
 * Narrowed to `select` on purpose. `lib/remove-from-tree.ts` (E3-T8) reads
 * the graph *inside* the transaction that then deletes from it, so that what
 * the confirmation reports afterwards describes the same rows the delete
 * actually saw. Passing the transaction in is all that takes — and typing the
 * parameter as "something that can select" rather than as a whole database
 * leaves this function unable to write, whichever of the two it is given.
 */
export type GraphReader = Pick<typeof db, "select">;

/**
 * A family tree is small — hundreds of people at most — so the whole graph is
 * loaded at once and laid out client-side. No pagination, no virtualisation.
 *
 * @param reader the pool by default; a transaction when the caller has one
 */
export async function getFamilyGraph(
  reader: GraphReader = db,
): Promise<FamilyGraph> {
  const [people, unions, childLinks] = await Promise.all([
    reader.select().from(schema.individuals),
    // Sort by sequence first: families often remember that she remarried after
    // he died long after the actual years are lost.
    reader
      .select()
      .from(schema.unions)
      .orderBy(asc(schema.unions.sequence), asc(schema.unions.startDate)),
    reader.select().from(schema.unionChildren),
  ]);

  return {
    people: people.map((p) => ({
      id: p.id,
      givenName: p.givenName,
      surname: p.surname,
      sex: p.sex,
      birthDate: p.birthDate,
      birthDateQualifier: p.birthDateQualifier,
      birthDatePrecision: p.birthDatePrecision,
      birthDateUpper: p.birthDateUpper,
      birthDateUpperPrecision: p.birthDateUpperPrecision,
      birthPlace: p.birthPlace,
      deathDate: p.deathDate,
      deathDateQualifier: p.deathDateQualifier,
      deathDatePrecision: p.deathDatePrecision,
      deathDateUpper: p.deathDateUpper,
      deathDateUpperPrecision: p.deathDateUpperPrecision,
      deathPlace: p.deathPlace,
      notes: p.notes,
      pageId: p.pageId,
    })),
    unions: unions.map((u) => ({
      id: u.id,
      partnerAId: u.partnerAId,
      partnerBId: u.partnerBId,
      type: u.type,
      endReason: u.endReason,
      sequence: u.sequence,
      startDate: u.startDate,
      startDateQualifier: u.startDateQualifier,
      startDatePrecision: u.startDatePrecision,
      startDateUpper: u.startDateUpper,
      startDateUpperPrecision: u.startDateUpperPrecision,
      endDate: u.endDate,
      endDateQualifier: u.endDateQualifier,
      endDatePrecision: u.endDatePrecision,
      endDateUpper: u.endDateUpper,
      endDateUpperPrecision: u.endDateUpperPrecision,
    })),
    childLinks,
  };
}
