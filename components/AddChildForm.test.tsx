// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { AddChildForm } from "@/components/AddChildForm";
import {
  type AddChildFormAction,
  type ChildFormState,
  childFailedState,
  childInvalidState,
  childSavedState,
  emptyChildFormState,
} from "@/lib/child-form-state";
import { addChildInputFromFormData } from "@/lib/child-input";
import type { GraphPerson } from "@/lib/family-graph";
import type { SpouseLink } from "@/lib/person-detail";
import { render } from "@/test/render";

/**
 * The add-child form, mounted for the one thing no pure module can prove: that
 * each way of naming a child, and each way of choosing a family, posts the
 * fields the server expects (E3-T5, `YEO-33`).
 *
 * The rules the submission is judged by live in `lib/child-input.ts` and are
 * asserted there with no document. What is checked here is the *seam* — that
 * a twice-married parent is made to say which family, that the relation is
 * really sent, and that a refused submission does not quietly change it.
 *
 * Mountable at all only because the action arrives as a prop: importing
 * `addChildAction` would reach Auth.js and `@/db`, neither of which `npm test`
 * has an environment for (docs/testing.md).
 */

function person(overrides: Partial<GraphPerson> & { id: string }): GraphPerson {
  return {
    givenName: "Someone",
    surname: null,
    sex: "unknown",
    birthDate: null,
    birthDateQualifier: "exact",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
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
  person({ id: "clara", givenName: "Clara", surname: "Hale" }),
];

function union(
  unionId: string,
  partner: { id: string; name: string } | null,
  start: string | null = null,
): SpouseLink {
  return {
    unionId,
    person: partner === null ? null : { ...partner, lifespan: "" },
    type: "marriage",
    endReason: "ongoing",
    start,
    end: null,
  };
}

const WITH_THOMAS = union("u-thomas", { id: "thomas", name: "Thomas Hale" });
const WITH_WALTER = union("u-walter", { id: "walter", name: "Walter Byrne" });

const noop = () => {};

/**
 * Mount the form with an action that records what it was sent and answers with
 * `reply`. The recorded `FormData` is what every assertion below is really
 * about.
 */
function mount(
  options: {
    unions?: readonly SpouseLink[];
    reply?: ChildFormState;
    onSaved?: () => void;
    onCancel?: () => void;
  } = {},
) {
  const submissions: FormData[] = [];
  const action: AddChildFormAction = async (_previous, form) => {
    submissions.push(form);
    return options.reply ?? emptyChildFormState;
  };

  const host = render(
    <AddChildForm
      action={action}
      person={ROSE}
      unions={options.unions ?? [WITH_THOMAS]}
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

async function submit(host: HTMLElement): Promise<void> {
  const form = host.querySelector("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.requestSubmit();
  });
}

/** What the action was sent, read back the way the server reads it. */
function sent(form: FormData) {
  return addChildInputFromFormData(form);
}

describe("choosing which family the child belongs to", () => {
  it("does not ask when the parent has only one", async () => {
    const { host, submissions } = mount({ unions: [WITH_THOMAS] });

    // Named on screen rather than offered as a select of one option.
    expect(host.textContent).toContain("with Thomas Hale");
    expect(host.querySelector('select[name="unionId"]')).toBeNull();

    click(buttonLabelled(host, "Clara Hale"));
    await submit(host);

    expect(sent(submissions[0]).link.unionId).toBe("u-thomas");
  });

  /**
   * The ticket's first acceptance criterion. With two marriages the answer
   * decides which children are half-siblings of which, so the form starts with
   * nothing chosen and the author has to say.
   */
  it("asks, and chooses nothing for you, when the parent has more than one", async () => {
    const { host, submissions } = mount({
      unions: [WITH_THOMAS, WITH_WALTER],
    });

    expect(namedControl(host, "unionId").value).toBe("");

    click(buttonLabelled(host, "Clara Hale"));
    selectOption(host, "unionId", "u-walter");
    await submit(host);

    expect(sent(submissions[0]).link.unionId).toBe("u-walter");
  });

  it("names a family whose other partner was never recorded", () => {
    const { host } = mount({ unions: [union("u-alone", null)] });

    // Both partner columns are nullable so a single parent never has to invent
    // a placeholder; the option has to be nameable all the same.
    expect(host.textContent).toContain("unrecorded partner");
  });

  it("tells the author what to do when there is no family at all", () => {
    const { host } = mount({ unions: [] });

    expect(host.textContent).toContain("Add a spouse first");
    // Nothing to submit: there is no union to attach a child to.
    expect(host.querySelector("form")).toBeNull();
  });
});

describe("naming a child who is already on the tree", () => {
  it("posts the chosen person's id", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "Clara Hale"));
    await submit(host);

    const input = sent(submissions[0]);
    expect(input.childMode).toBe("existing");
    expect(input.childId).toBe("clara");
  });

  it("does not offer either of the chosen family's own parents", () => {
    const { host } = mount({ unions: [WITH_THOMAS] });

    const names = host.querySelector('ul[aria-label="Matching people"]')
      ?.textContent;
    expect(names).toContain("Clara Hale");
    // Nobody is their own parent, and Thomas is the other half of this union.
    expect(names).not.toContain("Thomas Hale");
    expect(names).not.toContain("Rose Hale");
  });
});

