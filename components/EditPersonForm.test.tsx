// @vitest-environment jsdom
import { act } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { EditPerson, type EditPersonProps } from "@/components/EditPersonForm";
import type { GraphPerson } from "@/lib/family-graph";
import {
  emptyIndividualFormState,
  failedFormState,
  type IndividualFormState,
  invalidFormState,
  savedFormState,
} from "@/lib/individual-form-state";
import {
  individualInputFromFormData,
  validateIndividual,
} from "@/lib/individual-input";
import { render } from "@/test/render";

/**
 * The edit-person flow (E3-T3, `YEO-31`).
 *
 * The action is a stub, and that is the point of it being a prop: this file
 * asserts what the *form* does with a record, with a submission, and with what
 * comes back. What a real submission then writes belongs to `updateIndividual`
 * and `validateIndividual`, both already tested without a document.
 *
 * Three things here cannot be checked any other way, and each is a criterion
 * the ticket names:
 *
 * - **Prefilled.** That the record actually reaches the inputs — a form that
 *   opens blank and saves would silently erase a person.
 * - **The unsaved-changes warning.** Its whole job is to intervene between an
 *   author's exit and an unmount, which is a behaviour and not a value.
 * - **A cleared field becomes null.** `lib/individual-input.ts` already tests
 *   that blank text reads as `null`, but the claim this ticket makes is
 *   end-to-end: that emptying an input on *this* form posts something that
 *   validates to `null`. So the assertions below run the captured `FormData`
 *   through the very functions the server action calls, rather than trusting
 *   the two halves to agree.
 *
 * The fourth is the React-resets-the-form trap E3-T2 found: "a refusal keeps
 * what was typed" is the test that fails the day somebody makes these inputs
 * uncontrolled because it looks tidier.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Rose from docs/architecture.md, with every field recorded. */
const rose: GraphPerson = {
  id: "3f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81",
  givenName: "Rose",
  surname: "Hale",
  sex: "female",
  birthDate: "1890-04-12",
  birthDateQualifier: "about",
  birthDatePrecision: "day",
  birthPlace: "Cork",
  deathDate: "1953-11-02",
  deathDateQualifier: "exact",
  deathDatePrecision: "day",
  deathPlace: "Dublin",
  notes: "From the 1911 census.",
  pageId: null,
};

/** The same person as the tree usually holds them: mostly unknown. */
const sparse: GraphPerson = {
  ...rose,
  surname: null,
  sex: "unknown",
  birthDate: null,
  birthDateQualifier: "exact",
  birthDatePrecision: "day",
  birthPlace: null,
  deathDate: null,
  deathDateQualifier: "exact",
  deathDatePrecision: "day",
  deathPlace: null,
  notes: null,
};

/**
 * An action that records what it was sent and answers with whatever the test
 * wants. `submissions` is read after the fact rather than asserted inside the
 * action, so a failure points at the expectation and not at a callback.
 */
function stubAction(
  reply: (form: FormData) => IndividualFormState = () =>
    emptyIndividualFormState,
): EditPersonProps["action"] & { submissions: FormData[] } {
  const submissions: FormData[] = [];
  const action = async (_state: IndividualFormState, form: FormData) => {
    submissions.push(form);
    return reply(form);
  };
  return Object.assign(action, { submissions });
}

function mount(
  person: GraphPerson,
  action: EditPersonProps["action"] = stubAction(),
): HTMLElement {
  return render(<EditPerson person={person} action={action} />);
}

function trigger(host: HTMLElement): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Edit details",
  );
  if (found === undefined) throw new Error("no button to open the form");
  return found;
}

function open(host: HTMLElement): void {
  act(() => trigger(host).click());
}

function dialog(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('[role="dialog"]');
}

