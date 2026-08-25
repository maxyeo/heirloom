import type { ChildRelation } from "./child-input";
import type { FamilyGraph, GraphChildLink, GraphUnion } from "./family-graph";
import { formatQualifiedDate, unionEnd, unionStart } from "./format-date";
import { personSummary, type PersonSummary } from "./person-detail";

/**
 * Two unions between the same two people, and what merging them costs
 * (E3-T10, `YEO-82`).
 *
 * ## Why duplicates exist at all
 *
 * `lib/set-parents.ts` can create a family inline: naming two people as
 * somebody's parents when they have never been recorded as a couple writes a
 * `unions` row of type `unknown`, because what the author has said is that
 * these two are somebody's parents and nothing whatsoever about their
 * relationship. Nothing stopped that landing beside a marriage the same two
 * people already had, so the tree ended up holding the marriage *and* a bare
 * second row, with the children split between them.
 *
 * ## Why this cannot be a uniqueness constraint
 *
 * Because two unions between the same pair is not evidence of a mistake.
 * Couples who divorced and remarried each other are ordinary genealogy, and
 * `lib/save-union.ts` says so out loud as the reason it has never checked for
 * duplicates. A unique index on the two partner columns would make that case
 * unrecordable, which is a worse bug than the one it fixes.
 *
 * So the duplicate is a *prompt*, not a refusal: the set-parents flow asks
 * "these two already have a family — did you mean that one?" and takes yes for
 * an answer either way. What this module supplies is the two halves that
 * question needs — finding the existing families, and saying exactly what
 * merging two of them would do.
 *
 * ## Why it is pure
 *
 * The same argument `lib/removal-preview.ts` makes, and the same shape: a
 * plain function over a `FamilyGraph` takes a literal in a test and returns
 * something to assert on. It also means the two sides of the operation run the
 * *same* function — the browser calls it against the graph the canvas already
 * holds, to render the confirmation, and `lib/merge-unions.ts` calls it again
 * against a fresh read inside the merging transaction, so what is reported
 * afterwards describes the rows the write actually saw.
 */

/**
 * The two people a union records, when it records two.
 *
 * A union with a `null` partner column is deliberately not a couple here, and
 * that exclusion is the load-bearing one in this file. Both columns are
 * nullable so that "we know the mother, the father is unknown" needs no
 * placeholder person (`db/schema.ts`) — which means two rows that each record
 * Rose and an unrecorded partner are not evidence of anything at all. They may
 * be Rose's two children by two different men nobody can name, and merging
 * them would assert that those men were one man.
 *
 * "The same two people" therefore means two named people, both times.
 *
 * @returns the pair, or null when the union does not name two people
 */
export function couplePartnerIds(
  union: GraphUnion,
): readonly [string, string] | null {
  const { partnerAId, partnerBId } = union;
  if (partnerAId === null || partnerBId === null) return null;
  // A malformed row naming one person in both slots is not a couple either.
  if (partnerAId === partnerBId) return null;
  return [partnerAId, partnerBId];
}

/** Whether two unions record the same two named people, in either order. */
export function sameCouple(a: GraphUnion, b: GraphUnion): boolean {
  const left = couplePartnerIds(a);
  const right = couplePartnerIds(b);
  if (left === null || right === null) return false;
  return left.includes(right[0]) && left.includes(right[1]);
}

/**
 * Every union recording exactly this pair of people.
 *
 * The set-parents flow's question, asked before it writes: two people are
 * about to be recorded as somebody's parents, and this is what the tree
 * already holds for them. Ordinarily nothing; occasionally one family the
 * author should be offered instead of a second; and legitimately more than
 * one, for a couple who married twice.
 *
 * Returned in the graph's own order, which `getFamilyGraph` has already sorted
 * by `sequence` and then `start_date` — so a list of a couple's families reads
 * in the order they happened.
 *
 * @param unions every union on the tree
 * @param aId one of the two people
 * @param bId the other, which must be somebody else
 */
export function findUnionsBetween(
  unions: readonly GraphUnion[],
  aId: string,
  bId: string,
): GraphUnion[] {
  if (aId === bId) return [];
  return unions.filter((union) => {
    const pair = couplePartnerIds(union);
    return pair !== null && pair.includes(aId) && pair.includes(bId);
  });
}

