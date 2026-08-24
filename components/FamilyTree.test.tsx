// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { IndividualFormAction } from "@/components/AddPersonPanel";
import { FamilyTree } from "@/components/FamilyTree";
import type { FamilyGraph } from "@/lib/family-graph";
import { emptyIndividualFormState } from "@/lib/individual-form-state";
import { removedState } from "@/lib/removal-state";
import {
  type AddSpouseFormAction,
  emptySpouseFormState,
  spouseSavedState,
} from "@/lib/spouse-form-state";
import { render as mount, rerender } from "@/test/render";

/**
 * The panel's footer (E3-T8) renders `components/PersonRemoval.tsx`, which
 * imports `app/tree/actions.ts` so it can hand its form a server action —
 * and that module reaches `@/auth`, which loads next-auth, which cannot be
 * imported outside the Next.js runtime at all. Vitest fails on the import
 * itself, before any of this file's own assertions run.
 *
 * So this is a stub for a module boundary rather than for behaviour, in the
 * same category as the two browser APIs stubbed below, and it is the rule
 * docs/testing.md states under "Mocking". Every future component test that
 * mounts a tree reaching a server action — E3-T2's and E3-T4's forms
 * included — will need the same three lines.
 */
vi.mock("@/app/tree/actions", () => ({
  removePersonAction: async () => removedState,
  detachPartnerAction: async () => removedState,
  detachChildAction: async () => removedState,
}));

/**
 * The one thing in E2-T1 that cannot be checked without a document: that
 * clicking a node on a real React Flow canvas opens the panel, and that the
 * three ways out of it — Escape, the canvas, the close button — put focus back
 * on the node the reader started from.
 *
 * It is worth the DOM because the wiring is where this ticket's only real trap
 * lives. React Flow applies a selection to its own store only when the flow is
 * uncontrolled; given a `nodes` prop it emits a change and expects the owner to
 * apply it. A canvas that passes `nodes` and no `onNodesChange` therefore looks
 * completely normal and silently selects nothing — which is what this component
 * did for as long as nothing read the selection. A test that clicks a node and
 * expects a panel is the only thing that notices.
 *
 * Everything the panel *says* is decided in `lib/person-detail.ts` and asserted
 * with no DOM at all, and the pan geometry is asserted in
 * `lib/tree-viewport.test.ts`. Only the joins are here.
 */

beforeAll(() => {
  // React's own flag for "act() is safe here". Without it React 19 warns on
  // every update this file drives.
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  // The two browser APIs React Flow reaches for that jsdom does not implement.
  // It measures nodes with a ResizeObserver and reads the zoom out of a
  // DOMMatrix; neither has to do anything for a click to land.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
  } as unknown as typeof DOMMatrixReadOnly;
});

function render(
  graph: FamilyGraph,
  addSpouseAction?: AddSpouseFormAction,
  createIndividualAction?: IndividualFormAction,
  updateIndividualAction?: IndividualFormAction,
): HTMLElement {
  return mount(
    <FamilyTree
      graph={graph}
      addSpouseAction={addSpouseAction}
      createIndividualAction={createIndividualAction}
      updateIndividualAction={updateIndividualAction}
    />,
  );
}

/** Hand the canvas a new graph, as a write that revalidated `/tree` would. */
function reseed(
  host: HTMLElement,
  graph: FamilyGraph,
  addSpouseAction?: AddSpouseFormAction,
): void {
  rerender(
    host,
    <FamilyTree graph={graph} addSpouseAction={addSpouseAction} />,
  );
}

/** An add-person action that records nothing and refuses nothing. */
const inertCreate: IndividualFormAction = async () => emptyIndividualFormState;

/** Nobody recorded at all: the first screen of a fresh deployment. */
function emptyGraph(): FamilyGraph {
  return { people: [], unions: [], childLinks: [] };
}

/** One person and nothing else, which is what the first save leaves behind. */
function loneGraph(): FamilyGraph {
  return {
    people: [person({ id: "rose", givenName: "Rose" })],
    unions: [],
    childLinks: [],
  };
}

/** An add-spouse action that records nothing and refuses nothing. */
const inertAction: AddSpouseFormAction = async () => emptySpouseFormState;

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