function control(host: HTMLElement, name: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[name="${name}"]`);
  if (element === null) throw new Error(`no control named ${name}`);
  return element;
}

function valueOf(host: HTMLElement, name: string): string {
  const element = control(host, name);
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return element.value;
  }
  throw new Error(`${name} is not a form control`);
}

function press(host: HTMLElement, label: string): void {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (found === undefined) throw new Error(`no button labelled ${label}`);
  act(() => found.click());
}

function has(host: HTMLElement, label: string): boolean {
  return [...host.querySelectorAll("button")].some(
    (button) => button.textContent === label,
  );
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
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

/**
 * The visible box for one date, found by the word above it.
 *
 * Since E4-T2 (`YEO-39`) a date is a free-text control with no `name` — what
 * posts is three hidden inputs it derives — so the label is the only route to
 * it. See `components/DateField.tsx`.
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

/** Type into a control found by something other than its `name`. */
function typeInto(element: HTMLElement, value: string): void {
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
  if (form === null) throw new Error("the dialogue has no form");
  await act(async () => {
    form.requestSubmit();
  });
}

function escape(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

/**
 * What the server action would make of a submission: exactly the two calls
 * `updateIndividualAction` makes before it reaches the database.
 */
function asRecord(form: FormData) {
  const checked = validateIndividual(individualInputFromFormData(form));
  if (!checked.ok) {
    throw new Error(
      `the form posted something invalid: ${JSON.stringify(checked.issues)}`,
    );
  }
  return checked.value;
}

describe("opening", () => {
  it("stays closed until the button is pressed", () => {
    const host = mount(rose);

    expect(dialog(host)).toBeNull();

    open(host);

    expect(dialog(host)).not.toBeNull();
  });

  it("names the dialogue after the person being corrected", () => {
    const host = mount(rose);
    open(host);

    const labelledBy = dialog(host)?.getAttribute("aria-labelledby");
    expect(document.getElementById(labelledBy ?? "")?.textContent).toBe(
      "Edit Rose Hale",
    );
  });
});

describe("prefilling", () => {
  it("shows every value the record holds", () => {
    const host = mount(rose);
    open(host);

    expect(valueOf(host, "givenName")).toBe("Rose");
    expect(valueOf(host, "surname")).toBe("Hale");
    expect(valueOf(host, "sex")).toBe("female");
    expect(valueOf(host, "birthDate")).toBe("1890-04-12");
    expect(valueOf(host, "birthDateQualifier")).toBe("about");
    expect(valueOf(host, "birthPlace")).toBe("Cork");
    expect(valueOf(host, "deathDate")).toBe("1953-11-02");
    expect(valueOf(host, "deathDateQualifier")).toBe("exact");
    expect(valueOf(host, "deathPlace")).toBe("Dublin");
    expect(valueOf(host, "notes")).toBe("From the 1911 census.");
  });

  it("shows an unknown field as blank rather than as a null", () => {
    const host = mount(sparse);
    open(host);

    expect(valueOf(host, "surname")).toBe("");
    expect(valueOf(host, "birthDate")).toBe("");
    expect(valueOf(host, "notes")).toBe("");
  });

  it("sends the person it is correcting", () => {
    const host = mount(rose);
    open(host);

    const id = host.querySelector<HTMLInputElement>('input[name="id"]');
    expect(id?.value).toBe(rose.id);
    expect(id?.type).toBe("hidden");
  });
});

describe("saving", () => {
  it("posts the correction under the record's own field names", async () => {
    const action = stubAction(() => savedFormState(rose.id));
    const host = mount(rose, action);
    open(host);

    type(host, "surname", "Doyle");
    type(host, "deathPlace", "Cork");

    await submit(host);

    expect(action.submissions).toHaveLength(1);
    const record = asRecord(action.submissions[0]);
    expect(record.surname).toBe("Doyle");
    expect(record.deathPlace).toBe("Cork");
    // Everything untouched goes back exactly as it was read out.
    expect(record.givenName).toBe("Rose");
    expect(record.birthDate).toBe("1890-04-12");
    expect(record.birthDateQualifier).toBe("about");
  });

  it("closes and returns focus to the button once the write lands", async () => {
    const host = mount(
      rose,
      stubAction(() => savedFormState(rose.id)),
    );
    open(host);

    type(host, "surname", "Doyle");
    await submit(host);

    expect(dialog(host)).toBeNull();
    expect(document.activeElement).toBe(trigger(host));
  });

  it("saves an untouched form without complaint", async () => {
    // `updateIndividual` answers `unchanged` here, which carries the id — so
    // the form has nothing special to do and simply closes.
    const action = stubAction(() => savedFormState(rose.id));
    const host = mount(rose, action);
    open(host);

    await submit(host);

    expect(action.submissions).toHaveLength(1);
    expect(dialog(host)).toBeNull();
  });

  it("keeps what was typed when the submission is refused", async () => {
    const host = mount(
      rose,
      stubAction(() =>
        invalidFormState([
          {
            field: "deathDate",
            message:
              "The death date is before the birth date. Check whether one of them has the wrong year.",
          },
        ]),
      ),
    );
    open(host);

    type(host, "surname", "Doyle");
    typeInto(dateBox(host, "Died"), "1880-01-01");
    await submit(host);

    // Still open, still holding the correction, and saying what is wrong.
    expect(dialog(host)).not.toBeNull();
    expect(valueOf(host, "surname")).toBe("Doyle");
    expect(valueOf(host, "deathDate")).toBe("1880-01-01");
    expect(host.textContent).toContain("The death date is before the birth");
  });

  it("keeps a select on the answer that was given when refused", async () => {
    // The `FormSelect` trap: React's form reset restores a select to its
    // *first* option, so a refusal would quietly turn Rose male.
    const host = mount(
      rose,
      stubAction(() =>
        invalidFormState([
          { field: "givenName", message: "Give this person a first name." },
        ]),
      ),
    );
    open(host);

    type(host, "sex", "other");
    await submit(host);

    expect(valueOf(host, "sex")).toBe("other");
    expect(valueOf(host, "birthDateQualifier")).toBe("about");
  });

  it("shows a failure that belongs to no field", async () => {
    const host = mount(
      rose,
      stubAction(() =>
        failedFormState(
          "That person is no longer in the tree. They may have been deleted.",
        ),
      ),
    );
    open(host);

    await submit(host);

    expect(dialog(host)).not.toBeNull();
    expect(host.textContent).toContain("no longer in the tree");
  });
});

describe("clearing a field", () => {
  it("records it as unknown rather than as an empty string", async () => {
    const action = stubAction(() => savedFormState(rose.id));
    const host = mount(rose, action);
    open(host);

    type(host, "surname", "");
    type(host, "birthPlace", "");
    type(host, "deathPlace", "");
    typeInto(dateBox(host, "Died"), "");
    type(host, "notes", "");

    await submit(host);

    const record = asRecord(action.submissions[0]);
    expect(record.surname).toBeNull();
    expect(record.birthPlace).toBeNull();
    expect(record.deathPlace).toBeNull();
    expect(record.deathDate).toBeNull();
    expect(record.notes).toBeNull();

    // The form still posts the fields — it is a blank value that means
    // unknown, not an absent one.
    expect(action.submissions[0].get("surname")).toBe("");
  });

  it("normalises away a qualifier left behind by a cleared date", () => {
    // Not the form's rule, and deliberately so: `validateIndividual` drops a
    // qualifier with no date beside it for every caller. Asserted here because
    // clearing the date while leaving "about" showing is the exact sequence
    // this form makes easy.
    const form = new FormData();
    form.set("givenName", "Rose");
    form.set("birthDate", "");
    form.set("birthDateQualifier", "about");

    expect(asRecord(form).birthDateQualifier).toBe("exact");
  });
});

describe("unsaved changes", () => {
  it("closes straight away when nothing was changed", () => {
    const host = mount(rose);
    open(host);

    press(host, "Cancel");

    expect(dialog(host)).toBeNull();
  });

  it("closes straight away when the only change is whitespace", () => {
    // `validateIndividual` trims, so this would write nothing — and a prompt
    // over it is how authors learn to click through prompts.
    const host = mount(rose);
    open(host);

    type(host, "surname", "Hale  ");
    press(host, "Cancel");

    expect(dialog(host)).toBeNull();
  });

  it("warns instead of closing when there is a correction to lose", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");

    expect(dialog(host)).not.toBeNull();
    expect(host.textContent).toContain("have not been saved");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("puts focus on the safe answer", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");

    expect((document.activeElement as HTMLElement | null)?.textContent).toBe(
      "Keep editing",
    );
  });

  it("goes back to the form, correction intact, on keep editing", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");
    press(host, "Keep editing");

    expect(dialog(host)).not.toBeNull();
    expect(valueOf(host, "surname")).toBe("Doyle");
    expect(has(host, "Cancel")).toBe(true);
  });

  it("lets the correction be saved from the warning itself", async () => {
    const action = stubAction(() => savedFormState(rose.id));
    const host = mount(rose, action);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");
    await submit(host);

    expect(asRecord(action.submissions[0]).surname).toBe("Doyle");
    expect(dialog(host)).toBeNull();
  });

  it("closes on discard", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");
    press(host, "Discard them");

    expect(dialog(host)).toBeNull();
    expect(document.activeElement).toBe(trigger(host));
  });

  it("warns on Escape too, rather than closing", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    escape();

    expect(dialog(host)).not.toBeNull();
    expect(host.textContent).toContain("have not been saved");
  });

  it("closes on Escape when there is nothing to lose", () => {
    const host = mount(rose);
    open(host);

    escape();

    expect(dialog(host)).toBeNull();
  });

  it("warns on a click on the backdrop", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");

    const backdrop = dialog(host)?.parentElement;
    act(() =>
      backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(dialog(host)).not.toBeNull();
    expect(host.textContent).toContain("have not been saved");
  });

  it("forgets the correction once the dialogue is closed", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");
    press(host, "Discard them");
    open(host);

    expect(valueOf(host, "surname")).toBe("Hale");
  });
});

describe("leaving the page", () => {
  /** What the browser asks before it unloads. */
  function unload(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it("does not interrupt when there is nothing unsaved", () => {
    const host = mount(rose);
    open(host);

    expect(unload()).toBe(false);
  });

  it("interrupts while a correction is unsaved", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");

    expect(unload()).toBe(true);
  });

  it("stops interrupting once the dialogue is gone", () => {
    const host = mount(rose);
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");
    press(host, "Discard them");

    expect(unload()).toBe(false);
  });
});

describe("Escape, and the panel behind it", () => {
  /**
   * `components/PersonPanel.tsx` listens for Escape on `document` and closes
   * the panel this dialogue is rendered inside. Without the capture-phase
   * handler in `ModalDialog`, one Escape would answer the edit form *and*
   * close the record behind it — so this stands in for the panel's listener
   * and asserts it never fires.
   *
   * The identical assertion lives in `components/PersonRemoval.test.tsx`. Both
   * are worth keeping: they are the two dialogues that rely on the behaviour,
   * and `ModalDialog` says in its own header that both of them pin it.
   */
  const panelListener = vi.fn();

  beforeEach(() => {
    panelListener.mockClear();
    document.addEventListener("keydown", panelListener);
  });

  afterEach(() => {
    document.removeEventListener("keydown", panelListener);
  });

  it("stops the panel from closing too", () => {
    const host = mount(rose);
    open(host);

    act(() => {
      host
        .querySelector("[role='dialog'] button")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });

    expect(dialog(host)).toBeNull();
    expect(panelListener).not.toHaveBeenCalled();
  });

  it("keeps the panel out of it even when the warning appears instead", () => {
    const host = mount(rose);
    open(host);
    type(host, "surname", "Doyle");

    act(() => {
      host
        .querySelector("[role='dialog'] button")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });

    // The worst version of this bug: the dialogue stays open over the warning
    // while the record behind it closes anyway.
    expect(dialog(host)).not.toBeNull();
    expect(panelListener).not.toHaveBeenCalled();
  });
});

describe("while a save is in flight", () => {
  /**
   * An action that never answers, so `pending` stays true for the whole test.
   * The promise is deliberately left hanging — nothing awaits it, and the
   * component unmounts at teardown.
   */
  function neverAnswers(): EditPersonProps["action"] {
    return () => new Promise<IndividualFormState>(() => {});
  }

  function labelled(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    if (found === undefined) throw new Error(`no button labelled ${label}`);
    return found;
  }

  it("disables the warning's buttons, discard included", async () => {
    const host = mount(rose, neverAnswers());
    open(host);

    type(host, "surname", "Doyle");
    press(host, "Cancel");
    await submit(host);

    /**
     * "Discard them" is the one exit that calls `onClose` directly rather than
     * through `requestClose`, so it carries none of the pending guard of its
     * own. Enabled here it would close the dialogue over a write that is still
     * going, and the author would never see what came back.
     */
    expect(labelled(host, "Discard them").disabled).toBe(true);
    expect(labelled(host, "Keep editing").disabled).toBe(true);
    expect(labelled(host, "Saving…").disabled).toBe(true);
    expect(dialog(host)).not.toBeNull();
  });

  it("ignores Escape rather than racing the write", async () => {
    const host = mount(rose, neverAnswers());
    open(host);

    type(host, "surname", "Doyle");
    await submit(host);
    escape();

    expect(dialog(host)).not.toBeNull();
    expect(host.textContent).not.toContain("have not been saved");
  });
});
