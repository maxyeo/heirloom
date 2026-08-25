// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PortraitField,
  type PortraitPair,
  type PreparePortrait,
} from "@/components/PortraitField";
import { portraitSrc } from "@/lib/portrait";
import { render, rerender } from "@/test/render";

/**
 * What only a document can prove about choosing a portrait (E5-T4, `YEO-44`).
 *
 * `preparePortrait` itself calls `createImageBitmap` and draws into a canvas,
 * neither of which jsdom implements — see `PortraitField`'s own docblock,
 * "why the three browser calls are here". That is exactly why `prepare` is a
 * prop: every test below hands it a stub, docs/testing.md's "take it, do not
 * import it", and asserts only what the component itself decides — what it
 * posts, when it clears both keys rather than one, and what the picker looks
 * like before and after.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const KEY = "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";
const THUMB = "images/cd/2f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81.webp";

function mount(options: {
  portraitKey?: string;
  portraitThumbKey?: string;
  onChange?: (field: "portraitKey" | "portraitThumbKey", value: string) => void;
  namePrefix?: string;
  prepare?: PreparePortrait;
}) {
  return render(
    <PortraitField
      portraitKey={options.portraitKey ?? ""}
      portraitThumbKey={options.portraitThumbKey ?? ""}
      onChange={options.onChange ?? (() => {})}
      personName="Rose Hale"
      namePrefix={options.namePrefix}
      prepare={options.prepare}
    />,
  );
}

function hiddenInput(host: HTMLElement, name: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    `input[type="hidden"][name="${name}"]`,
  );
  if (input === null) throw new Error(`no hidden input named "${name}"`);
  return input;
}

function fileInput(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  return input;
}

/** Choose a file, the way `components/GedcomImport.test.tsx` does. */
async function choose(
  input: HTMLInputElement,
  name = "photo.jpg",
): Promise<void> {
  const chosen = new File(["x"], name, { type: "image/jpeg" });
  Object.defineProperty(input, "files", {
    configurable: true,
    value: Object.assign([chosen], { item: () => chosen }),
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // Let the component's async `choose` handler settle.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function ok(pair: PortraitPair): PreparePortrait {
  return async () => ({ ok: true, pair });
}

function failing(message: string): PreparePortrait {
  return async () => ({ ok: false, message });
}

describe("with no portrait", () => {
  it("has both hidden inputs present and empty", () => {
    const host = mount({});

    expect(hiddenInput(host, "portraitKey").value).toBe("");
    expect(hiddenInput(host, "portraitThumbKey").value).toBe("");
  });

  it("shows the placeholder", () => {
    const host = mount({});
    expect(
      host.querySelector('[data-testid="portrait-placeholder"]'),
    ).not.toBeNull();
    expect(host.querySelector("img")).toBeNull();
  });

  it("offers no remove button", () => {
    const host = mount({});
    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Remove photograph"),
      ),
    ).toBe(false);
  });
});

describe("with a portrait already set", () => {
  it("carries both keys on the hidden inputs", () => {
    const host = mount({ portraitKey: KEY, portraitThumbKey: THUMB });

    expect(hiddenInput(host, "portraitKey").value).toBe(KEY);
    expect(hiddenInput(host, "portraitThumbKey").value).toBe(THUMB);
  });

  it("previews the resolved path of the full portrait", () => {
    // The full portrait, deliberately, not the thumbnail — the same asymmetry
    // `lib/person-detail.ts` gives for the detail panel, checked here for the
    // form's own preview.
    const host = mount({ portraitKey: KEY, portraitThumbKey: THUMB });
    const src = host.querySelector("img")?.getAttribute("src") ?? "";
    expect(src.endsWith(portraitSrc(KEY) ?? "")).toBe(true);
  });

  it("removing the photograph clears both keys", () => {
    const onChange = vi.fn();
    const host = mount({ portraitKey: KEY, portraitThumbKey: THUMB, onChange });

    const remove = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Remove photograph"),
    );
    if (!remove) throw new Error("no remove button");
    act(() => remove.click());

    expect(onChange).toHaveBeenCalledWith("portraitKey", "");
    expect(onChange).toHaveBeenCalledWith("portraitThumbKey", "");
  });
});

describe("picking a file", () => {
  it("on success, calls onChange with both keys", async () => {
    const onChange = vi.fn();
    const host = mount({
      onChange,
      prepare: ok({ portraitKey: KEY, portraitThumbKey: THUMB }),
    });

    await choose(fileInput(host));

    expect(onChange).toHaveBeenCalledWith("portraitKey", KEY);
    expect(onChange).toHaveBeenCalledWith("portraitThumbKey", THUMB);
  });

  it("writes an empty string for a null thumbnail rather than leaving it unset", async () => {
    const onChange = vi.fn();
    const host = mount({
      onChange,
      prepare: ok({ portraitKey: KEY, portraitThumbKey: null }),
    });

    await choose(fileInput(host));

    expect(onChange).toHaveBeenCalledWith("portraitKey", KEY);
    expect(onChange).toHaveBeenCalledWith("portraitThumbKey", "");
  });

  it("on failure, clears both keys and shows the message", async () => {
    const onChange = vi.fn();
    const host = mount({
      portraitKey: KEY,
      portraitThumbKey: THUMB,
      onChange,
      prepare: failing("That file could not be read as an image."),
    });

    await choose(fileInput(host));

    expect(onChange).toHaveBeenCalledWith("portraitKey", "");
    expect(onChange).toHaveBeenCalledWith("portraitThumbKey", "");
    expect(host.textContent).toContain(
      "That file could not be read as an image.",
    );
  });
});

describe("namePrefix", () => {
  it("prefixes both hidden inputs' names", () => {
    const host = mount({ namePrefix: "spouse." });

    expect(hiddenInput(host, "spouse.portraitKey")).not.toBeNull();
    expect(hiddenInput(host, "spouse.portraitThumbKey")).not.toBeNull();
  });
});

describe("the file input", () => {
  it("has no name attribute — the file itself is never a posted field", () => {
    // The contract with `individualInputFromFormData`: what posts is the
    // two hidden inputs below, named exactly as the columns are. A `name`
    // here would post a `File` under a key nothing reads.
    const host = mount({});
    expect(fileInput(host).getAttribute("name")).toBeNull();
  });
});

// Exercises `rerender` so the file input's cleared value between two picks is
// not mistaken for coverage that was never asserted.
describe("re-rendering with new props", () => {
  it("reflects a portrait key set by the caller after a rerender", () => {
    const host = mount({});
    rerender(
      host,
      <PortraitField
        portraitKey={KEY}
        portraitThumbKey={THUMB}
        onChange={() => {}}
        personName="Rose Hale"
      />,
    );

    expect(hiddenInput(host, "portraitKey").value).toBe(KEY);
    expect(hiddenInput(host, "portraitThumbKey").value).toBe(THUMB);
  });
});