/** Rose married Walter and they had Dora. Three nodes and one union. */
function graph(): FamilyGraph {
  return {
    people: [
      person({ id: "rose", givenName: "Rose", birthDate: "1910-05-05" }),
      person({ id: "walter", givenName: "Walter", sex: "male" }),
      person({ id: "dora", givenName: "Dora" }),
    ],
    unions: [
      {
        id: "u1",
        partnerAId: "rose",
        partnerBId: "walter",
        type: "marriage",
        endReason: "ongoing",
        sequence: 1,
        startDate: null,
        startDateQualifier: "exact",
        endDate: null,
        endDateQualifier: "exact",
      },
    ],
    childLinks: [{ unionId: "u1", childId: "dora", relation: "biological" }],
  };
}

function nodeWrapper(host: HTMLElement, id: string): HTMLElement {
  const found = [
    ...host.querySelectorAll<HTMLElement>(".react-flow__node"),
  ].find((wrapper) => wrapper.dataset.id === id);
  if (!found) throw new Error(`no node rendered for "${id}"`);
  return found;
}

function panelLabel(host: HTMLElement): string | null {
  return host.querySelector("aside")?.getAttribute("aria-label") ?? null;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

function open(host: HTMLElement, id: string): void {
  click(nodeWrapper(host, id));
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

function buttonLabelled(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

describe("opening the panel", () => {
  it("opens on a node click", () => {
    const host = render(graph());

    expect(panelLabel(host)).toBeNull();
    open(host, "rose");

    expect(panelLabel(host)).toBe("Details for Rose Hale");
    // Derived on the spot from the same graph the canvas was laid out from —
    // no second query, and nothing about "spouse" stored anywhere.
    expect(host.textContent).toContain("Walter Hale");
    expect(host.textContent).toContain("Dora Hale");
  });

  it("marks the node it opened for", () => {
    const host = render(graph());
    open(host, "rose");

    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(true);
  });

  it("does not open for a union marker", () => {
    const host = render(graph());

    // A union is a connector, not a record. It is not selectable, so clicking
    // it must leave the canvas exactly as it was.
    click(nodeWrapper(host, "u1"));

    expect(panelLabel(host)).toBeNull();
  });
});

describe("navigating by the panel's links", () => {
  it("moves the panel and the selection onto the relative", () => {
    const host = render(graph());
    open(host, "rose");

    click(buttonLabelled(host, "Dora Hale"));

    expect(panelLabel(host)).toBe("Details for Dora Hale");
    expect(nodeWrapper(host, "dora").classList.contains("selected")).toBe(true);
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(
      false,
    );
    // Read from the other end of the same rows: Dora's parents are the two
    // partners of the union she was born into.
    expect(host.textContent).toContain("Rose Hale");
    expect(host.textContent).toContain("Walter Hale");
  });
});

describe("closing the panel", () => {
  it("closes on Escape and puts focus back on the node", () => {
    const host = render(graph());
    open(host, "rose");

    pressEscape();

    expect(panelLabel(host)).toBeNull();
    // The acceptance criterion in full: not merely that the panel went away,
    // but that a keyboard is left where it started rather than on <body>.
    expect(document.activeElement).toBe(nodeWrapper(host, "rose"));
  });

  it("closes on a canvas click and puts focus back on the node", () => {
    const host = render(graph());
    open(host, "rose");

    const pane = host.querySelector<HTMLElement>(".react-flow__pane");
    if (!pane) throw new Error("no pane rendered");
    click(pane);

    expect(panelLabel(host)).toBeNull();
    expect(document.activeElement).toBe(nodeWrapper(host, "rose"));
  });

  it("closes on the panel's own close button", () => {
    const host = render(graph());
    open(host, "rose");

    click(buttonLabelled(host, "Close"));

    expect(panelLabel(host)).toBeNull();
    expect(document.activeElement).toBe(nodeWrapper(host, "rose"));
  });
});

/**
 * The E3-T4 wiring (`YEO-32`). Everything the add-spouse form *does* is
 * asserted in `components/AddSpouseForm.test.tsx` against a stub action; what
 * is left for the canvas is the joins — which are exactly the kind of thing
 * that looks right and silently does nothing.
 */
describe("starting the add-spouse flow", () => {
  it("offers nothing when the canvas was given no action", () => {
    // `/tree` always passes one, but the prop is optional so that this file
    // and anything else can mount the canvas without reaching Auth.js.
    const host = render(graph());
    open(host, "rose");

    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Add a spouse"),
      ),
    ).toBe(false);
  });

  it("swaps the panel for the form, headed with the right person", () => {
    const host = render(graph(), inertAction);
    open(host, "rose");

    click(buttonLabelled(host, "Add a spouse"));

    expect(panelLabel(host)).toBe("Add a spouse for Rose Hale");
  });

  it("comes back to the panel on cancel", () => {
    const host = render(graph(), inertAction);
    open(host, "rose");
    click(buttonLabelled(host, "Add a spouse"));

    click(buttonLabelled(host, "Cancel"));

    expect(panelLabel(host)).toBe("Details for Rose Hale");
  });

  it("comes back to the panel once a union has been written", async () => {
    const host = render(graph(), async () => spouseSavedState("u2"));
    open(host, "rose");
    click(buttonLabelled(host, "Add a spouse"));

    // The picker offers Walter even though Rose is already married to him:
    // a couple who divorced and remarried each other is a real record.
    click(buttonLabelled(host, "Walter Hale"));
    // Awaited: the action is async, and the form only closes on the state it
    // answers with.
    await act(async () => {
      host.querySelector("form")?.requestSubmit();
    });

    expect(panelLabel(host)).toBe("Details for Rose Hale");
  });

  /**
   * The form is keyed to the person it was opened for, not to a boolean. A
   * form headed "Add a spouse for Rose" must never be submitted against
   * whoever the reader clicked next.
   */
  it("closes when the reader selects somebody else", () => {
    const host = render(graph(), inertAction);
    open(host, "rose");
    click(buttonLabelled(host, "Add a spouse"));

    open(host, "dora");

    expect(panelLabel(host)).toBe("Details for Dora Hale");
  });
});

/**
 * Every E3 write calls `revalidatePath("/tree")`, so a fresh graph arrives as
 * a prop the moment anything is saved. Dropping the selection then would close
 * the panel of the person you just added a spouse to, at the exact moment you
 * wanted to look at the result — which is what makes remarriage-in-place feel
 * like it worked rather than like the canvas reset.
 */
describe("a fresh graph arriving after a write", () => {
  it("keeps the panel open on the person it was open on", () => {
    const host = render(graph());
    open(host, "rose");

    reseed(host, graph());

    expect(panelLabel(host)).toBe("Details for Rose Hale");
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(true);
  });

  it("shows what the write added", () => {
    const host = render(graph());
    open(host, "rose");
    expect(host.textContent).not.toContain("Ada Hale");

    // Rose gains a second union, exactly as an add-spouse save would leave it.
    const grown = graph();
    grown.people.push(person({ id: "ada", givenName: "Ada" }));
    grown.unions.push({
      id: "u2",
      partnerAId: "rose",
      partnerBId: "ada",
      type: "marriage",
      endReason: "ongoing",
      sequence: 2,
      startDate: null,
      startDateQualifier: "exact",
      endDate: null,
      endDateQualifier: "exact",
    });
    reseed(host, grown);

    expect(panelLabel(host)).toBe("Details for Rose Hale");
    expect(host.textContent).toContain("Ada Hale");
    // Rose is one node with two unions hanging off her, not two Roses.
    expect(
      [...host.querySelectorAll<HTMLElement>(".react-flow__node")].filter(
        (wrapper) => wrapper.dataset.id === "rose",
      ),
    ).toHaveLength(1);
  });

  it("closes the panel when the person is no longer in the graph", () => {
    const host = render(graph());
    open(host, "dora");

    // Deleted in another tab, or by E3-T8. There is no node left to select.
    const without = graph();
    without.people = without.people.filter((p) => p.id !== "dora");
    without.childLinks = [];
    reseed(host, without);

    expect(panelLabel(host)).toBeNull();
  });
});

/**
 * E3-T9 (`YEO-37`). The two states this canvas has always been able to
 * produce and nothing ever asserted: no people at all, and people with
 * nothing joining them.
 *
 * What each state *says* is decided in `lib/tree-onboarding.ts` and asserted
 * there with no DOM. What is left here is the part that can only be seen by
 * mounting: that an empty graph gets an invitation instead of a canvas, that
 * the invitation's button opens the real add-person panel, and that the hint
 * appears and disappears at the right moments.
 */
describe("an empty tree", () => {
  it("invites the first person instead of showing a blank canvas", () => {
    const host = render(emptyGraph(), undefined, inertCreate);

    expect(host.textContent).toContain("Nobody is on the tree yet");
    expect(buttonLabelled(host, "Add the first person")).toBeTruthy();
    // Nothing to lay out, so there is no canvas — and therefore no minimap of
    // an empty viewport, which is the thing that reads as broken.
    expect(host.querySelector(".react-flow")).toBeNull();
  });

  it("walks somebody to the first save", () => {
    const host = render(emptyGraph(), undefined, inertCreate);

    click(buttonLabelled(host, "Add the first person"));

    // The same panel the page header opens, not a second form: one flow, one
    // set of validation messages, however the author reached it.
    expect(panelLabel(host)).toBe("Add a person");
  });

  it("still says what to do when the canvas was given no action", () => {
    // `/tree` always passes one; a test that mounts the tree without reaching
    // Auth.js does not, and the invitation has to survive that.
    const host = render(emptyGraph());

    expect(host.textContent).toContain("Nobody is on the tree yet");
    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Add the first person"),
      ),
    ).toBe(false);
  });

  it("becomes a canvas as soon as somebody is saved", () => {
    // The write revalidated `/tree`, so the new graph arrives as a prop. This
    // is the join between the invitation and the tree, and it is the step of
    // the walk that would silently strand somebody on a dead screen.
    const host = render(emptyGraph(), undefined, inertCreate);
    reseed(host, loneGraph());

    expect(host.textContent).not.toContain("Nobody is on the tree yet");
    expect(nodeWrapper(host, "rose")).toBeTruthy();
  });
});

