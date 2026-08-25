// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { PartnerPicker } from "@/components/PartnerPicker";
import type { GraphPerson } from "@/lib/family-graph";
import type { PartnerCandidate } from "@/lib/partner-search";
import { render } from "@/test/render";

/**
 * The partner picker, mounted only for what cannot exist without a document
 * (E3-T4, `YEO-32`).
 *
 * Everything the picker *decides* — who matches "hal", how the results are
 * ranked, what "Rose Hale" splits into — is decided in `lib/partner-search.ts`
 * and asserted against literals next to it. What is left here is the wiring
 * that only a mounted component has: typing narrowing a real list, a click
 * reporting the right person back, and the create-inline route carrying what
 * was typed with it. See docs/testing.md, "prefer no DOM".
 */

function person(overrides: Partial<GraphPerson> & { id: string }): GraphPerson {
  return {
    givenName: "Someone",
    surname: null,
    sex: "unknown",
    birthDate: null,
    birthDateQualifier: "exact",
    birthDatePrecision: "day",
    birthDateUpper: null,
    birthDateUpperPrecision: "day",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
    deathDateUpper: null,
    deathDateUpperPrecision: "day",
    deathPlace: null,
    notes: null,
    portraitKey: null,
    portraitThumbKey: null,
    pageId: null,
    ...overrides,
  };
}

const PEOPLE: GraphPerson[] = [
  person({ id: "rose", givenName: "Rose", surname: "Hale" }),
  person({
    id: "thomas",
    givenName: "Thomas",
    surname: "Hale",
    birthDate: "1899-03-02",
  }),
  person({ id: "walter", givenName: "Walter", surname: "Byrne" }),
];

const noop = () => {};

function mount(overrides: Partial<Parameters<typeof PartnerPicker>[0]> = {}) {
  return render(
    <PartnerPicker
      people={PEOPLE}
      selected={null}
      onSelect={noop}
      onClear={noop}
      onCreateNew={noop}
      {...overrides}
    />,
  );
}

function searchBox(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector("input");
  if (!input) throw new Error("no search box");
  return input;
}

function type(host: HTMLElement, text: string): void {
  const input = searchBox(host);
  act(() => {
    // React tracks the last value it wrote to the node, so assigning `.value`
    // directly makes it treat an identical value as "no change". Going through
    // the prototype setter is what makes the change visible to React.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function resultNames(host: HTMLElement): string[] {
  const list = host.querySelector('ul[aria-label="Matching people"]');
  return [...(list?.querySelectorAll("button") ?? [])].map((button) =>
    (button.textContent ?? "").trim(),
  );
}

function buttonLabelled(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("finding somebody already on the tree", () => {
  it("offers everyone before anything is typed", () => {
    // In full-name order, so the picker opens with a list rather than a prompt.
    expect(resultNames(mount())).toEqual([
      "Rose Hale",
      "Thomas Hale (b. 1899)",
      "Walter Byrne",
    ]);
  });

  it("narrows the list as the author types", () => {
    const host = mount();
    type(host, "byrne");
    expect(resultNames(host)).toEqual(["Walter Byrne"]);
  });

  it("says so when nobody matches, instead of showing an empty box", () => {
    const host = mount();
    type(host, "zzz");
    expect(resultNames(host)).toEqual([]);
    expect(host.textContent).toContain("Nobody on the tree matches that");
  });

  it("reports the person who was clicked", () => {
    const onSelect = vi.fn();
    const host = mount({ onSelect });

    click(buttonLabelled(host, "Thomas Hale"));

    expect(onSelect).toHaveBeenCalledWith({
      id: "thomas",
      name: "Thomas Hale",
      lifespan: "b. 1899",
    });
  });

  it("does not offer the people it is told to leave out", () => {
    const host = mount({ excludeIds: ["thomas"] });
    expect(resultNames(host)).toEqual(["Rose Hale", "Walter Byrne"]);
  });
});

describe("once somebody is chosen", () => {
  const selected: PartnerCandidate = {
    id: "thomas",
    name: "Thomas Hale",
    lifespan: "b. 1899",
  };

  /**
   * The search box goes away with the choice. Leaving the list on screen would
   * let a second click silently replace an answer the author had stopped
   * looking at.
   */
  it("shows the choice instead of the search", () => {
    const host = mount({ selected });
    expect(host.textContent).toContain("Thomas Hale");
    expect(host.querySelector("input")).toBe(null);
  });

  it("can be undone", () => {
    const onClear = vi.fn();
    click(buttonLabelled(mount({ selected, onClear }), "Change"));
    expect(onClear).toHaveBeenCalled();
  });
});

describe("adding somebody who is not on the tree yet", () => {
  /**
   * Offered whether or not the search found anybody. A list containing a
   * *different* Thomas Hale is not evidence that this Thomas Hale is already
   * recorded, and in a family tree that is the likeliest way to attach a
   * marriage to the wrong person.
   */
  it("is offered even when the search found people", () => {
    const host = mount();
    expect(resultNames(host)).not.toEqual([]);
    expect(buttonLabelled(host, "add them as a new person")).toBeTruthy();
  });

  it("carries what was typed into the offer", () => {
    const host = mount();
    type(host, "  Ada Byron ");
    expect(buttonLabelled(host, "Ada Byron").textContent).toContain(
      "add “Ada Byron” as a new person",
    );
  });

  it("reports the typed name back when taken up", () => {
    const onCreateNew = vi.fn();
    const host = mount({ onCreateNew });

    type(host, "Ada Byron");
    click(buttonLabelled(host, "Ada Byron"));

    expect(onCreateNew).toHaveBeenCalledWith("Ada Byron");
  });
});
