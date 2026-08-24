// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AddPersonPanel,
  type IndividualFormAction,
} from "@/components/AddPersonPanel";
import {
  emptyIndividualFormState,
  invalidFormState,
  savedFormState,
  type IndividualFormState,
} from "@/lib/individual-form-state";
import { render } from "@/test/render";

/**
 * The add-person panel's wiring (E3-T2, `YEO-30`).
 *
 * The action is a stub, and that is the point of it being a prop: this file
 * asserts what the *form* does with a submission and with what comes back,
 * which is everything E3-T2 owns. What a real submission then writes belongs
 * to `createIndividual` and `validateIndividual`, both already tested without
 * a document.
 *
 * The one behaviour here that no amount of reading the component reveals:
 * React resets a form on every action submission, before the action has even
 * run. "A refusal keeps what was typed" is the test that fails the day
 * somebody makes these inputs uncontrolled because it looks tidier.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * An action that records what it was sent and answers with whatever the test
 * wants. `submissions` is read after the fact rather than asserted inside the
 * action, so a failure points at the expectation and not at a callback.
 */
function stubAction(
  reply: (form: FormData) => IndividualFormState = () =>
    emptyIndividualFormState,
): IndividualFormAction & { submissions: FormData[] } {
  const submissions: FormData[] = [];
  const action = async (_state: IndividualFormState, form: FormData) => {
    submissions.push(form);
    return reply(form);
  };
  return Object.assign(action, { submissions });
}

function mount(action: IndividualFormAction): HTMLElement {
  return render(<AddPersonPanel action={action} />);
}

function opener(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>("button");
  if (button === null) throw new Error("no button to open the panel");
  return button;
}

function open(host: HTMLElement): void {
  act(() => opener(host).click());
}

function panel(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('aside[aria-label="Add a person"]');
}

