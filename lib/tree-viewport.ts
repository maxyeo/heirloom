/**
 * The geometry behind one acceptance criterion of E2-T1: *the panel does not
 * obscure the selected node — pan the canvas if needed*.
 *
 * It lives here, away from the component, because it is arithmetic rather than
 * rendering: every input is a rectangle and the output is a translation. That
 * makes the awkward cases — a node already visible, a node off-screen, a panel
 * wider than the space left over — assertable in plain Node with no DOM and no
 * React Flow instance (docs/testing.md: "prefer no DOM").
 *
 * Everything below is in **screen pixels**, which is also the unit React
 * Flow's viewport translation is in. Working in flow coordinates would mean
 * dividing by the zoom on the way in and multiplying on the way out, and the
 * panel — a fixed slab of chrome — has no flow coordinates at all.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** How much clear space to leave between the node and the edge of the region. */
export const REVEAL_PADDING = 24;

/**
 * The part of the canvas the panel is not sitting on top of.
 *
 * The panel is an edge slab: it spans the canvas fully in one axis and eats
 * into the other. Which axis it eats is a layout decision made in CSS — a
 * side panel on a wide viewport, a bottom sheet on a narrow one — so this
 * reads the axis off the measured rectangles instead of being told, and the
 * component keeps its breakpoints in one place rather than two.
 *
 * Anything that is not an edge slab (a floating panel, a panel that misses the
 * canvas entirely) returns the canvas unchanged. Guessing at a subtraction
 * that leaves an L-shape would be worse than not panning at all.
 */
export function unobscuredRegion(canvas: Rect, panel: Rect | null): Rect {
  if (!panel || panel.width <= 0 || panel.height <= 0) return canvas;

  const canvasRight = canvas.x + canvas.width;
  const canvasBottom = canvas.y + canvas.height;
  const panelRight = panel.x + panel.width;
  const panelBottom = panel.y + panel.height;

  const spansHeight = panel.y <= canvas.y && panelBottom >= canvasBottom;
  const spansWidth = panel.x <= canvas.x && panelRight >= canvasRight;

  // A panel covering the whole canvas leaves nothing to pan into, so the
  // caller is better off with the canvas and no movement than with a region
  // of zero width that sends the node somewhere arbitrary.
  if (spansHeight && spansWidth) return canvas;

  if (spansHeight) {
    if (panelRight >= canvasRight && panel.x > canvas.x) {
      return { ...canvas, width: panel.x - canvas.x };
    }
    if (panel.x <= canvas.x && panelRight < canvasRight) {
      return { ...canvas, x: panelRight, width: canvasRight - panelRight };
    }
    return canvas;
  }

  if (spansWidth) {
    if (panelBottom >= canvasBottom && panel.y > canvas.y) {
      return { ...canvas, height: panel.y - canvas.y };
    }
    if (panel.y <= canvas.y && panelBottom < canvasBottom) {
      return { ...canvas, y: panelBottom, height: canvasBottom - panelBottom };
    }
  }

  return canvas;
}

/**
 * How far to move the canvas so `node` sits inside `region`.
 *
 * Minimal on purpose: a node that is already comfortably inside returns
 * `{ dx: 0, dy: 0 }` and the viewport is left alone. Clicking a node the
 * panel was never going to cover should not shove the tree sideways — the
 * layout the reader is looking at is the thing they are navigating by.
 */
export function panToReveal(
  node: Rect,
  region: Rect,
  padding = REVEAL_PADDING,
): { dx: number; dy: number } {
  return {
    dx: axisShift(node.x, node.width, region.x, region.width, padding),
    dy: axisShift(node.y, node.height, region.y, region.height, padding),
  };
}

function axisShift(
  nodeStart: number,
  nodeSize: number,
  regionStart: number,
  regionSize: number,
  padding: number,
): number {
  const min = regionStart + padding;
  const max = regionStart + regionSize - padding - nodeSize;

  // Too little room to honour the padding — a big node, a narrow phone, or
  // both. Centring is the best available answer: the node is as far from
  // being covered as the space allows, which is what the criterion is
  // actually asking for.
  if (max < min) return regionStart + (regionSize - nodeSize) / 2 - nodeStart;

  if (nodeStart < min) return min - nodeStart;
  if (nodeStart > max) return max - nodeStart;
  return 0;
}

/** `DOMRect` narrowed to the four numbers this module uses. */
export function toRect(rect: DOMRectReadOnly): Rect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}
