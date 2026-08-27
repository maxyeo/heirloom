import dagre from "@dagrejs/dagre";
import type { OrderConstraint } from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import { compareIds } from "./compare-ids";
import { connectedFamilies } from "./family-components";
import type { FamilyGraph, GraphChildLink, GraphPerson } from "./family-graph";
import { formatLifespan } from "./format-date";
import { compareByBirth } from "./person-detail";
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
 * The gap dagre leaves between one rank and the next, and the room a descent
 * bar has to move inside it. See {@link descentBarLevels} for what moves and
 * why.
 *
 * `DESCENT_STUB` is the straight run a line is guaranteed on each side of its
 * bar: below the union marker before the bar, and above the child's card
 * after it. It is also handed to `getSmoothStepPath` as its `offset` in
 * `components/DescentEdge.tsx`, and the two have to agree — that function
 * drops `offset` pixels from the source before it turns, so a bar closer than
 * `offset` to the marker is drawn by going down past it and back up.
 *
 * `DESCENT_BAR_STEP` is the most that separates two bars stacked on one rank.
 * Twelve pixels is three times the stroke and reads as two lines at every zoom
 * the canvas offers.
 *
 * A rank of 48 with a stub at each end leaves 24 to stack in, so three bars
 * take the full step and a fourth would not fit. {@link descentBarHeights}
 * answers that by tightening the step on the one rank that is crowded rather
 * than by growing `ranksep`, which is a graph-wide setting: no family should
 * be drawn a generation taller everywhere because one corner of it is dense.
 * The stubs are never given up, so a bar is always inside its own gap.
 */
const RANK_SEPARATION = 48;
export const DESCENT_STUB = 12;
const DESCENT_BAR_STEP = 12;

/**
 * How far apart two bars have to be to share a level.
 *
 * Two sibships whose bars merely fail to overlap can still be read as one
 * line if the gap between them is small enough to look like a join. 24 is
 * `nodesep`, the least dagre ever leaves between two things on a rank, so a
 * pair of bars this close are closer than any two cards on the canvas ever
 * are. Anything wider would stack bars a reader can already tell apart.
 */
const DESCENT_BAR_CLEARANCE = 24;

/**
 * The dash patterns, and what they mean (E10-T5).
 *
 * ## Why these are constants rather than two string literals in the loops
 *
 * They are the canvas's answer to "colour is never the only signal". Nothing
 * on this canvas has ever encoded a relationship in colour — every edge is
 * React Flow's own grey, and the qualification rides entirely on the dash —
 * which means the criterion is already met and the risk is the other
 * direction: somebody later "fixing" the readability of an ended marriage by
 * tinting it red, and quietly making the one channel a colour-blind reader
 * gets the one channel they do not. Naming the patterns here, reading them
 * back in `lib/tree-legend.ts`, and asserting in `lib/tree-layout.test.ts`
 * that no edge declares a `stroke` is what makes that a property of the code
 * rather than a habit.
 *
 * ## Why the two patterns differ from each other
 *
 * They mark two unrelated qualifications on two different kinds of line, and
 * a reader who has just learnt that a dashed line between partners means the
 * union ended should not read the same dash under a child and conclude the
 * child ended. The partner dash is long (`4 4`); the parentage dash is short
 * and tight (`2 3`). `components/TreeLegend.tsx` draws both at the size they
 * are actually rendered, from these same values, so the key cannot drift from
 * the drawing it explains.
 */
export const ENDED_UNION_DASH = "4 4";
export const NON_BIOLOGICAL_DASH = "2 3";

/**
 * What every edge says to a screen reader, which is nothing (E10-T5).
 *
 * ## Why silence is the right answer here and not a shortcut
 *
 * React Flow makes edges focusable by default and gives an unlabelled one the
 * name "Edge from <source> to <target>". Both halves are wrong for this
 * canvas. The ids are database UUIDs, so the default name is thirty-six
 * characters of hexadecimal read aloud twice; and the edges are rendered
 * *before* the nodes in the document, so leaving them focusable means a
 * keyboard has to cross every line in the family before it reaches the first
 * person. `components/FamilyTree.tsx` turns the focusability off at the
 * canvas — one switch for all of them — and this turns off what is left,
 * which is the element's own presence in the accessibility tree.
 *
 * Nothing is lost, because the edges are not where this application says what
 * a relationship is. Selecting a person opens `components/PersonPanel.tsx`,
 * which lists their partners, parents and children as words — "marriage,
 * 1931–1960, ended by death", "adopted" — through `describeUnion` and its
 * `Qualifier`. That is a better description than a line can carry, it is
 * reachable by the same keystroke that reaches the node, and it does not
 * repeat itself once per edge on a canvas with several hundred of them.
 *
 * So the edges are decoration in the strict sense the ARIA specification
 * means: the information is genuinely available elsewhere in the document.
 *
 * `aria-hidden` rather than `ariaRole: "presentation"`, and the difference is
 * not stylistic. React Flow writes an `aria-label` onto the edge whatever the
 * role says, and a global ARIA attribute on an element *negates* a
 * presentational role — the specification is explicit about it — so
 * `role="presentation"` here would be silently ignored and the UUIDs would
 * still be announced. `aria-hidden` takes the element and its subtree out of
 * the accessibility tree regardless of what else is on it, which is the only
 * one of the two that is true. It is safe for the same reason the switch in
 * `components/FamilyTree.tsx` is: nothing inside an edge is focusable once
 * `edgesFocusable` is off, and hiding focusable content is the one thing
 * `aria-hidden` must never do.
 */
