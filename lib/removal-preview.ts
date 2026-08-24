import type {
  FamilyGraph,
  GraphChildLink,
  GraphPerson,
  GraphUnion,
} from "./family-graph";
import type { PersonSummary } from "./person-detail";
import {
  formatLifespan,
  formatPersonName,
  formatQualifiedDate,
} from "./person-format";

/**
 * What disappears when something is removed from the tree (E3-T8, `YEO-36`).
 *
 * ## Why this module exists at all
 *
 * `db/schema.ts` puts `onDelete: "cascade"` on both partner columns of
 * `unions` and on both columns of `union_children`. That is a much bigger
 * blast radius than it looks, and it is the reason this ticket is mostly a
 * *reading* problem rather than a writing one:
 *
 * > Deleting a person deletes **the whole union row** they were a partner in,
 * > not just their slot in it — so the surviving partner loses their recorded
 * > link to every child of that union too.
 *
 * Nobody guesses that from a "Delete" button. There is also no revision
 * history under the tree the way there is under entries (see
 * `lib/save-individual.ts`), so a delete is final. The confirmation copy is
 * therefore the entire safety mechanism, and copy is only as honest as the
 * facts behind it — which is what everything below computes.
 *
 * ## Derived from the database, never guessed
 *
 * Every value here is read out of a `FamilyGraph`, which is `individuals`,
 * `unions` and `union_children` exactly as they are stored. Nothing infers
 * "they probably have children" from a name or a count held somewhere else.
 * The dialogue names the real unions and the real child links, because those
 * rows are what it was handed.
 *
 * The same functions run on both sides of the operation. The browser calls
 * them against the graph the tree is already holding, to render the
 * confirmation; `lib/remove-from-tree.ts` calls them again against a fresh
 * read inside the deleting transaction, so what is reported afterwards is
 * what the database actually did rather than an echo of a preview that may
 * have gone stale in another tab. One function, so the two cannot disagree.
 *
 * ## Why it is pure, and why that is the point
 *
 * Same argument as `lib/person-detail.ts`, which this deliberately mirrors:
 * a plain function over a plain value takes a literal graph in a test and
 * returns something to assert on. Half-siblings, a union with one partner
 * recorded and one unknown, a person married twice, a person who is both
 * somebody's child and somebody's spouse — those are the cases that are easy
 * to get wrong and, here, expensive to get wrong. They are all reachable from
 * `lib/removal-preview.test.ts` with no database and no DOM.
 */

/**
 * A union that a removal takes with it, and everything that hung off it.
 *
 * `children` is the part worth reading twice: those people are **not**
 * deleted, but the row recording who their parents were is, and there is
 * nothing left afterwards to reconstruct it from.
 */
export type UnionRemoval = {
  unionId: string;
  type: GraphUnion["type"];
  /** Already qualified — "about 1946" — or null when no date is held. */
  start: string | null;
  end: string | null;
  /**
   * The partner who is not the person being removed, or null when the union
   * never recorded one. Both partner columns are nullable on purpose (see
   * `db/schema.ts`), so "and the father is unknown" is a real answer here
   * rather than missing data.
   */
  partner: PersonSummary | null;
  /** Children recorded in this union. They survive; the link does not. */
  children: PersonSummary[];
};

/**
 * One `union_children` row that a removal takes with it.
 *
 * Parenthood in this schema runs child → union → partners, never child →
 * parent, so severing a single link always detaches the child from *both*
 * parents at once. There is no shape in the data for "no longer his daughter,
 * still hers", and a confirmation that implied otherwise would be lying.
 */
export type ChildLinkRemoval = {
  unionId: string;
  child: PersonSummary;
  relation: GraphChildLink["relation"];
  /** The parents the link ran to. Empty when the union recorded none. */
  parents: PersonSummary[];
};

