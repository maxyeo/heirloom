// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  EditUnionForm,
  type EditUnionFormProps,
} from "@/components/EditUnionForm";
import { PersonPanel } from "@/components/PersonPanel";
import type { GraphUnion } from "@/lib/family-graph";
import type { PersonDetail } from "@/lib/person-detail";
import {
  emptyUnionEditState,
  type UnionEditState,
  unionEditFailedState,
  unionInvalidState,
  unionSavedState,
} from "@/lib/union-edit-state";
import {
  editUnionInputFromFormData,
  validateUnionEdit,
} from "@/lib/union-input";
import { render } from "@/test/render";

/**
 * Correcting a union that is already recorded.
 *
 * The action is a stub, and that is the point of it being a prop: this file
 * asserts what the *form* does with a row, with a submission, and with what
 * comes back. What a real submission then writes belongs to `updateUnion` and
 * `validateUnion`, tested without a document in `lib/union-input.test.ts` and
 * against Postgres in `lib/save-union.db.test.ts`.
 *
 * Four things cannot be checked any other way:
 *
 * - **Prefilled, in the author's own phrasing.** A form that opens blank and
 *   saves would silently erase the dates it exists to fix, and one that opened
 *   showing `1912-01-01` for a marriage recorded as "about 1912" would ask the
 *   author to re-type a qualifier that is already stored.
 * - **What it posts.** The claim is end-to-end: the submission this form makes
 *   is run through the very functions the server action calls, rather than
 *   trusting the two halves to agree — including that a *cleared* date posts
 *   something that validates to `null`.
 * - **What it refuses to post.** The partners and the sequence are not fields
 *   here, and this is where "not fields" is checked as a property of the
 *   submission rather than of the markup.
 * - **The unsaved-changes warning.** Its whole job is to intervene between an
 *   author's exit and an unmount, which is a behaviour and not a value.
 *
 * The fifth is the React-resets-the-form trap E3-T2 found: "a refusal keeps
 * what was typed" is the test that fails the day somebody makes these inputs
 * uncontrolled because it looks tidier.
 */

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Rose and Walter from docs/architecture.md, married and later widowed. */
const marriage: GraphUnion = {
  id: "6b1f2c3d-4e5a-4b6c-8d7e-9f0a1b2c3d4e",
  partnerAId: "3f6c1b0e-9c3a-4a1f-8f2b-2d4c5e6a7b81",
  partnerBId: "5a2d3e4f-6b7c-4d8e-9f0a-1b2c3d4e5f60",
  type: "marriage",
  endReason: "death",
  sequence: 0,
  startDate: "1912-06-04",
  startDateQualifier: "about",
  startDatePrecision: "day",
  startDateUpper: null,
  startDateUpperPrecision: "day",
  endDate: "1947-06-11",
  endDateQualifier: "exact",
  endDatePrecision: "day",
  endDateUpper: null,
  endDateUpperPrecision: "day",
  notes: "From the parish register.",
};

/** The same union as the tree usually holds one: remembered, never written down. */
const undated: GraphUnion = {
  ...marriage,
  type: "unknown",
  endReason: "ongoing",
  startDate: null,
  startDateQualifier: "exact",
  startDatePrecision: "day",
  endDate: null,
  endDateQualifier: "exact",
  endDatePrecision: "day",
  notes: null,
};

/**
 * An action that records what it was sent and answers with whatever the test
 * wants. `submissions` is read after the fact rather than asserted inside the
 * action, so a failure points at the expectation and not at a callback.
 */
function stubAction(
  reply: (form: FormData) => UnionEditState = () => emptyUnionEditState,
): EditUnionFormProps["action"] & { submissions: FormData[] } {
  const submissions: FormData[] = [];
  const action = async (_state: UnionEditState, form: FormData) => {
    submissions.push(form);
    return reply(form);
  };
  return Object.assign(action, { submissions });
}