const EDGE_A11Y = { domAttributes: { "aria-hidden": true } } as const;

/**
 * Which partner a reader should meet first, when the tree can tell them apart.
 *
 * Dagre has no notion of a couple. Left to itself it orders a rank to
 * minimise edge crossings, so which parent lands on the left is a by-product
 * of how the rest of the tree happened to fall — and it flips when a sibling,
 * a remarriage, or a child somewhere else entirely is added. That is fine as
 * a graph and wrong as a family tree, where "father on the left" is what most
 * Western charts have trained a reader to expect.
 *
 * The setting is *lead*, not *left*, on purpose. Father-on-the-left is the
 * Western convention; a traditional Chinese 族譜 is written in vertical
 * columns read right to left and puts the husband on the reader's right, so
 * the portable rule is "the leading partner comes first in reading order"
 * rather than "the father goes left". While this canvas is `rankdir: "TB"`
 * and left-to-right, first *is* leftmost, which is the one thing
 * {@link partnerOrderConstraints} would have to reverse for an RTL canvas.
 *
 * `neither` produces no constraints at all, which is what the tree did before
 * this existed.
 */
export type PartnerLead = "father" | "mother" | "neither";

/** Western convention, and what the tree did not previously guarantee. */
const DEFAULT_PARTNER_LEAD: PartnerLead = "father";

/**
 * Ask dagre to order each couple, as constraints for its ordering phase.
 *
 * Dagre takes `constraints` — `{ left, right }` pairs meaning *left sorts
 * before right within a rank* — and feeds them to the same constraint graph
 * that holds its own subgraph constraints, so they are honoured *by* crossing
 * minimisation rather than imposed on top of it. That is the whole reason to
 * express this as a constraint instead of swapping two x values after
 * `dagre.layout` returns: a swap silently discards the arrangement dagre
 * chose, while a constraint lets it find the best arrangement that satisfies
 * the couples. Everything else — ranks, routing, the position pass — is left
 * to dagre exactly as before.
 *
 * The pairs cannot contradict each other. Every constraint returned here puts
 * the leading sex on the left and the other on the right, and a person's sex
 * does not change between two of them, so no node is ever on both sides and
 * the constraint graph is bipartite by construction. A cycle would need some
 * constraint pointing the other way, and none does. That holds on its own;
 * the exclusions below narrow the set further, but nothing about acyclicity
 * rests on them.
 *
 * It is a claim about *these* pairs, though, and no longer about everything
 * dagre is handed: {@link siblingOrderConstraints} contributes pairs of its
 * own, and the two rules together can close a cycle where neither could
 * alone. {@link withoutCycles} is what keeps that off dagre, and it is why
 * being unable to contradict itself is worth something here — a set that
 * cannot conflict is a set nothing is ever dropped from.
 *
 * ## What a constraint assumes, and does not check
 *
 * Dagre applies a constraint only where both of its nodes turn up on one rank
 * — the constraint graph is consulted per layer, and a pair split across two
 * ranks is dropped in silence rather than raised. Nothing here checks for
 * that, because partners of one union are what dagre's ranker puts on a rank
 * together: it is fed an edge from each partner to their shared union node,
 * and the shallower partner is pulled down to meet the deeper one. Trees with
 * one partner's ancestry many generations deeper than the other's were tried
 * against this and held.
 *
 * So it is an assumption rather than a checked precondition, and worth
 * knowing which way it fails. A pair that did somehow rank apart would keep
 * dagre's own order — the couple simply goes unled, exactly as the two
 * exclusions below go unled. There is no arrangement in which a dropped
 * constraint draws a wrong tree, which is why this is documented rather than
 * guarded.
 *
 * ## What it declines to order
 *
 * **Couples the tree cannot tell apart.** One partner has to be `male` and
 * the other `female` for there to be a father and a mother to order.
 * Same-sex unions, and the very common half-entered couple whose second
 * partner is still `unknown`, get no constraint and keep dagre's own order.
 * Guessing would be worse than declining: it would be arbitrary, and a guess
 * that gets corrected later would move somebody who never needed to move.
 *
 * **Anybody partnered more than once.** A twice-married person sits *between*
 * their two unions — the reason unions are nodes at all, and the case
 * `lib/tree-layout.seed.test.ts` exists to guard. Constraining them to lead
 * both spouses would force them to the outside of the pair instead, dragging
 * one marriage's edge back across the canvas. Between two unions beats
 * father-left, so the couples in a remarriage keep dagre's order and only
 * partners who married once are led. In a typical tree that is nearly all of
 * them.
 *
 * Both exclusions are silent by design: there is nothing a reader could do
 * about either, and an unled couple is not an error, just an unled couple.
 */
