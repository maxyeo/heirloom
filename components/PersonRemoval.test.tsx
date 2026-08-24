// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PersonRemoval } from "@/components/PersonRemoval";
import type { FamilyGraph } from "@/lib/family-graph";
import { type RemovalState, removedState } from "@/lib/removal-state";
import { render } from "@/test/render";

/**
 * The confirmation dialogue (E3-T8, `YEO-36`).
 *
 * Most of what this ticket has to get right is decided in
 * `lib/removal-preview.ts` and asserted next to it with no DOM at all —
 * which unions a delete takes, whose links are severed, when a union has
 * stopped recording anything. What is left here is the part that only exists
 * once there is a document, and it is not incidental: **that the sentences
 * reach the screen**. A preview that computes the cascade perfectly and a
 * dialogue that renders half of it is exactly as dangerous as getting the
 * cascade wrong. See docs/testing.md, "prefer no DOM".
 *
 * ## Why this file mocks
 *
 * It is the first one to, and docs/testing.md said this is where the decision
 * gets made. The component imports `app/tree/actions.ts` in order to hand its
 * form a server action; that module reaches `@/auth`, which loads next-auth,
 * which cannot be imported outside the Next.js runtime at all. So the mock is
 * not standing in for behaviour worth exercising — it is standing in for a
 * module boundary that Vitest cannot cross. Everything on this side of it is
 * real.
 *
 * The stubs double as the assertion for *which* action each removal reaches
 * and *what* it sends, which is the one thing about the wiring that could
 * silently invert.
 */
const removalAction = () =>
  // Typed through `vi.fn`'s parameter rather than by declaring the arguments,
  // so that `mock.calls[0][1]` is known to be the `FormData` these assertions
  // read without the stub having to name arguments it does not use.
  vi.fn<(state: RemovalState, form: FormData) => Promise<RemovalState>>(
    async () => removedState,
  );

const removePersonAction = removalAction();
const detachPartnerAction = removalAction();
const detachChildAction = removalAction();

vi.mock("@/app/tree/actions", () => ({
  removePersonAction: (state: RemovalState, form: FormData) =>
    removePersonAction(state, form),
  detachPartnerAction: (state: RemovalState, form: FormData) =>
    detachPartnerAction(state, form),
  detachChildAction: (state: RemovalState, form: FormData) =>
    detachChildAction(state, form),
}));

/**
 * The tree from docs/architecture.md, trimmed to the branch these tests read:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]
 *             │              │
 *           Alice      Brian, Clara
 *
 * Thomas is a partner in two unions and Alice is somebody's child, so between
 * them they exercise every list the dialogue can draw.
 */
function graph(): FamilyGraph {
  return {
    people: [
      person({ id: "mary", givenName: "Mary", surname: "Ellis" }),
      person({ id: "thomas", givenName: "Thomas", sex: "male" }),
      person({ id: "rose", givenName: "Rose", pageId: "page-rose" }),
      person({ id: "alice", givenName: "Alice" }),
      person({ id: "brian", givenName: "Brian" }),
      person({ id: "clara", givenName: "Clara" }),
    ],
    unions: [
      union({
        id: "u1",
        partnerAId: "mary",
        partnerBId: "thomas",
        sequence: 1,
        startDate: "1920-06-01",
      }),
      union({
        id: "u2",
        partnerAId: "thomas",
        partnerBId: "rose",
        sequence: 2,
      }),
    ],
    childLinks: [
      { unionId: "u1", childId: "alice", relation: "biological" },
      { unionId: "u2", childId: "brian", relation: "biological" },
      { unionId: "u2", childId: "clara", relation: "adopted" },
    ],
  };
}

function person(
  overrides: Partial<FamilyGraph["people"][number]> & {
    id: string;
    givenName: string;
  },
) {
  return {
    surname: "Hale",
    sex: "female",
    birthDate: null,
    birthDateQualifier: "exact",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathPlace: null,
    notes: null,
    pageId: null,
    ...overrides,
  } satisfies FamilyGraph["people"][number];
}