describe("a tree with nobody connected", () => {
  it("draws the lone person and says what comes next", () => {
    const host = render(loneGraph(), inertAction);

    // Not an empty state: there is a real card on a real canvas.
    expect(nodeWrapper(host, "rose")).toBeTruthy();
    expect(host.textContent).toContain("Just Rose Hale so far.");
    // The one thing about this application that cannot be guessed from the
    // interface, said before anybody goes hunting for "add a child".
    expect(host.textContent).toContain(
      "Children belong to a marriage rather than to a person",
    );
  });

  it("phrases the hint generally when there is nobody in particular to name", () => {
    const several = loneGraph();
    several.people.push(
      person({ id: "walter", givenName: "Walter", sex: "male" }),
    );

    const host = render(several, inertAction);

    expect(host.textContent).toContain("Nobody is connected yet.");
  });

  it("gets out of the way once a panel is open", () => {
    const host = render(loneGraph(), inertAction);
    open(host, "rose");

    // The panel is the answer to the hint, and on a narrow viewport it is
    // sitting on top of it.
    expect(host.textContent).not.toContain("Just Rose Hale so far.");
    expect(panelLabel(host)).toBe("Details for Rose Hale");
  });

  it("stops once a union exists", () => {
    // The three-person seed: Rose married Walter and they had Dora. Nothing
    // about this tree needs explaining.
    const host = render(graph(), inertAction);

    expect(host.textContent).not.toContain("Nobody is connected yet.");
    expect(host.textContent).not.toContain("so far.");
  });
});