function partnerOrderConstraints(
  graph: FamilyGraph,
  lead: PartnerLead,
): OrderConstraint[] {
  if (lead === "neither") return [];

  const leadingSex = lead === "father" ? "male" : "female";

  /**
   * How many unions each person partners in, so the second exclusion above
   * costs a lookup per union rather than a rescan of `graph.unions` per
   * partner.
   */
  const partnerships = new Map<string, number>();
  for (const union of graph.unions) {
    for (const id of [union.partnerAId, union.partnerBId]) {
      if (!id) continue;
      partnerships.set(id, (partnerships.get(id) ?? 0) + 1);
    }
  }

  const sexes = new Map(graph.people.map((person) => [person.id, person.sex]));
  const constraints: OrderConstraint[] = [];

  for (const union of graph.unions) {
    const { partnerAId, partnerBId } = union;
    if (!partnerAId || !partnerBId) continue;
    if (partnerships.get(partnerAId) !== 1) continue;
    if (partnerships.get(partnerBId) !== 1) continue;

    const sexA = sexes.get(partnerAId);
    const sexB = sexes.get(partnerBId);
    // A father and a mother, in some order, or no opinion. A same-sex union
    // fails the first line; `other` and `unknown` fail the other two.
    if (sexA === sexB) continue;
    if (sexA !== "male" && sexA !== "female") continue;
    if (sexB !== "male" && sexB !== "female") continue;

    const leads = sexA === leadingSex;
    // `left` is first in the rank's order, which is leftmost while the canvas
    // is LTR — the one line an RTL canvas would swap.
    constraints.push({
      left: leads ? partnerAId : partnerBId,
      right: leads ? partnerBId : partnerAId,
    });
  }

  return constraints;
}

/**
 * The child links in a fixed order, whatever order the rows arrived in.
 *
 * `getFamilyGraph` reads `union_children` with no `ORDER BY` — the one of its
 * three selects that has never had a reason to — so the same archive hands
 * this file its child links in whatever order Postgres felt like, and that
 * order is not inert. It reaches dagre twice over: as the order the
 * `union → child` edges are added to the graph in, which is an input to its
 * ordering heuristic, and as the order the sibships below are offered to
 * {@link withoutCycles} in, whose tie-break is first-offered-wins. Reversing
 * the four links of the archive `lib/tree-layout.test.ts` builds for the
 * cycle moved three people across the canvas.
 *
 * So the drawing was a function of the family *and* of a row order nobody
 * chose. Sorted here rather than in the query, because the property is owed
 * by a `FamilyGraph` assembled any other way too — an import preview, a
 * fixture in a test — and a layout that is a pure function of its argument is
 * the thing worth having. {@link compareIds} for the reason every other
 * tie-break in this file uses it: these ids are never read, so all the
 * comparison has to do is give the same answer on CI as on a laptop.
 */
function orderedChildLinks(graph: FamilyGraph): GraphChildLink[] {
  return [...graph.childLinks].sort(
    (a, b) =>
      compareIds(a.unionId, b.unionId) || compareIds(a.childId, b.childId),
  );
}

/**
 * Order each sibship oldest first, as constraints for the same ordering phase.
 *
 * A sibship is not a couple, but the problem is the one
 * {@link partnerOrderConstraints} solves and so is the mechanism. Dagre
 * arranges a rank to minimise crossings, so which of four siblings came out on
 * the left was decided by where their spouses and their children happened to
 * fall, and it moved when any of those moved. That is worse than arbitrary:
 * every family chart a reader has ever seen runs eldest to youngest, so an
 * order nothing chose still gets read as a claim about birth order, and was
 * usually wrong.
 *
 * The order itself is {@link compareByBirth}, imported rather than restated.
 * `lib/person-detail.ts` sorts a person's children with it for the detail
 * panel and `lib/person-infobox.ts` for the infobox, so a canvas ordering
 * siblings by a rule of its own would put two children one way round in the
 * picture and the other way round in the panel beside it. What it decides is
 * argued there: birth date first; the undated last rather than first, because
 * having no recorded date is not a claim to have been born early; then the
 * formatted name, then the id.
 *
 * It compares the *stored* date and nothing else, which is the right amount of
 * precision for this. A year-only birth is anchored to 1 January and sorts as
 * such — see `lib/format-date.ts` — so a brother recorded as 1903 leads a
 * sister recorded as 12 June 1903, and two siblings born in the same recorded
 * year come out in name order. Neither is a claim the layout is making; both
 * are the archive saying it does not know, and inventing an order from a
 * qualifier would be the layout claiming to know better.
 *
 * ## Why every pair, and not just neighbouring ones
 *
 * Eldest before second and second before third implies eldest before third,
 * so a chain would say this in three constraints where this says it in six.
 * It is the wrong economy, because dagre applies a constraint only where both
 * of its nodes turn up on one rank and drops it in silence otherwise — and a
 * sibship is not guaranteed to be on one rank.
 *
 * What splits one is a person who is a child of two unions a generation
 * apart. A daughter raised by her elder brother is recorded as a child of her
 * parents' union and an adopted child of his, and his union is a rank below
 * theirs, so she is ranked below the siblings she was born beside. That
 * fixture is in `lib/tree-layout.test.ts` and it does split, checked rather
 * than argued — as were two shapes that sound like they should and do not,
 * both of them a sibling marrying into a lineage recorded generations deeper.
 * Dagre answers those by moving the shallower *family* down together, and the
 * sibship stays whole.
 *
 * So it is one sibling in an uncommon position, and the difference is what
 * happens to the rest of her sibship. Every pair costs her the two pairs she
 * is in and leaves her brother and sister ordered by the pair between them. A
 * chain has nothing between them at all: both of its links ran through her,
 * both are dropped, and the two siblings still standing on the rank come out
 * in whatever order dagre reached for. Run against that fixture a chain does
 * exactly that — it lays the youngest out left of the eldest, which is the
 * arrangement with no constraints at all.
 *
 * The cost is a sibship squared, and a sibship is small: twelve children is a
 * large family and 66 constraints.
 */
