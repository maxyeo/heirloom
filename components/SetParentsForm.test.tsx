// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { SetParentsForm } from "@/components/SetParentsForm";
import type { FamilyGraph, GraphPerson } from "@/lib/family-graph";
import {
  emptyParentsFormState,
  type ParentsFormState,
  parentsFailedState,
  parentsDuplicateState,
  parentsInvalidState,
  parentsSavedState,
  type SetParentsFormAction,
} from "@/lib/parents-form-state";
import { setParentsInputFromFormData } from "@/lib/parents-input";
import { render } from "@/test/render";

/**
 * The set-parents form, mounted for the one thing no pure module can prove:
 * that each way of answering "which family" posts the fields the server
 * expects (E3-T6, `YEO-34`).
 *
 * The rules the submission is judged by live in `lib/parents-input.ts`, the
 * cycle walk in `lib/ancestry.ts`, and the two lists in
 * `lib/parent-options.ts` — all asserted with no document. What is checked
 * here is the *seam*: that choosing a family sends its id, that naming two
 * people sends two ids and no invented person, that a move sends the family
 * being left, and that a refused submission does not quietly change any of it.
 *
 * Mountable at all only because the action arrives as a prop: importing
 * `setParentsAction` would reach Auth.js and `@/db`, neither of which
 * `npm test` has an environment for (docs/testing.md).
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
    portraitKey: null,
    portraitThumbKey: null,
    pageId: null,
    ...overrides,
  };
}

function union(
  overrides: Partial<FamilyGraph["unions"][number]> & { id: string },
): FamilyGraph["unions"][number] {
  return {
    partnerAId: null,
    partnerBId: null,
    type: "marriage",
    endReason: "ongoing",
    sequence: 1,
    startDate: null,
    startDateQualifier: "exact",
    startDatePrecision: "day",
    startDateUpper: null,
    startDateUpperPrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    endDateUpper: null,
    endDateUpperPrecision: "day",
    ...overrides,
  };
}

const DORA = { id: "dora", name: "Dora Byrne" };

/**
 * Dora is the person whose parents are being set. Rose has two marriages, so
 * there are two families to choose between; Dora has a daughter of her own,
 * whose family must never be offered as her parents.
 */
function graph(): FamilyGraph {
  return {
    people: [
      person({ id: "rose", givenName: "Rose", surname: "Hale" }),
      person({ id: "thomas", givenName: "Thomas", surname: "Hale" }),
      person({ id: "walter", givenName: "Walter", surname: "Byrne" }),
      person({ id: "dora", givenName: "Dora", surname: "Byrne" }),
      person({ id: "ida", givenName: "Ida", surname: "Byrne" }),
    ],
    unions: [
      union({ id: "u-thomas", partnerAId: "rose", partnerBId: "thomas" }),
      union({ id: "u-walter", partnerAId: "rose", partnerBId: "walter" }),
      union({ id: "u-dora", partnerAId: "dora" }),
      union({ id: "u-ida", partnerAId: "ida" }),
    ],
    childLinks: [{ unionId: "u-dora", childId: "ida", relation: "biological" }],
  };
}

const noop = () => {};

/**
 * Mount the form with an action that records what it was sent and answers with
 * `reply`. The recorded `FormData` is what every assertion below is really
 * about.
 */
function mount(
  options: {
    graph?: FamilyGraph;
    reply?: ParentsFormState;
    onSaved?: () => void;
    onCancel?: () => void;
  } = {},
) {
  const submissions: FormData[] = [];
  const action: SetParentsFormAction = async (_previous, form) => {
    submissions.push(form);
    return options.reply ?? emptyParentsFormState;
  };

  const host = render(
    <SetParentsForm
      action={action}
      person={DORA}
      graph={options.graph ?? graph()}
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

function searchBoxes(host: HTMLElement): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('input[type="search"]')];
}

function namedControl(
  host: HTMLElement,
  name: string,
): HTMLInputElement | HTMLSelectElement {
  const control = host.querySelector(`[name="${name}"]`);
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLSelectElement)
  ) {
    throw new Error(`no control named ${name}`);
  }
  return control;
}

function optionLabels(host: HTMLElement, name: string): string[] {
  const control = namedControl(host, name);
  if (!(control instanceof HTMLSelectElement)) {
    throw new Error(`${name} is not a select`);
  }
  return [...control.options].map((option) => option.textContent ?? "");
}

function optionValues(host: HTMLElement, name: string): string[] {
  const control = namedControl(host, name);
  if (!(control instanceof HTMLSelectElement)) {
    throw new Error(`${name} is not a select`);
  }
  return [...control.options].map((option) => option.value);
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
  return setParentsInputFromFormData(form);
}

