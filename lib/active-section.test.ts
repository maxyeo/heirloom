import { describe, expect, it } from "vitest";

import { activeSectionId, type SectionPosition } from "@/lib/active-section";

/**
 * A scroll position is a number, so this is a table of numbers — which is the
 * point of the function existing separately from the panel that draws it. The
 * two cases worth having a test for are the ones a browser makes awkward to
 * reproduce by hand: reading the last section of a short article, and clicking
 * an entry and landing a fraction of a pixel short of the heading.
 *
 * `top` is `getBoundingClientRect().top`: measured from the top of the
 * viewport, and negative once the heading has scrolled off it. `offset` is how
 * much of the viewport the sticky header covers.
 */

const HEADER = 56;

/** Three headings, at the viewport positions given. */
function at(...tops: number[]): SectionPosition[] {
  return tops.map((top, index) => ({ id: `h${index + 1}`, top }));
}

function current(
  positions: SectionPosition[],
  { atEnd = false } = {},
): string | null {
  return activeSectionId(positions, { offset: HEADER, atEnd });
}

describe("activeSectionId", () => {
  it("has no answer for an article with no headings", () => {
    expect(current([])).toBeNull();
  });

  it("marks the first section before any heading has been reached", () => {
    // Everything still below the header. A contents panel with nothing lit
    // reads as broken, and the reader is at the top of the first section.
    expect(current(at(200, 600, 1000))).toBe("h1");
  });

  it("follows the reader down the article", () => {
    expect(current(at(-400, 40, 500))).toBe("h2");
    expect(current(at(-900, -400, 20))).toBe("h3");
  });

  it("follows the reader back up again", () => {
    // No state is carried between calls, so scrolling up is the same question
    // asked with different numbers.
    expect(current(at(-900, -400, 20))).toBe("h3");
    expect(current(at(-400, 40, 500))).toBe("h2");
    expect(current(at(200, 600, 1000))).toBe("h1");
  });

  it("counts a heading as reached exactly when it clears the header", () => {
    // At `top === offset` the heading is sitting immediately below the sticky
    // header, which is where a click on its contents entry puts it.
    expect(current(at(0, HEADER, 900))).toBe("h2");
    expect(current(at(0, HEADER + 2, 900))).toBe("h1");
  });

  it("forgives the fraction of a pixel a click lands short by", () => {
    // Fractional device pixels and zoom levels routinely leave the heading a
    // hair below where it was asked to be. Without the tolerance the entry the
    // reader just clicked is the one that does not light up.
    expect(current(at(0, HEADER + 0.75, 900))).toBe("h2");
  });

  it("marks the last section once the page has run out of scroll", () => {
    // The case that has no other fix: a final heading two paragraphs from the
    // bottom of a tall viewport stops moving while it is still well below the
    // header, so it would never become current on its own.
    expect(current(at(-900, -400, 700), { atEnd: true })).toBe("h3");
  });

  it("prefers the end of the page to the arithmetic", () => {
    // Even when no heading has been reached at all — a one-screen article.
    expect(current(at(200, 300), { atEnd: true })).toBe("h2");
  });

  it("has no answer at the end of an article with no headings", () => {
    expect(current([], { atEnd: true })).toBeNull();
  });

  it("works with a header of no height", () => {
    expect(activeSectionId(at(-10, 0, 40), { offset: 0, atEnd: false })).toBe(
      "h2",
    );
  });
});