/** Deleting a person outright: the destructive one. */
export type PersonRemovalPreview = {
  kind: "person";
  person: PersonSummary;
  /** Unions removed outright by the cascade, with what hung off each. */
  unions: UnionRemoval[];
  /** This person's own place as somebody's child, severed by the cascade. */
  parentLinks: ChildLinkRemoval[];
  /**
   * Whether a wiki entry is linked to this person.
   *
   * The entry is kept either way — `individuals.page_id` is the foreign key
   * and it points *at* `pages`, so there is no cascade in this direction at
   * all, and the `onDelete: "set null"` on it fires only when a page is
   * deleted. This flag exists so the dialogue can say the reassuring half out
   * loud to the people it applies to, rather than leaving everyone to wonder.
   */
  keepsEntry: boolean;
  /**
   * Everyone who loses a recorded relationship and is *not* deleted.
   *
   * The single most useful sentence in the dialogue is "nobody else is
   * deleted", and it is only worth saying beside the list of people it is
   * true of.
   */
  survivors: PersonSummary[];
  /**
   * Unions this person's departure empties, which the delete cleans up.
   *
   * The cascade does not reach these on its own, and that is the point. A
   * union this person was a *partner* in is deleted outright by the foreign
   * key; a union they were merely a *child* of survives, because their link
   * to it is all that goes. So the one left holding nothing is the union with
   * no partners recorded whose only child was this person — the "we know
   * there were children, we do not know the parents" case — and after the
   * cascade it is a row no panel can reach and nobody can ever remove.
   *
   * `lib/remove-from-tree.ts` deletes these in the same transaction. Named in
   * the preview rather than swept later so that the dialogue can say it is
   * about to happen, which is the acceptance criterion's "cleaned up or
   * flagged" answered with both.
   */
  orphanedUnionIds: string[];
};

/**
 * Taking one partner out of a union without deleting anybody: the gentle one.
 *
 * This is a `set null` on their slot rather than a delete of the union, which
 * is the whole reason it is gentler than deleting the person. The union
 * survives holding the other partner and all of the children, so the children
 * keep the parent they still have and keep reading as one family — exactly
 * the "we know the mother, the father is unknown" shape `db/schema.ts` made
 * the partner columns nullable for.
 */
export type PartnerDetachmentPreview = {
  kind: "partner";
  unionId: string;
  type: GraphUnion["type"];
  start: string | null;
  end: string | null;
  /** The partner being detached. Not deleted — only unlinked. */
  person: PersonSummary;
  /** The partner who stays, or null when the union recorded none. */
  partner: PersonSummary | null;
  /** Children who lose `person` as a recorded parent and keep `partner`. */
  children: PersonSummary[];
  /** Whether the union row itself goes, having nothing left to record. */
  removesUnion: boolean;
};

/** Taking one child out of a union: the other gentle one. */
export type ChildDetachmentPreview = {
  kind: "child";
  unionId: string;
  child: PersonSummary;
  relation: GraphChildLink["relation"];
  /** The parents this child stops being recorded as belonging to. */
  parents: PersonSummary[];
  /** Whether the union row itself goes, having nothing left to record. */
  removesUnion: boolean;
};

export type RemovalPreview =
  PersonRemovalPreview | PartnerDetachmentPreview | ChildDetachmentPreview;

/**
 * Whether a union has stopped recording anything at all, and should go with
 * the operation that emptied it.
 *
 * True only when **nothing is attached**: no partners and no children. That
 * is the acceptance criterion word for word ("both partners gone, no
 * children"), and the reason to hold to it exactly is that such a row is
 * *unreachable*. Every other union in the database is listed on the panel of
 * somebody who is in it, so a person who thinks it is junk can remove it
 * themselves. A union with nobody in it appears on no panel, can never be
 * selected, and would sit in the table forever.
 *
 * ## Why a lone remaining partner is not enough
 *
 * It is tempting to sweep the union left holding one partner and no children,
 * on the grounds that it states nothing useful — and an earlier draft of this
 * function did. That is wrong, and dangerously so, because of *who* the lone
 * partner is at each of the three call sites:
 *
 * - detaching a partner: the survivor is the subject's own ex-partner;
 * - detaching a **child**: the survivor is an untouched third party;
 * - deleting a person: likewise.
 *
 * In the last two the author said nothing whatsoever about that person, and
 * `unions` carries more than a pair of ids — a start date, an end date, an
 * end reason, a type, notes. Taking all of it away as a side effect of
 * removing somebody else, with no revision history under the tree to restore
 * it from, is the exact class of surprise this whole ticket exists to
 * prevent. "Known mother, unknown father" (`db/schema.ts`) is a shape the
 * model deliberately supports, so a union holding one real partner is a
 * record, not debris.
 *
 * The rule is therefore the same at all three sites rather than tuned per
 * caller. One predicate is one thing to reason about, and it keeps the
 * dialogue's sentence — "left with nobody in it, no partners and no children"
 * — true wherever it appears.
 *
 * **This is only ever asked about a union an operation has just emptied.**
 * There is no sweep over the table. Rows that were already like this — from a
 * seed script, or from E6-T2's import — are left exactly where they are.
 *
 * @param partnerIds the union's two partner columns *after* the operation
 * @param childCount how many children remain in the union afterwards
 */