function mount(
  union: GraphUnion,
  action: EditUnionFormProps["action"] = stubAction(),
  onClose: () => void = () => {},
): HTMLElement {
  return render(
    <EditUnionForm
      union={union}
      title="Rose and Walter"
      action={action}
      onClose={onClose}
    />,
  );
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

/**
 * The visible box for one date, found by the word above it.
 *
 * Since E4-T2 (`YEO-39`) a date is a free-text control with no `name` — what
 * posts is the hidden inputs it derives — so the label is the only route to
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

/** See the identical note in `IndividualFieldset.test.tsx`. */
function typeInto(element: HTMLElement, value: string): void {
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

function type(host: HTMLElement, name: string, value: string): void {
  typeInto(control(host, name), value);
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

function messages(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[role="alert"]')].map(
    (node) => node.textContent ?? "",
  );
}

describe("opening the form on a union that exists", () => {
  it("prefills every field from the row", () => {
    const host = mount(marriage);

    expect(valueOf(host, "type")).toBe("marriage");
    expect(valueOf(host, "endReason")).toBe("death");
    expect(valueOf(host, "notes")).toBe("From the parish register.");
  });

  it("prefills a date in the phrasing it was recorded with, not as an ISO day", () => {
    const host = mount(marriage);

    /*
      The qualifier is the whole point. A marriage recorded as "about 1912"
      that opened as `1912-06-04` would ask the author to re-state an
      uncertainty that is already stored — and the day they left alone would
      quietly become an exact one.
    */
    expect(dateBox(host, "Started").value).toBe("about 4 June 1912");
    expect(dateBox(host, "Ended").value).toBe("11 June 1947");
  });

  it("opens with empty boxes for a union nobody wrote a date for", () => {
    const host = mount(undated);

    expect(dateBox(host, "Started").value).toBe("");
    expect(dateBox(host, "Ended").value).toBe("");
    expect(valueOf(host, "notes")).toBe("");
  });

  it("names the union it is correcting", () => {
    const host = mount(marriage);

    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Edit Rose and Walter",
    );
  });
});

describe("what a submission carries", () => {
  it("sends the union being corrected", async () => {
    const action = stubAction();
    const host = mount(marriage, action);

    await submit(host);

    expect(action.submissions[0].get("unionId")).toBe(marriage.id);
  });

  it("posts a corrected year as the date it parses to", async () => {
    const action = stubAction();
    const host = mount(marriage, action);

    typeInto(dateBox(host, "Started"), "1912");
    await submit(host);

    /*
      Run through the very reader the server action calls, rather than
      inspecting field names this test would then own a copy of.
      `validateUnionEdit` needs the row's anchors, which is exactly what
      `updateUnion` hands it.
    */
    const { union } = editUnionInputFromFormData(action.submissions[0]);
    const checked = validateUnionEdit(union, {
      partnerAId: marriage.partnerAId,
      partnerBId: marriage.partnerBId,
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.startDate).toBe("1912-01-01");
    expect(checked.value.startDatePrecision).toBe("year");
  });

  it("records a cleared date as unknown rather than as blank", async () => {
    const action = stubAction();
    const host = mount(marriage, action);

    typeInto(dateBox(host, "Ended"), "");
    type(host, "endReason", "unknown");
    await submit(host);

    const { union } = editUnionInputFromFormData(action.submissions[0]);
    const checked = validateUnionEdit(union, {
      partnerAId: marriage.partnerAId,
      partnerBId: marriage.partnerBId,
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.endDate).toBeNull();
  });

  it("does not send the partners or the order, so a correction cannot move them", async () => {
    const action = stubAction();
    const host = mount(marriage, action);

    await submit(host);

    const form = action.submissions[0];
    expect(form.get("partnerAId")).toBeNull();
    expect(form.get("partnerBId")).toBeNull();
    expect(form.get("sequence")).toBeNull();
  });

  it("keeps the stored partners when the submission is validated", async () => {
    const action = stubAction();
    const host = mount(marriage, action);

    type(host, "notes", "Corrected.");
    await submit(host);

    const { union } = editUnionInputFromFormData(action.submissions[0]);
    const checked = validateUnionEdit(union, {
      partnerAId: marriage.partnerAId,
      partnerBId: marriage.partnerBId,
    });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    /*
      The anchors survive a submission that never mentioned them, which is what
      makes "an edit cannot change who is in a union" a fact about the write
      rather than about which inputs happen to be on screen.
    */
    expect(checked.value.partnerAId).toBe(marriage.partnerAId);
    expect(checked.value.partnerBId).toBe(marriage.partnerBId);
  });
});

describe("what comes back", () => {
  it("closes when the correction is written", async () => {
    const onClose = vi.fn();
    const host = mount(
      marriage,
      stubAction(() => unionSavedState(marriage.id)),
      onClose,
    );

    await submit(host);

    expect(onClose).toHaveBeenCalled();
  });

  it("stays open, showing the message, when a field is refused", async () => {
    const onClose = vi.fn();
    const host = mount(
      marriage,
      stubAction(() =>
        unionInvalidState([
          { field: "endDate", message: "The union ends before it starts." },
        ]),
      ),
      onClose,
    );

    await submit(host);

    expect(onClose).not.toHaveBeenCalled();
    expect(messages(host)).toContain("The union ends before it starts.");
  });

  it("keeps what was typed when a submission is refused", async () => {
    const host = mount(
      marriage,
      stubAction(() =>
        unionInvalidState([
          { field: "endDate", message: "The union ends before it starts." },
        ]),
      ),
    );

    type(host, "notes", "Half-written note");
    await submit(host);

    /*
      React calls `requestFormReset` on every submission through a form action.
      This is the assertion that fails the day these inputs stop being
      controlled.
    */
    expect(valueOf(host, "notes")).toBe("Half-written note");
  });

  it("shows a union that has gone as a sentence, not as a field error", async () => {
    const host = mount(
      marriage,
      stubAction(() =>
        unionEditFailedState("That union is no longer in the tree."),
      ),
    );

    await submit(host);

    expect(messages(host)).toContain("That union is no longer in the tree.");
  });
});

describe("leaving with unsaved changes", () => {
  it("closes straight away when nothing was touched", () => {
    const onClose = vi.fn();
    const host = mount(marriage, stubAction(), onClose);

    press(host, "Cancel");

    expect(onClose).toHaveBeenCalled();
  });

  it("asks first when something was", () => {
    const onClose = vi.fn();
    const host = mount(marriage, stubAction(), onClose);

    type(host, "notes", "Something worth keeping");
    press(host, "Cancel");

    expect(onClose).not.toHaveBeenCalled();
    expect(has(host, "Keep editing")).toBe(true);
  });

  it("asks on Escape too, which is the exit nobody means to take", () => {
    const onClose = vi.fn();
    const host = mount(marriage, stubAction(), onClose);

    type(host, "notes", "Something worth keeping");
    escape();

    expect(onClose).not.toHaveBeenCalled();
    expect(has(host, "Keep editing")).toBe(true);
  });

  it("goes back to the form when the author keeps editing", () => {
    const host = mount(marriage);

    type(host, "notes", "Something worth keeping");
    press(host, "Cancel");
    press(host, "Keep editing");

    expect(has(host, "Keep editing")).toBe(false);
    expect(valueOf(host, "notes")).toBe("Something worth keeping");
  });

  it("closes when the author discards them", () => {
    const onClose = vi.fn();
    const host = mount(marriage, stubAction(), onClose);

    type(host, "notes", "Something worth losing");
    press(host, "Cancel");
    press(host, "Discard them");

    expect(onClose).toHaveBeenCalled();
  });

  it("can save from the prompt rather than backing out of it", async () => {
    const action = stubAction(() => unionSavedState(marriage.id));
    const host = mount(marriage, action);

    type(host, "notes", "Something worth keeping");
    press(host, "Cancel");
    await submit(host);

    expect(action.submissions).toHaveLength(1);
    expect(action.submissions[0].get("notes")).toBe("Something worth keeping");
  });

  it("treats a field put back the way it was as untouched", () => {
    const onClose = vi.fn();
    const host = mount(marriage, stubAction(), onClose);

    type(host, "notes", "Something else");
    type(host, "notes", "From the parish register.");
    press(host, "Cancel");

    expect(onClose).toHaveBeenCalled();
  });
});

describe("the route in, on the detail panel", () => {
  const detail: PersonDetail = {
    id: marriage.partnerAId ?? "",
    name: "Rose Hale",
    lifespan: "1890–1953",
    sex: "female",
    birth: null,
    death: null,
    notes: null,
    portraitSrc: null,
    pageId: null,
    parents: [],
    spouses: [
      {
        unionId: marriage.id,
        person: {
          id: marriage.partnerBId ?? "",
          name: "Walter Hale",
          lifespan: "1888–1947",
        },
        type: "marriage",
        endReason: "death",
        start: "about 1912",
        end: "1947",
      },
    ],
    children: [],
  };

  function panel(onEditUnion?: (unionId: string) => void): HTMLElement {
    return render(
      <PersonPanel
        detail={detail}
        onSelectPerson={() => {}}
        onClose={() => {}}
        onEditUnion={onEditUnion}
      />,
    );
  }

  it("offers a way to correct each union, naming which one", () => {
    const onEditUnion = vi.fn();
    const host = panel(onEditUnion);

    const button = [...host.querySelectorAll("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.includes("Walter Hale"),
    );
    expect(button).toBeDefined();

    act(() => button?.click());
    expect(onEditUnion).toHaveBeenCalledWith(marriage.id);
  });

  it("marks the button with the union it opens, so focus can come back to it", () => {
    const host = panel(() => {});

    /*
      The contract between the panel and the canvas: the panel does not know a
      dialogue exists, and the canvas does not know which row opened one, so
      the union's id is the only thing they both hold. Without this the
      dialogue closes onto `<body>`, behind the panel the author was reading.
    */
    expect(
      host.querySelector(`[data-edit-union="${marriage.id}"]`),
    ).not.toBeNull();
  });

  it("offers nothing when the canvas has no action to give it", () => {
    const host = panel();

    /*
      The panel is a read-only record wherever the flow is not offered — the
      same property every other route in has, and what keeps it mountable in a
      test with no server action in sight.
    */
    expect(
      [...host.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === "Edit",
      ),
    ).toBe(false);
  });
});
