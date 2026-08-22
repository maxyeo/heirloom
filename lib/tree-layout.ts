import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import type { FamilyGraph } from "./family-graph";

export const PERSON_WIDTH = 176;
export const PERSON_HEIGHT = 64;
const UNION_SIZE = 14;

/**
 * Family trees are layered DAGs, not trees: a person can be a partner in more
 * than one union, so they have more than one downward path. `d3-tree` assumes
 * a single parent slot per node and cannot represent that. Dagre lays out
 * layered graphs, which is exactly the right shape — generation becomes rank.
 *
 * Unions are rendered as their own small nodes. That is what lets a twice-
 * married person sit between both of their unions instead of being duplicated.
 */
export function layoutFamilyGraph(graph: FamilyGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", ranksep: 48, nodesep: 24, edgesep: 12 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const person of graph.people) {
    g.setNode(person.id, { width: PERSON_WIDTH, height: PERSON_HEIGHT });
  }
  for (const union of graph.unions) {
    g.setNode(union.id, { width: UNION_SIZE, height: UNION_SIZE });
  }

  const edges: Edge[] = [];

  for (const union of graph.unions) {
    for (const partnerId of [union.partnerAId, union.partnerBId]) {
      if (!partnerId) continue;
      g.setEdge(partnerId, union.id);
      edges.push({
        id: `p-${partnerId}-${union.id}`,
        source: partnerId,
        target: union.id,
        type: "smoothstep",
        // A union that ended is drawn dashed, so widowhood and divorce are
        // visible rather than buried in a detail panel.
        style:
          union.endReason === "ongoing"
            ? undefined
            : { strokeDasharray: "4 4" },
      });
    }
  }

  for (const link of graph.childLinks) {
    g.setEdge(link.unionId, link.childId);
    edges.push({
      id: `c-${link.unionId}-${link.childId}`,
      source: link.unionId,
      target: link.childId,
      type: "smoothstep",
      style:
        link.relation === "biological" ? undefined : { strokeDasharray: "2 3" },
    });
  }

  dagre.layout(g);

  const nodes: Node[] = [];

  for (const person of graph.people) {
    const laid = g.node(person.id);
    nodes.push({
      id: person.id,
      type: "person",
      // Dagre returns centres; React Flow positions from the top-left.
      position: {
        x: laid.x - PERSON_WIDTH / 2,
        y: laid.y - PERSON_HEIGHT / 2,
      },
      data: {
        name: [person.givenName, person.surname].filter(Boolean).join(" "),
        lifespan: formatLifespan(person.birthDate, person.deathDate),
        sex: person.sex,
        pageId: person.pageId,
      },
    });
  }

  for (const union of graph.unions) {
    const laid = g.node(union.id);
    nodes.push({
      id: union.id,
      type: "union",
      position: {
        x: laid.x - UNION_SIZE / 2,
        y: laid.y - UNION_SIZE / 2,
      },
      data: { endReason: union.endReason },
      selectable: false,
    });
  }

  return { nodes, edges };
}

function formatLifespan(birth: string | null, death: string | null): string {
  const b = birth?.slice(0, 4);
  const d = death?.slice(0, 4);
  if (!b && !d) return "";
  if (b && d) return `${b}–${d}`;
  if (b) return `b. ${b}`;
  return `d. ${d}`;
}
