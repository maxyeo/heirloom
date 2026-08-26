import type { FamilyGraph } from "./family-graph";
import { ENDED_UNION_DASH, NON_BIOLOGICAL_DASH } from "./tree-layout";

/**
 * The key to the canvas's lines (E10-T5).
 *
 * ## The criterion this answers, and the half of it that was already true
 *
 * "Colour is never the only signal — dashed edges already carry meaning, and
 * that meaning must survive without colour." The first half of that was
 * already the case and is defended where the patterns are declared, in
 * `lib/tree-layout.ts`: no edge on this canvas has ever had a colour of its
 * own, so a reader who cannot distinguish two hues loses nothing at all.
 *
 * The half that was missing is the one that only shows up when you sit
 * somebody in front of the tree: **a dash is a signal nobody has been told
 * how to read.** A line under a child is drawn a little differently and there
 * is nowhere on the screen that says the child was adopted. The information
 * is in the detail panel, one selection away, which is fine for somebody
 * looking a person up and no use at all to somebody looking at the shape of a
 * family. Making a non-colour channel legible is the same work as adding one.
 *
 * ## Why the key is derived from the family rather than fixed
 *
 * Most trees have no dashed line in them, and a permanent four-row key in the
 * corner of a canvas that has nothing to explain is furniture. So the rule is:
 *
 *   - a family with nothing qualified on it gets **no key at all**;
 *   - a family with an ended union gets the two union rows, so the dash has
 *     the unbroken line to be read against;
 *   - a family with an adopted, step or foster child gets the two child rows,
 *     for the same reason;
 *   - and a row is only ever offered for a line that is actually drawn — the
 *     unbroken partner line is left out of a family whose every union ended,
 *     because a key entry for a line nobody can point at explains nothing.
 *
 * This is a plain function over a `FamilyGraph` for the reason
 * docs/testing.md gives for preferring no DOM: which rows a family earns is
 * the whole of the logic, and it is all assertable without rendering
 * anything. `components/TreeLegend.tsx` draws whatever comes back.
 */

/** Which line a row explains. Distinct so a test can name one. */
export type TreeLegendEntryId =
  "union" | "union-ended" | "child" | "child-other";

/** One row of the key: a line drawn the way the canvas draws it, and words. */
export interface TreeLegendEntry {
  id: TreeLegendEntryId;
  /**
   * The `stroke-dasharray` to draw the sample with, or `null` for an unbroken
   * line.
   *
   * Carried through from `lib/tree-layout.ts` rather than restated, so the key
   * cannot end up describing a dash the canvas stopped drawing. That is not a
   * hypothetical: the two patterns differ from each other on purpose, and a
   * key that drew one sample for both would quietly undo the reason they do.
   */
  dash: string | null;
  /** What the line means, in the vocabulary `PersonPanel` already uses. */
  label: string;
}

/**
 * The rows this family earns, in the order they should be read.
 *
 * Unions before children, which is the order the canvas draws them in going
 * down the page, and unbroken before dashed within each pair, so that each
 * dash is introduced immediately after the line it is a variation on.
 *
 * @param graph the family being drawn
 * @returns the key, or an empty array when there is nothing to explain
 */
export function treeLegend(graph: FamilyGraph): TreeLegendEntry[] {
  const entries: TreeLegendEntry[] = [];

  const endedUnions = graph.unions.filter(
    (union) => union.endReason !== "ongoing",
  );
  if (endedUnions.length > 0) {
    if (endedUnions.length < graph.unions.length) {
      entries.push({
        id: "union",
        dash: null,
        label: "Marriage or partnership",
      });
    }
    entries.push({
      id: "union-ended",
      dash: ENDED_UNION_DASH,
      label: "One that ended, by death, divorce or separation",
    });
  }

  const otherChildren = graph.childLinks.filter(
    (link) => link.relation !== "biological",
  );
  if (otherChildren.length > 0) {
    if (otherChildren.length < graph.childLinks.length) {
      entries.push({ id: "child", dash: null, label: "Child" });
    }
    entries.push({
      id: "child-other",
      dash: NON_BIOLOGICAL_DASH,
      label: "A child who was adopted, a stepchild or fostered",
    });
  }

  return entries;
}
