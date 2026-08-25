import type { FamilyGraph } from "./family-graph";
import { formatPersonName } from "./person-format";

/**
 * How far along a tree is, for E3-T9's onboarding (`YEO-37`).
 *
 * The three stages are the three things the canvas can honestly be: nothing
 * recorded at all, people recorded but nobody connected to anybody, and a
 * tree that has started to be a tree.
 *
 * `unconnected` covers the one-person case the acceptance criteria name, and
 * generalises it, because a tree of three people and no unions is the same
 * dead end wearing a different number — a handful of cards floating in a
 * viewport with nothing joining them. `person` is the name to say out loud
 * when there is exactly one person to name, and null when there are several
 * and the invitation has to be phrased generally.
 */
export type TreeOnboarding =
  | { stage: "no-people" }
  | { stage: "unconnected"; person: string | null }
  | { stage: "under-way" };

/**
 * Whether any union in the graph joins people, as opposed to merely being a
 * row in the unions table.
 *
 * The two are not the same claim, and reading the first off the second is
 * `YEO-84`. Both partner columns are nullable and a union can hold no
 * children — see "Unknown parent" in docs/architecture.md — so a union is
 * free to name nobody at all, or one person and no second. What it has drawn
 * on the canvas in that state is a connector dangling off a lone card, which
 * is the picture the start hint exists to answer, not evidence that the hint
 * has been answered.
 *
 * Two, then, is the threshold: a union counts once it has joined one person
 * to another. Children count towards the pair as readily as partners do, a
 * union holding one parent and one child being a family in the ordinary
 * sense, and so is one holding two siblings whose parents are unknown.
 *
 * The count is of distinct people rather than of filled columns, because the
 * malformed row that lists one person as both partners is a shape this
 * codebase already knows about (`previewPartnerDetachment` restates both
 * slots for exactly that reason) and it joins nobody to anybody.
 *
 * None of this is only theoretical, whatever the ticket's own reachability
 * note allows. Detaching one partner from a childless couple leaves a union
 * with one partner and no children behind *today*: E3-T8's cleanup removes a
 * union only at zero partners *and* zero children (`isUnionOrphaned`).
 */
function unionsConnectAnybody(graph: FamilyGraph): boolean {
  const joined = new Map<string, Set<string>>();

  for (const union of graph.unions) {
    const people = new Set<string>();
    if (union.partnerAId) people.add(union.partnerAId);
    if (union.partnerBId) people.add(union.partnerBId);
    if (people.size > 1) return true;
    joined.set(union.id, people);
  }

  for (const link of graph.childLinks) {
    // A link naming a union the graph does not hold cannot survive the
    // foreign key, but the graph is a snapshot rather than a live read, so
    // the lookup is written to tolerate one rather than to assume it away.
    const people = joined.get(link.unionId);
    if (!people) continue;
    people.add(link.childId);
    if (people.size > 1) return true;
  }

  return false;
}

/**
 * Which stage a graph is at.
 *
 * A derivation rather than a component, for the reason `lib/person-detail.ts`
 * is one: what the canvas should say about an almost-empty tree is a decision
 * about a `FamilyGraph`, and deciding it here means it is asserted against
 * literals in plain Node rather than by mounting React Flow (docs/testing.md,
 * "prefer no DOM"). The component is then a `switch` and some words.
 *
 * The order of the two tests matters and is the degenerate case: a union that
 * names nobody is not evidence that anybody is on the tree, so "is there
 * anyone at all" is asked first. `unionsConnectAnybody` then decides the
 * second question on the same footing — what the unions actually join, not
 * how many rows there are.
 */
export function treeOnboarding(graph: FamilyGraph): TreeOnboarding {
  if (graph.people.length === 0) return { stage: "no-people" };
  if (unionsConnectAnybody(graph)) return { stage: "under-way" };

  const lone = graph.people.length === 1 ? graph.people[0] : null;

  return {
    stage: "unconnected",
    person: lone ? formatPersonName(lone.givenName, lone.surname) : null,
  };
}
