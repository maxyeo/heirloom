import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import type { FamilyGraph } from "./family-graph";
import { formatLifespan } from "./format-date";
import { formatPersonName } from "./person-format";
import { PORTRAIT_NODE_SIZE, nodePortraitKey, portraitSrc } from "./portrait";

/**
 * Everything the node was before E5-T4: two lines of text, their padding and
 * their border.
 *
 * Naming it is what lets the portrait be *added* to the node's width below
 * rather than *taken out of* it, and that distinction is the whole of how
 * this ticket keeps a name that fitted yesterday still fitting. Taking the
 * portrait out of 176 would have left the text column 56 pixels narrower, so
 * every card would have started truncating names that used to fit — a
 * regression with no error in it, visible only to somebody who knew what the
 * tree looked like last week.
 */
const PERSON_TEXT_WIDTH = 176;

/**
 * The horizontal gap between the portrait and the name (`gap-2`).
 *
 * Here rather than only in the component for the same reason
 * {@link PORTRAIT_NODE_SIZE} is in `lib/portrait.ts`: every pixel the node
 * occupies has to be a pixel dagre reserved, and a spacing value that exists
 * in the stylesheet alone is one dagre cannot know about.
 */
const PORTRAIT_GAP = 8;

/**
 * The box dagre reserves for a person, portrait included (E5-T4, `YEO-44`).
 *
 * ## What these two numbers are, and what they are not
 *
 * They are what dagre is *told*, not a measurement of the DOM. The card has
 * always rendered at about 58 pixels — less without a lifespan — while this
 * file has always said 64, and nothing was wrong with that: the constants are
 * the space reserved in the layout, and a little slack inside it is what
 * keeps two cards from touching. So the job here is not to make these agree
 * with a stylesheet to the pixel. It is to make sure they are big enough, and
 * that they are *the same for everybody*.
 *
 * ## Why the layout is stable whether or not a portrait exists
 *
 * Two facts, and neither of them is a number:
 *
 * 1. **Dagre is told these constants for every person.** The loop below never
 *    looks at whether the person has a portrait — it cannot, because the
 *    values are constants. That is the property to preserve; a future
 *    "measure the node and pass its real height" would break the criterion
 *    this ticket is written against, quietly and for everybody.
 * 2. **The rendered card is the same box either way.** The portrait slot is
 *    one fixed-size element in `components/FamilyTree.tsx` whose *child*
 *    changes — a photograph, or a placeholder drawn into the same square.
 *    Nothing inside it can resize it.
 *
 * A node sized to its contents would re-rank the tree the moment somebody
 * uploaded a picture: everything below a great-grandmother sliding sideways
 * because her face arrived. The layout is a function of the family, not of
 * which photographs happen to have been found.
 *
 * ## The arithmetic
 *
 * The portrait is 48 pixels square with an 8-pixel gap after it, and it is
 * *added* to the 176 the card already was — so the text column keeps exactly
 * the 150 pixels it has today and no name truncates that did not truncate
 * before. See {@link PERSON_TEXT_WIDTH}.
 *
 * The height moves because the portrait is now the tallest thing in the row:
 * 48 for the portrait, 16 for the vertical padding and 2 for the border is
 * 66, where the two lines of text alone came to about 58. 72 keeps the same
 * few pixels of slack over the rendered card that 64 gave.
 */
export const PERSON_WIDTH =
  PORTRAIT_NODE_SIZE + PORTRAIT_GAP + PERSON_TEXT_WIDTH;
export const PERSON_HEIGHT = 72;
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
    const name = formatPersonName(person.givenName, person.surname);
    const lifespan = formatLifespan(person);
    /**
     * The portrait as an `<img src>`, already resolved, or null.
     *
     * A path rather than a key, because the node component's only job with it
     * is to put it in an attribute — and resolving it here keeps
     * `portraitSrc` named on this path once, rather than in a component that
     * is otherwise about layout. The path is site-relative and durable; the
     * signed URL it redirects to is minted when the browser fetches it. See
     * `lib/portrait.ts`.
     *
     * Which of the two stored keys this is — the thumbnail, or the original
     * standing in for a thumbnail that was never made — is `nodePortraitKey`'s
     * decision, argued there.
     */
    const portrait = nodePortraitKey(person);
    nodes.push({
      id: person.id,
      type: "person",
      // Dagre returns centres; React Flow positions from the top-left.
      position: {
        x: laid.x - PERSON_WIDTH / 2,
        y: laid.y - PERSON_HEIGHT / 2,
      },
      data: {
        name,
        lifespan,
        sex: person.sex,
        pageId: person.pageId,
        portraitSrc: portrait === null ? null : portraitSrc(portrait),
      },
      // Nodes are focusable by default, so a keyboard reaches every person
      // without help — but only the wrapper div is in the tab order, and it
      // has no text of its own. Without this a screen reader announces
      // "group, node" thirty times over.
      ariaLabel: lifespan ? `${name}, ${lifespan}` : name,
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
      // A union marker is a connector, not a record. Clicking it opens
      // nothing, and putting it in the tab order would double the number of
      // stops a keyboard has to make to cross a generation.
      selectable: false,
      focusable: false,
    });
  }

  return { nodes, edges };
}
