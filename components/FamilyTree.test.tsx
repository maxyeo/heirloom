// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { FamilyTree } from "@/components/FamilyTree";
import type { FamilyGraph } from "@/lib/family-graph";
import { render as mount } from "@/test/render";

/**
 * The one thing in E2-T1 that cannot be checked without a document: that
 * clicking a node on a real React Flow canvas opens the panel, and that the
 * three ways out of it — Escape, the canvas, the close button — put focus back
 * on the node the reader started from.
 *
 * It is worth the DOM because the wiring is where this ticket's only real trap
 * lives. React Flow applies a selection to its own store only when the flow is
 * uncontrolled; given a `nodes` prop it emits a change and expects the owner to
 * apply it. A canvas that passes `nodes` and no `onNodesChange` therefore looks
 * completely normal and silently selects nothing — which is what this component
 * did for as long as nothing read the selection. A test that clicks a node and
 * expects a panel is the only thing that notices.
 *
 * Everything the panel *says* is decided in `lib/person-detail.ts` and asserted
 * with no DOM at all, and the pan geometry is asserted in
 * `lib/tree-viewport.test.ts`. Only the joins are here.
 */

beforeAll(() => {
  // React's own flag for "act() is safe here". Without it React 19 warns on
  // every update this file drives.
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  // The two browser APIs React Flow reaches for that jsdom does not implement.
  // It measures nodes with a ResizeObserver and reads the zoom out of a
  // DOMMatrix; neither has to do anything for a click to land.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
  } as unknown as typeof DOMMatrixReadOnly;
});

function render(graph: FamilyGraph): HTMLElement {
  return mount(<FamilyTree graph={graph} />);
}

function person(
  overrides: Partial<FamilyGraph["people"][number]> & {
    id: string;
    givenName: string;
  },
) {
  return {
    surname: "Hale",
    sex: "female",
    birthDate: null,
    birthDateQualifier: "exact",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathPlace: null,
    notes: null,
    pageId: null,
    ...overrides,
  } satisfies FamilyGraph["people"][number];
}

/** Rose married Walter and they had Dora. Three nodes and one union. */
function graph(): FamilyGraph {
  return {
    people: [
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({ id: "walter", givenName: "Walter", sex: "male" }),
      person({ id: "dora", givenName: "Dora" }),
    ],
    unions: [
      {
        id: "u1",
        partnerAId: "rose",
        partnerBId: "walter",
        type: "marriage",
        endReason: "ongoing",
        sequence: 1,
        startDate: null,
        startDateQualifier: "exact",
        endDate: null,
        endDateQualifier: "exact",
      },
    ],
    childLinks: [{ unionId: "u1", childId: "dora", relation: "biological" }],
  };
}

function nodeWrapper(host: HTMLElement, id: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>(".react-flow__node")].find(
    (wrapper) => wrapper.dataset.id === id,
  );
  if (!found) throw new Error(`no node rendered for "${id}"`);
  return found;
}

function panelLabel(host: HTMLElement): string | null {
  return host.querySelector("aside")?.getAttribute("aria-label") ?? null;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

function open(host: HTMLElement, id: string): void {
  click(nodeWrapper(host, id));
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

function buttonLabelled(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

describe("opening the panel", () => {
  it("opens on a node click", () => {
    const host = render(graph());

    expect(panelLabel(host)).toBeNull();
    open(host, "rose");

    expect(panelLabel(host)).toBe("Details for Rose Hale");
    // Derived on the spot from the same graph the canvas was laid out from —
    // no second query, and nothing about "spouse" stored anywhere.
    expect(host.textContent).toContain("Walter Hale");
    expect(host.textContent).toContain("Dora Hale");
  });

  it("marks the node it opened for", () => {
    const host = render(graph());
    open(host, "rose");

    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(true);
  });

  it("does not open for a union marker", () => {
    const host = render(graph());

    // A union is a connector, not a record. It is not selectable, so clicking
    // it must leave the canvas exactly as it was.
    click(nodeWrapper(host, "u1"));

    expect(panelLabel(host)).toBeNull();
  });
});

describe("navigating by the panel's links", () => {
  it("moves the panel and the selection onto the relative", () => {
    const host = render(graph());
    open(host, "rose");

    click(buttonLabelled(host, "Dora Hale"));

    expect(panelLabel(host)).toBe("Details for Dora Hale");
    expect(nodeWrapper(host, "dora").classList.contains("selected")).toBe(true);
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(false);
    // Read from the other end of the same rows: Dora's parents are the two
    // partners of the union she was born into.
    expect(host.textContent).toContain("Rose Hale");
    expect(host.textContent).toContain("Walter Hale");
  });
});

describe("closing the panel", () => {
  it("closes on Escape and puts focus back on the node", () => {
    const host = render(graph());
    open(host, "rose");

    pressEscape();

    expect(panelLabel(host)).toBeNull();
    // The acceptance criterion in full: not merely that the panel went away,
    // but that a keyboard is left where it started rather than on <body>.
    expect(document.activeElement).toBe(nodeWrapper(host, "rose"));
  });

  it("closes on a canvas click and puts focus back on the node", () => {
    const host = render(graph());
    open(host, "rose");

    const pane = host.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("no pane rendered");
    click(pane);

    expect(panelLabel(host)).toBeNull();
    expect(document.activeElement).toBe(nodeWrapper(host, "rose"));
  });

  it("closes on the panel's own close button", () => {
    const host = render(graph());
    open(host, "rose");

    click(buttonLabelled(host, "Close"));

    expect(panelLabel(host)).toBeNull();
    expect(document.activeElement).toBe(nodeWrapper(host, "rose"));
  });
});