/** Two or more families recorded between one person and one other person. */
export type DuplicateUnionGroup = {
  /** The person whose panel this was read for. */
  personId: string;
  /** The partner they share all of these families with. */
  partner: PersonSummary;
  /** The families themselves, in the order the tree lists them. */
  unions: GraphUnion[];
};

/**
 * The duplicate families on one person's panel, if there are any.
 *
 * Grouped by the *other* partner rather than listed flat, because that is the
 * question the author is answering: not "which of these eleven unions", but
 * "you and Beth are recorded as a family twice — is that a remarriage, or is
 * one of them a duplicate?".
 *
 * Deliberately silent for everybody else. Most people have one union or none,
 * and a panel that headed a section "Duplicate families" over an empty list
 * would be inventing a problem to look at.
 */
export function duplicateUnionGroups(
  graph: FamilyGraph,
  personId: string,
): DuplicateUnionGroup[] {
  const byPartner = new Map<string, GraphUnion[]>();

  for (const union of graph.unions) {
    const pair = couplePartnerIds(union);
    if (pair === null || !pair.includes(personId)) continue;

    const partnerId = pair[0] === personId ? pair[1] : pair[0];
    const existing = byPartner.get(partnerId);
    if (existing) existing.push(union);
    else byPartner.set(partnerId, [union]);
  }

  const groups: DuplicateUnionGroup[] = [];
  for (const [partnerId, unions] of byPartner) {
    if (unions.length < 2) continue;
    const person = graph.people.find((candidate) => candidate.id === partnerId);
    // The partner column points at somebody the graph did not hand us, which
    // a foreign key rules out — but the graph is a plain value here, and a
    // group nobody can be named in is not a question worth asking.
    if (person === undefined) continue;
    groups.push({
      personId,
      partner: personSummary(person),
      unions,
    });
  }

  return groups;
}

/** One union's recorded facts, already in words. */
export type UnionFacts = {
  unionId: string;
  type: GraphUnion["type"];
  /** Already qualified — "about 1946" — or null when no date is held. */
  start: string | null;
  end: string | null;
  endReason: GraphUnion["endReason"];
};

/**
 * One recorded fact that the union being merged away holds and the surviving
 * one will not.
 *
 * `notes` is not among the fields, on purpose: nothing recorded there is
 * dropped by a merge, so there is no choice to present. See `joinNotes`.
 *
 * This is the whole of the acceptance criterion's "choosing which `type` /
 * `endReason` / dates survive", and it is answered by *which union is kept*
 * rather than field by field. Two reasons. The first is that a per-field
 * picker can assemble a union neither source ever recorded — a marriage date
 * from one row and an end reason from the other — which is an assertion nobody
 * made, in a table with no revision history to walk back. The second is that
 * this dialogue's premise is that one of these two rows is the *duplicate*: the
 * useful question is which row is real, and the answer to that settles every
 * field at once.
 *
 * What makes that honest rather than merely simple is this list. Every value
 * the losing row holds and the winning row does not is named in the
 * confirmation before anything is written, so an author who is about to lose
 * the marriage date sees it and turns the merge around.
 */
export type UnionFactLoss =
  | {
      field: "type";
      /** The value about to go. Never absent — an absence is not a loss. */
      losing: GraphUnion["type"];
      /** What the survivor records instead, or null when it records nothing. */
      keeping: GraphUnion["type"] | null;
    }
  | {
      field: "endReason";
      losing: GraphUnion["endReason"];
      keeping: GraphUnion["endReason"] | null;
    }
  | {
      /** A date, already qualified and formatted by `lib/format-date.ts`. */
      field: "start" | "end";
      losing: string;
      keeping: string | null;
    };

/** A child recorded in both unions, and the two relations recorded for them. */
export type SharedChild = {
  child: PersonSummary;
  /** The relation on the surviving union's link, which is the one that stands. */
  keptRelation: ChildRelation;
  /** The relation on the link being merged away. */
  mergedRelation: ChildRelation;
};

/** A child whose link moves across to the surviving union. */
export type MovingChild = {
  child: PersonSummary;
  relation: ChildRelation;
};

