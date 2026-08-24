// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DateField } from "@/components/DateField";
import { render } from "@/test/render";

/**
 * What the date box does that a pure function cannot (E4-T2, `YEO-39`).
 *
 * Everything about *what a date means* is decided by `lib/parse-date.ts` and
 * asserted in `lib/parse-date.test.ts` with no DOM at all. What is left, and
 * all this file covers, is the three things only a component can be wrong
 * about: what it posts, when it complains, and whether the author can see that
 * they were understood.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function mount(
  options: {
    value?: string;
    error?: string;
    onChange?: (value: string) => void;
  } = {},
): HTMLElement {
  return render(
    <DateField
      legend="Born"
      name="birthDate"
      value={options.value ?? ""}
      onChange={options.onChange ?? (() => {})}
      error={options.error}
    />,
  );
}

function box(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[type="text"]');
  if (input === null) throw new Error("no date box");
  return input;
}

function posted(host: HTMLElement, name: string): string {
  const input = host.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (input === null) throw new Error(`nothing posts as ${name}`);
  return input.value;
}

/**
 * Leave the field.
 *
 * `focusout` rather than `blur`: React's `onBlur` is backed by the native
 * bubbling event, and `blur` does not bubble — dispatching it reaches the
 * root listener at no point and the handler never runs.
 */
function blur(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("what it posts", () => {
  it("splits a typed date into the three columns it occupies", () => {
    const host = mount({ value: "about 1890" });

    expect(posted(host, "birthDate")).toBe("1890-01-01");
    expect(posted(host, "birthDateQualifier")).toBe("about");
    expect(posted(host, "birthDatePrecision")).toBe("year");
  });

  it("posts nothing for a blank field", () => {
    const host = mount({ value: "" });

    expect(posted(host, "birthDate")).toBe("");
    // The column defaults, so a blank date carries no stray qualifier into a
    // GEDCOM export.
    expect(posted(host, "birthDateQualifier")).toBe("exact");
    expect(posted(host, "birthDatePrecision")).toBe("day");
  });

  it("posts text it could not read unchanged, rather than nothing", () => {
    const host = mount({ value: "sometime in the 90s" });

    // The rule the whole ticket rests on. An empty date here would be a save
    // that appears to succeed while discarding what somebody typed; posting
    // the text makes the server refuse it, which is a message the author sees.
    expect(posted(host, "birthDate")).toBe("sometime in the 90s");
  });

  it("gives the visible box no name of its own", () => {
    // The author's phrasing has no column. What posts is derived from it.
    expect(box(mount()).hasAttribute("name")).toBe(false);
  });

  it("reports what was typed, unparsed", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });

    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(box(host), "abt 1890");
    act(() => {
      box(host).dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("abt 1890");
  });
});

describe("showing the author they were understood", () => {
  it("echoes the parsed date back in plain language", () => {
    const host = mount({ value: "c. 1890" });

    // The acceptance criterion: somebody who wrote "c. 1890" needs to see that
    // it landed as "about 1890" and not as something else.
    expect(host.textContent).toContain("about 1890");
  });

  it("echoes a full date the way the rest of the app writes one", () => {
    expect(mount({ value: "1890-03-12" }).textContent).toContain(
      "12 March 1890",
    );
  });

  it("does not turn a year into 1 January", () => {
    const host = mount({ value: "1890" });

    expect(host.textContent).toContain("1890");
    expect(host.textContent).not.toContain("January");
  });

  it("always says what shapes are accepted", () => {
    // The entire discoverability of the feature. Without it the box reads as
    // an ordinary date field and nobody finds out that "about 1890" is
    // allowed — which would leave the qualifier dropdown removed and the
    // problem it caused unsolved.
    const host = mount();

    expect(host.textContent).toContain("about 1890");
    expect(host.textContent).toContain("12 March 1890");
  });
});

describe("when it complains", () => {
  it("says nothing while the author is still typing", () => {
    // Every date passes through unreadable states on the way to being
    // written. A field that reddens at each of them is telling the author
    // they are wrong for having a keyboard.
    const host = mount({ value: "abo" });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(box(host).getAttribute("aria-invalid")).toBe("false");
  });

  it("says so once the author has moved on", () => {
    const host = mount({ value: "abo" });

    blur(box(host));

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("could not be read");
    expect(box(host).getAttribute("aria-invalid")).toBe("true");
  });

  it("shows what the server said straight away", () => {
    // That one is about a submission which has already happened, so there is
    // nothing left to wait for.
    const host = mount({
      value: "1880-01-01",
      error: "The death date is before the birth date.",
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "before the birth date",
    );
  });

  it("describes the box with its hint, its echo and its message", () => {
    const host = mount({ value: "1890", error: "Something was wrong." });

    const described = (box(host).getAttribute("aria-describedby") ?? "").split(
      " ",
    );
    const text = described
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");

    expect(text).toContain("about 1890"); // the hint
    expect(text).toContain("Understood as"); // the echo
    expect(text).toContain("Something was wrong."); // the message
  });
});
