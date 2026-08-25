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

/** Put a file on the input, without dispatching anything. */
function setFiles(input: HTMLInputElement, name: string): void {
  const chosen = new File(["x"], name, { type: "image/jpeg" });
  Object.defineProperty(input, "files", {
    configurable: true,
    value: Object.assign([chosen], { item: () => chosen }),
  });
}

/** Choose a file, the way `components/GedcomImport.test.tsx` does. */
async function choose(
  input: HTMLInputElement,
  name = "photo.jpg",
): Promise<void> {
  setFiles(input, name);
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

  /**
   * The data-loss guard.
   *
   * An earlier version of this component cleared both keys when a pick was
   * refused, on the theory that it was avoiding a half-pair. It was not:
   * `prepare` fails before any `onChange` runs, so the keys still hold the
   * portrait the person already had — and emptying them meant that picking a
   * file the endpoint refuses, or picking one with the connection down,
   * deleted a photograph the family had already saved. Nothing gates Save on
   * the error message, and "that file could not be read" does not read as
   * "and your old picture is gone", so the next thing an author does is save.
   *
   * Asserted as `not.toHaveBeenCalled` rather than by checking the final
   * values, because the bug was an *extra write* — a test that only looked at
   * the end state would pass just as happily with the write present and the
   * caller reapplying its own props.
   */
  it("leaves an already-saved portrait untouched when a replacement fails", async () => {
    const onChange = vi.fn();
    const host = mount({
      portraitKey: KEY,
      portraitThumbKey: THUMB,
      onChange,
      prepare: failing("That file could not be read as an image."),
    });

    await choose(fileInput(host));

    expect(onChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      "That file could not be read as an image.",
    );
    // And the preview still shows the photograph that is genuinely on file.
    const preview = host.querySelector("img")?.getAttribute("src") ?? "";
    expect(preview.endsWith(portraitSrc(KEY) ?? "")).toBe(true);
  });

  it("keeps both keys empty when a first-ever pick fails", async () => {
    // The same rule seen from the other side: with nothing saved yet there is
    // nothing to protect, and the hidden inputs must still post as empty
    // rather than as a stale value from a failed attempt.
    const onChange = vi.fn();
    const host = mount({
      portraitKey: "",
      portraitThumbKey: "",
      onChange,
      prepare: failing("That file is too large."),
    });

    await choose(fileInput(host));

    expect(onChange).not.toHaveBeenCalled();
    expect(hiddenInput(host, "portraitKey").value).toBe("");
    expect(hiddenInput(host, "portraitThumbKey").value).toBe("");
  });
});

describe("two picks in flight at once", () => {
  /**
   * The winner must be the pick the author made last, not the upload that
   * happened to finish last — a large photograph chosen first can easily
   * settle after a small one chosen second.
   *
   * The file input is `disabled` while an upload runs, which is what makes
   * this hard to reach with a mouse. It is not the guarantee, and this
   * codebase draws that distinction elsewhere: `components/GedcomImport.tsx`
   * says in as many words that disabling a control is "a convenience for the
   * ordinary path, not the guard". So the component carries a pick counter,
   * and this asserts the counter rather than the attribute.
   */
  it("ignores an earlier pick that settles after a later one", async () => {
    const onChange = vi.fn();
    const SECOND = "images/ef/3f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b99.jpg";

    let releaseFirst = () => {};
    const firstSettled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let call = 0;
    const prepare: PreparePortrait = async () => {
      call += 1;
      if (call === 1) {
        await firstSettled;
        return { ok: true, pair: { portraitKey: KEY, portraitThumbKey: null } };
      }
      return {
        ok: true,
        pair: { portraitKey: SECOND, portraitThumbKey: null },
      };
    };

    const host = mount({ onChange, prepare });
    const input = fileInput(host);

    /**
     * Both picks are dispatched inside **one** `act`, and the first is left
     * hanging. Two overlapping `act` calls corrupt React's internal state,
     * so the un-awaited pick cannot go through the `choose` helper above —
     * which is exactly why the events are dispatched by hand here.
     */
    await act(async () => {
      setFiles(input, "slow.jpg");
      input.dispatchEvent(new Event("change", { bubbles: true }));
      setFiles(input, "quick.jpg");
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(call).toBe(2);
    expect(onChange).toHaveBeenCalledWith("portraitKey", SECOND);
    onChange.mockClear();

    // Now let the abandoned first upload land. It must change nothing.
    await act(async () => {
      releaseFirst();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
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
