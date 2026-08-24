import { describe, expect, it } from "vitest";

import {
  REVEAL_PADDING,
  panToReveal,
  unobscuredRegion,
  type Rect,
} from "@/lib/tree-viewport";

/** A 1000×600 canvas at the origin, which every case below panels differently. */
const canvas: Rect = { x: 0, y: 0, width: 1000, height: 600 };

/** The wide-viewport layout: a 320px slab down the right-hand edge. */
const sidePanel: Rect = { x: 680, y: 0, width: 320, height: 600 };

/** The narrow-viewport layout: a sheet across the bottom. */
const bottomSheet: Rect = { x: 0, y: 360, width: 1000, height: 240 };

describe("unobscuredRegion", () => {
  it("is the whole canvas when no panel is open", () => {
    expect(unobscuredRegion(canvas, null)).toEqual(canvas);
  });

  it("takes the width a right-hand panel covers", () => {
    expect(unobscuredRegion(canvas, sidePanel)).toEqual({
      x: 0,
      y: 0,
      width: 680,
      height: 600,
    });
  });

  it("takes the height a bottom sheet covers", () => {
    // Which axis the panel eats is a CSS breakpoint decision, so this is read
    // off the measured rectangles rather than passed in. Getting it from one
    // place means the component keeps its layout in one place too.
    expect(unobscuredRegion(canvas, bottomSheet)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 360,
    });
  });

  it("handles a panel on the leading edge too", () => {
    expect(
      unobscuredRegion(canvas, { x: 0, y: 0, width: 320, height: 600 }),
    ).toEqual({ x: 320, y: 0, width: 680, height: 600 });
  });

  it("measures against a canvas that is not at the origin", () => {
    // The rectangles come from `getBoundingClientRect`, so the canvas sits
    // wherever the page header left it. Treating its top-left as (0, 0) would
    // pan the tree by exactly the height of the header.
    const offset: Rect = { x: 40, y: 80, width: 1000, height: 600 };
    const panel: Rect = { x: 720, y: 80, width: 320, height: 600 };

    expect(unobscuredRegion(offset, panel)).toEqual({
      x: 40,
      y: 80,
      width: 680,
      height: 600,
    });
  });

  it("gives up rather than guess at an L-shape", () => {
    // A panel that is neither a full-height nor a full-width slab would leave
    // a region no rectangle describes. Returning the canvas means no pan,
    // which is a better answer than panning to a made-up box.
    const floating: Rect = { x: 400, y: 200, width: 200, height: 100 };

    expect(unobscuredRegion(canvas, floating)).toEqual(canvas);
  });

  it("gives up when the panel covers everything", () => {
    expect(unobscuredRegion(canvas, canvas)).toEqual(canvas);
  });
});

describe("panToReveal", () => {
  const node: Rect = { x: 0, y: 0, width: 176, height: 64 };
  const region = unobscuredRegion(canvas, sidePanel);

  it("leaves a node that is already clear exactly where it is", () => {
    // Clicking a node the panel was never going to cover must not shove the
    // tree sideways — the layout on screen is what the reader navigates by.
    expect(panToReveal({ ...node, x: 300, y: 250 }, region)).toEqual({
      dx: 0,
      dy: 0,
    });
  });

  it("slides a node out from under the panel, and no further", () => {
    // Its right edge lands on the region's inner edge: 680 - 24 - 176 = 480.
    const covered = { ...node, x: 700, y: 250 };

    expect(panToReveal(covered, region)).toEqual({ dx: -220, dy: 0 });
    expect(covered.x - 220 + covered.width).toBe(
      region.width - REVEAL_PADDING,
    );
  });

  it("brings a node back that is off the canvas entirely", () => {
    // Following a link to a great-aunt three generations away is exactly this
    // case: nothing is covering her, she is simply not on screen.
    expect(panToReveal({ ...node, x: -900, y: 1400 }, region)).toEqual({
      dx: 924,
      dy: -888,
    });
  });

  it("moves in both axes at once when both are wrong", () => {
    const { dx, dy } = panToReveal({ ...node, x: 900, y: -100 }, region);

    expect(dx).toBeLessThan(0);
    expect(dy).toBeGreaterThan(0);
  });

  it("centres a node in a region too small to pad it", () => {
    // A phone with the sheet open, or a region narrower than one node. There
    // is no position that satisfies the padding, and centring is the closest
    // thing to "not obscured" the space allows.
    const cramped: Rect = { x: 0, y: 0, width: 200, height: 80 };
    const { dx, dy } = panToReveal({ ...node, x: 0, y: 0 }, cramped);

    expect(dx).toBe(12);
    expect(dy).toBe(8);
  });
});