function union(
  overrides: Partial<FamilyGraph["unions"][number]> & { id: string },
) {
  return {
    partnerAId: null,
    partnerBId: null,
    type: "marriage",
    endReason: "ongoing",
    sequence: 1,
    startDate: null,
    startDateQualifier: "exact",
    endDate: null,
    endDateQualifier: "exact",
    ...overrides,
  } satisfies FamilyGraph["unions"][number];
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

function dialog(): HTMLElement | null {
  return document.querySelector("[role='dialog']");
}

/** The dialogue's whole text, with whitespace flattened for matching. */
function dialogText(): string {
  return (dialog()?.textContent ?? "").replace(/\s+/g, " ");
}

/** Open the dialogue on `personId` and take the named removal. */
function openRemoval(personId: string, choice?: string): HTMLElement {
  const host = render(<PersonRemoval graph={graph()} personId={personId} />);
  click(buttonLabelled(host, "Remove…"));
  if (choice !== undefined) {
    const open = dialog();
    if (!open) throw new Error("the dialogue did not open");
    click(buttonLabelled(open, choice));
  }
  return host;
}

beforeEach(() => {
  removePersonAction.mockClear();
  detachPartnerAction.mockClear();
  detachChildAction.mockClear();
});

describe("getting to a removal", () => {
  it("shows nothing until the author asks", () => {
    render(<PersonRemoval graph={graph()} personId="thomas" />);

    expect(dialog()).toBeNull();
  });

  it("offers every detach before it offers the delete", () => {
    // The ordering is the acceptance criterion — detaching has to read as the
    // separate, gentler thing rather than as an afterthought under a delete
    // button. Asserted on the rendered order rather than by eye, because it
    // is the sort of thing a later edit reshuffles without noticing.
    openRemoval("thomas");

    const labels = [...(dialog()?.querySelectorAll("button") ?? [])].map(
      (button) => button.textContent ?? "",
    );
    const firstDelete = labels.findIndex((label) =>
      label.includes("Delete Thomas Hale from the tree"),
    );
    const lastDetach = labels.findLastIndex((label) =>
      label.includes("were not partners"),
    );

    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastDetach).toBeGreaterThan(-1);
    expect(lastDetach).toBeLessThan(firstDelete);
  });

  it("says so plainly when there is nothing to detach", () => {
    const solo: FamilyGraph = {
      people: [person({ id: "solo", givenName: "Solo" })],
      unions: [],
      childLinks: [],
    };
    const host = render(<PersonRemoval graph={solo} personId="solo" />);
    click(buttonLabelled(host, "Remove…"));

    expect(dialogText()).toContain("no recorded relationships to detach");
  });

  it("renders nothing at all for a person the graph has lost", () => {
    const host = render(<PersonRemoval graph={graph()} personId="nobody" />);

    expect(host.querySelector("button")).toBeNull();
  });
});

describe("what the delete confirmation says", () => {
  it("names the unions it will take and the partner left in each", () => {
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    expect(dialogText()).toContain("Marriage to Mary Ellis, from 1 June 1920.");
    expect(dialogText()).toContain("Marriage to Rose Hale.");
  });

  it("says which surviving parent stops being recorded as one", () => {
    // The sentence this entire ticket exists for. Deleting Thomas does not
    // take him out of his marriage to Rose — it takes the marriage, so Rose
    // stops being recorded as Brian and Clara's mother even though all three
    // of them are still in the tree. Nobody predicts that from a delete
    // button, and nothing can restore it afterwards.
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    expect(dialogText()).toContain(
      "Rose Hale stops being recorded as a parent of Brian Hale and Clara Hale.",
    );
    expect(dialogText()).toContain(
      "Mary Ellis stops being recorded as a parent of Alice Hale.",
    );
  });

  it("names the people who survive it", () => {
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    expect(dialogText()).toContain(
      "Mary Ellis, Alice Hale, Rose Hale, Brian Hale and Clara Hale stay in the tree.",
    );
  });

  it("says the place they held as somebody's child goes too", () => {
    openRemoval("alice", "Delete Alice Hale from the tree");

    expect(dialogText()).toContain(
      "Their place as a child of Mary Ellis and Thomas Hale.",
    );
  });

  it("promises the wiki entry survives", () => {
    // `individuals.page_id` points *at* `pages`, so nothing about deleting a
    // person reaches the entry. Saying so is the reassuring half of a
    // dialogue that is otherwise entirely bad news.
    openRemoval("rose", "Delete Rose Hale from the tree");

    expect(dialogText()).toContain(
      "Their wiki entry, and all of its revisions",
    );
  });

  it("says nothing about an entry for somebody who has none", () => {
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    expect(dialogText()).not.toContain("Their wiki entry");
  });

  it("warns that it cannot be undone", () => {
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    expect(dialogText()).toContain("cannot be undone");
  });
});

