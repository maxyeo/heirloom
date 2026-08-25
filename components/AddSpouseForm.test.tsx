// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { AddSpouseForm } from "@/components/AddSpouseForm";
import type { GraphPerson } from "@/lib/family-graph";
import {
  type AddSpouseFormAction,
  emptySpouseFormState,
  type SpouseFormState,
  spouseFailedState,
  spouseInvalidState,
  spouseSavedState,
} from "@/lib/spouse-form-state";
import { addSpouseInputFromFormData } from "@/lib/union-input";
import { render } from "@/test/render";

/**
 * The add-spouse form, mounted for the one thing no pure module can prove:
 * that the three ways of naming a partner each post the fields the server
 * expects (E3-T4, `YEO-32`).
 *
 * The rules the submission is judged by live in `lib/union-input.ts` and are
 * asserted there with no document. What is checked here is the *seam* — that
 * choosing an existing person really does send their id, that "not here, add
 * them" really does send a person to create, and that a saved union really
 * does close the form. Those are exactly the mistakes that make a form look
 * right and record the wrong thing.
 *
 * Mountable at all only because the action arrives as a prop: importing
 * `addSpouseAction` would reach Auth.js and `@/db`, neither of which `npm
 * test` has an environment for (docs/testing.md).
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
    pageId: null,
    ...overrides,
  };
}

const ROSE = { id: "rose", name: "Rose Hale" };

const PEOPLE: GraphPerson[] = [
  person({ id: "rose", givenName: "Rose", surname: "Hale" }),
  person({ id: "thomas", givenName: "Thomas", surname: "Hale" }),
  person({ id: "walter", givenName: "Walter", surname: "Byrne" }),
];

const noop = () => {};

/**
 * Mount the form with an action that records what it was sent and answers
 * with `reply`. The recorded `FormData` is what every assertion below is
 * really about.
 */
function mount(
  options: {
    reply?: SpouseFormState;
    onSaved?: () => void;
    onCancel?: () => void;
  } = {},
) {
  const submissions: FormData[] = [];
  const action: AddSpouseFormAction = async (_previous, form) => {
    submissions.push(form);
    return options.reply ?? emptySpouseFormState;
  };

  const host = render(
    <AddSpouseForm
      action={action}
      person={ROSE}
      people={PEOPLE}
      onSaved={options.onSaved ?? noop}
      onCancel={options.onCancel ?? noop}
    />,
  );

  return { host, submissions };
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

function type(input: HTMLInputElement, text: string): void {
  act(() => {
    // React tracks the last value it wrote to the node, so going through the
    // prototype setter is what makes the change visible to it.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function searchBox(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector('input[type="search"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no search box");
  return input;
}

function namedControl(
  host: HTMLElement,
  name: string,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const control = host.querySelector(`[name="${name}"]`);
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLSelectElement) &&
    !(control instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`no control named ${name}`);
  }
  return control;
}

function selectOption(host: HTMLElement, name: string, value: string): void {
  const control = namedControl(host, name);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
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

  const input = host.querySelector(`#${label.htmlFor}`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`${legend} labels nothing`);
  }
  return input;
}

function namedInput(host: HTMLElement, name: string): HTMLInputElement {
  const input = host.querySelector(`[name="${name}"]`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`no input named ${name}`);
  }
  return input;
}

async function submit(host: HTMLElement): Promise<void> {
  const form = host.querySelector("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.requestSubmit();
  });
}

/** What the action was sent, read back the way the server reads it. */
function sent(form: FormData) {
  return addSpouseInputFromFormData(form);
}

describe("naming a partner who is already on the tree", () => {
  it("posts the chosen person's id", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    const input = sent(submissions[0]);
    expect(input.personId).toBe("rose");
    expect(input.partnerMode).toBe("existing");
    expect(input.partnerId).toBe("thomas");
  });

  /**
   * The ticket asks for these to be fields rather than defaults to fix later,
   * so the form has to actually send them.
   */
  it("posts the union's kind and end reason, not an empty form", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    const { union } = sent(submissions[0]);
    expect(union.type).toBe("marriage");
    expect(union.endReason).toBe("ongoing");
  });

  it("posts the dates and their qualifiers together", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "Thomas Hale"));
    type(namedInput(host, "startDate"), "1912-06-04");
    await submit(host);

    const { union } = sent(submissions[0]);
    expect(union.startDate).toBe("1912-06-04");
    expect(union.startDateQualifier).toBe("exact");
    // Both dates stay optional; nothing invents an end for an ongoing union.
    expect(union.endDate).toBe("");
  });
});

describe("creating a partner inline", () => {
  it("carries what was typed into the search across to the name fields", () => {
    const { host } = mount();

    type(searchBox(host), "Ada Byron");
    click(buttonLabelled(host, "add “Ada Byron” as a new person"));

    expect(namedInput(host, "partner.givenName").value).toBe("Ada");
    expect(namedInput(host, "partner.surname").value).toBe("Byron");
  });

  it("posts the new person under its own prefix, alongside the union", async () => {
    const { host, submissions } = mount();

    type(searchBox(host), "Ada Byron");
    click(buttonLabelled(host, "add “Ada Byron” as a new person"));
    await submit(host);

    const input = sent(submissions[0]);
    expect(input.partnerMode).toBe("new");
    expect(input.partnerId).toBe("");
    expect(input.partner.givenName).toBe("Ada");
    expect(input.partner.surname).toBe("Byron");
    // The person's fields must not leak into the union's.
    expect(input.union.notes).toBe("");
  });

  it("can be backed out of, returning to the search", () => {
    const { host } = mount();

    click(buttonLabelled(host, "add them as a new person"));
    click(buttonLabelled(host, "Search the tree instead"));

    expect(searchBox(host)).toBeTruthy();
  });
});