describe("choosing a family already on the tree", () => {
  it("sends the family the author chose, and the person it is for", async () => {
    const { host, submissions } = mount();

    selectOption(host, "unionId", "u-walter");
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      childId: "dora",
      familyMode: "existing",
      unionId: "u-walter",
    });
  });

  it("chooses nothing for you", async () => {
    // Every family on the tree is a possible answer here, so one of them
    // happening to be eligible is not evidence that it is the right one.
    const { host } = mount();

    expect(namedControl(host, "unionId").value).toBe("");
  });

  it("names both parents of each family it offers", () => {
    expect(optionLabels(mount().host, "unionId")).toEqual([
      "Choose a family…",
      "Rose Hale and Thomas Hale",
      "Rose Hale and Walter Byrne",
    ]);
  });

  it("says outright when a family records only one parent", () => {
    const withOneParent = graph();
    withOneParent.unions.push(union({ id: "u-solo", partnerAId: "thomas" }));

    expect(
      optionLabels(mount({ graph: withOneParent }).host, "unionId"),
    ).toContain("Thomas Hale and an unrecorded partner");
  });

  /**
   * The cycle guard's visible half, and the ticket's fourth criterion as an
   * author would meet it. Dora's own family and her daughter's are the two
   * that would make her her own ancestor, and neither is on the list at all —
   * a picker that offered them and then refused them would teach nothing
   * except that the form is unreliable.
   */
  it("leaves out the families that would make them their own ancestor", () => {
    const values = optionValues(mount().host, "unionId");

    expect(values).not.toContain("u-dora");
    expect(values).not.toContain("u-ida");
    expect(values).toEqual(["", "u-thomas", "u-walter"]);
  });

  it("leaves out a family that already records them", () => {
    const recorded = graph();
    recorded.childLinks.push({
      unionId: "u-thomas",
      childId: "dora",
      relation: "biological",
    });

    expect(optionValues(mount({ graph: recorded }).host, "unionId")).toEqual([
      "",
      "u-walter",
    ]);
  });
});

describe("naming the parents when no family is recorded yet", () => {
  function openInlineMode() {
    const mounted = mount();
    click(buttonLabelled(mounted.host, "not recorded as a family yet"));
    return mounted;
  }

  it("sends two people and no union", async () => {
    const { host, submissions } = openInlineMode();

    // Re-queried between the two, because choosing somebody replaces that
    // picker's search box with the answer and a way to undo it.
    type(searchBoxes(host)[0], "Rose");
    click(buttonLabelled(host, "Rose Hale"));
    type(searchBoxes(host)[0], "Thomas");
    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      familyMode: "new",
      parentAId: "rose",
      parentBId: "thomas",
      // No union control is rendered in this mode, so nothing is posted for
      // it — the id the server uses is the one it is about to create.
      unionId: null,
    });
  });

  /**
   * The ticket's third criterion, at the seam. One parent chosen and the other
   * left alone posts an empty second id — a nullable partner column — rather
   * than anything that could become a placeholder person.
   */
  it("sends one known parent and an empty second, never a placeholder", async () => {
    const { host, submissions } = openInlineMode();

    type(searchBoxes(host)[0], "Rose");
    click(buttonLabelled(host, "Rose Hale"));
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      familyMode: "new",
      parentAId: "rose",
      parentBId: "",
    });
  });

  it("offers no way to invent a person", () => {
    // This flow connects people who are already on the tree. A fourth door
    // onto `individuals` would be a fourth place for the rules about a person
    // to drift; see the note on the component.
    const { host } = openInlineMode();
    type(searchBoxes(host)[0], "Nobody");

    expect(host.textContent).not.toContain("as a new person");
  });

  it("keeps whoever one slot holds out of the other", () => {
    // The server refuses a union naming one person in both columns, but
    // finding that out on submit is finding it out too late.
    const { host } = openInlineMode();

    type(searchBoxes(host)[0], "Rose");
    click(buttonLabelled(host, "Rose Hale"));
    type(searchBoxes(host)[0], "Rose");

    // The remaining picker offers nobody: the only Rose is spoken for. Her
    // name is still on screen, in the first slot's answer.
    expect(host.textContent).toContain("Nobody on the tree matches that.");
  });

  it("keeps the person and their descendants out of both pickers", () => {
    // Nobody at or below Dora may be named as her parent.
    const { host } = openInlineMode();
    type(searchBoxes(host)[0], "Byrne");

    expect(host.textContent).toContain("Walter Byrne");
    expect(host.textContent).not.toContain("Ida Byrne");
  });

  it("opens on this mode when no family on the tree could hold them", async () => {
    // The ordinary state of a young tree: the person was added moments ago and
    // there is nothing to connect them to, so an empty select would be a dead
    // end rather than a question.
    const alone: FamilyGraph = {
      people: [person({ id: "dora", givenName: "Dora", surname: "Byrne" })],
      unions: [],
      childLinks: [],
    };
    const { host, submissions } = mount({ graph: alone });

    expect(host.querySelector('select[name="unionId"]')).toBeNull();
    await submit(host);
    expect(sent(submissions[0]).familyMode).toBe("new");
  });

  it("goes back to the list when the author changes their mind", async () => {
    const { host, submissions } = openInlineMode();

    click(buttonLabelled(host, "Choose a family on the tree instead"));
    selectOption(host, "unionId", "u-thomas");
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      familyMode: "existing",
      unionId: "u-thomas",
    });
  });
});