function siblingOrderConstraints(graph: FamilyGraph): OrderConstraint[] {
  const people = new Map(graph.people.map((person) => [person.id, person]));

  /**
   * The children of each union, as people rather than links.
   *
   * Grouped by union rather than by parent, because a union *is* the sibship:
   * a person's children across two marriages are two families who never
   * shared a nursery, and dagre draws them under two different markers. A
   * child link naming somebody outside `graph.people` is skipped rather than
   * ordered on default dates, which cannot happen from `getFamilyGraph` — the
   * foreign key sees to that — and is not worth a wrong order if it ever does.
   */
  const sibships = new Map<string, GraphPerson[]>();

  // {@link orderedChildLinks}, so the sibships reach {@link withoutCycles} in
  // an order the rows cannot move.
  for (const link of orderedChildLinks(graph)) {
    const child = people.get(link.childId);
    if (!child) continue;
    const sibship = sibships.get(link.unionId);
    if (sibship) sibship.push(child);
    else sibships.set(link.unionId, [child]);
  }

  /**
   * Everybody each person is drawn beside: themselves, and their partners.
   *
   * ## Why a sibling is ordered with their spouse and not on their own
   *
   * A married sibling does not occupy a slot on the rank; their couple does.
   * Ordering the siblings alone leaves dagre a rank it has two partial orders
   * for — the siblings among themselves, the couples among themselves — and
   * no statement about how they fit together, so it is free to resolve the
   * gap by threading a sister in between a husband and his wife. Its
   * heuristic does exactly that, and what gives way is the couple: the
   * observed tree put a wife on her husband's left, which is the arrangement
   * `partnerOrderConstraints` exists to rule out.
   *
   * Naming the block closes the gap. "The eldest and his wife both come
   * before the second child" is a total order on the rank rather than two
   * partial ones, dagre has nothing left to resolve, and both rules come out
   * satisfied — checked against the fixture that used to reverse the couple,
   * where it now draws eldest, wife, youngest with the middle child ranked
   * away. That is also what the convention has always meant: a family chart
   * puts the children in birth order and each one's spouse beside them, not
   * the children in birth order and the spouses wherever they fit.
   *
   * ## What it does not assume
   *
   * A partner may be on another rank, in which case dagre drops the pair in
   * silence, exactly as it drops any cross-rank constraint. A partner may be
   * married twice, in which case both spouses join the block and the whole
   * group stays on one side of the next sibling — which is what should happen
   * to a remarriage, and does not disturb {@link partnerOrderConstraints}'
   * separate decision to leave a twice-married person unled. And a spouse who
   * is also a sibling somewhere on the same rank can be pulled two ways at
   * once; that is a contradiction rather than a disaster, and
   * {@link withoutCycles} settles it.
   */
  const partners = new Map<string, string[]>();
  for (const union of graph.unions) {
    const { partnerAId, partnerBId } = union;
    if (!partnerAId || !partnerBId) continue;
    for (const [person, partner] of [
      [partnerAId, partnerBId],
      [partnerBId, partnerAId],
    ]) {
      const known = partners.get(person);
      if (known) known.push(partner);
      else partners.set(person, [partner]);
    }
  }

  const blockOf = (id: string): string[] => [id, ...(partners.get(id) ?? [])];

  const constraints: OrderConstraint[] = [];

  for (const sibship of sibships.values()) {
    if (sibship.length < 2) continue;

    const eldestFirst = [...sibship].sort(compareByBirth);
    for (let older = 0; older < eldestFirst.length; older++) {
      for (let younger = older + 1; younger < eldestFirst.length; younger++) {
        for (const left of blockOf(eldestFirst[older].id)) {
          for (const right of blockOf(eldestFirst[younger].id)) {
            // `left` is first in the rank's order, which is leftmost while the
            // canvas is LTR — the same line an RTL canvas would swap in
            // {@link partnerOrderConstraints}.
            constraints.push({ left, right });
          }
        }
      }
    }
  }

  return constraints;
}