export function isUnionOrphaned(
  partnerIds: readonly (string | null)[],
  childCount: number,
): boolean {
  if (childCount > 0) return false;
  return partnerIds.every((id) => id === null);
}

/**
 * Everything deleting a person destroys.
 *
 * Returns null for an id the graph does not hold — which is an ordinary case
 * rather than a defensive one, since the same id may have been deleted in
 * another tab between the panel opening and the button being pressed.
 */
export function previewPersonRemoval(
  graph: FamilyGraph,
  personId: string,
): PersonRemovalPreview | null {
  const index = indexGraph(graph);
  const person = index.byId.get(personId);
  if (!person) return null;

  /**
   * Every union this person is a partner in, in the order the panel lists
   * them. All of them go: the foreign key cascades from `individuals` to the
   * whole `unions` row, so there is no such thing as being removed from a
   * union by deleting yourself.
   */
  const unions: UnionRemoval[] = index
    .unionsOfPartner(personId)
    .map((union) => ({
      unionId: union.id,
      type: union.type,
      start: formatQualifiedDate(union.startDate, union.startDateQualifier),
      end: formatQualifiedDate(union.endDate, union.endDateQualifier),
      partner: index.summarise(otherPartnerId(union, personId)),
      children: index
        .childrenOf(union.id)
        .map((link) => index.summarise(link.childId))
        .filter(isPresent),
    }));

  // The same edge walked from the other end: rows where this person is the
  // child rather than a partner. Those cascade too, but the union they point
  // at survives — the person was never a partner in it.
  const parentLinks: ChildLinkRemoval[] = index
    .unionsOfChild(personId)
    .map((link) => ({
      unionId: link.unionId,
      child: toSummary(person),
      relation: link.relation,
      parents: index.partnersOf(link.unionId, personId),
    }));

  return {
    kind: "person",
    person: toSummary(person),
    unions,
    parentLinks,
    keepsEntry: person.pageId !== null,
    /**
     * Only the unions they were a child of can be left behind at all — the
     * ones they partnered in go with them, row and all. For each, ask the
     * same question a detach asks: with this link gone, does the union still
     * record anything?
     */
    orphanedUnionIds: parentLinks.flatMap((link) => {
      const union = index.unionById.get(link.unionId);
      if (!union) return [];
      // Already going, entirely, by cascade. Nothing left to clean up.
      if (union.partnerAId === personId || union.partnerBId === personId) {
        return [];
      }

      const remaining = index
        .childrenOf(link.unionId)
        .filter((child) => child.childId !== personId).length;

      return isUnionOrphaned([union.partnerAId, union.partnerBId], remaining)
        ? [link.unionId]
        : [];
    }),
    survivors: dedupe([
      ...unions.flatMap((union) => [
        ...(union.partner ? [union.partner] : []),
        ...union.children,
      ]),
      ...parentLinks.flatMap((link) => link.parents),
    ]).filter((summary) => summary.id !== personId),
  };
}

/**
 * Everything taking one partner out of a union costs.
 *
 * Returns null when the union is not in the graph, or when this person is not
 * a partner in it — the second being the same "somebody POSTed at it
 * directly" case `updateIndividual` folds into `not-found`.
 */
