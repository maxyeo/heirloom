// @vitest-environment jsdom
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  AddPersonPanel,
  type IndividualFormAction,
} from "@/components/AddPersonPanel";
import { FamilyTree } from "@/components/FamilyTree";
import type { EntryLink } from "@/lib/entry-link";
import {
  changedEntryLinkState,
  type PersonEntryActions,
} from "@/lib/entry-link-state";
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
        startDatePrecision: "day",
        startDateUpper: null,
        startDateUpperPrecision: "day",
        endDate: null,
        endDateQualifier: "exact",
        endDatePrecision: "day",
        endDateUpper: null,
        endDateUpperPrecision: "day",
      },
    ],
    childLinks: [{ unionId: "u1", childId: "dora", relation: "biological" }],
  };
}

/** Two entries: one about Rose, one nobody has claimed. */
const ROSE_ENTRY: EntryLink = {
  id: "page-rose",
  slug: "rose-hale",
  title: "Rose Hale",
};

const LOOSE_ENTRY: EntryLink = {
  id: "page-loose",
  slug: "the-farm",
  title: "The farm",
};

/** Entry actions that record nothing and refuse nothing. */
const inertEntryActions: PersonEntryActions = {
  create: async () => changedEntryLinkState,
  link: async () => changedEntryLinkState,
  unlink: async () => changedEntryLinkState,
};

