import { describe, expect, it } from "vitest";

import {
  isTopmost,
  nextTrapIndex,
  topmost,
  withSurface,
  withoutSurface,
} from "@/lib/surface-stack";

/**
 * The two decisions behind `YEO-83`, asserted with no document.
 *
 * `components/surface-stack.test.tsx` mounts real surfaces and checks the
 * wiring — one listener, registration order, focus going back where it came
 * from. Everything here is a function of three numbers or of a list, so none
 * of it needs a browser, and the branches that are awkward to reach through a
 * mounted dialogue (a surface with exactly one focusable element, a Tab in the
 * middle of the list) are one call each.
 */

/** Surfaces as the registry holds them, minus everything only a browser has. */
const panel = { id: 1 };
const dialogue = { id: 2 };

describe("the stack", () => {
  it("has no topmost surface when nothing is open", () => {
    expect(topmost([])).toBeNull();
  });

  it("treats the surface registered last as the one on top", () => {
    // Registration order *is* the mechanism: a surface opens over the ones
    // that were already there, so the newest is the one Escape is for.
    expect(topmost([panel, dialogue])).toBe(dialogue);
    expect(isTopmost([panel, dialogue], dialogue.id)).toBe(true);
    expect(isTopmost([panel, dialogue], panel.id)).toBe(false);
  });

  it("puts a new surface on top", () => {
    expect(withSurface([panel], dialogue)).toEqual([panel, dialogue]);
    expect(topmost(withSurface([panel], dialogue))).toBe(dialogue);
  });

  it("puts an `underneath` surface below what is already open", () => {
    // The tree's one pair where mount order and z-index disagree: a person's
    // record opening below the add-person panel drawn over it. Escape has to
    // reach the panel somebody can see.
    const record = { id: 3 };
    expect(withSurface([panel], record, true)).toEqual([record, panel]);
    expect(topmost(withSurface([panel], record, true))).toBe(panel);
  });

  it("makes `underneath` the topmost surface when nothing else is open", () => {
    // Which is the ordinary case for that record: it is the lowest thing the
    // canvas draws, so "at the bottom" and "on top" are the same place until
    // something else is up.
    const record = { id: 3 };
    expect(topmost(withSurface([], record, true))).toBe(record);
  });

  it("carries whatever else an entry holds", () => {
    // The registry stores a ref full of callbacks beside the id, and these
    // helpers have to hand it back rather than reduce an entry to its id.
    const withPayload = { id: 3, label: "add person" };

    expect(topmost([withPayload])?.label).toBe("add person");
  });

  it("says nothing is topmost in an empty stack", () => {
    expect(isTopmost([], 1)).toBe(false);
  });

  it("removes a surface by id, keeping the order of the rest", () => {
    const third = { id: 3 };

    expect(withoutSurface([panel, dialogue, third], dialogue.id)).toEqual([
      panel,
      third,
    ]);
  });

  it("hands topmost-ness back when the surface above leaves", () => {
    expect(topmost(withoutSurface([panel, dialogue], dialogue.id))).toBe(panel);
  });

  it("removes a surface from underneath one that is still open", () => {
    // The detail panel can be taken out from under a dialogue by a delete in
    // another tab. The dialogue is still the one on top afterwards.
    const left = withoutSurface([panel, dialogue], panel.id);

    expect(left).toEqual([dialogue]);
  });

  it("leaves a stack that does not hold the id alone", () => {
    expect(withoutSurface([panel], 99)).toEqual([panel]);
  });

  it("does not mutate the stack it was given", () => {
    const stack = [panel, dialogue];
    withoutSurface(stack, panel.id);

    expect(stack).toEqual([panel, dialogue]);
  });
});

describe("nextTrapIndex", () => {
  it("declines to trap a surface with nothing focusable in it", () => {
    // A dialogue mid-submission disables every button it has. Swallowing Tab
    // there would leave the keyboard with nowhere at all to go.
    expect(nextTrapIndex(0, -1, false)).toBeNull();
    expect(nextTrapIndex(0, -1, true)).toBeNull();
  });

  it("pulls focus in from outside the surface", () => {
    // The whole of the `aria-modal="true"` bug. Focus is on the button behind
    // the backdrop that opened the dialogue, or on the dialogue's own heading,
    // which is not in the tab order — and before `YEO-83` both tabbed on out
    // into the panel underneath.
    expect(nextTrapIndex(3, -1, false)).toBe(0);
    expect(nextTrapIndex(3, -1, true)).toBe(2);
  });

  it("wraps at the end of the list", () => {
    expect(nextTrapIndex(3, 2, false)).toBe(0);
  });

  it("wraps at the start of the list", () => {
    expect(nextTrapIndex(3, 0, true)).toBe(2);
  });

  it("leaves the browser to it in the middle of the list", () => {
    // `querySelectorAll` sorts by document position and knows nothing about a
    // positive `tabindex`. Inside the surface the browser is already right.
    expect(nextTrapIndex(3, 1, false)).toBeNull();
    expect(nextTrapIndex(3, 1, true)).toBeNull();
    expect(nextTrapIndex(3, 0, false)).toBeNull();
    expect(nextTrapIndex(3, 2, true)).toBeNull();
  });

  it("returns to the single element when that is all there is", () => {
    // A confirmation with one button. Both directions are a wrap, and both
    // ends are the same element.
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
    expect(nextTrapIndex(1, -1, false)).toBe(0);
    expect(nextTrapIndex(1, -1, true)).toBe(0);
  });
});
