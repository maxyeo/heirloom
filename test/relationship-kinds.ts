import { descendantsOrSelf } from "@/lib/ancestry";
import type { FamilyGraph } from "@/lib/family-graph";
import { derivePersonDetail } from "@/lib/person-detail";

/**
 * Half-sibling, step-parent, step-sibling, blood relation — derived, for
 * `lib/relationship-derivation.test.ts` (E10-T4, `YEO-68`).
 *
 * ## Why these live in `test/` rather than in `lib/`
 *
 * Not because deriving a relationship is something the application avoids —
 * it is the whole model. `lib/person-detail.ts` derives spouses, children and
 * parents; `lib/person-infobox.ts` derives stepchildren; docs/architecture.md
 * rests on the claim that every such label is *read back out of* `unions` and
 * `union_children` rather than stored beside them.
 *
 * They live here because **nothing in the application asks these four
 * questions**. No panel shows a kinship degree and no box lists step-siblings.
 * Shipping a `lib/relationships.ts` for them would be an exported API with no
 * caller, and a taxonomy of relationship types is the one kind of speculative
 * surface this model exists to make unnecessary: the point of not storing a
 * label is that nobody has to anticipate which labels will be wanted.
 *
 * So this is the same arrangement as `test/route-inventory.ts` — logic a test
 * needs, that the application does not, kept out of `lib/` and given its own
 * unit test (`test/relationship-kinds.test.ts`) because the suite that uses it
 * cannot reach every branch.
 *
 * ## Where each hop comes from, and why
 *
 * Two different sources, deliberately:
 *
 * - **Parents come from `derivePersonDetail`.** That is the hop the
 *   application already makes, and it is what the detail panel and the
 *   infobox both show. Re-querying `childLinks` here for the same answer
 *   would leave the matrix in `lib/relationship-derivation.test.ts` proving
 *   something about this file rather than about what a reader sees — and a
 *   derivation that broke identically in both places would still be green.
 * - **The union a person was born into comes from the rows.** A union with
 *   *neither* partner recorded still holds its children together, and
 *   `PersonDetail.parents` cannot report it because there is no parent in it
 *   to report. Two such children are full siblings and nothing about that
 *   depends on who their parents were, so the union is read from
 *   `union_children` directly — a stored fact, not a derived label.
 */

/** The unions a person was recorded into as a child. */
export function birthUnionsOf(
  graph: FamilyGraph,
  personId: string,
): Set<string> {
  return new Set(
    graph.childLinks
      .filter((link) => link.childId === personId)
      .map((link) => link.unionId),
  );
}

/** The unions a person stands in as a partner. */
export function partnerUnionsOf(
  graph: FamilyGraph,
  personId: string,
): Set<string> {
  return new Set(
    graph.unions
      .filter((u) => u.partnerAId === personId || u.partnerBId === personId)
      .map((u) => u.id),
  );
}

/**
 * A person's parents: the partners of the unions they were born into, as the
 * detail panel already lists them.
 *
 * This is the hop a `person.parent_id` column would have made cheaper and
 * would have been unable to express — Edward has two parents and one of them
 * remarried, which is one row here and an impossible column there.
 */
export function parentsOf(graph: FamilyGraph, personId: string): Set<string> {
  const detail = derivePersonDetail(graph, personId);
  return new Set(detail?.parents.map((parent) => parent.person.id) ?? []);
}

/**
 * The people married into a parent of this person, who are not themselves a
 * parent of this person.
 *
 * Nothing in the schema records the word "step". This is remarriage read from
 * the child's end: my parent's other spouse. `lib/person-infobox.ts` walks the
 * same relationship from the parent's end — a child of a union my spouse
 * belongs to that I do not — and the two are asserted against each other.
 */
export function stepParentsOf(
  graph: FamilyGraph,
  personId: string,
): Set<string> {
  const parents = parentsOf(graph, personId);
  const unionById = new Map(graph.unions.map((u) => [u.id, u]));

  const steps = new Set<string>();
  for (const parentId of parents) {
    for (const unionId of partnerUnionsOf(graph, parentId)) {
      const union = unionById.get(unionId);
      if (union === undefined) continue;
      for (const partnerId of [union.partnerAId, union.partnerBId]) {
        if (partnerId === null) continue;
        // Not me, and not one of my own parents — including the parent whose
        // union this is.
        if (partnerId === personId || parents.has(partnerId)) continue;
        steps.add(partnerId);
      }
    }
  }
  return steps;
}

