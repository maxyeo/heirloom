import type {
  FamilyGraph,
  GraphChildLink,
  GraphPerson,
  GraphUnion,
} from "./family-graph";
import {
  formatLifespan,
  formatPersonName,
  formatQualifiedDate,
} from "./person-format";

/**
 * Everything the detail panel (E2-T1) shows about one person, derived from the
 * graph the tree is already holding.
 *
 * ## Derived, never stored
 *
 * "Spouse", "child" and "parent" are not columns anywhere. The schema records
 * two facts — who partnered with whom (`unions`) and who was born into which
 * union (`union_children`) — and every label below is read back out of those.
 * That is the property docs/architecture.md rests the whole data model on, and
 * this module is where it is cashed in: a spouse is the *other* partner of a
 * union you belong to, a child is a member of one of those unions, and a
 * parent is found by walking the same edge backwards. Nothing here would
 * survive a `parent_id` column, and nothing here needs one.
 *
 * ## Why it is a plain function over a plain value
 *
 * `lib/tree-layout.ts` is the model docs/testing.md points at: take a
 * `FamilyGraph`, return a value, and a test hands it a literal. The same
 * applies here, and it matters more — half-siblings, a partner nobody
 * recorded, and a person married twice are exactly the cases that are hard to
 * get right and trivial to assert on. The panel component then renders a value
 * it did no reasoning to produce.
 *
 * The graph is already in the browser for the layout, so this costs one pass
 * over it and no request. That is only true because the graph is small — a
 * family tree is hundreds of people at most (docs/architecture.md).
 */

/** A person as they appear in someone *else's* panel: enough to link to. */
export type PersonSummary = {
  id: string;
  name: string;
  /** Years only — this is a label beside a link, not a record. */
  lifespan: string;
};

/** A birth or a death: whichever of the date and the place is recorded. */
export type LifeEvent = {
  /** Already qualified — "about 12 March 1890" — or null if no date is held. */
  date: string | null;
  place: string | null;
};

/**
 * One union this person belongs to, seen from their side of it.
 *
 * `person` is nullable because both partner columns are: "we know the mother,
 * the father is unknown" is common enough in older generations that the model
 * refuses to make you invent a placeholder for it, and the panel has to be
 * able to say so rather than drop the union.
 */
export type SpouseLink = {
  unionId: string;
  person: PersonSummary | null;
  type: GraphUnion["type"];
  endReason: GraphUnion["endReason"];
  start: string | null;
  end: string | null;
};

/**
 * A child, carrying the union they arrived through.
 *
 * `otherParent` is what makes half-siblings legible: eight children by Walter
 * and two by Thomas is a different family from ten children, and the only
 * thing that distinguishes them is which union each child belongs to.
 */
export type ChildLink = {
  person: PersonSummary;
  relation: GraphChildLink["relation"];
  unionId: string;
  otherParent: PersonSummary | null;
};

/**
 * A parent, carrying the relation recorded on the child↔union link.
 *
 * Adoption is an attribute of that link rather than a different shape, so it
 * surfaces here identically to how it surfaces on the child list — read from
 * the same row, just from the other end.
 */
export type ParentLink = {
  person: PersonSummary;
  relation: GraphChildLink["relation"];
  unionId: string;
};

export type PersonDetail = {
  id: string;
  name: string;
  lifespan: string;
  sex: GraphPerson["sex"];
  /** Null when neither a date nor a place is recorded — the panel omits the row. */
  birth: LifeEvent | null;
  death: LifeEvent | null;
  notes: string | null;
  pageId: string | null;
  spouses: SpouseLink[];
  children: ChildLink[];
  parents: ParentLink[];
};

/**
 * Read one person's full record out of the graph.
 *
 * Returns null for an id the graph does not hold, which is a real case rather
 * than a defensive one: E2-T4 will open the panel from `?person=<id>` in the
 * URL, where the id is whatever was pasted into the address bar.
 */
