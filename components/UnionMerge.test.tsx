// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { UnionMerge } from "@/components/UnionMerge";
import type { FamilyGraph, GraphPerson } from "@/lib/family-graph";
import { mergedUnionState, type UnionMergeState } from "@/lib/merge-state";
import { render, rerender } from "@/test/render";

/**
 * The merge confirmation (E3-T10, `YEO-82`).
 *
 * Most of what this ticket has to get right is decided in
 * `lib/union-merge.ts` and asserted next to it with no DOM at all — which
 * children move, what stops being recorded, where the surviving row sits in
 * the order. What is left here is the part that only exists once there is a
 * document, and it is not incidental: **that the sentences reach the screen**.
 * A preview that computes the losses perfectly and a dialogue that renders
 * half of them is exactly as dangerous as computing them wrongly, because the
 * copy is the whole safety mechanism — the tree keeps no history. See
 * docs/testing.md, "prefer no DOM".
 *
 * ## Why this file mocks
 *
 * The same module boundary `components/PersonRemoval.test.tsx` mocks and for
 * the same reason: the component imports `app/tree/actions.ts` to hand its
 * form a server action, and that module reaches `@/auth`, which cannot be
 * imported outside the Next.js runtime. The stub doubles as the assertion for
 * *which* two ids the merge is sent, which is the one thing about this wiring
 * that could silently invert — and inverting it would keep the wrong record.
 */
const mergeUnionsAction = vi.fn<
  (state: UnionMergeState, form: FormData) => Promise<UnionMergeState>
>(async () => mergedUnionState("u-marriage"));

vi.mock("@/app/tree/actions", () => ({
  mergeUnionsAction: (state: UnionMergeState, form: FormData) =>
    mergeUnionsAction(state, form),
}));

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

/**
 * Rose and Walter, recorded twice: the marriage somebody entered properly, and
 * the bare `unknown` union the set-parents flow created inline while recording
 * Edith's parents. Dora hangs off the marriage, so a merge in either direction
 * has a child to move and a child to leave alone.
 */
function graph(): FamilyGraph {
  return {
    people: [
      person({ id: "rose", givenName: "Rose", surname: "Hale" }),
      person({ id: "walter", givenName: "Walter", surname: "Byrne" }),
      person({ id: "dora", givenName: "Dora", surname: "Byrne" }),
      person({ id: "edith", givenName: "Edith", surname: "Byrne" }),
    ],
    unions: [
      union({
        id: "u-marriage",
        partnerAId: "rose",
        partnerBId: "walter",
        startDate: "1946-09-30",
        endDate: "1970-01-02",
        endReason: "divorce",
        sequence: 1,
      }),
      union({
        id: "u-inline",
        partnerAId: "walter",
        partnerBId: "rose",
        type: "unknown",
        sequence: 2,
      }),
    ],
    childLinks: [
      { unionId: "u-marriage", childId: "dora", relation: "biological" },
      { unionId: "u-inline", childId: "edith", relation: "biological" },
    ],
  };
}

