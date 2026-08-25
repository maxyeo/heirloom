// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { PersonPanel } from "@/components/PersonPanel";
import type { PersonDetail } from "@/lib/person-detail";
import { render, rerender, unmount } from "@/test/render";

/**
 * The second file in the project to need a DOM, and it needs one for the same
 * narrow reason the first did: what is being checked here cannot be checked
 * without mounting.
 *
 * Everything the panel *decides* — who counts as a spouse, which union a child
 * came through, how a qualified date reads — is decided in
 * `lib/person-detail.ts` and asserted in plain Node next to it. What is left is
 * behaviour that only exists once there is a document: Escape closing the
 * panel, focus landing somewhere a keyboard can use, and a relative's link
 * actually calling back with an id. See docs/testing.md, "prefer no DOM".
 */

function detail(overrides: Partial<PersonDetail> = {}): PersonDetail {
  return {
    id: "rose",
    name: "Rose Hale",
    lifespan: "1910–1994",
    sex: "female",
    birth: { date: "5 May 1910", place: "Cork" },
    death: null,
    notes: null,
    pageId: null,
    spouses: [],
    children: [],
    parents: [],
    ...overrides,
  };
}

function summary(id: string, name: string, lifespan = "") {
  return { id, name, lifespan };
}

function buttonLabelled(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}

const noop = () => {};

