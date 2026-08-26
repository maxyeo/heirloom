// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { SkipLink } from "@/components/SkipLink";
import { render } from "@/test/render";

/**
 * The bypass mechanism itself (`YEO-108`), tested where it is small
 * enough to be tested exhaustively.
 *
 * The point of the ticket is that a skip link either moves focus or is
 * decoration, and the difference is invisible in the markup: a link and a
 * target with the right ids can be perfectly correct and still leave the
 * reader inside the block they asked to leave. So every assertion here is
 * about `document.activeElement` after the link has been taken, and one of
 * them is about what a Tab from there would reach next.
 *
 * `components/FamilyTree.test.tsx` runs the same question against the real
 * canvas, with two hundred people's worth of tab stops in between — this file
 * is the mechanism, that one is the use.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** A block worth skipping, with a way over it and something on the far side. */
function page(): HTMLElement {
  return render(
    <>
      <SkipLink targetId="past-the-block">Skip the block</SkipLink>
      <button type="button">inside one</button>
      <button type="button">inside two</button>
      <div id="past-the-block" tabIndex={-1}>
        the far side
      </div>
      <button type="button">after</button>
    </>,
  );
}

function link(host: HTMLElement): HTMLAnchorElement {
  const found = host.querySelector<HTMLAnchorElement>("a.skip-link");
  if (!found) throw new Error("no skip link was rendered");
  return found;
}

/**
 * Everything Tab would stop on, in document order.
 *
 * jsdom implements no Tab key — there is no layout and no focus ring, and
 * `dispatchEvent` of a `Tab` keydown moves nothing. So "where does Tab go
 * next" is answered the way the browser answers it for a document with no
 * positive tabindex anywhere: document order, minus what a negative tabindex
 * takes out.
 */
function tabbable(root: ParentNode): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("a[href], button, [tabindex]"),
  ].filter((element) => element.getAttribute("tabindex") !== "-1");
}

/** The first tab stop after `from`, which is where Tab would land. */
function nextTabStopAfter(from: HTMLElement): HTMLElement | undefined {
  return tabbable(document.body).find(
    (element) =>
      (from.compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0,
  );
}

describe("SkipLink", () => {
  it("is the first thing Tab reaches, ahead of the block", () => {
    const host = page();

    expect(tabbable(host)[0]).toBe(link(host));
  });

  it("puts focus on the target rather than merely pointing at it", () => {
    const host = page();
    const anchor = link(host);

    act(() => anchor.focus());
    // What Enter on a focused link does. The assertion is deliberately about
    // focus and not about `location.hash`: a fragment in the URL is what a
    // skip link that does nothing also produces.
    act(() => anchor.click());

    expect(document.activeElement).toBe(host.querySelector("#past-the-block"));
  });

  it("leaves Tab continuing past the block, not back into it", () => {
    const host = page();
    const anchor = link(host);

    act(() => anchor.focus());
    act(() => anchor.click());

    const target = document.activeElement as HTMLElement;
    // The failure this catches is the one that looks fine: a target with no
    // `tabindex` cannot take focus, focus stays on the link, and the next Tab
    // goes to the first thing in the block the reader just skipped.
    expect(nextTabStopAfter(target)?.textContent).toBe("after");
  });

  it("adds no tab stop of its own to the block it skips", () => {
    const host = page();

    // The order through the page is the link, then the block, then what is
    // after it — the block itself is untouched. This is the half of the
    // criterion about the reader who does *not* skip.
    expect(tabbable(host).map((element) => element.textContent)).toEqual([
      "Skip the block",
      "inside one",
      "inside two",
      "after",
    ]);
  });

  it("works before it has hydrated, because the href is the real mechanism", () => {
    const host = page();

    // A handler that has not attached yet is a link that does nothing, so the
    // fragment has to be on the element rather than only in the handler.
    expect(link(host).getAttribute("href")).toBe("#past-the-block");
  });
});