describe("creating a child inline", () => {
  it("carries what was typed into the search across to the name fields", () => {
    const { host } = mount();

    type(searchBox(host), "Dora Hale");
    click(buttonLabelled(host, "add “Dora Hale” as a new person"));

    expect(namedControl(host, "child.givenName").value).toBe("Dora");
    expect(namedControl(host, "child.surname").value).toBe("Hale");
  });

  it("posts the new person under its own prefix, alongside the link", async () => {
    const { host, submissions } = mount();

    type(searchBox(host), "Dora Hale");
    click(buttonLabelled(host, "add “Dora Hale” as a new person"));
    await submit(host);

    const input = sent(submissions[0]);
    expect(input.childMode).toBe("new");
    expect(input.childId).toBe("");
    expect(input.child.givenName).toBe("Dora");
    expect(input.child.surname).toBe("Hale");
    expect(input.link.unionId).toBe("u-thomas");
  });

  it("can be backed out of, returning to the search", () => {
    const { host } = mount();

    click(buttonLabelled(host, "add them as a new person"));
    click(buttonLabelled(host, "Search the tree instead"));

    expect(searchBox(host)).toBeTruthy();
  });
});

describe("the relation", () => {
  it("is posted rather than left to the column's default", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "Clara Hale"));
    await submit(host);

    expect(sent(submissions[0]).link.relation).toBe("biological");
  });

  it("carries an adoption on the link", async () => {
    const { host, submissions } = mount();

    click(buttonLabelled(host, "Clara Hale"));
    selectOption(host, "relation", "adopted");
    await submit(host);

    const input = sent(submissions[0]);
    expect(input.link.relation).toBe("adopted");
    // Nothing about the relation reaches the person. Adoption is a fact about
    // the link, so a field on `individuals` would be the wrong shape entirely.
    expect(input.child.notes).toBeNull();
  });
});

describe("what the form does with the answer", () => {
  it("closes once a child has been written", async () => {
    const onSaved = vi.fn();
    const { host } = mount({ reply: childSavedState("clara"), onSaved });

    click(buttonLabelled(host, "Clara Hale"));
    await submit(host);

    expect(onSaved).toHaveBeenCalled();
  });

  it("stays open and shows a refusal beside the field it belongs to", async () => {
    const { host } = mount({
      unions: [WITH_THOMAS, WITH_WALTER],
      reply: childInvalidState(
        [{ field: "unionId", message: "Choose which family this child belongs to." }],
        [{ field: "givenName", message: "Give this person a first name." }],
      ),
    });

    type(searchBox(host), "Dora");
    click(buttonLabelled(host, "add “Dora” as a new person"));
    await submit(host);

    expect(host.textContent).toContain("Choose which family");
    expect(host.textContent).toContain("Give this person a first name");
  });

  it("shows a failure that belongs to no single field", async () => {
    const { host } = mount({
      reply: childFailedState("That person is already recorded as a child."),
    });

    click(buttonLabelled(host, "Clara Hale"));
    await submit(host);

    expect(host.textContent).toContain("already recorded");
  });

  /**
   * The regression test for the trap `FormSelect` exists to fix. React calls
   * `requestFormReset` on every submission through a form action, before the
   * action runs — and a reset reverts a `<select>` to its *first option*, which
   * React never re-renders away because its own props did not change.
   *
   * On this form that is the worst of the three places it could happen: the
   * first option of `relation` is `biological`, so without `FormSelect` a
   * refused submission would come back having quietly turned an adopted child
   * into a biological one, and a child of the second marriage into a child of
   * the first. Nothing would look wrong.
   */
  it("keeps the family and the relation when the submission is refused", async () => {
    const { host } = mount({
      unions: [WITH_THOMAS, WITH_WALTER],
      reply: childInvalidState(
        [],
        [{ field: "givenName", message: "Give this person a first name." }],
      ),
    });

    type(searchBox(host), "Dora Hale");
    click(buttonLabelled(host, "add “Dora Hale” as a new person"));
    selectOption(host, "unionId", "u-walter");
    selectOption(host, "relation", "adopted");
    await submit(host);

    expect(host.textContent).toContain("Give this person a first name");

    // Selects: kept because `FormSelect` keeps their DOM default in step.
    expect(namedControl(host, "unionId").value).toBe("u-walter");
    expect(namedControl(host, "relation").value).toBe("adopted");
    // Text: kept because the inputs are controlled.
    expect(namedControl(host, "child.givenName").value).toBe("Dora");
  });

  it("does not close on a refusal", async () => {
    const onSaved = vi.fn();
    const { host } = mount({ reply: childFailedState("Nope."), onSaved });

    click(buttonLabelled(host, "Clara Hale"));
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