/**
 * Drop any constraint that would close a cycle, keeping the earlier one.
 *
 * ## What a cycle costs
 *
 * Dagre resolves constraints one rank at a time with a Kahn-style pass:
 * entries with no unsatisfied predecessor are released in turn, and anything
 * still waiting when the pass runs dry is dropped from that rank's order
 * altogether. Nothing is reported either way, and the two observed outcomes
 * are both worse than an unordered pair.
 *
 * The ordinary one is that dagre resolves the contradiction its own way and
 * *some* constraint is lost — not the one this module would have chosen. Fed
 * the fixture `lib/tree-layout.test.ts` builds for it, dagre discarded the
 * couple and kept the siblings, so a cycle in one corner of an archive
 * quietly un-fathers a marriage in that corner. Constraints exist to take
 * that decision away from whatever arrangement dagre happened to reach; a
 * cycle hands it straight back.
 *
 * The other is that the stranded nodes come back from `dagre.layout` with no
 * coordinates at all, and the failure surfaces phases later as `Not possible
 * to find intersection inside of the rectangle` thrown out of edge routing —
 * observed on dagre 3.1.1 by handing it a two-cycle directly, rather than
 * reasoned about. No family shape reached that through this layout, and the
 * reason it did not is thin: every cycle contains a partner constraint, so
 * its nodes have a union node under them, and the barycenter that gives them
 * is enough for dagre to merge the conflict instead of stranding it. Thin
 * enough to be worth knowing, because the throw would happen inside the
 * `useMemo` in `components/FamilyTree.tsx` and what a reader would get is not
 * a tree with two siblings the wrong way round. It is no tree.
 *
 * ## Where a cycle comes from
 *
 * Neither set of constraints can hold one on its own: the partner set is
 * bipartite by construction, and every sibling constraint points from earlier
 * to later in a single total order. So a cycle takes both kinds, and at least
 * one partner constraint pointing against birth order.
 *
 * Nothing exotic is needed for that. A child linked to two unions — an
 * adoption recorded beside a birth, which the schema has always allowed and
 * `lib/person-detail.ts` treats as ordinary — belongs to two sibships that
 * may share nobody else. A man from one of them marrying a woman from the
 * other, no blood between them, closes the loop: he leads her because he is
 * the father, she precedes his adoptive brother because she was born first,
 * and the brother precedes him. Marrying an actual sibling does it in one
 * step, and half a dozen royal lines in the historical record did exactly
 * that.
 *
 * So this is a guarantee, not a defence. The alternative is a proof that no
 * family can produce a cycle, which is a proof about genealogy, and genealogy
 * would eventually win it — the more so because much of what reaches this
 * schema arrives through `lib/gedcom-import.ts` from files this project did
 * not write.
 *
 * ## Which constraint gives way
 *
 * The first one, so the caller orders the list by what it cares about most.
 * {@link orderConstraints} puts the partners in front, and because they
 * cannot conflict with each other none of them is ever dropped here. What
 * gives way is one sibling pair, which leaves those two in dagre's own order
 * — the same thing that happens to a pair split across two ranks, and the
 * same non-event.
 *
 * That is a promise about this filter and not, on its own, about the drawing.
 * A constraint this function keeps is one dagre is *asked* for, and dagre
 * satisfies what it can rank by rank with a heuristic rather than a solver —
 * so a rank it cannot see how to satisfy is a rank where something gives way
 * whatever this list says. That is not hypothetical: asked for the couples
 * and for the siblings *as bare pairs of people*, it reversed 181 of 2579
 * couples across the trees `lib/tree-layout.test.ts` generates, and one of
 * them was reported from a real archive. What fixed it was not a priority
 * here — there is none to hand dagre — but asking for something it can
 * satisfy, which is what the blocks in {@link siblingOrderConstraints} are
 * for. The same couples now come out father-first, every one.
 */
function withoutCycles(constraints: OrderConstraint[]): OrderConstraint[] {
  /** Everything each node has been constrained to precede, so far. */
  const followers = new Map<string, string[]>();
  const kept: OrderConstraint[] = [];

  /** Whether `from` already has to precede `to`, directly or through others. */
  const precedes = (from: string, to: string): boolean => {
    const seen = new Set([from]);
    const pending = [from];

    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (at === to) return true;
      for (const next of followers.get(at) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }

    return false;
  };

  for (const constraint of constraints) {
    const { left, right } = constraint;
    // A node constrained to precede itself is a cycle of one, and dagre loses
    // it the same way it loses a cycle of two. Two child links naming the same
    // person in the same union are all it would take.
    if (left === right) continue;
    if (precedes(right, left)) continue;

    kept.push(constraint);
    const following = followers.get(left);
    if (following) following.push(right);
    else followers.set(left, [right]);
  }

  return kept;
}

/**
 * Every opinion this layout has about the order a rank comes out in.
 *
 * One function rather than two calls at the layout, because the two sets are
 * not independent. They reach dagre as a single list, they can contradict
 * each other, and {@link withoutCycles} settles it in favour of whichever
 * comes first — a tie-break that belongs beside the two rules it arbitrates
 * rather than in the middle of the layout, where nobody reading either rule
 * would find it.
 */
function orderConstraints(
  graph: FamilyGraph,
  lead: PartnerLead,
): OrderConstraint[] {
  return withoutCycles([
    ...partnerOrderConstraints(graph, lead),
    ...siblingOrderConstraints(graph),
  ]);
}

/**
 * One union's descent: the horizontal bar under the marker that its children
 * hang from, measured in dagre's coordinates.
 *
 * `left` and `right` are the ends of the horizontal run — the leftmost and
 * rightmost of the marker's own centre and its children's centres, because
 * the line has to reach from the drop under the marker out to the drop above
 * each child. `midY` is where the bar sits when nothing is in its way: midway
 * between the bottom of the marker and the top of the nearest child, which is
 * where `smoothstep` put every bar before this existed. `room` is the distance
 * between those two, which is what a stack of bars has to fit inside.
 */