describe("what the detach confirmations say", () => {
  it("promises the children keep their other parent", () => {
    openRemoval("thomas", "Thomas Hale and Rose Hale were not partners");

    expect(dialogText()).toContain(
      "Brian Hale and Clara Hale stop being recorded as Thomas Hale\u2019s children.",
    );
    expect(dialogText()).toContain("They keep Rose Hale as a parent");
    expect(dialogText()).toContain("Nobody is deleted.");
  });

  it("admits that a child link cannot be half-removed", () => {
    // Parenthood runs child → union → partners, so detaching a child always
    // detaches both parents. Saying so is the difference between a true
    // confirmation and one that over-promises.
    openRemoval("thomas", "Clara Hale is not their child");

    expect(dialogText()).toContain(
      "Clara Hale is no longer recorded as a child of Thomas Hale and Rose Hale.",
    );
    expect(dialogText()).toContain("Both parents go together.");
  });

  it("warns when the union itself will go with the detach", () => {
    // Ada is the only person recorded in u9 and it has no children, so
    // detaching her leaves a row nobody could ever reach again.
    const lone: FamilyGraph = {
      people: [person({ id: "a", givenName: "Ada" })],
      unions: [union({ id: "u9", partnerAId: "a" })],
      childLinks: [],
    };
    const host = render(<PersonRemoval graph={lone} personId="a" />);
    click(buttonLabelled(host, "Remove…"));
    click(buttonLabelled(host, "Ada Hale and an unrecorded partner"));

    expect(dialogText()).toContain("The union record itself goes");
    expect(dialogText()).toContain("no partners and no children");
  });

  it("does not threaten a union a real partner is still in", () => {
    // The third-party rule, seen from the dialogue: Ben keeps his row, so
    // nothing may say otherwise.
    const pair: FamilyGraph = {
      people: [
        person({ id: "a", givenName: "Ada" }),
        person({ id: "b", givenName: "Ben" }),
      ],
      unions: [union({ id: "u9", partnerAId: "a", partnerBId: "b" })],
      childLinks: [],
    };
    const host = render(<PersonRemoval graph={pair} personId="a" />);
    click(buttonLabelled(host, "Remove…"));
    click(buttonLabelled(host, "Ada Hale and Ben Hale were not partners"));

    expect(dialogText()).not.toContain("The union record itself goes");
  });
});

