import type { FamilyGraph } from "@/lib/family-graph";

/**
 * Which people belong to the same family as which (E10-T5 follow-up,
 * `YEO-103`).
 *
 * ## Why this is a file rather than a comparator
 *
 * `lib/tree-layout.ts` sorts the person nodes into the order a keyboard walks
 * them, and until this ticket that order was dagre's `y` and then its `x` —
 * the reading order of *one* tree. An archive is not required to be one tree.
 * `app/tree/page.tsx` loads the whole database onto a single canvas, and
 * `lib/tree-onboarding.ts` has an `unconnected` stage precisely because people
 * with nobody attached to them yet are an expected state of a tree somebody is
 * still typing in — so two branches of a family that have not been joined, or
 * a GEDCOM import of two lineages, are ordinary rather than exotic.
 *
 * Answering "which family is this person in" is a graph walk, not a
 * comparison, and this repository already has a place for those: `lib/
 * ancestry.ts` takes a `FamilyGraph` and returns a `Set`, with no database and
 * no React Flow anywhere near it. This file is that shape. `import type` for
 * the graph for the same reason it gives: `lib/family-graph.ts` exports the
 * type *and* a function that queries the database, and a value import would
 * drag postgres.js into any suite that touched this.
 *
 * ## How this differs from `descendantsOrSelf`
 *
 * That walk is directed — partner → union → child, downwards only, because it
 * is answering whether somebody stands above somebody else. This one is
 * undirected: a mother, her husband, their children and their children's
 * spouses are all one family, and which way the arrows point between them does
 * not come into it. Neither walk can be written in terms of the other.
 */

/**
 * Everybody in the archive, grouped into the families they actually belong to
 * and put in a canonical order.
 *
 * ## What counts as one family
 *
 * A connected component, computed from the unions: everybody a union names —
 * both partners, and every child recorded under it — is in one family with
 * everybody else it names, and families merge transitively through the people
 * they share. That is the same threshold `unionsConnectAnybody` uses in
 * `lib/tree-onboarding.ts`, deliberately: a union naming one person and no
 * second joins nobody to anybody, and what it draws on the canvas is a
 * connector dangling off a lone card rather than a family of two. A person
 * that no union names is a family of one.
 *
 * ## What the order is, and why it is not the layout's
 *
 * Families that join two or more people come first, in order of the smallest
 * person id in each; then the people joined to nobody, in the same order among
 * themselves.
 *
 * The tempting keys both come from dagre, and both are wrong:
 *
 * - **Where the component sits sideways.** Ordering families left to right
 *   would make the tab order agree with the eye, which sounds like exactly the
 *   right answer until you ask what decides it. Dagre breaks ties by insertion
 *   order, and insertion order here is `graph.people` — which `getFamilyGraph`
 *   reads with **no `ORDER BY` at all**. `lib/tree-layout.seed.test.ts` says
 *   it out loud: the order rows arrive in "is Postgres's business and not a
 *   promise". A tab order keyed on that is a fact about the last `VACUUM`.
 * - **The component's topmost `y`.** Dagre normalises every component's own
 *   root to rank 0, so this is the same number for every family and decides
 *   nothing (confirmed against dagre, not assumed: two chains laid out
 *   together put both roots on one `y`). What variation it does have comes
 *   from node *height* — a family whose topmost node is a 14-pixel union
 *   marker centres higher than one whose topmost node is a person — so it
 *   would sort families by whether their oldest record is a marriage.
 *
 * So the order is taken from the data instead. The smallest id says nothing
 * about a family, and it is not trying to: two unrelated lineages have no
 * natural precedence over one another, and the criterion this answers is that
 * the same archive tabs the same way twice, not that it tabs in some
 * meaningful order across families that are not related to each other.
 *
 * ## Why the unattached go last
 *
 * This is a decision rather than a consequence, and the alternative is
 * defensible — it is being written down because letting dagre pick was the
 * bug. Somebody joined to nobody is a loose end: `lib/tree-onboarding.ts`
 * treats them as a tree that has not started yet, and a GEDCOM import leaves a
 * handful of them lying about until the branches are joined up. Putting them
 * last means Tab crosses the family that has been built before it reaches the
 * fragments waiting to be attached to it, instead of opening on a stranger or
 * stopping at one halfway down a lineage. The moment somebody joins them to a
 * union they stop being a loose end and take their place inside a family's own
 * generations, which is the behaviour worth having.
 *
 * @param graph the whole archive, as `getFamilyGraph` returns it
 * @returns the person ids, grouped by family, each group in no particular
 *   internal order — the caller sorts within a family, this only says which
 *   family somebody is in and which family comes first
 */
export function connectedFamilies(graph: FamilyGraph): string[][] {
  /**
   * Only people are walked. Unions are the edges here rather than the nodes —
   * every union is a clique over the people it names — so putting union ids in
   * this map would mean a component could be "one person and a union", which
   * is not a number anything below wants to count.
   */
  const neighbours = new Map<string, string[]>(
    graph.people.map((person) => [person.id, []]),
  );

  // Indexed once rather than filtered per union, for the reason
  // `descendantsOrSelf` gives: the graph is small, but a rescan per union is
  // quadratic for nothing.
  const childrenOfUnion = new Map<string, string[]>();
  for (const link of graph.childLinks) {
    const children = childrenOfUnion.get(link.unionId);
    if (children === undefined) {
      childrenOfUnion.set(link.unionId, [link.childId]);
    } else {
      children.push(link.childId);
    }
  }

  for (const union of graph.unions) {
    /**
     * An unrecorded partner is a `null` to drop, and an id naming somebody
     * outside `graph.people` is dropped too. The layout tolerates the second
     * — `setEdge` invents a dagre node for an id it has not seen — but there
     * is no person node for it, so it is nobody's family.
     */
    const named = [
      union.partnerAId,
      union.partnerBId,
      ...(childrenOfUnion.get(union.id) ?? []),
    ].filter((id): id is string => id !== null && neighbours.has(id));

    /**
     * A star from the first of them rather than every pair. Connectivity is
     * all that is being recorded, and joining the rest to one of them puts the
     * whole union in one component at a union of twelve children costing
     * eleven links instead of sixty-six.
     */
    const [first, ...rest] = named;
    if (first === undefined) continue;
    for (const id of rest) {
      neighbours.get(first)?.push(id);
      neighbours.get(id)?.push(first);
    }
  }

  const seen = new Set<string>();
  const families: { members: string[]; alone: boolean; key: string }[] = [];

  for (const person of graph.people) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);

    const members: string[] = [];
    const pending = [person.id];
    // Iterative, and depth-first because the answer does not depend on the
    // order — the same two reasons `descendantsOrSelf` is.
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      members.push(current);
      for (const neighbour of neighbours.get(current) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        pending.push(neighbour);
      }
    }

    families.push({
      members,
      alone: members.length === 1,
      // `members` always holds at least the person the walk started from, so
      // there is no empty-array case for `reduce` to fall off.
      key: members.reduce((lowest, id) =>
        id.localeCompare(lowest) < 0 ? id : lowest,
      ),
      // `localeCompare` rather than `<` to match the tiebreak
      // `lib/tree-layout.ts` already sorts ids with; one file should not order
      // two ids one way while the other orders them the opposite way.
    });
  }

  families.sort(
    (a, b) => Number(a.alone) - Number(b.alone) || a.key.localeCompare(b.key),
  );

  return families.map((family) => family.members);
}