interface DescentBar {
  unionId: string;
  /** The marker's rank, as its dagre centre — the key bars are stacked by. */
  rankY: number;
  left: number;
  right: number;
  midY: number;
  room: number;
}

/**
 * Where each union's children hang from, before any stacking.
 *
 * Unions with no children get no bar: they draw no descent at all. So does a
 * union whose whole descent is a single vertical drop — one child, directly
 * below the marker — because a bar with no horizontal run cannot be confused
 * with anybody else's. Letting those reserve a level would push real bars
 * apart to separate a line that is not drawn.
 */
function descentBars(
  graph: FamilyGraph,
  laidOut: (id: string) => { x: number; y: number },
): DescentBar[] {
  const children = new Map<string, string[]>();
  for (const link of orderedChildLinks(graph)) {
    const known = children.get(link.unionId);
    if (known) known.push(link.childId);
    else children.set(link.unionId, [link.childId]);
  }

  const bars: DescentBar[] = [];
  for (const union of graph.unions) {
    const kids = children.get(union.id);
    if (!kids) continue;

    const marker = laidOut(union.id);
    let left = marker.x;
    let right = marker.x;
    let nearestTop = Infinity;
    for (const childId of kids) {
      const child = laidOut(childId);
      left = Math.min(left, child.x);
      right = Math.max(right, child.x);
      nearestTop = Math.min(nearestTop, child.y - PERSON_HEIGHT / 2);
    }

    // A drop with no horizontal run. Sub-pixel rather than exact, because
    // these are dagre's arithmetic and not round numbers.
    if (right - left < 1) continue;

    const markerBottom = marker.y + UNION_SIZE / 2;
    bars.push({
      unionId: union.id,
      rankY: marker.y,
      left,
      right,
      midY: (markerBottom + nearestTop) / 2,
      room: nearestTop - markerBottom,
    });
  }

  return bars;
}

/**
 * Stack the bars on each rank so no two sibships are drawn as one line.
 *
 * ## The drawing this fixes
 *
 * Every descent bar on a rank was drawn at the same height, because
 * `smoothstep` bends each edge halfway between its ends and every union on a
 * rank has the same halfway. Where two of those runs overlapped they merged
 * into one unbroken horizontal line with a drop hanging under each child, and
 * the picture said something false: that all of the parents above were the
 * parents of all of the children below. Reported from the archive as "it
 * looks like my parents have four parents", which is exactly what an
 * unbroken line with two markers on it and four drops under it draws.
 *
 * Overlap is not exotic and it is not a mistake upstream. A married middle
 * child sits beside their spouse — {@link siblingOrderConstraints} puts them
 * there deliberately, and every family chart does — so the spouse stands
 * between two siblings, and the sibship's bar has to reach over them to the
 * younger one. The spouse's own parents are a union on the same rank, and
 * their bar runs underneath. Two bars, one inside the other, at one height.
 *
 * ## The order they stack in
 *
 * Widest first, so a sibship that spans another gets the higher bar. Then no
 * child's drop ever passes through a bar it does not belong to: the drops
 * from the outer bar reach past the inner one on both sides, and the drops
 * from the inner bar stop below the outer one without touching it. In the
 * reported family that leaves the picture with no crossings at all.
 *
 * What can still cross is a *marker's* drop, when its bar is below a wider
 * one that spans it. That crossing is unavoidable — the marker is inside the
 * other sibship's span, and any bar below the top level is reached by
 * crossing it — and it is the better of the two places to spend it, because a
 * reader traces a line down from a couple far less often than they trace one
 * up from a person. A crossing is also not a junction: it is drawn as one
 * line passing over another, where a child that belongs to a bar meets it in
 * a corner.
 *
 * Ties in width break on the left end and then on the id, so the levels are
 * the same on CI as on a laptop — {@link compareIds}, for the reason given
 * there.
 *
 * ## Why greedy is enough
 *
 * Levels are assigned by taking the first one where the bar clears
 * everything already on it, which is the standard colouring of an interval
 * graph and gives the fewest levels a set of intervals can be drawn in when
 * they are taken in a sorted order. The count matters because it is what
 * `ranksep` has to pay for; the arrangement matters because it is what a
 * reader sees; and both come out of the same pass.
 */
function descentBarLevels(bars: DescentBar[]): Map<string, number> {
  const clear = (a: DescentBar, b: DescentBar) =>
    a.right + DESCENT_BAR_CLEARANCE < b.left ||
    b.right + DESCENT_BAR_CLEARANCE < a.left;

  const byRank = new Map<number, DescentBar[]>();
  for (const bar of bars) {
    const known = byRank.get(bar.rankY);
    if (known) known.push(bar);
    else byRank.set(bar.rankY, [bar]);
  }

  const levels = new Map<string, number>();
  for (const rank of byRank.values()) {
    const widestFirst = [...rank].sort(
      (a, b) =>
        b.right - b.left - (a.right - a.left) ||
        a.left - b.left ||
        compareIds(a.unionId, b.unionId),
    );

    const taken: DescentBar[][] = [];
    for (const bar of widestFirst) {
      let level = 0;
      while (taken[level]?.some((other) => !clear(bar, other))) level++;
      (taken[level] ??= []).push(bar);
      levels.set(bar.unionId, level);
    }
  }

  return levels;
}