describe("what the panel shows", () => {
  it("puts the name, the lifespan and the recorded events on the page", () => {
    const host = render(
      <PersonPanel
        detail={detail({
          death: { date: "about 2 August 1994", place: null },
          notes: "Kept the family bible.",
        })}
        onSelectPerson={noop}
        onClose={noop}
      />,
    );

    const text = host.textContent ?? "";
    expect(text).toContain("Rose Hale");
    expect(text).toContain("1910–1994");
    expect(text).toContain("5 May 1910");
    expect(text).toContain("Cork");
    // The qualifier is the reason the columns exist; it has to reach the page.
    expect(text).toContain("about 2 August 1994");
    expect(text).toContain("Kept the family bible.");
  });

  /**
   * Both sides of the one branch this panel takes on a person's `sex`
   * (`YEO-85`).
   *
   * `unknown` is the column default, and it is the value that *hides* the row
   * — so a fixture carrying anything else, which is all this file had, only
   * ever renders the half that shows. Nothing asserted the row at all, in
   * either direction, which left "an unrecorded sex is omitted rather than
   * printed as the word unknown" as a claim the code made and no test read
   * back. Printing it would be the same category of error as an invented
   * birthday: stating a fact from the absence of one.
   */
  it("shows a recorded sex and omits an unrecorded one", () => {
    const shown = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );
    expect(shown.textContent).toContain("Sex");
    expect(shown.textContent).toContain("female");

    const hidden = render(
      <PersonPanel
        detail={detail({ sex: "unknown" })}
        onSelectPerson={noop}
        onClose={noop}
      />,
    );
    expect(hidden.textContent).not.toContain("Sex");
    expect(hidden.textContent).not.toContain("unknown");
  });

  it("says that a relation is unrecorded rather than hiding the heading", () => {
    // The two mean different things in genealogy, and the difference is the
    // whole point: an absent section reads as "this panel does not show
    // children", where what is true is "nobody has entered any".
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );

    expect(host.textContent).toContain("Children");
    expect(host.querySelectorAll("h3")).toHaveLength(3);
    expect(
      [...host.querySelectorAll("p")].filter((p) =>
        p.textContent?.includes("None recorded"),
      ),
    ).toHaveLength(3);
  });

  it("names the co-parent beside each child", () => {
    const host = render(
      <PersonPanel
        detail={detail({
          children: [
            {
              person: summary("brian", "Brian Hale", "1934–"),
              relation: "biological",
              unionId: "u2",
              otherParent: summary("thomas", "Thomas Hale"),
            },
            {
              person: summary("dora", "Dora Hale"),
              relation: "adopted",
              unionId: "u3",
              otherParent: null,
            },
          ],
        })}
        onSelectPerson={noop}
        onClose={noop}
      />,
    );

    // Half-siblings are only legible if the union each child came through is
    // on the page — two by Thomas and one by Walter is a different family
    // from three children.
    expect(host.textContent).toContain("with Thomas Hale");
    expect(host.textContent).toContain("other parent unknown");
    // Adoption is recorded on the child↔union link, so it is shown, not
    // smoothed over.
    expect(host.textContent).toContain("(adopted)");
  });

  it("keeps a union whose other partner nobody recorded", () => {
    const host = render(
      <PersonPanel
        detail={detail({
          spouses: [
            {
              unionId: "u2",
              person: null,
              type: "marriage",
              endReason: "death",
              start: "1932",
              end: null,
            },
          ],
        })}
        onSelectPerson={noop}
        onClose={noop}
      />,
    );

    expect(host.textContent).toContain("Unknown partner");
    expect(host.textContent).toContain("Married, 1932, ended by death");
  });

  it("renders notes as text, never as markup", () => {
    // `individuals.notes` is a plain `text` column that no editor and no
    // sanitiser has ever been near. Treating it like a wiki body would make
    // it the one place in the app where unsanitised markup reaches the
    // browser — see the "Entry HTML" section of docs/architecture.md.
    const host = render(
      <PersonPanel
        detail={detail({ notes: "<img src=x onerror=alert(1)>" })}
        onSelectPerson={noop}
        onClose={noop}
      />,
    );

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("navigating to a relative", () => {
  it("calls back with the person's id", () => {
    const onSelectPerson = vi.fn();
    const host = render(
      <PersonPanel
        detail={detail({
          parents: [
            {
              person: summary("thomas", "Thomas Hale", "1898–1947"),
              relation: "biological",
              unionId: "u0",
            },
          ],
        })}
        onSelectPerson={onSelectPerson}
        onClose={noop}
      />,
    );

    act(() => {
      buttonLabelled(host, "Thomas Hale").click();
    });

    expect(onSelectPerson).toHaveBeenCalledWith("thomas");
  });
});

describe("dismissal", () => {
  it("closes on Escape from anywhere on the page", () => {
    // The listener is on the document rather than on the panel because focus
    // may still be on the node that opened it.
    const onClose = vi.fn();
    render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={onClose} />,
    );

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={onClose} />,
    );

    act(() => {
      buttonLabelled(host, "Close").click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops listening once it is gone", () => {
    // A leaked document listener would keep firing `onClose` against a panel
    // nobody can see, and the canvas would keep stealing focus back to a node.
    const onClose = vi.fn();
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={onClose} />,
    );
    unmount(host);

    pressEscape();

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("focus", () => {
  it("moves focus into the panel when it opens", () => {
    // Without this a keyboard user selects a node and is left with focus on
    // the canvas behind a panel they cannot tab into — and "focus returns to
    // the node on close" would be describing something that never left.
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );

    expect(host.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain("Rose Hale");
  });

  it("follows the panel when it swaps to a different person", () => {
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });

    // A prop change rather than a remount: following a link inside the panel
    // swaps who it is about while the same panel stays on screen, and focus
    // has to follow or the reader is left announcing the previous person.
    rerender(
      host,
      <PersonPanel
        detail={detail({ id: "walter", name: "Walter Hale" })}
        onSelectPerson={noop}
        onClose={noop}
      />,
    );

    expect(document.activeElement?.textContent).toContain("Walter Hale");
  });

  it("hands focus back to whatever opened it", () => {
    /*
      The canvas is the only thing that knows which node that is, so the panel
      takes a getter rather than finding one (`YEO-83`). Asserted on the
      *unmount* rather than on a close handler because that is the one event
      every exit has in common — Escape, the close button, a click on the empty
      canvas, and a person deleted out from under an open panel.
    */
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    const host = render(
      <PersonPanel
        detail={detail()}
        onSelectPerson={noop}
        onClose={noop}
        returnFocus={() => opener}
      />,
    );

    unmount(host);

    expect(document.activeElement).toBe(opener);
  });

  it("labels itself with whose record it is", () => {
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );

    expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe(
      "Details for Rose Hale",
    );
  });
});

/**
 * The panel's one route *out* into an editing flow (E3-T4, `YEO-32`).
 *
 * The panel is otherwise read-only by design, and stays that way: it renders a
 * button when the canvas gives it a callback and knows nothing about what
 * opening it means. Both halves are worth asserting — an optional prop whose
 * absent case was never checked is how a read-only surface quietly grows an
 * edit control nobody meant to ship.
 */
describe("starting the add-spouse flow", () => {
  it("offers nothing when no callback was given", () => {
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );

    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Add a spouse"),
      ),
    ).toBe(false);
  });

  it("calls back when the button is pressed", () => {
    const onAddSpouse = vi.fn();
    const host = render(
      <PersonPanel
        detail={detail()}
        onSelectPerson={noop}
        onClose={noop}
        onAddSpouse={onAddSpouse}
      />,
    );

    act(() => buttonLabelled(host, "Add a spouse").click());

    expect(onAddSpouse).toHaveBeenCalledTimes(1);
  });

  /**
   * Remarriage is the ordinary case this data model exists for, so the offer
   * cannot be conditional on there being no spouse yet.
   */
  it("is offered to somebody who already has a spouse", () => {
    const host = render(
      <PersonPanel
        detail={detail({
          spouses: [
            {
              unionId: "u1",
              person: summary("thomas", "Thomas Hale"),
              type: "marriage",
              endReason: "death",
              start: null,
              end: null,
            },
          ],
        })}
        onSelectPerson={noop}
        onClose={noop}
        onAddSpouse={noop}
      />,
    );

    expect(buttonLabelled(host, "Add a spouse")).toBeTruthy();
  });
});