/** Exactly what merging one union into another does. */
export type UnionMergePreview = {
  /** The two people both unions record, in the surviving union's own order. */
  partners: PersonSummary[];
  /** The union that survives, and everything it goes on recording. */
  kept: UnionFacts;
  /** The union that goes. */
  merged: UnionFacts;
  /** Children who move across. Their links are rewritten, not recreated. */
  moving: MovingChild[];
  /**
   * Children already recorded in both. One link is enough, so the surviving
   * union's is left exactly as it is and the duplicate goes with its union.
   */
  shared: SharedChild[];
  /** Recorded values on the union being merged away that will not survive. */
  losses: UnionFactLoss[];
  /**
   * The `sequence` the surviving union takes: the earlier of the two.
   *
   * The two rows describe one family, so its place in each partner's order is
   * the earlier of the two claims about it — anything else would let a
   * duplicate created *today* (numbered one past everything by `nextSequence`)
   * drag a marriage from 1946 below a remarriage from 1972.
   */
  sequence: number;
  /** Whether that moves the surviving union at all. */
  resequences: boolean;
};

/**
 * Everything merging `mergeUnionId` into `keepUnionId` changes.
 *
 * Returns null when there is nothing to describe: either union missing from
 * the graph, the same union named twice, or two unions that do not record the
 * same two named people. All three are ordinary rather than defensive — the
 * first is a panel left open in one tab while E3-T8 deleted a family in
 * another, and the last is the guard that keeps this operation from quietly
 * reassigning somebody's children to a couple they were never recorded under.
 *
 * @param graph the tree, as the canvas holds it or as the transaction read it
 * @param keepUnionId the family that survives
 * @param mergeUnionId the family whose children and place move into it
 */
export function previewUnionMerge(
  graph: FamilyGraph,
  keepUnionId: string,
  mergeUnionId: string,
): UnionMergePreview | null {
  if (keepUnionId === mergeUnionId) return null;

  const keep = graph.unions.find((union) => union.id === keepUnionId);
  const merge = graph.unions.find((union) => union.id === mergeUnionId);
  if (keep === undefined || merge === undefined) return null;
  if (!sameCouple(keep, merge)) return null;

  const people = new Map(graph.people.map((person) => [person.id, person]));
  const summarise = (id: string): PersonSummary | null => {
    const person = people.get(id);
    return person === undefined ? null : personSummary(person);
  };

  const childrenOf = (unionId: string): GraphChildLink[] =>
    graph.childLinks.filter((link) => link.unionId === unionId);

  const keptRelations = new Map(
    childrenOf(keepUnionId).map((link) => [link.childId, link.relation]),
  );

  const moving: MovingChild[] = [];
  const shared: SharedChild[] = [];

  for (const link of childrenOf(mergeUnionId)) {
    const child = summarise(link.childId);
    // A child link pointing at nobody is impossible under the foreign key and
    // meaningless in a literal graph; either way there is no sentence to write
    // about them, and the write moves the row regardless.
    if (child === null) continue;

    const keptRelation = keptRelations.get(link.childId);
    if (keptRelation === undefined) {
      moving.push({ child, relation: link.relation });
    } else {
      shared.push({ child, keptRelation, mergedRelation: link.relation });
    }
  }

  const sequence = Math.min(keep.sequence, merge.sequence);

  return {
    partners: [keep.partnerAId, keep.partnerBId]
      .filter((id): id is string => id !== null)
      .map(summarise)
      .filter((summary): summary is PersonSummary => summary !== null),
    kept: unionFacts(keep),
    merged: unionFacts(merge),
    moving,
    shared,
    losses: factLosses(keep, merge),
    sequence,
    resequences: sequence !== keep.sequence,
  };
}

/** One union's facts, formatted the way every other surface formats them. */
export function unionFacts(union: GraphUnion): UnionFacts {
  return {
    unionId: union.id,
    type: union.type,
    start: formatQualifiedDate(unionStart(union)),
    end: formatQualifiedDate(unionEnd(union)),
    endReason: union.endReason,
  };
}