/**
 * The height each bar is actually drawn at, from its level.
 *
 * ## Where the stack sits
 *
 * Centred on {@link DescentBar.midY} rather than hung from the top of the
 * gap, so a rank that needs one level draws exactly where the canvas drew
 * before this existed, and a rank that needs three spreads symmetrically
 * around the same line instead of sliding every bar upwards. Per rank, from
 * that rank's own level count: a rank with one sibship is not spread apart
 * because some other generation has three.
 *
 * ## What a crowded rank gives up
 *
 * The step, and never the stubs. Three levels fit the ordinary 48-pixel gap
 * at the full {@link DESCENT_BAR_STEP}; a fourth would have to come out of
 * the straight run above the children's cards, which is the one part of the
 * drawing that says which bar a child belongs to. So the step is whatever
 * divides that rank's room evenly, capped at 12, and a rank deep enough to
 * need it draws its bars closer together rather than pushing every other
 * generation apart.
 *
 * ## Why one line per rank and not one per bar
 *
 * Both the room and the centre are the *smallest* on the rank rather than
 * each bar's own. Two bars on one rank can want different heights: `midY` is
 * measured to a union's nearest child, and a union with a child ranked
 * further down than its siblings — the adopted-daughter case in
 * `lib/tree-layout.test.ts` — has no child on the rank below at all. Stacking
 * each around its own midpoint is what a level cannot then promise anything
 * about, because two levels centred twelve pixels apart can land on the same
 * line and merge, which is the drawing this exists to prevent. One centre and
 * one band per rank makes the level the whole answer.
 *
 * The smallest of each is the safe one: every marker on a rank has the same
 * bottom, so taking the shallowest bar's room and centre keeps the stack
 * clear of the nearest card on the rank, and therefore of every other.
 */
function descentBarHeights(bars: DescentBar[]): Map<string, number> {
  const levels = descentBarLevels(bars);

  const countByRank = new Map<number, number>();
  const roomByRank = new Map<number, number>();
  const centreByRank = new Map<number, number>();
  for (const bar of bars) {
    const level = levels.get(bar.unionId) ?? 0;
    countByRank.set(
      bar.rankY,
      Math.max(countByRank.get(bar.rankY) ?? 1, level + 1),
    );
    roomByRank.set(
      bar.rankY,
      Math.min(roomByRank.get(bar.rankY) ?? Infinity, bar.room),
    );
    centreByRank.set(
      bar.rankY,
      Math.min(centreByRank.get(bar.rankY) ?? Infinity, bar.midY),
    );
  }

  const heights = new Map<string, number>();
  for (const bar of bars) {
    const level = levels.get(bar.unionId) ?? 0;
    const gaps = (countByRank.get(bar.rankY) ?? 1) - 1;
    const band = Math.max(
      0,
      (roomByRank.get(bar.rankY) ?? 0) - 2 * DESCENT_STUB,
    );
    const step = gaps === 0 ? 0 : Math.min(DESCENT_BAR_STEP, band / gaps);
    const centre = centreByRank.get(bar.rankY) ?? bar.midY;
    heights.set(bar.unionId, centre - (gaps * step) / 2 + level * step);
  }

  return heights;
}

/**
 * Family trees are layered DAGs, not trees: a person can be a partner in more
 * than one union, so they have more than one downward path. `d3-tree` assumes
 * a single parent slot per node and cannot represent that. Dagre lays out
 * layered graphs, which is exactly the right shape — generation becomes rank.
 *
 * Unions are rendered as their own small nodes. That is what lets a twice-
 * married person sit between both of their unions instead of being duplicated.
 *
 * What dagre will not decide is the order across a rank — which partner of a
 * couple goes on which side, and which of four siblings comes first — so
 * {@link orderConstraints} tells it.
 *
 * @param options.partnerLead which partner a reader meets first, defaulting
 *   to {@link DEFAULT_PARTNER_LEAD}. See {@link PartnerLead}.
 */