/** The canvas, wired for entries the way `app/tree/page.tsx` wires it. */
function renderWithEntries(
  people: FamilyGraph,
  entries: readonly EntryLink[],
  entryActions?: PersonEntryActions,
): HTMLElement {
  return mount(
    <FamilyTree graph={people} entries={entries} entryActions={entryActions} />,
  );
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

/**
 * "Tree nodes reachable and selectable by keyboard" (E10-T5).
 *
 * The tab stops themselves are React Flow's — it puts `tabIndex={0}` on every
 * focusable node — so what is worth mounting a canvas for is the two things
 * this application decides about them: which elements end up in that order,
 * and in what sequence.
 *
 * Two things this file deliberately cannot show, and where they are shown
 * instead:
 *
 *   - **The focus ring.** React Flow's own stylesheet sets `outline: none` on
 *     a focused node, and the rule that puts it back is unlayered CSS in
 *     `app/globals.css`. jsdom applies no stylesheet, so `app/globals.test.ts`
 *     asserts the declaration and this file cannot.
 *   - **`edgesFocusable={false}`.** jsdom renders no edges at all — React Flow
 *     needs measurements it has no layout engine for — so the elements this
 *     takes out of the tab order are not here to count. `lib/tree-layout.ts`
 *     carries the other half of that decision and it is asserted there.
 */
describe("reaching the canvas with a keyboard", () => {
  /**
   * The same family as `graph()`, with the rows in the order the database
   * hands them over — surname then given name, so the daughter first.
   *
   * That mismatch is the whole point. Before E10-T5 the tab order *was* this
   * array, so Tab opened on Dora, went back up a generation to her mother,
   * and then sideways to her father.
   */
  function unsortedGraph(): FamilyGraph {
    const family = graph();
    return {
      ...family,
      people: [
        family.people.find((p) => p.id === "dora")!,
        family.people.find((p) => p.id === "rose")!,
        family.people.find((p) => p.id === "walter")!,
      ],
    };
  }

  /** Everything a Tab would stop on, in document order. */
  function tabStops(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>("[tabindex='0']")];
  }

  it("puts every person in the tab order and nothing else", () => {
    const host = render(unsortedGraph());

    expect(
      tabStops(host)
        .map((stop) => stop.dataset.id)
        .sort(),
    ).toEqual(["dora", "rose", "walter"]);
    // The union marker is a connector, not a record. Tabbing through one would
    // double the stops it takes to cross a generation for no gain.
    expect(nodeWrapper(host, "u1").getAttribute("tabindex")).toBeNull();
  });

  it("crosses the tree generation by generation, not row by row", () => {
    const host = render(unsortedGraph());

    /**
     * Dora is first in the graph and last on the canvas. A tab order taken
     * from the array would open on her; taken from the layout it ends there.
     *
     * Which of her parents comes first is dagre's business and is not
     * asserted — `lib/tree-layout.test.ts` covers the ordering rule itself,
     * and pinning "Walter then Rose" here would be pinning a horizontal
     * placement that a dagre release could reasonably swap without breaking
     * anything this criterion is about.
     */
    const order = tabStops(host).map((stop) => stop.dataset.id);
    expect(order.indexOf("dora")).toBe(order.length - 1);
    expect(order.indexOf("rose")).toBeLessThan(order.indexOf("dora"));
    expect(order.indexOf("walter")).toBeLessThan(order.indexOf("dora"));
  });

  it("names each node for a reader who cannot see it", () => {
    const host = render(graph());

    // The wrapper is what is in the tab order and it has no text of its own,
    // so without this a screen reader announces "group" once per person.
    expect(nodeWrapper(host, "rose").getAttribute("aria-label")).toBe(
      "Rose Hale, b. 1910",
    );
    expect(nodeWrapper(host, "walter").getAttribute("aria-label")).toBe(
      "Walter Hale",
    );
  });

  it("opens the record on Enter, exactly as a click does", () => {
    const host = render(graph());
    const node = nodeWrapper(host, "rose");

    act(() => node.focus());
    act(() => {
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    // The "selectable" half of the criterion. It is not free: React Flow
    // applies a selection to its own store only for an *uncontrolled* flow,
    // so a canvas that passes `nodes` without `onNodesChange` swallows this
    // keystroke and looks perfectly normal doing it.
    expect(panelLabel(host)).toBe("Details for Rose Hale");
    expect(node.classList.contains("selected")).toBe(true);
  });

  it("opens the record on Space as well", () => {
    const host = render(graph());
    const node = nodeWrapper(host, "walter");

    act(() => node.focus());
    act(() => {
      node.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });

    expect(panelLabel(host)).toBe("Details for Walter Hale");
  });
});

/**
 * The key to the canvas's lines (E10-T5). Which rows a family earns is
 * `lib/tree-legend.test.ts`'s subject; what is here is only that the box
 * appears on a canvas that needs one, stays away from one that does not, and
 * does not sit on top of the surfaces that share its corner.
 */
describe("the line key", () => {
  function legend(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>(
      'aside[aria-label="What the lines mean"]',
    );
  }

  /** Rose and Walter divorced; everything else as `graph()` has it. */
  function endedGraph(): FamilyGraph {
    const family = graph();
    return {
      ...family,
      unions: family.unions.map((union) => ({
        ...union,
        endReason: "divorce" as const,
      })),
    };
  }

  it("stays away from a family with no dashed line on it", () => {
    expect(legend(render(graph()))).toBeNull();
  });

  it("explains the dash on a family that has one", () => {
    const host = render(endedGraph());

    const box = legend(host);
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("ended");
    // Words *and* a sample of the line they describe — a key that drew a dash
    // and said nothing would be the state this ticket found the canvas in.
    expect(box?.querySelectorAll("svg line").length).toBe(1);
  });

  it("gets out of the way while a record is open", () => {
    // It shares the top-left corner with the panel on a narrow viewport, and
    // an open record is the more specific answer to the same question.
    const host = render(endedGraph());
    open(host, "rose");

    expect(legend(host)).toBeNull();
  });
});

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

/**
 * What a node draws for a person's face (E5-T4, `YEO-44`). Everything about
 * *which* key a node loads is decided by `lib/tree-layout.ts` and
 * `lib/portrait.ts`, and asserted with no DOM in `lib/tree-layout.test.ts`'s
 * "layout stability" block. What is left here is only what a real mount can
 * show: that a photograph on a person becomes an `<img>` inside their node,
 * and that a person with none gets the placeholder rather than a broken
 * image.
 */
describe("portraits on the canvas", () => {
  const KEY = "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";

  it("renders an img under /api/images/ for a person with a portrait", () => {
    const withPortrait = graph();
    withPortrait.people = withPortrait.people.map((p) =>
      p.id === "rose" ? { ...p, portraitKey: KEY, portraitThumbKey: null } : p,
    );
    const host = render(withPortrait);

    const img = nodeWrapper(host, "rose").querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("/api/images/");
  });

  it("renders the placeholder for a person with no portrait", () => {
    const host = render(graph());

    const node = nodeWrapper(host, "rose");
    expect(node.querySelector("img")).toBeNull();
    expect(
      node.querySelector('[data-testid="portrait-placeholder"]'),
    ).not.toBeNull();
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
 * Two panels open at once, and one Escape each (`YEO-83`).
 *
 * This is the symptom the ticket opens with, and the one E3-T2 (`YEO-30`)
 * recorded when it added the second panel to this page: every surface ran its
 * own `document` listener, so an Escape over the add-person panel closed the
 * record behind it as well. Nothing pinned it, because the two panels are
 * mounted by different components — the add-person panel lives in the tree
 * page's header, outside the canvas — and neither file's own test had the
 * other one on screen.
 *
 * So this mounts them the way `app/tree/page.tsx` does, which is the smallest
 * arrangement in which the bug exists at all.
 */
describe("the add-person panel over the detail panel", () => {
  /** The header and the canvas, as the tree page composes them. */
  function renderPage(): HTMLElement {
    return mount(
      <>
        <AddPersonPanel action={inertCreate} />
        <FamilyTree graph={graph()} />
      </>,
    );
  }

  function detailPanel(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('aside[aria-label^="Details for"]');
  }

  function addPersonPanel(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('aside[aria-label="Add a person"]');
  }

  it("closes the add-person panel first and the record second", () => {
    const host = renderPage();
    open(host, "rose");
    click(buttonLabelled(host, "Add person"));

    expect(detailPanel(host)).not.toBeNull();
    expect(addPersonPanel(host)).not.toBeNull();

    pressEscape();

    // One keystroke, one surface. The record is still open behind it.
    expect(addPersonPanel(host)).toBeNull();
    expect(detailPanel(host)).not.toBeNull();

    pressEscape();

    expect(detailPanel(host)).toBeNull();
    /*
      And focus is left where the *first* Escape put it: on the button the
      add-person panel came from. The canvas only rescues focus that the
      browser dropped on `<body>` when the panel unmounted — a reader who is
      demonstrably somewhere else is not dragged back to the node. That guard
      is the hook's, and it is why closing two surfaces in a row does not end
      in a fight over the cursor.
    */
    expect(document.activeElement).toBe(buttonLabelled(host, "Add person"));
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
      startDatePrecision: "day",
      startDateUpper: null,
      startDateUpperPrecision: "day",
      endDate: null,
      endDateQualifier: "exact",
      endDatePrecision: "day",
      endDateUpper: null,
      endDateUpperPrecision: "day",
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
  const inertUpdate: IndividualFormAction = async () =>
    emptyIndividualFormState;

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
    expect(
      host.querySelector<HTMLInputElement>('input[name="id"]')?.value,
    ).toBe("rose");
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

/**
 * The deep link (E2-T4). The canvas takes the URL as a prop rather than
 * reading it — `components/DeepLinkedFamilyTree.tsx` explains why — which is
 * what lets this file drive both directions of it with no router: a changed
 * `personId` is what arriving on a link and pressing Back both look like from
 * in here, and `onChange` is what the address bar would be asked to follow.
 *
 * Everything that is arithmetic — resolving an unknown id, rewriting a query
 * string, applying a selection to a list of nodes — is asserted with no DOM in
 * `lib/tree-selection.test.ts`. Only the joins are here.
 */
describe("the deep link", () => {
  function renderLinked(
    personId: string | null,
    onChange: (next: string | null) => void,
  ): HTMLElement {
    return mount(
      <FamilyTree graph={graph()} personLink={{ personId, onChange }} />,
    );
  }

  /** The URL changing under a mounted canvas: a deep link, or back/forward. */
  function navigate(
    host: HTMLElement,
    personId: string | null,
    onChange: (next: string | null) => void,
  ): void {
    rerender(
      host,
      <FamilyTree graph={graph()} personLink={{ personId, onChange }} />,
    );
  }

  it("opens on the person the URL names", () => {
    const host = renderLinked("rose", () => {});

    expect(panelLabel(host)).toBe("Details for Rose Hale");
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(true);
  });

  it("does not push back the selection it was handed", () => {
    // Arriving on a link is the URL and the canvas already agreeing. Reporting
    // it would write the entry the reader just followed into the history a
    // second time, and Back would then land on the page they are looking at.
    const changes: (string | null)[] = [];
    renderLinked("rose", (next) => changes.push(next));

    expect(changes).toEqual([]);
  });

  it("falls back to the ordinary canvas for an id nobody answers to", () => {
    const changes: (string | null)[] = [];
    const host = renderLinked("nobody", (next) => changes.push(next));

    expect(panelLabel(host)).toBeNull();
    // The tree itself is untouched: three people, drawn as usual.
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(
      false,
    );
    // And the bad parameter is left alone rather than tidied away, which would
    // be a history entry nobody asked for.
    expect(changes).toEqual([]);
  });

  it("reports a click for the URL to follow", () => {
    const changes: (string | null)[] = [];
    const host = renderLinked(null, (next) => changes.push(next));

    open(host, "walter");

    expect(changes).toEqual(["walter"]);
  });

  it("reports the panel closing", () => {
    const changes: (string | null)[] = [];
    const host = renderLinked("rose", (next) => changes.push(next));

    pressEscape();

    expect(panelLabel(host)).toBeNull();
    expect(changes).toEqual([null]);
  });

  it("follows the URL back to nobody", () => {
    // Back, from a panel the reader opened by clicking. The canvas closes it,
    // and reports nothing: the history already holds this entry, and pushing
    // it again is what breaks Forward.
    const changes: (string | null)[] = [];
    const onChange = (next: string | null) => changes.push(next);
    const host = renderLinked("rose", onChange);

    navigate(host, null, onChange);

    expect(panelLabel(host)).toBeNull();
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(
      false,
    );
    expect(changes).toEqual([]);
  });

  it("follows the URL on to somebody else", () => {
    // Forward again, or a second link followed from a wiki entry.
    const changes: (string | null)[] = [];
    const onChange = (next: string | null) => changes.push(next);
    const host = renderLinked(null, onChange);

    navigate(host, "dora", onChange);

    expect(panelLabel(host)).toBe("Details for Dora Hale");
    expect(nodeWrapper(host, "dora").classList.contains("selected")).toBe(true);
    expect(changes).toEqual([]);
  });

  it("reports where the panel's own links go", () => {
    const changes: (string | null)[] = [];
    const host = renderLinked("rose", (next) => changes.push(next));

    click(buttonLabelled(host, "Dora Hale"));

    expect(panelLabel(host)).toBe("Details for Dora Hale");
    expect(changes).toEqual(["dora"]);
  });
});

/**
 * The wiring E2-T2 added to this file: `page_id` on the graph and the entry
 * list are two separate values, and matching them is the canvas's job. The
 * matching itself is asserted in `lib/entry-link.test.ts` and the control in
 * `components/PersonEntry.test.tsx`; what is checked here is that the panel is
 * handed the right answer for the person who is actually selected.
 */
describe("the entry link on the panel", () => {
  /** Rose has an entry; Walter and Dora do not. */
  function linkedGraph(): FamilyGraph {
    const family = graph();
    return {
      ...family,
      people: family.people.map((candidate) =>
        candidate.id === "rose"
          ? { ...candidate, pageId: ROSE_ENTRY.id }
          : candidate,
      ),
    };
  }

  it("links to the entry of the person whose panel is open", () => {
    const host = renderWithEntries(linkedGraph(), [ROSE_ENTRY, LOOSE_ENTRY]);
    open(host, "rose");

    const link = [...host.querySelectorAll("a")].find((anchor) =>
      anchor.getAttribute("href")?.startsWith("/wiki/"),
    );

    expect(link?.getAttribute("href")).toBe("/wiki/rose-hale");
  });

  it("offers to write one for a person who has none", () => {
    const host = renderWithEntries(
      linkedGraph(),
      [ROSE_ENTRY, LOOSE_ENTRY],
      inertEntryActions,
    );
    open(host, "walter");

    expect(host.textContent).toContain("No entry yet for Walter Hale");
    expect(buttonLabelled(host, "Write about this person")).toBeDefined();
  });

  it("swaps the answer when the panel moves to somebody else", () => {
    // The panel stays open and changes person when a relative is followed, so
    // an entry link left over from the previous record would be wrong *and*
    // clickable.
    const host = renderWithEntries(linkedGraph(), [ROSE_ENTRY, LOOSE_ENTRY]);
    open(host, "rose");
    open(host, "dora");

    expect(
      [...host.querySelectorAll("a")].some((anchor) =>
        anchor.getAttribute("href")?.startsWith("/wiki/"),
      ),
    ).toBe(false);
    expect(host.textContent).toContain("No entry yet for Dora Hale");
  });

  it("does not offer an entry somebody else already has", () => {
    // `unlinkedEntries` filters the picker, so Rose's entry must not appear as
    // an option on Walter's panel. Only the unclaimed one may.
    const host = renderWithEntries(
      linkedGraph(),
      [ROSE_ENTRY, LOOSE_ENTRY],
      inertEntryActions,
    );
    open(host, "walter");

    const options = [...host.querySelectorAll("option")].map(
      (option) => option.value,
    );

    expect(options).toContain(LOOSE_ENTRY.id);
    expect(options).not.toContain(ROSE_ENTRY.id);
  });

  it("offers nothing to write with when the canvas was given no actions", () => {
    // `/tree` always passes them, but the prop is optional so that this file
    // can mount the canvas without reaching Auth.js — and a canvas without
    // them still has to show the entry a person has.
    const host = renderWithEntries(linkedGraph(), [ROSE_ENTRY, LOOSE_ENTRY]);
    open(host, "walter");

    expect(host.textContent).not.toContain("Write about this person");
    expect(host.querySelector("select")).toBeNull();
  });
});

/**
 * The seam E2-T4 and E2-T2 share: the deep link decides *which* person is
 * selected, and the entry link decides *what* the panel says about them.
 * Neither ticket's own tests mount both props at once — "the deep link"
 * above never passes `entries`, and "the entry link on the panel" above
 * never passes `personLink` — so nothing else in this file catches the two
 * wires crossed, or one of the pair overwriting the other's slot.
 */
describe("a deep link that opens on a person with an entry", () => {
  /** Rose has an entry; Walter and Dora do not. Same shape as `linkedGraph`
   * above, kept local rather than shared so this block reads on its own. */
  function linkedGraph(): FamilyGraph {
    const family = graph();
    return {
      ...family,
      people: family.people.map((candidate) =>
        candidate.id === "rose"
          ? { ...candidate, pageId: ROSE_ENTRY.id }
          : candidate,
      ),
    };
  }

  it("opens the panel on the linked person with their entry already rendered", () => {
    const host = mount(
      <FamilyTree
        graph={linkedGraph()}
        entries={[ROSE_ENTRY, LOOSE_ENTRY]}
        personLink={{ personId: "rose", onChange: () => {} }}
      />,
    );

    expect(panelLabel(host)).toBe("Details for Rose Hale");
    expect(nodeWrapper(host, "rose").classList.contains("selected")).toBe(true);

    const link = [...host.querySelectorAll("a")].find((anchor) =>
      anchor.getAttribute("href")?.startsWith("/wiki/"),
    );
    expect(link?.getAttribute("href")).toBe("/wiki/rose-hale");
  });

  it("opens the panel on a linked person with none, offering to write one", () => {
    const host = mount(
      <FamilyTree
        graph={linkedGraph()}
        entries={[ROSE_ENTRY, LOOSE_ENTRY]}
        entryActions={inertEntryActions}
        personLink={{ personId: "walter", onChange: () => {} }}
      />,
    );

    expect(panelLabel(host)).toBe("Details for Walter Hale");
    expect(host.textContent).toContain("No entry yet for Walter Hale");
    expect(buttonLabelled(host, "Write about this person")).toBeDefined();
  });

  it("swaps the entry when a relative's link moves the deep-linked selection", () => {
    const changes: (string | null)[] = [];
    const host = mount(
      <FamilyTree
        graph={linkedGraph()}
        entries={[ROSE_ENTRY, LOOSE_ENTRY]}
        personLink={{
          personId: "rose",
          onChange: (next) => changes.push(next),
        }}
      />,
    );

    click(buttonLabelled(host, "Dora Hale"));

    expect(panelLabel(host)).toBe("Details for Dora Hale");
    expect(host.textContent).toContain("No entry yet for Dora Hale");
    expect(
      [...host.querySelectorAll("a")].some((anchor) =>
        anchor.getAttribute("href")?.startsWith("/wiki/"),
      ),
    ).toBe(false);
    expect(changes).toEqual(["dora"]);
  });
});