export function derivePersonDetail(
  graph: FamilyGraph,
  personId: string,
): PersonDetail | null {
  const byId = new Map(graph.people.map((person) => [person.id, person]));
  const person = byId.get(personId);
  if (!person) return null;

  const summary = (id: string | null): PersonSummary | null => {
    if (!id) return null;
    const found = byId.get(id);
    return found ? toSummary(found) : null;
  };

  // Indexed once rather than filtered per union: still linear over a graph
  // this size, but it keeps the two walks below symmetrical — one map is
  // "children of this union", the other is "unions this person was born into",
  // and they are the same rows read from opposite ends.
  const childrenOfUnion = new Map<string, GraphChildLink[]>();
  const unionsOfChild = new Map<string, GraphChildLink[]>();
  for (const link of graph.childLinks) {
    appendTo(childrenOfUnion, link.unionId, link);
    appendTo(unionsOfChild, link.childId, link);
  }

  const unionById = new Map(graph.unions.map((union) => [union.id, union]));

  // Sorted here rather than trusted from the query, so that the panel orders a
  // life the same way whoever built the `FamilyGraph` did or did not.
  const ownUnions = graph.unions
    .filter(
      (union) => union.partnerAId === personId || union.partnerBId === personId,
    )
    .sort(compareUnions);

  const spouses: SpouseLink[] = ownUnions.map((union) => ({
    unionId: union.id,
    person: summary(
      union.partnerAId === personId ? union.partnerBId : union.partnerAId,
    ),
    type: union.type,
    endReason: union.endReason,
    start: formatQualifiedDate(union.startDate, union.startDateQualifier),
    end: formatQualifiedDate(union.endDate, union.endDateQualifier),
  }));

  // Grouped by union and in the same order as the spouse list above, which is
  // what lets the panel show half-siblings as the separate families they are.
  const children: ChildLink[] = ownUnions.flatMap((union) => {
    const otherParent = summary(
      union.partnerAId === personId ? union.partnerBId : union.partnerAId,
    );

    return (childrenOfUnion.get(union.id) ?? [])
      .flatMap((link) => {
        const child = byId.get(link.childId);
        return child ? [{ child, link }] : [];
      })
      .sort((a, b) => compareByBirth(a.child, b.child))
      .map(({ child, link }) => ({
        person: toSummary(child),
        relation: link.relation,
        unionId: union.id,
        otherParent,
      }));
  });

  // The same edge, walked back. A person can be a child of more than one union
  // — an adoption recorded alongside a birth — so this is a list, not a pair.
  const parents: ParentLink[] = (unionsOfChild.get(personId) ?? [])
    .flatMap((link) => {
      const union = unionById.get(link.unionId);
      return union ? [{ union, link }] : [];
    })
    .sort((a, b) => compareUnions(a.union, b.union))
    .flatMap(({ union, link }) =>
      [union.partnerAId, union.partnerBId]
        .map(summary)
        .filter((parent): parent is PersonSummary => parent !== null)
        .map((parent) => ({
          person: parent,
          relation: link.relation,
          unionId: union.id,
        })),
    );

  return {
    id: person.id,
    name: formatPersonName(person.givenName, person.surname),
    lifespan: formatLifespan(person.birthDate, person.deathDate),
    sex: person.sex,
    birth: toLifeEvent(
      formatQualifiedDate(person.birthDate, person.birthDateQualifier),
      person.birthPlace,
    ),
    death: toLifeEvent(
      formatQualifiedDate(person.deathDate, person.deathDateQualifier),
      person.deathPlace,
    ),
    notes: person.notes,
    pageId: person.pageId,
    spouses,
    children,
    parents,
  };
}

function toSummary(person: GraphPerson): PersonSummary {
  return {
    id: person.id,
    name: formatPersonName(person.givenName, person.surname),
    lifespan: formatLifespan(person.birthDate, person.deathDate),
  };
}

function toLifeEvent(
  date: string | null,
  place: string | null,
): LifeEvent | null {
  return date === null && place === null ? null : { date, place };
}

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * `sequence` first, `start_date` second — the ordering rule the schema states
 * and `getFamilyGraph` queries by. In older generations the exact year of a
 * marriage is often lost while the *order* is remembered perfectly well ("she
 * remarried after he died"), so sorting on dates alone would scramble the
 * story every time a year is missing. Ties break on id so the list is stable
 * rather than dependent on how the rows happened to arrive.
 */
function compareUnions(a: GraphUnion, b: GraphUnion): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  const byDate = compareNullableDates(a.startDate, b.startDate);
  return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
}

/** Siblings read as a family in birth order; the undated ones follow. */
function compareByBirth(a: GraphPerson, b: GraphPerson): number {
  const byDate = compareNullableDates(a.birthDate, b.birthDate);
  if (byDate !== 0) return byDate;
  const byName = formatPersonName(a.givenName, a.surname).localeCompare(
    formatPersonName(b.givenName, b.surname),
  );
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * ISO dates compare correctly as strings, and a missing date sorts last.
 * Sorting nulls first would put every undated child above the ones whose
 * birthday is known, which reads as a claim about the order rather than as
 * the absence of one.
 */
function compareNullableDates(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
