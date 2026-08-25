// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { PersonPortrait } from "@/components/PersonPortrait";
import { render, rerender } from "@/test/render";

/**
 * What only a document can prove about the box a person's face sits in
 * (E5-T4, `YEO-44`). Everything else — which key a node loads, whether a
 * thumbnail is worth making — is decided by `lib/portrait.ts` and
 * `lib/portrait-image.ts`, and asserted with no DOM at all.
 *
 * The acceptance criterion this component exists to satisfy is that the
 * tree's layout does not move whether or not a portrait exists. jsdom has no
 * layout engine, so nothing here can measure that directly — see
 * `PersonPortrait`'s own docblock for why the test instead asserts something
 * that entails it: the same box, with the same className and the same inline
 * size, is rendered whether or not there is a `src`.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function box(host: HTMLElement): HTMLElement {
  const found = host.firstElementChild;
  if (found === null || !(found instanceof HTMLElement)) {
    throw new Error("no outer box rendered");
  }
  return found;
}

describe("the outer box", () => {
  it("has identical className and size with and without a src", () => {
    const withPhoto = render(
      <PersonPortrait
        src="/api/images/ab/x.jpg"
        name="Rose Hale"
        size="node"
      />,
    );
    const withoutPhoto = render(
      <PersonPortrait src={null} name="Rose Hale" size="node" />,
    );

    const a = box(withPhoto);
    const b = box(withoutPhoto);

    expect(a.className).toBe(b.className);
    expect(a.style.width).toBe(b.style.width);
    expect(a.style.height).toBe(b.style.height);
  });

  it("sizes the same box identically at both node and panel sizes, with and without a src", () => {
    const nodeWith = box(
      render(
        <PersonPortrait src="/api/images/ab/x.jpg" name="Rose" size="node" />,
      ),
    );
    const nodeWithout = box(
      render(<PersonPortrait src={null} name="Rose" size="node" />),
    );
    expect(nodeWith.style.width).toBe(nodeWithout.style.width);
    expect(nodeWith.style.height).toBe(nodeWithout.style.height);

    const panelWith = box(
      render(
        <PersonPortrait src="/api/images/ab/x.jpg" name="Rose" size="panel" />,
      ),
    );
    const panelWithout = box(
      render(<PersonPortrait src={null} name="Rose" size="panel" />),
    );
    expect(panelWith.style.width).toBe(panelWithout.style.width);
    expect(panelWith.style.height).toBe(panelWithout.style.height);
  });
});

describe("alt text", () => {
  it("is empty on the canvas, since the node already announces the person", () => {
    const host = render(
      <PersonPortrait
        src="/api/images/ab/x.jpg"
        name="Rose Hale"
        size="node"
      />,
    );
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("names the person in the panel", () => {
    const host = render(
      <PersonPortrait
        src="/api/images/ab/x.jpg"
        name="Rose Hale"
        size="panel"
      />,
    );
    expect(host.querySelector("img")?.getAttribute("alt")).toBe(
      "Portrait of Rose Hale",
    );
  });
});

describe("the placeholder", () => {
  it("renders when src is null", () => {
    const host = render(
      <PersonPortrait src={null} name="Rose Hale" size="node" />,
    );
    expect(
      host.querySelector('[data-testid="portrait-placeholder"]'),
    ).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
  });

  it("renders instead of the image once that image's src has errored", () => {
    const host = render(
      <PersonPortrait
        src="/api/images/ab/x.jpg"
        name="Rose Hale"
        size="node"
      />,
    );
    const img = host.querySelector("img");
    expect(img).not.toBeNull();

    act(() => {
      img?.dispatchEvent(new Event("error"));
    });

    expect(
      host.querySelector('[data-testid="portrait-placeholder"]'),
    ).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
  });

  /**
   * The subtle case this component was specifically written for: React
   * reuses this element across people — the panel swaps person without
   * unmounting, and React Flow keeps a node's DOM as the graph changes. What
   * is remembered has to be *which* `src` failed, not that one did, or one
   * missing photograph would permanently hide the next person's.
   */
  it("shows an image again when a different src arrives after a failure", () => {
    const host = render(
      <PersonPortrait
        src="/api/images/ab/rose.jpg"
        name="Rose Hale"
        size="node"
      />,
    );
    act(() => {
      host.querySelector("img")?.dispatchEvent(new Event("error"));
    });
    expect(
      host.querySelector('[data-testid="portrait-placeholder"]'),
    ).not.toBeNull();

    rerender(
      host,
      <PersonPortrait
        src="/api/images/cd/walter.jpg"
        name="Walter Hale"
        size="node"
      />,
    );

    expect(host.querySelector("img")).not.toBeNull();
    expect(
      host.querySelector('[data-testid="portrait-placeholder"]'),
    ).toBeNull();
  });
});