function control(host: HTMLElement, name: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[name="${name}"]`);
  if (element === null) throw new Error(`no control named ${name}`);
  return element;
}

/** See the identical note in `IndividualFieldset.test.tsx`. */
function type(host: HTMLElement, name: string, value: string): void {
  const element = control(host, name);
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    "value",
  )?.set;
  setter?.call(element, value);
  act(() => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Submit, and let the action's promise settle before anything is asserted. */
async function submit(host: HTMLElement): Promise<void> {
  const form = host.querySelector("form");
  if (form === null) throw new Error("the panel has no form");
  await act(async () => {
    form.requestSubmit();
  });
}

describe("opening and closing", () => {
  it("stays closed until the button is pressed", () => {
    const host = mount(stubAction());

    expect(panel(host)).toBeNull();
    expect(opener(host).getAttribute("aria-expanded")).toBe("false");

    open(host);

    expect(panel(host)).not.toBeNull();
    expect(opener(host).getAttribute("aria-expanded")).toBe("true");
  });

  it("puts focus in the first field when it opens", () => {
    const host = mount(stubAction());
    open(host);

    expect(document.activeElement).toBe(control(host, "givenName"));
  });

  it("closes on Escape and puts focus back on the button", () => {
    const host = mount(stubAction());
    open(host);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(panel(host)).toBeNull();
    expect(document.activeElement).toBe(opener(host));
  });

  it("forgets a half-typed person when it is closed", () => {
    const host = mount(stubAction());
    open(host);
    type(host, "givenName", "Rose");

    const close = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Close",
    );
    act(() => close?.click());
    open(host);

    expect((control(host, "givenName") as HTMLInputElement).value).toBe("");
  });
});

describe("submitting", () => {
  it("sends every field under the record's own names", async () => {
    const action = stubAction(() => savedFormState(nextSavedId()));
    const host = mount(action);
    open(host);

    type(host, "givenName", "Rose");
    type(host, "surname", "Hale");
    type(host, "birthDate", "1890-04-12");
    type(host, "birthPlace", "Cork");
    type(host, "notes", "From the 1911 census.");

    await submit(host);

    expect(action.submissions).toHaveLength(1);
    const sent = action.submissions[0];
    expect(sent.get("givenName")).toBe("Rose");
    expect(sent.get("surname")).toBe("Hale");
    expect(sent.get("birthDate")).toBe("1890-04-12");
    expect(sent.get("birthPlace")).toBe("Cork");
    expect(sent.get("notes")).toBe("From the 1911 census.");

    // Untouched optional fields still post — blank, which
    // `validateIndividual` reads as "unknown" rather than as an empty string.
    expect(sent.get("deathDate")).toBe("");
    expect(sent.get("sex")).toBe("unknown");
    expect(sent.get("birthDateQualifier")).toBe("exact");
  });

  it("can add a person with nothing but a first name", async () => {
    const action = stubAction(() => savedFormState(nextSavedId()));
    const host = mount(action);
    open(host);

    type(host, "givenName", "Rose");
    await submit(host);

    expect(action.submissions).toHaveLength(1);
    expect(host.textContent).toContain("Added Rose.");
  });

  it("keeps what was typed when the submission is refused", async () => {
    const action = stubAction(() =>
      invalidFormState([
        {
          field: "deathDate",
          message:
            "The death date is before the birth date. Check whether one of them has the wrong year.",
        },
      ]),
    );
    const host = mount(action);
    open(host);

    type(host, "givenName", "Rose");
    type(host, "birthDate", "1890-04-12");
    type(host, "deathDate", "1880-01-01");

    await submit(host);

    // React resets a form on every action submission. Nothing the author
    // typed may disappear because of it.
    expect((control(host, "givenName") as HTMLInputElement).value).toBe("Rose");
    expect((control(host, "birthDate") as HTMLInputElement).value).toBe(
      "1890-04-12",
    );

    const deathDate = control(host, "deathDate");
    expect(deathDate.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(
      deathDate.getAttribute("aria-describedby") ?? "",
    );
    expect(message?.textContent).toContain("before the birth date");
  });

  it("clears the fields after a save, ready for the next person", async () => {
    const action = stubAction(() => savedFormState(nextSavedId()));
    const host = mount(action);
    open(host);

    type(host, "givenName", "Rose");
    type(host, "surname", "Hale");
    await submit(host);

    expect(host.textContent).toContain("Added Rose Hale.");
    expect((control(host, "givenName") as HTMLInputElement).value).toBe("");
    expect((control(host, "surname") as HTMLInputElement).value).toBe("");

    // Still open, and the cursor is back where the next person starts.
    expect(panel(host)).not.toBeNull();
    expect(document.activeElement).toBe(control(host, "givenName"));
  });

  it("stops confirming an earlier save once a later one is refused", async () => {
    // The confirmation belongs to the latest submission, not to the last one
    // that worked: "Added Rose." sitting beside the next person's error reads
    // as though the error were Rose's.
    let refuse = false;
    const action = stubAction(() =>
      refuse
        ? invalidFormState([
            {
              field: "deathDate",
              message:
                "The death date is before the birth date. Check whether one of them has the wrong year.",
            },
          ])
        : savedFormState(nextSavedId()),
    );
    const host = mount(action);
    open(host);

    type(host, "givenName", "Rose");
    await submit(host);
    expect(host.textContent).toContain("Added Rose.");

    refuse = true;
    type(host, "givenName", "Thomas");
    type(host, "deathDate", "1880-01-01");
    await submit(host);

    expect(host.textContent).not.toContain("Added Rose.");
    expect(host.textContent).toContain("before the birth date");
    // The correction is still in the fields, waiting to be fixed.
    expect((control(host, "givenName") as HTMLInputElement).value).toBe(
      "Thomas",
    );
  });

  it("shows a failure that belongs to no single field", async () => {
    const action = stubAction(() => ({
      savedId: null,
      error: "The tree could not be reached. Try again.",
      fieldErrors: {},
    }));
    const host = mount(action);
    open(host);

    type(host, "givenName", "Rose");
    await submit(host);

    expect(host.textContent).toContain("The tree could not be reached.");
    expect((control(host, "givenName") as HTMLInputElement).value).toBe("Rose");
  });
});

/** A different id per submission, so "a save just happened" is detectable. */
let saves = 0;
function nextSavedId(): string {
  saves += 1;
  return `saved-${saves}`;
}
