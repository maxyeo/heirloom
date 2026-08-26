// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { CategoryPicker } from "@/components/CategoryPicker";
import {
  MAX_CATEGORIES_PER_ENTRY,
  type NamedCategory,
} from "@/lib/category-name";
import { render } from "@/test/render";

/**
 * The category picker (E11-T8, `YEO-78`), mounted only for what cannot exist
 * without a document.
 *
 * Everything it *decides* about a name — what it normalises to, whether two
 * spellings are one category, whether a name can have an address at all — is
 * decided in `lib/category-name.ts` and asserted against literals next to it.
 * What is left here is the wiring only a mounted component has: typing
 * narrowing a real list, a click reporting the right filing back, the inline
 * create carrying what was typed, and the two things this control must not do
 * — offer to create a category that already exists, and submit the form the
 * author is standing in. See docs/testing.md, "prefer no DOM".
 */

const EXISTING: NamedCategory[] = [
  { name: "Born in Kilkenny", slug: "born-in-kilkenny" },
  { name: "Emigrated to Canada", slug: "emigrated-to-canada" },
  { name: "Whitfield family", slug: "whitfield-family" },
];

const noop = () => {};

function mount(overrides: Partial<Parameters<typeof CategoryPicker>[0]> = {}) {
  return render(
    <CategoryPicker
      value={[]}
      existing={EXISTING}
      onChange={noop}
      {...overrides}
    />,
  );
}

function field(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector("input");
  if (!input) throw new Error("no category field");
  return input;
}

function type(host: HTMLElement, text: string): void {
  const input = field(host);
  act(() => {
    // React tracks the last value it wrote to the node, so assigning `.value`
    // directly makes it treat an identical value as "no change". Going through
    // the prototype setter is what makes the change visible to React — the
    // same note `components/PartnerPicker.test.tsx` carries.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function suggestionLabels(host: HTMLElement): string[] {
  const list = host.querySelector('ul[aria-label="Matching categories"]');
  return [...(list?.querySelectorAll("button") ?? [])].map((button) =>
    (button.textContent ?? "").trim(),
  );
}

function chipLabels(host: HTMLElement): string[] {
  const list = host.querySelector('ul[role="list"]');
  return [...(list?.querySelectorAll("li > span") ?? [])].map((span) =>
    (span.textContent ?? "").trim(),
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

describe("choosing a category that already exists", () => {
  it("offers all of them before anything is typed", () => {
    // A list rather than a prompt: the point of the control is that filing
    // under something already used costs no thought and no request.
    expect(suggestionLabels(mount())).toEqual([
      "Born in Kilkenny",
      "Emigrated to Canada",
      "Whitfield family",
    ]);
  });

  it("narrows the list as the author types", () => {
    const host = mount();
    type(host, "canada");

    /**
     * The create row survives the narrowing, and that is deliberate rather
     * than an oversight in the assertion: "canada" is not "Emigrated to
     * Canada", and an author who means the shorter heading should be able to
     * make it. `PartnerPicker` offers its own create for the same reason —
     * a list containing something else is not evidence that what you meant is
     * already there.
     */
    expect(suggestionLabels(host)).toEqual([
      "Emigrated to Canada",
      "Create the category “canada”",
    ]);
  });

  it("matches on any part of the name, not only the start", () => {
    const host = mount();
    type(host, "kilkenny");
    expect(suggestionLabels(host)[0]).toBe("Born in Kilkenny");
  });

  it("reports the category that was clicked", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });

    click(buttonLabelled(host, "Whitfield family"));

    expect(onChange).toHaveBeenCalledWith([
      { name: "Whitfield family", slug: "whitfield-family" },
    ]);
  });

  it("appends rather than replaces", () => {
    const onChange = vi.fn();
    const host = mount({
      value: [{ name: "Born in Kilkenny", slug: "born-in-kilkenny" }],
      onChange,
    });

    click(buttonLabelled(host, "Whitfield family"));

    expect(onChange).toHaveBeenCalledWith([
      { name: "Born in Kilkenny", slug: "born-in-kilkenny" },
      { name: "Whitfield family", slug: "whitfield-family" },
    ]);
  });

  it("stops offering one the entry already carries", () => {
    // Not merely harmless to offer: clicking it would be a click that appears
    // to do nothing, which is worse than the option being absent.
    const host = mount({
      value: [{ name: "Whitfield family", slug: "whitfield-family" }],
    });

    expect(suggestionLabels(host)).toEqual([
      "Born in Kilkenny",
      "Emigrated to Canada",
    ]);
  });
});

describe("creating one inline", () => {
  it("offers to create what was typed when nothing matches", () => {
    const host = mount();
    type(host, "Buried at St Mary's");

    // Nothing existing matches, so the invitation is the only row.
    expect(suggestionLabels(host)).toEqual([
      "Create the category “Buried at St Mary's”",
    ]);
  });

  it("reports the new category with the slug it will be stored under", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });

    type(host, "  Buried at St Mary's  ");
    click(buttonLabelled(host, "Create the category"));

    // Normalised here as well as on the server, so the chip the author sees is
    // the name that will actually be stored.
    expect(onChange).toHaveBeenCalledWith([
      { name: "Buried at St Mary's", slug: "buried-at-st-marys" },
    ]);
  });

  it("does not offer to create one that already exists under another spelling", () => {
    /**
     * The de-duplication rule, seen from the author's side. "whitfield FAMILY"
     * and "Whitfield family" are one slug, so a create button here would be an
     * offer the unique index refuses a moment later — and the author would
     * have been shown a second chip for a category that is the first one.
     */
    const host = mount();
    type(host, "whitfield  FAMILY");

    expect(suggestionLabels(host)).toEqual(["Whitfield family"]);
  });

  it("offers nothing for a name that can have no address", () => {
    // See `categorySlug`: a name with no letter or digit has no slug, and the
    // fallback an entry title gets would merge every such name into one row.
    const host = mount();
    type(host, "🙂");

    expect(suggestionLabels(host)).toEqual([]);
  });
});

