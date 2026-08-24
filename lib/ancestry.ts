import type { FamilyGraph } from "@/lib/family-graph";

/**
 * Who stands above whom (E3-T6, `YEO-34`).
 *
 * ## Why this file exists at all
 *
 * Every other rule in this application is a rule about *data quality* — a
 * blank name, a death before a birth, a person recorded twice. This one is
 * different in kind: a child link that makes somebody their own ancestor puts
 * a **cycle** into a graph that `lib/tree-layout.ts` and `lib/family-graph.ts`
 * both walk as though it were acyclic. dagre ranks a cycle by giving up on it,
 * and a recursive walk over one does not return. So the failure this prevents
 * is not a wrong-looking panel; it is the tree page not rendering, for
 * everybody, until somebody finds the row in SQL.
 *
 * The repository had no such check before this ticket. `lib/save-child.ts`
 * refused a child who was one of the union's own partners, which catches the
 * one-hop case and nothing deeper — attach a grandmother as a child of her own
 * grandson's union and both partner columns look perfectly innocent.
 *
 * ## Why it is pure
 *
 * A `FamilyGraph` in, a `Set` or an id out. That is the shape docs/testing.md
 * points at `lib/tree-layout.ts` for, and it is what lets the interesting
 * cases — a diamond, four generations, a person legitimately recorded in two
 * families — be asserted against a literal with no database in sight. The two
 * callers that matter (`lib/save-child.ts` inside its transaction, and the
 * form, over the graph the browser already holds) then share one definition of
 * the rule rather than each having their own.
 *
 * `import type` for the graph, deliberately: `lib/family-graph.ts` exports the
 * type *and* a function that queries the database, and a plain import would
 * drag postgres.js into a jsdom component test. See docs/testing.md.
 *
 * ## Why descent is measured through unions
 *
 * Because that is where parenthood lives. A person's children are the children
 * of the unions they are a partner in — never a column on the person — so
 * "descendant" is two hops at a time: partner → union → child. Adoption,
 * fostering and step-parenthood are `relation` values on the link and are
 * *not* filtered out here. An adopted child is a real descendant for this
 * purpose: recording their adoptive grandmother as their own daughter is the
 * same unrenderable loop as the biological case, and this file is about what
 * the layout can draw rather than about who shares blood.
 */

/**
 * A person, everyone descended from them, and nobody else.
 *
 * "Or self" is not a convenience — it is the direct case. Attaching somebody
 * as a child of a union they are already a partner in makes them their own
 * parent, which is the shortest cycle there is, so the walk has to start with
 * the person in the set rather than with their children.
 *
 * The visited set is what makes this terminate, and it earns its keep twice
 * over. The ordinary reason is the **diamond**: cousins marry, two lines of
 * descent rejoin, and the same person is reached down two different paths.
 * That is an entirely legitimate family and not a cycle — the walk simply
 * meets them a second time and stops. The other reason is defensive: a cycle
 * that a hand-written `INSERT` or an import put into the table *before* this
 * check existed must not turn a validation into a hang.
 *
 * Iterative rather than recursive for the same reason. A deep pedigree is only
 * dozens of generations, but a corrupt row is unbounded, and a stack overflow
 * inside a transaction is a worse outcome than a slow answer.
 *
 * @param graph the whole tree, as `getFamilyGraph` returns it
 * @param personId the person to stand at the top of the walk
 * @returns their id, plus the id of everyone below them
 */
