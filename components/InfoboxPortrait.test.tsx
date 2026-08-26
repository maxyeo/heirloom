// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { InfoboxPortrait } from "@/components/InfoboxPortrait";
import { render, rerender } from "@/test/render";

/**
 * The article's portrait figure (`YEO-97`).
 *
 * What needs a document here is the failure path — an `onError` cannot be
 * asserted without one — and the shape of the figure it renders. What the
 * `src` *is* is decided in `lib/person-infobox.ts` and asserted there with no
 * DOM at all, and where the figure sits among the box's other elements is
 * asserted in `components/PersonInfobox.test.tsx`.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * The `src` as a path, not as jsdom found it.
 *
 * `next/image` reassigns `img.src = img.src` after mount — it is how it
 * re-fires load and error events for an image the browser had already cached
 * — and that assignment writes the *absolute* resolved URL back into the
 * attribute. What this application controls, and what is worth asserting, is
 * the path: an address of its own rather than a storage URL.
 */
function srcPath(image: Element | null | undefined): string {
  const raw = image?.getAttribute("src");
  if (raw === null || raw === undefined)
    throw new Error("the image has no src");
  return new URL(raw, "http://localhost").pathname;
}

const SRC = "/api/images/ab/abcdef01-2345-4678-89ab-cdef01234567.jpg";
const OTHER = "/api/images/cd/abcdef01-2345-4678-89ab-cdef01234568.jpg";

describe("the figure", () => {
  it("reserves its square before the image arrives", () => {
    // The box floats, so a figure that grew on load would re-wrap the article
    // text around it. jsdom has no layout engine and cannot measure that; the
    // reserved ratio is the property that entails its absence.
    const host = render(<InfoboxPortrait src={SRC} name="Rose Bennett" />);
    const frame = host.querySelector("figure")?.firstElementChild;

    expect(frame?.className).toContain("aspect-square");
    // Capped at the floated width, so the box below `sm` — where it is as
    // wide as the article — does not open on a portrait that tall.
    expect(frame?.className).toContain("max-w-infobox");
  });

  it("loads through this application's own image route, and names the face", () => {
    const image = render(
      <InfoboxPortrait src={SRC} name="Rose Bennett" />,
    ).querySelector("img");

    expect(srcPath(image)).toBe(SRC);
    expect(image?.getAttribute("alt")).toBe("Portrait of Rose Bennett");
  });
});

describe("a portrait whose image will not load", () => {
  /**
   * Not a hypothetical: `GET /api/images/…` answers 404 for an object that is
   * no longer in the store, and E5-T5's orphan sweep is a path that produces
   * exactly that.
   */
  it("removes the whole figure rather than showing a broken image", () => {
    const host = render(<InfoboxPortrait src={SRC} name="Rose Bennett" />);
    expect(host.querySelector("figure")).not.toBeNull();

    act(() => {
      host.querySelector("img")?.dispatchEvent(new Event("error"));
    });

    // No figure, no rule, and — the acceptance criterion — no silhouette
    // standing in for it. The tree node answers the other way because its
    // layout must not move; an article is ordinary flow.
    expect(host.querySelector("figure")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();
  });

  /**
   * What is remembered is *which* `src` failed, not that one did. React
   * reuses this element across a client navigation from one article to the
   * next, so a boolean would let one missing photograph hide the next
   * person's.
   */
  it("shows an image again when a different src arrives after a failure", () => {
    const host = render(<InfoboxPortrait src={SRC} name="Rose Bennett" />);
    act(() => {
      host.querySelector("img")?.dispatchEvent(new Event("error"));
    });
    expect(host.querySelector("figure")).toBeNull();

    rerender(host, <InfoboxPortrait src={OTHER} name="Walter Shaw" />);

    expect(host.querySelector("figure")).not.toBeNull();
    expect(srcPath(host.querySelector("img"))).toBe(OTHER);
  });
});
