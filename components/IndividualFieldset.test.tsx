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
 * pure function can stand in for: that every control an author touches carries
 * a `<label>` pointing at it, that every `name` the form posts is a key
 * `individualInputFromFormData` will look for, and that a message from
 * `fieldErrors` is rendered beside its own field and referenced by it. Break
 * any one of those and the form still renders perfectly — which is exactly why
 * they are worth asserting.
 *
 * Everything the messages *say* is decided in `lib/individual-input.ts` and
 * tested there with no DOM at all. What a typed date *means* is decided in
 * `lib/parse-date.ts` and tested there, likewise.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * Every `name` the fieldset posts — which is every key of `IndividualFields`.
 *
 * Since E4-T2 (`YEO-39`) four of them belong to no visible control: each
 * date's qualifier and precision are worked out from what the author typed and
 * posted as hidden inputs. Since `YEO-88` four more join them: a range's upper
 * bound and its own precision, worked out of the same one text box. They are
 * still listed here, because the promise this array is making is about the
 * *submission*, and that promise did not change when the controls did — this
 * is the guard that would have caught the upper bound leaking away silently.
 */
const POSTED_NAMES = [
  "givenName",
  "surname",
  "sex",
  "birthDate",
  "birthDateQualifier",
  "birthDatePrecision",
  "birthDateUpper",
  "birthDateUpperPrecision",
  "birthPlace",
  "deathDate",
  "deathDateQualifier",
  "deathDatePrecision",
  "deathDateUpper",
  "deathDateUpperPrecision",
  "deathPlace",
  "notes",
] as const;

