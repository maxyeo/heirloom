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
 * Which stage a graph is at.
 *
 * A derivation rather than a component, for the reason `lib/person-detail.ts`
 * is one: what the canvas should say about an almost-empty tree is a decision
 * about a `FamilyGraph`, and deciding it here means it is asserted against
 * literals in plain Node rather than by mounting React Flow (docs/testing.md,
 * "prefer no DOM"). The component is then a `switch` and some words.
 *
 * The order of the two tests matters and is the degenerate case: a union
 * whose partner columns are both null (the model allows it — see "Unknown
 * parent" in docs/architecture.md) is not evidence that anybody is on the
 * tree, so "is there anyone at all" is asked first.
 */
export function treeOnboarding(graph: FamilyGraph): TreeOnboarding {
  if (graph.people.length === 0) return { stage: "no-people" };
  if (graph.unions.length > 0) return { stage: "under-way" };

  const lone = graph.people.length === 1 ? graph.people[0] : null;

  return {
    stage: "unconnected",
    person: lone ? formatPersonName(lone.givenName, lone.surname) : null,
  };
}