export function layoutFamilyGraph(
  graph: FamilyGraph,
  options: { partnerLead?: PartnerLead } = {},
): {
  nodes: Node[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "TB",
    ranksep: RANK_SEPARATION,
    nodesep: 24,
    edgesep: 12,
  });
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
            : { strokeDasharray: ENDED_UNION_DASH },
        ...EDGE_A11Y,
      });
    }
  }

  for (const link of orderedChildLinks(graph)) {
    g.setEdge(link.unionId, link.childId);
  }

  dagre.layout(g, {
    constraints: orderConstraints(
      graph,
      options.partnerLead ?? DEFAULT_PARTNER_LEAD,
    ),
  });

  /**
   * Where each union's children hang from. A union missing from this draws no
   * horizontal run at all — see {@link descentBars} — and its edge falls back
   * to the bend `smoothstep` would have chosen on its own.
   */
  const barHeights = descentBarHeights(descentBars(graph, (id) => g.node(id)));

  for (const link of orderedChildLinks(graph)) {
    const barY = barHeights.get(link.unionId);
    edges.push({
      id: `c-${link.unionId}-${link.childId}`,
      source: link.unionId,
      target: link.childId,
      type: "descent",
      data: barY === undefined ? undefined : { barY },
      style:
        link.relation === "biological"
          ? undefined
          : { strokeDasharray: NON_BIOLOGICAL_DASH },
      ...EDGE_A11Y,
    });
  }

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
        portraitSrc: portraitSrc(portrait),
      },
      // Nodes are focusable by default, so a keyboard reaches every person
      // without help — but only the wrapper div is in the tab order, and it
      // has no text of its own. Without this a screen reader announces
      // "group, node" thirty times over.
      ariaLabel: lifespan ? `${name}, ${lifespan}` : name,
    });
  }

  /**
   * Reading order, which on this canvas *is* the tab order (E10-T5).
   *
   * React Flow renders nodes in the order of the array it is given and puts
   * `tabIndex={0}` on each one, so the browser's own sequential navigation
   * walks this array. Left alone it is `graph.people`, which is the order
   * `getFamilyGraph` returned rows in — surname, then given name. Tabbing a
   * family therefore jumped between generations alphabetically: in the
   * three-person tree `components/FamilyTree.test.tsx` builds, the first stop
   * is the daughter, then her mother, then her father.
   *
   * Sorting by rank and then by position across it makes the tab order the
   * order the tree is drawn in — each generation left to right, oldest first
   * — which is what a reader has already been told the picture means. That is
   * deliberately *not* a tab order bolted on beside React Flow's: nothing
   * here sets a `tabindex`, intercepts a key, or maintains a cursor. The
   * library's own sequential order is used, and the only thing changed is the
   * order of the array it reads.
   *
   * `y` before `x` because dagre ranks top to bottom and every person is the
   * same height, so within a generation `y` is identical and `x` decides. The
   * id is the last tiebreak so that two people laid out at exactly the same
   * point — which dagre will not do, but which nothing here guarantees —
   * still come out in a stable order rather than one that depends on the sort
   * being stable.
   *
   * ## Why the family comes before the rank (`YEO-103`)
   *
   * `y` alone is the reading order of *one* tree, and it was written when the
   * fixtures were all one tree. Dagre ranks each connected component from its
   * own root, so two families nobody has joined both start at rank 0 and their
   * generations come out shuffled together — `a1, b1, a2, b2, a3` for the
   * chains `a1→a2→a3` and `b1→b2`, confirmed against dagre rather than reasoned
   * about. Tab then alternates between two unrelated lineages, and the
   * generation-by-generation promise this docblock makes quietly stops holding.
   *
   * That is reachable rather than theoretical: `app/tree/page.tsx` puts the
   * entire archive on one canvas, and disconnected people are a state
   * `lib/tree-onboarding.ts` names rather than an invalid one.
   *
   * So the key grows a term in front of it — which family, then the rank
   * inside that family, then across it. Which family is which, in what order,
   * and where somebody joined to nobody goes are all
   * {@link connectedFamilies}' decisions, argued there. On a single-tree
   * canvas the new term is the same number for everybody and the order is
   * exactly the one E10-T5 left, which is why the two tests it added still
   * pass untouched.
   */
  const families = connectedFamilies(graph);
  const familyOf = new Map<string, number>();
  families.forEach((members, index) => {
    for (const id of members) familyOf.set(id, index);
  });

  /**
   * A default rather than a `!`, though nothing can reach it: `familyOf` is
   * built from the same `graph.people` these nodes were built from. If a
   * later caller ever sorts a node this map has not heard of, sorting it to
   * the end is a canvas somebody can still read; throwing is not.
   */
  const family = (node: Node) => familyOf.get(node.id) ?? families.length;

  /**
   * The last term is {@link compareIds}, not `localeCompare` (`YEO-111`).
   *
   * It is a backstop rather than a term that decides much: dagre gives two
   * people in the same family distinct coordinates — siblings on one rank
   * come out a node-width apart — so `y` and `x` have settled the order
   * before this is reached. It is here because "distinct coordinates" is
   * dagre's behaviour rather than dagre's promise, and a sort whose last word
   * is a coin toss is not the deterministic one `YEO-103` asked for.
   *
   * Which makes *what* it compares with a question worth answering rather
   * than inheriting. `localeCompare` reads whatever collation data the
   * process was built with, so it can order two ids one way on a laptop and
   * the other way on CI; code units are fixed by the language. The argument
   * in full — including the two specific comparisons elsewhere in the
   * repository that keep `localeCompare` on purpose, and why those are
   * different from this one — is on {@link compareIds} in
   * `lib/compare-ids.ts`.
   *
   * Sharing that comparator with `lib/family-components.ts`, both importing
   * it from `lib/compare-ids.ts` rather than each writing its own, is the
   * point rather than an economy. The family term above comes from
   * {@link connectedFamilies}, which ranks families by their smallest member
   * id; if the two files disagreed about which of two ids is smaller, the
   * canvas would order families by one rule and their members by another.
   */
  nodes.sort(
    (a, b) =>
      family(a) - family(b) ||
      a.position.y - b.position.y ||
      a.position.x - b.position.x ||
      compareIds(a.id, b.id),
  );

  /**
   * The union markers go on the end rather than into the order above, and it
   * costs nothing: they are `focusable: false`, so they are not tab stops to
   * be sequenced, and they are 14 pixels of connector that overlap nothing,
   * so their paint order does not matter either.
   */
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