describe("what the buttons do", () => {
  it("sends the delete to the delete action, with only a reference", async () => {
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    const form = dialog()?.querySelector("form");
    if (!form) throw new Error("no form in the dialogue");
    await act(async () => form.requestSubmit());

    expect(removePersonAction).toHaveBeenCalledTimes(1);
    expect(detachPartnerAction).not.toHaveBeenCalled();

    const sent = removePersonAction.mock.calls[0][1];
    expect([...sent.keys()]).toEqual(["personId"]);
    expect(sent.get("personId")).toBe("thomas");
  });

  it("sends a partner detach to the partner action, naming the union", async () => {
    openRemoval("thomas", "Thomas Hale and Rose Hale were not partners");

    const form = dialog()?.querySelector("form");
    if (!form) throw new Error("no form in the dialogue");
    await act(async () => form.requestSubmit());

    expect(detachPartnerAction).toHaveBeenCalledTimes(1);
    expect(removePersonAction).not.toHaveBeenCalled();

    const sent = detachPartnerAction.mock.calls[0][1];
    expect(sent.get("unionId")).toBe("u2");
    expect(sent.get("personId")).toBe("thomas");
  });

  it("sends a child detach to the child action, naming the union", async () => {
    openRemoval("thomas", "Clara Hale is not their child");

    const form = dialog()?.querySelector("form");
    if (!form) throw new Error("no form in the dialogue");
    await act(async () => form.requestSubmit());

    expect(detachChildAction).toHaveBeenCalledTimes(1);

    const sent = detachChildAction.mock.calls[0][1];
    expect(sent.get("unionId")).toBe("u2");
    expect(sent.get("childId")).toBe("clara");
  });

  it("goes back to the list without removing anything", () => {
    const host = openRemoval("thomas", "Delete Thomas Hale from the tree");

    click(buttonLabelled(host, "Back"));

    expect(dialogText()).toContain("Detach a relationship");
    expect(removePersonAction).not.toHaveBeenCalled();
  });

  it("closes on cancel", () => {
    const host = openRemoval("thomas", "Delete Thomas Hale from the tree");

    click(buttonLabelled(host, "Cancel"));

    expect(dialog()).toBeNull();
    expect(removePersonAction).not.toHaveBeenCalled();
  });
});

describe("where focus goes", () => {
  it("puts focus on the heading, which says what is being confirmed", () => {
    openRemoval("thomas");

    expect(document.activeElement?.textContent).toContain(
      "Remove something about Thomas Hale",
    );
  });

  it("moves focus again when the dialogue changes stage", () => {
    // The heading is the only thing that says which stage this is. Without a
    // second focus a screen-reader user picks a removal and is told nothing
    // at all about what replaced the list.
    openRemoval("thomas", "Delete Thomas Hale from the tree");

    expect(document.activeElement?.textContent).toContain("Check this first");
  });

  it("returns focus to the button that opened it", () => {
    // `components/PersonPanel.tsx` sets this pattern for itself. Without it a
    // keyboard user dismisses the dialogue and lands on `<body>`, behind the
    // panel they were reading.
    const host = openRemoval("thomas", "Delete Thomas Hale from the tree");

    click(buttonLabelled(host, "Cancel"));

    expect(document.activeElement).toBe(buttonLabelled(host, "Remove…"));
  });

  it("returns focus to the trigger on Escape too", () => {
    const host = openRemoval("thomas");

    act(() => {
      document
        .querySelector("[role='dialog'] button")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });

    expect(document.activeElement).toBe(buttonLabelled(host, "Remove…"));
  });
});

describe("dismissing it with the keyboard", () => {
  /**
   * `components/PersonPanel.tsx` listens for Escape on `document` and closes
   * the panel this dialogue is rendered inside. Without the capture-phase
   * handler in `RemovalDialog`, one Escape would dismiss the confirmation
   * *and* close the record behind it — so this stands in for the panel's
   * listener and asserts it never fires.
   */
  const panelListener = vi.fn();

  beforeEach(() => {
    panelListener.mockClear();
    document.addEventListener("keydown", panelListener);
  });

  afterEach(() => {
    document.removeEventListener("keydown", panelListener);
  });

  it("closes the dialogue and stops the panel from closing too", () => {
    openRemoval("thomas");

    act(() => {
      document
        .querySelector("[role='dialog'] button")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });

    expect(dialog()).toBeNull();
    expect(panelListener).not.toHaveBeenCalled();
  });

  it("leaves other keys alone", () => {
    openRemoval("thomas");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    expect(dialog()).not.toBeNull();
    expect(panelListener).toHaveBeenCalled();
  });
});
