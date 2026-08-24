// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  IndividualFieldset,
  emptyIndividualFormValues,
  individualFormValuesFrom,
  type IndividualFormValues,
} from "@/components/IndividualFieldset";
import type {
  IndividualFieldErrors,
  IndividualFields,
} from "@/lib/individual-input";
import { render } from "@/test/render";

/**
 * What the fields promise the rest of E3 (E3-T2, `YEO-30`).
 *
 * Three things here genuinely need a document, and they are all joins that no
 * pure function can stand in for: that every control carries a `<label>`
 * pointing at it, that each of the ten inputs is named the key
 * `individualInputFromFormData` will look for, and that a message from
 * `fieldErrors` is rendered beside its own field and referenced by it. Break
 * any one of those and the form still renders perfectly — which is exactly why
 * they are worth asserting.
 *
 * Everything the messages *say* is decided in `lib/individual-input.ts` and
 * tested there with no DOM at all.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Every key of `IndividualFields`, which is every `name` on the form. */
const FIELD_NAMES = [
  "givenName",
  "surname",
  "sex",
  "birthDate",
  "birthDateQualifier",
  "birthPlace",
  "deathDate",
  "deathDateQualifier",
  "deathPlace",
  "notes",
] as const;

function mount(
  options: {
    values?: IndividualFormValues;
    fieldErrors?: IndividualFieldErrors;
    onChange?: (field: string, value: string) => void;
  } = {},
): HTMLElement {
  return render(
    <IndividualFieldset
      values={options.values ?? emptyIndividualFormValues}
      onChange={options.onChange ?? (() => {})}
      fieldErrors={options.fieldErrors ?? {}}
    />,
  );
}

function control(host: HTMLElement, name: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[name="${name}"]`);
  if (element === null) throw new Error(`no control named ${name}`);
  return element;
}

/**
 * Type into a controlled input the way a person does.
 *
 * Assigning `.value` alone is not enough: React remembers the value it last
 * wrote and skips the change event when the DOM already agrees with it, so a
 * plain assignment plus a dispatch fires nothing. Going through the prototype
 * setter updates the node behind React's tracker, which is what makes the
 * following event look like a keystroke.
 */
function type(element: HTMLElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    "value",
  )?.set;
  setter?.call(element, value);
  act(() => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the fields", () => {
  it("names every control after the record's own field", () => {
    const host = mount();

    for (const name of FIELD_NAMES) {
      expect(control(host, name)).not.toBeNull();
    }
  });

  it("labels every control", () => {
    const host = mount();

    for (const name of FIELD_NAMES) {
      const id = control(host, name).id;
      expect(id, `${name} has no id to label`).not.toBe("");

      const label = host.querySelector(`label[for="${id}"]`);
      expect(label?.textContent?.trim(), `${name} has no label`).toBeTruthy();
    }
  });

  it("requires the first name and nothing else", () => {
    const host = mount();

    const required = FIELD_NAMES.filter((name) =>
      control(host, name).hasAttribute("required"),
    );

    // Partial knowledge is the normal case in genealogy: everything except a
    // first name is optional, and this is the assertion that keeps it so.
    expect(required).toEqual(["givenName"]);
  });

  it("shows the current values", () => {
    const host = mount({
      values: {
        ...emptyIndividualFormValues,
        givenName: "Rose",
        surname: "Hale",
        sex: "female",
        birthDate: "1890-04-12",
        birthDateQualifier: "about",
        notes: "From the 1911 census.",
      },
    });

    expect((control(host, "givenName") as HTMLInputElement).value).toBe("Rose");
    expect((control(host, "surname") as HTMLInputElement).value).toBe("Hale");
    expect((control(host, "sex") as HTMLSelectElement).value).toBe("female");
    expect((control(host, "birthDate") as HTMLInputElement).value).toBe(
      "1890-04-12",
    );
    expect(
      (control(host, "birthDateQualifier") as HTMLSelectElement).value,
    ).toBe("about");
    expect((control(host, "notes") as HTMLTextAreaElement).value).toBe(
      "From the 1911 census.",
    );
  });

  it("reports a change under the field's own name", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });

    type(control(host, "surname"), "Hale");

    expect(onChange).toHaveBeenCalledWith("surname", "Hale");
  });
});

describe("errors", () => {
  it("renders a message beside the field it belongs to", () => {
    const host = mount({
      fieldErrors: { givenName: "Give this person a first name." },
    });

    const givenName = control(host, "givenName");
    expect(givenName.getAttribute("aria-invalid")).toBe("true");

    const describedBy = givenName.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();

    const message = document.getElementById(describedBy ?? "");
    expect(message?.textContent).toBe("Give this person a first name.");
    expect(message?.getAttribute("role")).toBe("alert");
  });

  it("leaves the fields that are fine alone", () => {
    const host = mount({
      fieldErrors: {
        deathDate:
          "The death date is before the birth date. Check whether one of them has the wrong year.",
      },
    });

    expect(control(host, "deathDate").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(control(host, "givenName").getAttribute("aria-invalid")).toBe(
      "false",
    );
    expect(
      control(host, "givenName").getAttribute("aria-describedby"),
    ).toBeNull();

    // One message on the page, not one per field with an empty one hiding
    // under each of the nine that are fine.
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe("prefilling from a record", () => {
  /** A person with every optional field unknown — the hard half of the map. */
  const unknown: IndividualFields = {
    givenName: "Rose",
    surname: null,
    sex: "unknown",
    birthDate: null,
    birthDateQualifier: "exact",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathPlace: null,
    notes: null,
  };

  it("turns every unknown into the blank an input can hold", () => {
    expect(individualFormValuesFrom(unknown)).toEqual({
      ...emptyIndividualFormValues,
      givenName: "Rose",
    });
  });

  it("carries every recorded value through unchanged", () => {
    const recorded: IndividualFields = {
      givenName: "Rose",
      surname: "Hale",
      sex: "female",
      birthDate: "1890-04-12",
      birthDateQualifier: "about",
      birthPlace: "Cork",
      deathDate: "1953-11-02",
      deathDateQualifier: "before",
      deathPlace: "Dublin",
      notes: "From the 1911 census.",
    };

    expect(individualFormValuesFrom(recorded)).toEqual(recorded);
  });

  it("fills every field the fieldset renders", () => {
    // The pairing that matters: a field added to the record but forgotten
    // here would render as `undefined` in a controlled input, which React
    // turns into an uncontrolled one without saying so.
    const values = individualFormValuesFrom(unknown);

    for (const name of FIELD_NAMES) {
      expect(typeof values[name], `${name} is not prefilled`).toBe("string");
    }
  });

  it("renders as a filled-in form", () => {
    const host = mount({
      values: individualFormValuesFrom({ ...unknown, surname: "Hale" }),
    });

    expect((control(host, "surname") as HTMLInputElement).value).toBe("Hale");
    // Not the string "null", which is what a looser conversion would show.
    expect((control(host, "birthPlace") as HTMLInputElement).value).toBe("");
  });
});