describe("recording a union whose partner is unknown", () => {
  /**
   * Both partner columns are nullable precisely so an unrecorded spouse never
   * has to become a placeholder person. This is the route that makes that
   * reachable without SQL.
   */
  it("posts no partner at all", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "The partner is not recorded"));
    await submit(host);

    const input = sent(submissions[0]);
    expect(input.partnerMode).toBe("unknown");
    expect(input.partnerId).toBe("");
    expect(input.personId).toBe("rose");
  });
});

describe("what the form does with the answer", () => {
  it("closes once a union has been written", async () => {
    const onSaved = vi.fn();
    const { host } = mount({ reply: spouseSavedState("union-1"), onSaved });

    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    expect(onSaved).toHaveBeenCalled();
  });

  it("stays open and shows a refusal beside the field it belongs to", async () => {
    const { host } = mount({
      reply: spouseInvalidState(
        [
          {
            field: "endReason",
            message: "This union has an end date, so it is not ongoing.",
          },
        ],
        [{ field: "givenName", message: "Give this person a first name." }],
      ),
    });

    type(searchBox(host), "Ada");
    click(buttonLabelled(host, "add “Ada” as a new person"));
    await submit(host);

    expect(host.textContent).toContain("so it is not ongoing");
    expect(host.textContent).toContain("Give this person a first name");
  });

  it("shows a failure that belongs to no single field", async () => {
    const { host } = mount({
      reply: spouseFailedState("That person is no longer in the tree."),
    });

    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    expect(host.textContent).toContain("no longer in the tree");
  });

  /**
   * The regression test for the trap E3-T2 documented: React calls
   * `requestFormReset` on every submission through a form action, *before* the
   * action runs and without waiting to see what it says. With uncontrolled
   * inputs this form would come back reporting one bad field and silently
   * discard everything else the author had typed — the dates, the notes, and a
   * whole half-entered partner.
   *
   * The selects are the half that being controlled does *not* fix, and they
   * are the ones worth asserting hardest: a reset reverts a select to its
   * first option, so without `FormSelect` this submission would come back with
   * the partnership recorded as a marriage, "about" as exact, and the partner
   * silently male. Nothing would look wrong.
   */
  it("keeps everything the author typed when the submission is refused", async () => {
    const { host } = mount({
      reply: spouseInvalidState(
        [{ field: "endReason", message: "Say how it ended." }],
        [],
      ),
    });

    type(searchBox(host), "Ada Byron");
    click(buttonLabelled(host, "add “Ada Byron” as a new person"));
    type(dateBox(host, "Started"), "about 1912");
    selectOption(host, "type", "partnership");
    selectOption(host, "partner.sex", "female");
    await submit(host);

    expect(host.textContent).toContain("Say how it ended");

    // Text: kept because the inputs are controlled — the author's own
    // phrasing of the date included, not just what it parsed to.
    expect(dateBox(host, "Started").value).toBe("about 1912");
    expect(namedControl(host, "startDateQualifier").value).toBe("about");
    expect(namedControl(host, "partner.givenName").value).toBe("Ada");
    expect(namedControl(host, "partner.surname").value).toBe("Byron");

    // Selects: kept because `FormSelect` keeps their DOM default in step.
    // Each of these reverts to the first option without it.
    expect(namedControl(host, "type").value).toBe("partnership");
    expect(namedControl(host, "startDateQualifier").value).toBe("about");
    expect(namedControl(host, "partner.sex").value).toBe("female");
  });

  it("does not close on a refusal", async () => {
    const onSaved = vi.fn();
    const { host } = mount({
      reply: spouseFailedState("Nope."),
      onSaved,
    });

    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    expect(onSaved).not.toHaveBeenCalled();
  });

  it("backs out without submitting anything", () => {
    const onCancel = vi.fn();
    const { host, submissions } = mount({ onCancel });

    click(buttonLabelled(host, "Cancel"));

    expect(onCancel).toHaveBeenCalled();
    expect(submissions).toEqual([]);
  });
});

/**
 * The two behaviours every surface on this canvas now shares (`YEO-83`).
 *
 * This form replaces the detail panel while it is open, so the reader has just
 * come from a surface that closes on Escape and puts focus on its own heading.
 * Before this ticket it did neither, which made Escape a key that worked, then
 * silently did not, then worked again.
 */
describe("dismissing the form", () => {
  it("backs out on Escape, submitting nothing", () => {
    const onCancel = vi.fn();
    const { submissions } = mount({ onCancel });

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(submissions).toEqual([]);
  });

  it("puts focus on the heading when it opens", () => {
    // Otherwise the author presses the button that opens this and is left on
    // an element that has just been unmounted.
    const { host } = mount();

    expect(host.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain("Add a spouse");
  });
});