/**
 * The E3-T3 wiring (`YEO-31`). Everything the edit form *does* — the prefill,
 * the unsaved-changes warning, what a cleared field posts — is asserted in
 * `components/EditPersonForm.test.tsx` against a stub action. What is left for
 * the canvas is the two joins the ticket names: that the form is reached from
 * the detail panel, and that it is opened on the person whose panel it is.
 */
describe("reaching the edit form", () => {
  /** An edit action that records nothing and refuses nothing. */
  const inertUpdate: IndividualFormAction = async () => emptyIndividualFormState;

  it("offers nothing when the canvas was given no action", () => {
    // `/tree` always passes one, but the prop is optional so that this file
    // and anything else can mount the canvas without reaching Auth.js.
    const host = render(graph());
    open(host, "rose");

    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Edit details"),
      ),
    ).toBe(false);
  });

  it("opens from the panel, prefilled with the selected person", () => {
    const host = render(graph(), undefined, undefined, inertUpdate);
    open(host, "rose");

    click(buttonLabelled(host, "Edit details"));

    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      host.querySelector<HTMLInputElement>('[name="givenName"]')?.value,
    ).toBe("Rose");
    // The hidden reference is what makes this an edit rather than a second
    // Rose, so it is worth asserting from the outside as well.
    expect(host.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe(
      "rose",
    );
  });

  it("edits whoever the panel is currently showing", () => {
    const host = render(graph(), undefined, undefined, inertUpdate);
    open(host, "walter");

    click(buttonLabelled(host, "Edit details"));

    expect(
      host.querySelector<HTMLInputElement>('[name="givenName"]')?.value,
    ).toBe("Walter");
  });
});