export function descendantsOrSelf(
  graph: FamilyGraph,
  personId: string,
): Set<string> {
  /**
   * Indexed once per call rather than filtered per generation. The graph is
   * small by design — hundreds of people (docs/architecture.md) — but a walk
   * that re-scanned `childLinks` for every union it reached would be quadratic
   * in the number of unions for no reason at all.
   */
  const childrenOfUnion = new Map<string, string[]>();
  for (const link of graph.childLinks) {
    const children = childrenOfUnion.get(link.unionId);
    if (children === undefined) {
      childrenOfUnion.set(link.unionId, [link.childId]);
    } else {
      children.push(link.childId);
    }
  }

  const unionsOfPartner = new Map<string, string[]>();
  for (const union of graph.unions) {
    // Both slots, and a union naming the same person in both is not a special
    // case: the id is appended twice, the visited set below absorbs it.
    for (const partnerId of [union.partnerAId, union.partnerBId]) {
      if (partnerId === null) continue;
      const unions = unionsOfPartner.get(partnerId);
      if (unions === undefined) {
        unionsOfPartner.set(partnerId, [union.id]);
      } else {
        unions.push(union.id);
      }
    }
  }

  const seen = new Set<string>([personId]);
  const pending = [personId];

  while (pending.length > 0) {
    // `pop` rather than `shift`: this is a reachability question, so the order
    // the graph is walked in cannot change the answer, and depth-first costs
    // no array reindexing per step.
    const currentId = pending.pop();
    if (currentId === undefined) break;

    for (const unionId of unionsOfPartner.get(currentId) ?? []) {
      for (const childId of childrenOfUnion.get(unionId) ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        pending.push(childId);
      }
    }
  }

  return seen;
}

/**
 * Whether recording `childId` as a child of `unionId` would make them their
 * own ancestor — and if so, through whom.
 *
 * The question is asked from the child's side rather than the union's, because
 * one walk answers it for both parents: a cycle appears exactly when a person
 * already at or below `childId` in the tree is one of the parents `childId` is
 * about to be placed under. Walking *up* from each partner instead would be
 * two walks and the same answer.
 *
 * The id of the offending parent is returned rather than a boolean so that a
 * caller with the graph in hand — the form — can name them. A caller that only
 * needs to refuse compares against null and ignores it.
 *
 * A union this graph does not hold yields null: there is no link to be made,
 * so there is no cycle to prevent, and whether the union exists is a question
 * for the write to answer with `union-not-found` rather than for this to
 * answer with a guess.
 *
 * @param graph the whole tree, as `getFamilyGraph` returns it
 * @param unionId the family the child would be recorded into
 * @param childId the person who would become its child
 * @returns the partner of `unionId` who already descends from `childId`, or
 *   `childId` itself when they are a partner in it; null when the link is safe
 */
export function ancestryCycle(
  graph: FamilyGraph,
  unionId: string,
  childId: string,
): string | null {
  const union = graph.unions.find((candidate) => candidate.id === unionId);
  if (union === undefined) return null;

  const below = descendantsOrSelf(graph, childId);

  for (const partnerId of [union.partnerAId, union.partnerBId]) {
    if (partnerId !== null && below.has(partnerId)) return partnerId;
  }

  return null;
}

/**
 * The unions a person may be recorded as a child of without creating a cycle.
 *
 * The form's half of the same rule. It exists so that the picker can leave the
 * impossible families out entirely instead of offering them and refusing
 * afterwards — but it is emphatically *not* the enforcement. That is in
 * `lib/save-child.ts`, against a fresh read inside the transaction, because
 * this answer is computed from a graph the browser loaded some time ago and a
 * union whose partner changed in another tab in the meantime would slip
 * straight through it.
 *
 * One walk for the whole list rather than one per union, which is the reason
 * this is here rather than a `filter` at the call site.
 *
 * @param graph the whole tree, as the canvas already holds it
 * @param childId the person whose parents are being set
 * @returns the ids of every union in `graph` that could hold them as a child
 */
export function unionsWithoutCycle(
  graph: FamilyGraph,
  childId: string,
): Set<string> {
  const below = descendantsOrSelf(graph, childId);

  const safe = new Set<string>();
  for (const union of graph.unions) {
    const blocked =
      (union.partnerAId !== null && below.has(union.partnerAId)) ||
      (union.partnerBId !== null && below.has(union.partnerBId));
    if (!blocked) safe.add(union.id);
  }

  return safe;
}