describe("naming two people who already have a family", () => {
  /**
   * The bug this ticket exists for (E3-T10, `YEO-82`), at the seam where an
   * author meets it. Rose and Thomas are already recorded as a family in the
   * fixture, so naming them both as Dora's parents is exactly the submission
   * that used to write a silent second `unions` row beside the first.
   */
  function nameBothParents() {
    const mounted = mount();
    click(buttonLabelled(mounted.host, "not recorded as a family yet"));
    type(searchBoxes(mounted.host)[0], "Rose");
    click(buttonLabelled(mounted.host, "Rose Hale"));
    type(searchBoxes(mounted.host)[0], "Thomas");
    click(buttonLabelled(mounted.host, "Thomas Hale"));
    return mounted;
  }

  it("says so, and holds the submission until the author answers", () => {
    const { host } = nameBothParents();

    expect(host.textContent).toContain("already have a family recorded");
    expect(buttonLabelled(host, "Set parents").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("offers the family they already have, and sends its id when taken", async () => {
    const { host, submissions } = nameBothParents();

    click(buttonLabelled(host, "Use this family"));
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      familyMode: "existing",
      unionId: "u-thomas",
      allowDuplicate: "no",
    });
  });

  it("records a second family when the author says they married twice", async () => {
    /**
     * The criterion the whole ticket turns on. A couple who divorced and
     * remarried each other is a real record, so this must be a prompt rather
     * than a refusal — one click, and the submission goes through unchanged
     * except for the answer.
     */
    const { host, submissions } = nameBothParents();

    click(buttonLabelled(host, "married more than once"));
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      familyMode: "new",
      parentAId: "rose",
      parentBId: "thomas",
      allowDuplicate: "yes",
    });
  });

  it("asks again when the author changes who the second parent is", () => {
    const { host } = nameBothParents();
    click(buttonLabelled(host, "married more than once"));

    // Consent belongs to the *pair*, not to the form: Rose and Walter are a
    // different question from Rose and Thomas, and one already answered must
    // not answer the other.
    // Both slots are filled, so both show "Change" rather than a search box;
    // the second one is Thomas's.
    click(
      [...host.querySelectorAll("button")].filter((button) =>
        button.textContent?.includes("Change"),
      )[1] as HTMLElement,
    );
    type(searchBoxes(host)[0], "Walter");
    click(buttonLabelled(host, "Walter Byrne"));

    expect(host.textContent).toContain("already have a family recorded");
  });

  it("does not ask when only one parent is named", () => {
    /**
     * Two rows that each record Rose and an unrecorded partner are not two
     * records of one couple — they may be two children by two men nobody can
     * name. Rose has `u-dora`-shaped company in the fixture, and naming her
     * alone must still go straight through.
     */
    const { host } = mount();
    click(buttonLabelled(host, "not recorded as a family yet"));
    type(searchBoxes(host)[0], "Rose");
    click(buttonLabelled(host, "Rose Hale"));

    expect(host.textContent).not.toContain("already have a family recorded");
    expect(buttonLabelled(host, "Set parents").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("reports a family recorded since the page loaded, which its graph cannot show", async () => {
    /**
     * The client-side check runs against a graph the browser may have loaded
     * minutes ago. `lib/set-parents.ts` re-asks inside the transaction, and
     * what comes back is a list of ids this graph does not hold — so all the
     * form can honestly do is say they exist and ask for a reload.
     */
    const { host } = mount({
      reply: parentsDuplicateState(["recorded-elsewhere"]),
    });

    click(buttonLabelled(host, "not recorded as a family yet"));
    type(searchBoxes(host)[0], "Walter");
    click(buttonLabelled(host, "Walter Byrne"));
    type(searchBoxes(host)[0], "Thomas");
    click(buttonLabelled(host, "Thomas Hale"));
    await submit(host);

    expect(host.textContent).toContain("recorded since this page loaded");
  });
});

describe("moving them out of the family they are in now", () => {
  function alreadyRecorded(): FamilyGraph {
    const recorded = graph();
    recorded.childLinks.push({
      unionId: "u-thomas",
      childId: "dora",
      relation: "biological",
    });
    return recorded;
  }

  it("offers the move, naming the family they would leave", () => {
    const { host } = mount({ graph: alreadyRecorded() });

    expect(optionLabels(host, "fromUnionId")).toEqual([
      "Leave that as it is",
      "Move them out of Rose Hale and Thomas Hale",
    ]);
  });

  it("sends the family being left when the author asks for a move", async () => {
    const { host, submissions } = mount({ graph: alreadyRecorded() });

    selectOption(host, "unionId", "u-walter");
    selectOption(host, "fromUnionId", "u-thomas");
    await submit(host);

    expect(sent(submissions[0])).toMatchObject({
      unionId: "u-walter",
      fromUnionId: "u-thomas",
    });
  });

  /**
   * Keeping is the default, and deliberately so. Being a child of two families
   * — adopted into one, born into another — is a real record, so removing one
   * has to be asked for rather than assumed by a flow whose name says nothing
   * about removing anything.
   */
  it("keeps every link they already have unless told otherwise", async () => {
    const { host, submissions } = mount({ graph: alreadyRecorded() });

    selectOption(host, "unionId", "u-walter");
    await submit(host);

    expect(sent(submissions[0]).fromUnionId).toBe("");
  });

  it("does not ask at all when there is nothing to move them out of", () => {
    expect(mount().host.querySelector('[name="fromUnionId"]')).toBeNull();
  });
});

describe("what comes back", () => {
  it("closes only once the link exists", async () => {
    let saved = 0;
    const { host } = mount({
      reply: parentsFailedState("That family is no longer recorded."),
      onSaved: () => {
        saved += 1;
      },
    });

    selectOption(host, "unionId", "u-walter");
    await submit(host);

    // A submission that came back with a message must not close the form over
    // the message it was supposed to be showing.
    expect(saved).toBe(0);
    expect(host.textContent).toContain("no longer recorded");
  });

  it("closes when the family comes back", async () => {
    let saved = 0;
    const { host } = mount({
      reply: parentsSavedState("u-walter"),
      onSaved: () => {
        saved += 1;
      },
    });

    selectOption(host, "unionId", "u-walter");
    await submit(host);

    expect(saved).toBe(1);
  });

  it("shows a refusal beside the control it belongs to", async () => {
    const { host } = mount({
      reply: parentsInvalidState([
        {
          field: "unionId",
          message: "Choose which family this person belongs to.",
        },
      ]),
    });

    await submit(host);

    expect(namedControl(host, "unionId").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(host.textContent).toContain("Choose which family this person");
  });

  /**
   * React calls `requestFormReset` on every submission through a form action,
   * before the action has run. A `<select>`'s DOM default lives in each
   * option's `defaultSelected` flag, which React never touches, so a plain
   * controlled select reverts to its *first option* on a refused submission —
   * here silently changing which family the author chose, and recording an
   * adopted child as biological. `FormSelect` is what prevents it; this is the
   * assertion that would catch its removal.
   */
  it("keeps every answer after a refused submission", async () => {
    const { host, submissions } = mount({
      graph: (() => {
        const recorded = graph();
        recorded.childLinks.push({
          unionId: "u-thomas",
          childId: "dora",
          relation: "biological",
        });
        return recorded;
      })(),
      reply: parentsFailedState("Something else was wrong."),
    });

    selectOption(host, "unionId", "u-walter");
    selectOption(host, "fromUnionId", "u-thomas");
    selectOption(host, "relation", "adopted");
    await submit(host);

    expect(namedControl(host, "unionId").value).toBe("u-walter");
    expect(namedControl(host, "fromUnionId").value).toBe("u-thomas");
    expect(namedControl(host, "relation").value).toBe("adopted");

    await submit(host);
    expect(sent(submissions[1])).toMatchObject({
      unionId: "u-walter",
      fromUnionId: "u-thomas",
      relation: "adopted",
    });
  });

  it("sends the relation the author chose", async () => {
    const { host, submissions } = mount();

    selectOption(host, "unionId", "u-walter");
    selectOption(host, "relation", "foster");
    await submit(host);

    expect(sent(submissions[0]).relation).toBe("foster");
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
    expect(document.activeElement?.textContent).toContain("Set parents");
  });
});