function mount(options: { graph?: FamilyGraph; personId?: string } = {}) {
  mergeUnionsAction.mockClear();
  return render(
    <UnionMerge
      graph={options.graph ?? graph()}
      personId={options.personId ?? "rose"}
    />,
  );
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonLabelled(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

/** The dialogue's surface, which is rendered in a portal-free fixed overlay. */
function dialogue(host: HTMLElement): HTMLElement {
  const found = host.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("no dialogue open");
  return found;
}

/** Open the confirmation for keeping `keep` and merging the other one in. */
function openConfirmation(keepLabel: string) {
  const host = mount();
  click(buttonLabelled(host, "Merge duplicate families"));
  click(buttonLabelled(dialogue(host), keepLabel));
  return host;
}

async function submit(host: HTMLElement): Promise<void> {
  const form = dialogue(host).querySelector("form");
  if (!form) throw new Error("no form");
  await act(async () => {
    form.requestSubmit();
  });
}

describe("offering the merge at all", () => {
  it("says nothing about somebody with no duplicates", () => {
    const single = graph();
    single.unions = single.unions.filter((u) => u.id === "u-marriage");
    single.childLinks = single.childLinks.filter(
      (link) => link.unionId === "u-marriage",
    );

    // Most people. A heading over an empty list would be inventing a problem.
    expect(mount({ graph: single }).textContent).toBe("");
  });

  it("says nothing about two unions that each record an unknown partner", () => {
    /**
     * The trap this ticket names. Both partner columns are nullable so that an
     * unknown father needs no placeholder person, so two such rows may be two
     * children by two men nobody can name — not one couple recorded twice.
     */
    const unknowns = graph();
    unknowns.unions = [
      union({ id: "x1", partnerAId: "rose" }),
      union({ id: "x2", partnerAId: "rose" }),
    ];
    unknowns.childLinks = [];

    expect(mount({ graph: unknowns }).textContent).toBe("");
  });

  it("offers both directions, because which record survives is the choice", () => {
    const host = mount();
    click(buttonLabelled(host, "Merge duplicate families"));

    const text = dialogue(host).textContent ?? "";
    expect(text).toContain("2 families recorded with Walter Byrne");
    // The surviving row keeps its own type and dates, so "keep the marriage"
    // and "keep the bare record" are different outcomes and both are offered.
    expect(text).toContain("Keep Marriage, 30 September 1946 – 2 January 1970");
    expect(text).toContain("Keep Union");
  });

  it("says out loud that a real remarriage should be left alone", () => {
    /**
     * The criterion the whole ticket turns on. Nothing here merges on its own,
     * and the dialogue has to say why somebody might close it.
     */
    const host = mount();
    click(buttonLabelled(host, "Merge duplicate families"));

    expect(dialogue(host).textContent).toContain("marry more than once");
  });
});

describe("the confirmation", () => {
  it("names the children whose links move, and says nobody loses a parent", () => {
    const host = openConfirmation("Keep Marriage");

    const text = dialogue(host).textContent ?? "";
    expect(text).toContain("Edith Byrne");
    expect(text).toContain("Nobody loses a parent");
  });

  it("names every value that stops being recorded", () => {
    /**
     * The sentence this dialogue exists for. Keeping the bare inline record
     * drops the marriage, its two dates and the divorce — and an author who
     * cannot read that here will not find out anywhere else, because the tree
     * keeps no history.
     */
    const host = openConfirmation("Keep Union");

    const text = dialogue(host).textContent ?? "";
    expect(text).toContain("what kind of union it was: Marriage");
    expect(text).toContain("when it began: 30 September 1946");
    expect(text).toContain("when it ended: 2 January 1970");
    expect(text).toContain("how it ended: Divorce");
  });

  it("names nothing as lost when the record going recorded nothing", () => {
    // The commonest merge: the bare inline row folded into the marriage.
    const host = openConfirmation("Keep Marriage");

    expect(dialogue(host).textContent).not.toContain("The record going says");
  });

  it("says the surviving record takes the earlier place in the order", () => {
    const host = openConfirmation("Keep Union");

    expect(dialogue(host).textContent).toContain("earlier of the two places");
  });

  it("promises what a merge actually promises", () => {
    const host = openConfirmation("Keep Marriage");

    const text = dialogue(host).textContent ?? "";
    expect(text).toContain("Nobody is deleted, and no child link is lost");
    expect(text).toContain("Notes from both records");
  });

  it("says which relation stands for a child recorded in both", () => {
    const both = graph();
    both.childLinks.push({
      unionId: "u-inline",
      childId: "dora",
      relation: "adopted",
    });

    const host = mount({ graph: both });
    click(buttonLabelled(host, "Merge duplicate families"));
    click(buttonLabelled(dialogue(host), "Keep Marriage"));

    const text = dialogue(host).textContent ?? "";
    expect(text).toContain("Dora Byrne is recorded in both");
    expect(text).toContain("The one you keep stands");
  });
});

describe("what it sends", () => {
  it("sends the record to keep and the record to merge, in that order", async () => {
    const host = openConfirmation("Keep Marriage");
    await submit(host);

    expect(mergeUnionsAction).toHaveBeenCalledTimes(1);
    const form = mergeUnionsAction.mock.calls[0][1];
    expect(form.get("keepUnionId")).toBe("u-marriage");
    expect(form.get("mergeUnionId")).toBe("u-inline");
  });

  it("sends them the other way round when the other record is kept", async () => {
    const host = openConfirmation("Keep Union");
    await submit(host);

    const form = mergeUnionsAction.mock.calls[0][1];
    expect(form.get("keepUnionId")).toBe("u-inline");
    expect(form.get("mergeUnionId")).toBe("u-marriage");
  });

  it("keeps its own confirmation when the merge empties the list under it", async () => {
    /**
     * The one that is easy to get wrong, and it fails *after* the write
     * succeeds — which is the worst place for a dialogue to lie. A merge
     * revalidates `/tree`, so a graph arrives in which the record that was
     * merged away is gone and Rose has no duplicates left. Two things then
     * happen unless they are stopped: `previewUnionMerge` returns null and the
     * "somebody else may have removed these" copy replaces the success, and
     * `duplicateUnionGroups` comes back empty and unmounts the whole section
     * with the open dialogue inside it.
     */
    const host = openConfirmation("Keep Marriage");
    await submit(host);

    expect(dialogue(host).textContent).toContain("Merged");

    const merged = graph();
    merged.unions = merged.unions.filter((u) => u.id !== "u-inline");
    merged.childLinks = merged.childLinks.map((link) =>
      link.unionId === "u-inline" ? { ...link, unionId: "u-marriage" } : link,
    );

    act(() => {
      rerender(host, <UnionMerge graph={merged} personId="rose" />);
    });

    const text = dialogue(host).textContent ?? "";
    expect(text).toContain("nothing recorded on either of them was lost");
    // Not the race message. The merge it would be warning about is the one the
    // author just performed.
    expect(text).not.toContain("no longer both recorded");
  });

  it("does not send anything from the first stage", () => {
    const host = mount();
    click(buttonLabelled(host, "Merge duplicate families"));

    // Choosing a direction opens a confirmation; it does not merge anything.
    click(buttonLabelled(dialogue(host), "Keep Marriage"));
    expect(mergeUnionsAction).not.toHaveBeenCalled();
  });
});