/**
 * The panel's second route out into an editing flow (E3-T5, `YEO-33`), and the
 * same two halves are worth asserting for the same reason: an optional prop
 * whose absent case was never checked is how a read-only surface quietly grows
 * an edit control nobody meant to ship.
 */
describe("starting the add-child flow", () => {
  it("offers nothing when no callback was given", () => {
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );

    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Add a child"),
      ),
    ).toBe(false);
  });

  it("calls back when the button is pressed", () => {
    const onAddChild = vi.fn();
    const host = render(
      <PersonPanel
        detail={detail()}
        onSelectPerson={noop}
        onClose={noop}
        onAddChild={onAddChild}
      />,
    );

    act(() => buttonLabelled(host, "Add a child").click());

    expect(onAddChild).toHaveBeenCalledTimes(1);
  });

  /**
   * Which family a child belongs to is the add-child form's question, not this
   * panel's — so the offer cannot be conditional on a union already existing.
   * Hiding it until then would leave the author guessing why it was missing.
   */
  it("is offered to somebody with no union recorded yet", () => {
    const host = render(
      <PersonPanel
        detail={detail({ spouses: [] })}
        onSelectPerson={noop}
        onClose={noop}
        onAddChild={noop}
      />,
    );

    expect(buttonLabelled(host, "Add a child")).toBeTruthy();
  });
});

/**
 * The panel's third route out into an editing flow (E3-T6, `YEO-34`), and the
 * one that reads differently depending on what is already recorded: naming a
 * family for the first time and correcting the one somebody is in are the same
 * flow, but "Set parents" beside two names already on screen would read as
 * though it replaced them.
 */
describe("starting the set-parents flow", () => {
  it("offers nothing when no callback was given", () => {
    const host = render(
      <PersonPanel detail={detail()} onSelectPerson={noop} onClose={noop} />,
    );

    expect(
      [...host.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Set parents"),
      ),
    ).toBe(false);
  });

  it("calls back when the button is pressed", () => {
    const onSetParents = vi.fn();
    const host = render(
      <PersonPanel
        detail={detail()}
        onSelectPerson={noop}
        onClose={noop}
        onSetParents={onSetParents}
      />,
    );

    act(() => buttonLabelled(host, "Set parents").click());

    expect(onSetParents).toHaveBeenCalledTimes(1);
  });

  it("asks to change the family when parents are already recorded", () => {
    const host = render(
      <PersonPanel
        detail={detail({
          parents: [
            {
              person: summary("thomas", "Thomas Hale", "1898–1947"),
              relation: "biological",
              unionId: "u0",
            },
          ],
        })}
        onSelectPerson={noop}
        onClose={noop}
        onSetParents={noop}
      />,
    );

    expect(buttonLabelled(host, "Change which family")).toBeTruthy();
  });
});