export type SiblingKind = "full" | "half" | "step" | "none";

/**
 * How two people are siblings, if they are.
 *
 * Asked union-first rather than by counting shared parents, because that is
 * where the distinction actually lives:
 *
 * - **full** — the same union, so whatever is and is not recorded about its
 *   partners applies to both of them equally;
 * - **half** — a shared parent across two different unions, which is the
 *   remarriage case;
 * - **step** — no shared parent at all, joined only because a parent of one
 *   married a parent of the other.
 *
 * Counting shared parents instead would get "full" wrong for exactly the
 * family the schema was designed around. Thomas's union records his mother
 * and leaves his father unknown; a sibling of his would share the one parent
 * that is written down, and "shares one parent" would call them a
 * half-sibling on the strength of a blank column.
 *
 * ## The couple who married twice
 *
 * Union-first alone is not quite enough, because the same couple can hold
 * more than one union. `lib/save-union.ts` says so outright and declines to
 * check for duplicates over it: "couples who divorced and remarried each
 * other are a real and unremarkable genealogical case, and refusing the
 * second would make it unrecordable." A child from each of those two unions
 * has the same two parents and is nobody's half-sibling, so the shared-parent
 * branch has to be able to answer "full" as well.
 *
 * It may only do so when **both** partners are recorded on both sides. That
 * restriction is the blank-column case again, seen from the other end: if
 * Agnes appears in two unions whose other partner is unknown each time, her
 * two children share every parent anybody wrote down, and calling them full
 * siblings would be inventing the fact that the unknown partner was the same
 * man. "Half" is the honest answer there, and it is what falls out.
 */
export function siblingKind(
  graph: FamilyGraph,
  a: string,
  b: string,
): SiblingKind {
  if (a === b) throw new Error(`siblingKind asked about "${a}" and itself`);

  const births = birthUnionsOf(graph, a);
  for (const unionId of birthUnionsOf(graph, b)) {
    if (births.has(unionId)) return "full";
  }

  const parents = parentsOf(graph, a);
  const otherParents = parentsOf(graph, b);
  const shared = [...otherParents].filter((id) => parents.has(id));
  if (shared.length > 0) {
    // Every parent of each, and two of them on both sides — the couple who
    // married twice. Anything less is a shared parent and a different one.
    const bothFullyRecorded = parents.size === 2 && otherParents.size === 2;
    return shared.length === 2 && bothFullyRecorded ? "full" : "half";
  }

  for (const union of graph.unions) {
    const partners = [union.partnerAId, union.partnerBId].filter(
      (id): id is string => id !== null,
    );
    if (
      partners.some((id) => parents.has(id)) &&
      partners.some((id) => otherParents.has(id))
    ) {
      return "step";
    }
  }

  return "none";
}

/**
 * Everyone who descends from somebody this person also descends from.
 *
 * `descendantsOrSelf` is `lib/ancestry.ts`'s own — the walk the cycle guard
 * makes, partner → union → child, asked a question it was not written for.
 * "Or self" is what makes a parent a relation of their own child rather than
 * only a co-descendant of somebody further up.
 *
 * Whether this is *blood* depends entirely on which links the graph holds,
 * which is the argument `bloodOnly` below makes concrete.
 */
export function relativesOf(graph: FamilyGraph, personId: string): Set<string> {
  const related = new Set<string>();
  for (const ancestor of graph.people) {
    const below = descendantsOrSelf(graph, ancestor.id);
    if (!below.has(personId)) continue;
    for (const id of below) if (id !== personId) related.add(id);
  }
  return related;
}

/**
 * The same graph with every link that is not a birth removed.
 *
 * The file's argument in one function: "related by blood" is not a second
 * label to store beside the first, it is the *same* derivation over a
 * narrower set of rows. How a child joined a union is already recorded on the
 * link, so filtering the links is the whole of it.
 */
export function bloodOnly(graph: FamilyGraph): FamilyGraph {
  return {
    ...graph,
    childLinks: graph.childLinks.filter(
      (link) => link.relation === "biological",
    ),
  };
}