/** The named controls an author types into. The two dates are found by label. */
const TYPED_NAMES = [
  "givenName",
  "surname",
  "sex",
  "birthPlace",
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
 * The visible box for one date, found the way a person finds it: by the word
 * above it.
 *
 * It has no `name` — see `components/DateField.tsx` — so there is nothing else
 * to look it up by, and going through the label is the assertion that the
 * label points at the right thing.
 */
function dateBox(host: HTMLElement, legend: string): HTMLInputElement {
  const label = [...host.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === legend,
  );
  if (!label) throw new Error(`no label reading ${legend}`);

  const input = host.querySelector<HTMLInputElement>(`#${label.htmlFor}`);
  if (input === null) throw new Error(`${legend} labels nothing`);
  return input;
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
  it("names every posted value after the record's own field", () => {
    const host = mount();

    for (const name of POSTED_NAMES) {
      expect(control(host, name)).not.toBeNull();
    }
  });

  it("labels every control an author touches", () => {
    const host = mount();

    for (const name of TYPED_NAMES) {
      const id = control(host, name).id;
      expect(id, `${name} has no id to label`).not.toBe("");

      const label = host.querySelector(`label[for="${id}"]`);
      expect(label?.textContent?.trim(), `${name} has no label`).toBeTruthy();
    }

    // Both dates, by the only route there is to them.
    expect(dateBox(host, "Born")).not.toBeNull();
    expect(dateBox(host, "Died")).not.toBeNull();
  });

  it("requires the first name and nothing else", () => {
    const host = mount();

    const required = TYPED_NAMES.filter((name) =>
      control(host, name).hasAttribute("required"),
    );

    // Partial knowledge is the normal case in genealogy: everything except a
    // first name is optional, and this is the assertion that keeps it so.
    expect(required).toEqual(["givenName"]);
    expect(dateBox(host, "Born").hasAttribute("required")).toBe(false);
    expect(dateBox(host, "Died").hasAttribute("required")).toBe(false);
  });

  it("shows the current values", () => {
    const host = mount({
      values: {
        ...emptyIndividualFormValues,
        givenName: "Rose",
        surname: "Hale",
        sex: "female",
        birthDate: "about 1890",
        notes: "From the 1911 census.",
      },
    });

    expect((control(host, "givenName") as HTMLInputElement).value).toBe("Rose");
    expect((control(host, "surname") as HTMLInputElement).value).toBe("Hale");
    expect((control(host, "sex") as HTMLSelectElement).value).toBe("female");
    expect((control(host, "notes") as HTMLTextAreaElement).value).toBe(
      "From the 1911 census.",
    );

    // The author's own phrasing stays on screen …
    expect(dateBox(host, "Born").value).toBe("about 1890");
  });

  it("posts a typed date as the three columns it occupies", () => {
    const host = mount({
      values: { ...emptyIndividualFormValues, birthDate: "about 1890" },
    });

    // … and the columns it means are posted beside it. The year anchors to 1
    // January because a `date` column has to hold a day; `birthDatePrecision`
    // is what stops anything downstream reading it as one.
    expect((control(host, "birthDate") as HTMLInputElement).value).toBe(
      "1890-01-01",
    );
    expect(
      (control(host, "birthDateQualifier") as HTMLInputElement).value,
    ).toBe("about");
    expect(
      (control(host, "birthDatePrecision") as HTMLInputElement).value,
    ).toBe("year");
  });

  it("posts a typed range as five columns, upper bound and all (YEO-88)", () => {
    // The highest-consequence guard in this ticket: if `DateField` did not
    // post these two, a range would come back through the form with its
    // upper bound silently gone.
    const host = mount({
      values: {
        ...emptyIndividualFormValues,
        birthDate: "between 1890 and 1900",
      },
    });

    expect((control(host, "birthDate") as HTMLInputElement).value).toBe(
      "1890-01-01",
    );
    expect(
      (control(host, "birthDateQualifier") as HTMLInputElement).value,
    ).toBe("exact");
    expect(
      (control(host, "birthDatePrecision") as HTMLInputElement).value,
    ).toBe("year");
    expect((control(host, "birthDateUpper") as HTMLInputElement).value).toBe(
      "1900-01-01",
    );
    expect(
      (control(host, "birthDateUpperPrecision") as HTMLInputElement).value,
    ).toBe("year");
  });

  it("posts a date it could not read unchanged, rather than nothing", () => {
    const host = mount({
      values: {
        ...emptyIndividualFormValues,
        birthDate: "sometime in the 90s",
      },
    });

    // The point of the whole ticket: an unreadable date must come back as a
    // refusal from the server, not as a save with the date quietly missing.
    expect((control(host, "birthDate") as HTMLInputElement).value).toBe(
      "sometime in the 90s",
    );
  });

  it("reports a change under the field's own name", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });

    type(control(host, "surname"), "Hale");

    expect(onChange).toHaveBeenCalledWith("surname", "Hale");
  });

  it("reports a typed date unparsed, as the author wrote it", () => {
    const onChange = vi.fn();
    const host = mount({ onChange });

    type(dateBox(host, "Born"), "abt 1890");

    // The form holds the phrasing; the parsing happens on the way out.
    expect(onChange).toHaveBeenCalledWith("birthDate", "abt 1890");
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

    expect(dateBox(host, "Died").getAttribute("aria-invalid")).toBe("true");
    expect(control(host, "givenName").getAttribute("aria-invalid")).toBe(
      "false",
    );
    expect(
      control(host, "givenName").getAttribute("aria-describedby"),
    ).toBeNull();

    // One message on the page, not one per field with an empty one hiding
    // under each of the ones that are fine.
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("shows a qualifier's own message under its date", () => {
    // Only a hand-made POST can get here, since nobody types a qualifier any
    // more — but a message with no field to hang under is a message nobody
    // reads, which is the silent drop this ticket exists to prevent.
    const host = mount({
      fieldErrors: {
        birthDatePrecision:
          "That is not one of the options for how much of a date is known.",
      },
    });

    const box = dateBox(host, "Born");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain(
      "That is not one of the options for how much of a date is known.",
    );
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
  };

  it("turns every unknown into the blank an input can hold", () => {
    expect(individualFormValuesFrom(unknown)).toEqual({
      ...emptyIndividualFormValues,
      givenName: "Rose",
    });
  });

  it("writes each date back as the sentence the author would have typed", () => {
    const recorded: IndividualFields = {
      givenName: "Rose",
      surname: "Hale",
      sex: "female",
      birthDate: "1890-01-01",
      birthDateQualifier: "about",
      birthDatePrecision: "year",
      birthDateUpper: null,
      birthDateUpperPrecision: "day",
      birthPlace: "Cork",
      deathDate: "1953-11-02",
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
      deathDateUpper: null,
      deathDateUpperPrecision: "day",
      deathPlace: "Dublin",
      notes: "From the 1911 census.",
    };

    expect(individualFormValuesFrom(recorded)).toEqual({
      givenName: "Rose",
      surname: "Hale",
      sex: "female",
      // Not "1 January 1890": the precision says the day was never recorded,
      // and prefilling it would put a fact in the author's mouth.
      birthDate: "about 1890",
      birthPlace: "Cork",
      deathDate: "2 November 1953",
      deathPlace: "Dublin",
      notes: "From the 1911 census.",
    });
  });

  it("writes a stored range back as 'between x and y' — the round trip the edit form depends on (YEO-88)", () => {
    const ranged: IndividualFields = {
      ...unknown,
      birthDate: "1890-01-01",
      birthDatePrecision: "year",
      birthDateUpper: "1900-01-01",
      birthDateUpperPrecision: "year",
    };

    expect(individualFormValuesFrom(ranged).birthDate).toBe(
      "between 1890 and 1900",
    );
  });

  it("fills every field the fieldset renders", () => {
    // The pairing that matters: a field added to the record but forgotten
    // here would render as `undefined` in a controlled input, which React
    // turns into an uncontrolled one without saying so.
    const values = individualFormValuesFrom(unknown);

    for (const name of Object.keys(emptyIndividualFormValues)) {
      expect(
        typeof values[name as keyof IndividualFormValues],
        `${name} is not prefilled`,
      ).toBe("string");
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