export function previewPartnerDetachment(
  graph: FamilyGraph,
  unionId: string,
  personId: string,
): PartnerDetachmentPreview | null {
  const index = indexGraph(graph);
  const union = index.unionById.get(unionId);
  const person = index.byId.get(personId);
  if (!union || !person) return null;
  if (union.partnerAId !== personId && union.partnerBId !== personId) {
    return null;
  }

  const children = index
    .childrenOf(unionId)
    .map((link) => index.summarise(link.childId))
    .filter(isPresent);

  return {
    kind: "partner",
    unionId,
    type: union.type,
    start: formatQualifiedDate(union.startDate, union.startDateQualifier),
    end: formatQualifiedDate(union.endDate, union.endDateQualifier),
    person: toSummary(person),
    partner: index.summarise(otherPartnerId(union, personId)),
    children,
    /**
     * The hypothetical union, built exactly the way the write builds it —
     * both slots re-stated with this person's removed — so the preview and
     * `lib/remove-from-tree.ts` cannot come to different conclusions about
     * whether the row survives. Restating both also covers the malformed row
     * that lists one person as both partners.
     */
    removesUnion: isUnionOrphaned(
      [
        union.partnerAId === personId ? null : union.partnerAId,
        union.partnerBId === personId ? null : union.partnerBId,
      ],
      children.length,
    ),
  };
}

/**
 * Everything taking one child out of a union costs.
 *
 * Returns null when there is no such link, which covers a union that is not
 * in the graph, a child who is not in it, and the pair simply not being
 * related.
 */
export function previewChildDetachment(
  graph: FamilyGraph,
  unionId: string,
  childId: string,
): ChildDetachmentPreview | null {
  const index = indexGraph(graph);
  const union = index.unionById.get(unionId);
  const child = index.byId.get(childId);
  if (!union || !child) return null;

  const link = index
    .childrenOf(unionId)
    .find((candidate) => candidate.childId === childId);
  if (!link) return null;

  return {
    kind: "child",
    unionId,
    child: toSummary(child),
    relation: link.relation,
    parents: index.partnersOf(unionId, childId),
    removesUnion: isUnionOrphaned(
      [union.partnerAId, union.partnerBId],
      index.childrenOf(unionId).length - 1,
    ),
  };
}

/** The partner of `union` who is not `personId`, which may be nobody. */
function otherPartnerId(union: GraphUnion, personId: string): string | null {
  return union.partnerAId === personId ? union.partnerBId : union.partnerAId;
}

function toSummary(person: GraphPerson): PersonSummary {
  return {
    id: person.id,
    name: formatPersonName(person.givenName, person.surname),
    lifespan: formatLifespan(person.birthDate, person.deathDate),
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Keep the first mention of each person.
 *
 * Somebody can be reached twice — a co-parent in two of the same person's
 * unions, or a child who is also a partner — and a confirmation that named
 * them twice would read as though there were two of them.
 */
function dedupe(people: PersonSummary[]): PersonSummary[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
}

/**
 * One pass over the graph, shared by all three previews.
 *
 * The lookups below are each asked for more than once per preview and the
 * graph is a plain array, so indexing first is what keeps this linear rather
 * than quadratic. It is the same shape `derivePersonDetail` builds; it is not
 * shared with that function because the two want different slices and a
 * common "index" abstraction over both would be a third thing to keep true.
 */
function indexGraph(graph: FamilyGraph) {
  const byId = new Map(graph.people.map((person) => [person.id, person]));
  const unionById = new Map(graph.unions.map((union) => [union.id, union]));

  const childrenByUnion = new Map<string, GraphChildLink[]>();
  const unionsByChild = new Map<string, GraphChildLink[]>();
  for (const link of graph.childLinks) {
    appendTo(childrenByUnion, link.unionId, link);
    appendTo(unionsByChild, link.childId, link);
  }

  const summarise = (id: string | null): PersonSummary | null => {
    if (id === null) return null;
    const person = byId.get(id);
    return person ? toSummary(person) : null;
  };

  return {
    byId,
    unionById,
    summarise,
    childrenOf: (unionId: string): GraphChildLink[] =>
      childrenByUnion.get(unionId) ?? [],
    unionsOfChild: (childId: string): GraphChildLink[] =>
      unionsByChild.get(childId) ?? [],
    unionsOfPartner: (personId: string): GraphUnion[] =>
      graph.unions.filter(
        (union) =>
          union.partnerAId === personId || union.partnerBId === personId,
      ),
    /** Both partners of a union, minus one person, minus the unrecorded ones. */
    partnersOf: (unionId: string, exclude: string): PersonSummary[] => {
      const union = unionById.get(unionId);
      if (!union) return [];
      return [union.partnerAId, union.partnerBId]
        .filter((id) => id !== exclude)
        .map(summarise)
        .filter(isPresent);
    },
  };
}

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
