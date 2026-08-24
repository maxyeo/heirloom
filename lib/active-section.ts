/**
 * Which section of an article the reader is currently in (E11-T3, `YEO-73`).
 *
 * The contents panel highlights one entry as you scroll, and deciding *which*
 * is the whole of that behaviour. It is arithmetic over a list of numbers, so
 * it lives here rather than inside the component: `npm test` can then check
 * the edge that a browser makes hard to reproduce — the last section of a
 * short article, whose heading never reaches the top of the viewport because
 * the page runs out of scroll first.
 *
 * `components/ArticleContents.tsx` is the only caller. It reads the numbers off
 * the document and hands them here.
 */

/** A heading's id and where its box currently is, relative to the viewport. */
export type SectionPosition = {
  id: string;
  /** `getBoundingClientRect().top` — negative once scrolled past. */
  top: number;
};

export type ActiveSectionOptions = {
  /**
   * How far below the top of the viewport a heading counts as "reached".
   *
   * The sticky header covers the first `--header-height` of the page, so a
   * heading at `top: 0` is behind it rather than in front of the reader. This
   * is the same offset the stylesheet gives those headings as
   * `scroll-margin-top`, which is where the component reads it from — see the
   * note there. Passing it in rather than looking it up keeps this function
   * arithmetic.
   */
  offset: number;
  /**
   * Whether the page is scrolled as far as it goes.
   *
   * Without this the last section of an article is never current: a final
   * heading two paragraphs from the bottom of a tall viewport stops moving
   * while it is still well below `offset`, so the highlight sticks on the
   * section above it and the reader watches the wrong entry stay lit while
   * they read to the end.
   */
  atEnd: boolean;
};

/**
 * A pixel of slack.
 *
 * Clicking a contents entry scrolls the heading to exactly `offset`, and
 * fractional device pixels and zoom levels routinely land that a hair short.
 * Without the slack the entry the reader just clicked is the one section that
 * does not light up.
 */
const TOLERANCE = 1;

/**
 * The heading whose section the reader is in, or `null` if there are none.
 *
 * The rule is "the last heading that has passed the line", which is what makes
 * the highlight track a reader going in either direction with no state carried
 * between calls. Before the first heading passes it, the answer is the first
 * heading rather than nothing: a contents panel with no entry lit reads as
 * broken, and the reader is, in every sense that matters, at the top of the
 * first section.
 *
 * @param positions every heading in the article, in document order
 * @returns the id to mark as current
 */
export function activeSectionId(
  positions: readonly SectionPosition[],
  { offset, atEnd }: ActiveSectionOptions,
): string | null {
  if (positions.length === 0) return null;
  if (atEnd) return positions[positions.length - 1].id;

  let current = positions[0].id;
  for (const position of positions) {
    if (position.top - offset <= TOLERANCE) current = position.id;
  }

  return current;
}
