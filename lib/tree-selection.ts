import type { Node } from "@xyflow/react";

import type { FamilyGraph } from "./family-graph";

/**
 * Which person the tree is showing — held in two places at once (E2-T4).
 *
 * The canvas holds it as React Flow's own `selected` flag on a node, because
 * that is what draws the highlight and what a click, a keypress and a canvas
 * click all produce. The URL holds it as `?person=<id>`, because that is what
 * can be sent to somebody, bookmarked, or walked back through with the browser
 * buttons.
 *
 * Everything in this module is the arithmetic of keeping those two agreeing:
 * reading an id out of a query string, writing one back in, and applying one
 * to a list of nodes. None of it needs a document or a router, which is what
 * lets `lib/tree-selection.test.ts` assert the awkward cases — an id nobody
 * recognises, a query string with other params in it, a selection that is
 * already correct — in plain Node (docs/testing.md: "prefer no DOM"). The
 * component is left with the wiring and none of the decisions.
 */

/** The query parameter a person is deep-linked by: `/tree?person=<id>`. */
export const PERSON_PARAM = "person";

/**
 * The two halves of the URL binding, handed to `FamilyTree` as one prop.
 *
 * One object rather than two props, and that is load-bearing: the canvas
 * mirrors its selection into whatever it is given and follows whatever comes
 * back. Given a reader and no writer it would push a selection out to nowhere
 * and then see the URL still saying `null`, and dutifully deselect the person
 * the reader just clicked. The binding is therefore all or nothing, and the
 * type is what says so.
 *
 * A canvas given none — every test that mounts one, and any future embedding
 * that is not a route — behaves exactly as it did before this ticket.
 */
export interface PersonLink {
  /** The raw `?person=` value, straight off the URL. May name nobody. */
  personId: string | null;
  /** Called with the canvas's new selection, for the URL to follow. */
  onChange: (personId: string | null) => void;
}

/**
 * The person a `?person=` value names, or `null` when nothing on the tree
 * answers to it.
 *
 * This is the whole of "unknown or malformed id falls back to the default view
 * without erroring". Membership in the graph is a stricter test than any
 * amount of uuid-shaped validation — a well-formed uuid for somebody who was
 * deleted last week is exactly as unopenable as `?person=<script>` — and it
 * costs one pass over a list that is already in the browser.
 */
export function linkedPersonId(
  graph: FamilyGraph,
  personId: string | null,
): string | null {
  if (personId === null || personId === "") return null;
  return graph.people.some((person) => person.id === personId)
    ? personId
    : null;
}

/**
 * The query string for a URL naming `personId`, given the one it currently
 * has. `null` removes the parameter rather than emptying it.
 *
 * Every other parameter survives, because this is not the only thing that may
 * ever be in the query string and a selection has no business dropping
 * somebody else's state. The leading `?` is included, and the empty query
 * string is returned as `""` rather than `"?"` — so a URL built by appending
 * this to a pathname is the same URL the reader would have typed.
 */
export function personSearch(search: string, personId: string | null): string {
  const params = new URLSearchParams(search);
  if (personId === null) params.delete(PERSON_PARAM);
  else params.set(PERSON_PARAM, personId);

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * `nodes` with exactly `personId` selected, and `null` for nothing selected.
 *
 * Returns the array it was given when the selection is already right, and
 * every node object that is already right within it. That is not a
 * micro-optimisation: this runs from an effect that watches the URL, and a new
 * array every time would hand React Flow a fresh `nodes` prop on every
 * navigation the parameter did not actually change.
 */
export function withSelection(nodes: Node[], personId: string | null): Node[] {
  const matches = (node: Node): boolean =>
    (node.selected ?? false) === (node.id === personId);

  if (nodes.every(matches)) return nodes;
  return nodes.map((node) =>
    matches(node) ? node : { ...node, selected: node.id === personId },
  );
}