describe("the field inside the editor's form", () => {
  it("files under what was typed when Enter is pressed", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });
    type(host, "Emigrated to Canada");

    act(() => {
      field(host).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    // The *existing* row, not a new one with the same name: pressing Enter on
    // a name that already exists must file under it.
    expect(onChange).toHaveBeenCalledWith([
      { name: "Emigrated to Canada", slug: "emigrated-to-canada" },
    ]);
  });

  it("stops Enter from submitting the form it sits in", () => {
    /**
     * The bug this prevents is the whole reason the handler calls
     * `preventDefault`: this control lives inside the editor's `<form>`, where
     * the browser's default for Enter in a text input is to submit — so
     * without it, adding a category would save the entry instead.
     */
    const host = mount();
    type(host, "Kin");

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      field(host).dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("what the entry is filed under", () => {
  it("says so plainly when it is filed under nothing", () => {
    expect(mount().textContent).toContain("not filed under any category yet");
  });

  it("shows a chip per category, in the order given", () => {
    const host = mount({
      value: [
        { name: "Whitfield family", slug: "whitfield-family" },
        { name: "Born in Kilkenny", slug: "born-in-kilkenny" },
      ],
    });

    expect(chipLabels(host)).toEqual(["Whitfield family", "Born in Kilkenny"]);
  });

  it("removes the one whose button was pressed and leaves the rest", () => {
    const onChange = vi.fn();
    const host = mount({
      value: [
        { name: "Whitfield family", slug: "whitfield-family" },
        { name: "Born in Kilkenny", slug: "born-in-kilkenny" },
      ],
      onChange,
    });

    const remove = [...host.querySelectorAll("button")].find(
      (button) =>
        button.getAttribute("aria-label") ===
        "Remove the category Whitfield family",
    );
    if (!remove) throw new Error("no remove button for Whitfield family");
    click(remove);

    expect(onChange).toHaveBeenCalledWith([
      { name: "Born in Kilkenny", slug: "born-in-kilkenny" },
    ]);
  });

  it("stops offering the field once the entry is full", () => {
    const full = Array.from(
      { length: MAX_CATEGORIES_PER_ENTRY },
      (_, index) => ({ name: `Category ${index}`, slug: `category-${index}` }),
    );
    const host = mount({ value: full });

    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toContain(
      "the most categories one entry can carry",
    );
  });
});
