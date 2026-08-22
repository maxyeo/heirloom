import { asc } from "drizzle-orm";

import { db, schema } from "@/db";

export type GraphPerson = {
  id: string;
  givenName: string;
  surname: string | null;
  sex: "male" | "female" | "other" | "unknown";
  birthDate: string | null;
  deathDate: string | null;
  pageId: string | null;
};

export type GraphUnion = {
  id: string;
  partnerAId: string | null;
  partnerBId: string | null;
  endReason: "ongoing" | "death" | "divorce" | "separation" | "unknown";
  sequence: number;
  startDate: string | null;
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
 * A family tree is small — hundreds of people at most — so the whole graph is
 * loaded at once and laid out client-side. No pagination, no virtualisation.
 */
export async function getFamilyGraph(): Promise<FamilyGraph> {
  const [people, unions, childLinks] = await Promise.all([
    db.select().from(schema.individuals),
    // Sort by sequence first: families often remember that she remarried after
    // he died long after the actual years are lost.
    db
      .select()
      .from(schema.unions)
      .orderBy(asc(schema.unions.sequence), asc(schema.unions.startDate)),
    db.select().from(schema.unionChildren),
  ]);

  return {
    people: people.map((p) => ({
      id: p.id,
      givenName: p.givenName,
      surname: p.surname,
      sex: p.sex,
      birthDate: p.birthDate,
      deathDate: p.deathDate,
      pageId: p.pageId,
    })),
    unions: unions.map((u) => ({
      id: u.id,
      partnerAId: u.partnerAId,
      partnerBId: u.partnerBId,
      endReason: u.endReason,
      sequence: u.sequence,
      startDate: u.startDate,
    })),
    childLinks,
  };
}