/**
 * How one family reads in a list of families: "Marriage, 1946 – 1970".
 *
 * Assembled from the parts that are actually recorded rather than from a
 * template with gaps in it — the rule `familyLabel` in `lib/parent-options.ts`
 * and `describeUnion` in `components/PersonPanel.tsx` both follow. A union with
 * no dates still has a type, and "Marriage" is a true phrase where
 * "Marriage, – " is not.
 *
 * Here rather than in either component because both of this ticket's surfaces
 * need it — the duplicate prompt in the set-parents form has to say which
 * family it found, and the merge dialogue has to say which one it is keeping —
 * and two copies is two places for them to start describing the same row
 * differently.
 *
 * The people are deliberately not in it. Every caller already has the couple in
 * hand and has just named them; repeating them per row would bury the only
 * thing that tells two of a couple's families apart.
 */
export function describeUnionFacts(facts: UnionFacts): string {
  const span =
    facts.start && facts.end
      ? `${facts.start} – ${facts.end}`
      : facts.start
        ? `from ${facts.start}`
        : facts.end
          ? `until ${facts.end}`
          : null;

  return [UNION_TYPE_NOUN[facts.type], span].filter(Boolean).join(", ");
}

/**
 * The noun each `union_type` reads as at the head of such a phrase.
 *
 * `unknown` is "Union" rather than "Not recorded", which is what the
 * add-spouse form's own map calls it. The two are answering different
 * questions: that one labels an *option* in a select, where "Not recorded" is
 * the honest name for the thing you are choosing, and this one heads a
 * *description of a row*, where the sentence has to go on to carry dates.
 */
const UNION_TYPE_NOUN: Record<UnionFacts["type"], string> = {
  marriage: "Marriage",
  partnership: "Partnership",
  unknown: "Union",
};

/**
 * Which of the losing union's recorded values the surviving one will not
 * carry.
 *
 * "Recorded" is doing real work in both enum cases, and the two enums put the
 * line in different places.
 *
 * `type: "unknown"` is the member meaning *nothing was said* — it is what
 * `lib/set-parents.ts` writes precisely so that a family created inline
 * asserts nothing about the relationship — so losing it loses nothing.
 *
 * For `end_reason` the unsaid member is `ongoing`, not `unknown`, and getting
 * that the wrong way round would make every ordinary merge report a loss
 * nobody suffered. `ongoing` is the column's default: it is what every row
 * nobody has edited carries, including the inline family this whole ticket is
 * about, which is never asked how it ended. `unknown` is the opposite — it
 * says the union *did* end and the reason was not recorded, which is a claim
 * somebody had to choose from a list, and dropping it drops something.
 */
function factLosses(keep: GraphUnion, merge: GraphUnion): UnionFactLoss[] {
  const losses: UnionFactLoss[] = [];
  const keptFacts = unionFacts(keep);
  const mergedFacts = unionFacts(merge);

  if (merge.type !== "unknown" && merge.type !== keep.type) {
    losses.push({
      field: "type",
      losing: merge.type,
      keeping: keep.type === "unknown" ? null : keep.type,
    });
  }

  for (const field of ["start", "end"] as const) {
    const losing = mergedFacts[field];
    if (losing !== null && losing !== keptFacts[field]) {
      losses.push({ field, losing, keeping: keptFacts[field] });
    }
  }

  if (merge.endReason !== "ongoing" && merge.endReason !== keep.endReason) {
    losses.push({
      field: "endReason",
      losing: merge.endReason,
      keeping: keep.endReason === "ongoing" ? null : keep.endReason,
    });
  }

  return losses;
}

/**
 * The notes the surviving union carries after a merge.
 *
 * Both, kept apart by a blank line — the one field a merge does not make the
 * author choose about, and deliberately so. Every other value on a `unions`
 * row is a *fact* with a fixed vocabulary or a date, where holding two answers
 * at once would be a contradiction and picking one is the whole point of
 * choosing which union survives. Notes are prose somebody typed, there is no
 * such thing as two of them contradicting, and the tree keeps no history to
 * recover deleted prose from (see `lib/removal-preview.ts`). So nothing
 * written is dropped, and the confirmation says exactly that.
 *
 * Order is kept-then-merged, so the surviving family's own note stays where
 * its author left it and the arriving one reads as an addition.
 *
 * @returns the combined notes, or null when neither union had any
 */
export function joinNotes(
  kept: string | null,
  merged: string | null,
): string | null {
  const parts = [kept, merged]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value !== "");

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}
