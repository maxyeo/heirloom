// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import { UnionOrder } from "@/components/UnionOrder";
import type { SpouseLink } from "@/lib/person-detail";
import { formatMove, reorderInputFromFormData } from "@/lib/union-order";
import {
  failedUnionOrderState,
  idleUnionOrderState,
  type ReorderUnionsFormAction,
  type UnionOrderState,
} from "@/lib/union-order-state";
import { render, rerender } from "@/test/render";

/**
 * The sequence editor, mounted for the one thing no pure module can prove:
 * that pressing an arrow posts the order the server expects (E3-T7, `YEO-35`).
 *
 * The arithmetic is in `lib/union-order.ts` and asserted there with no
 * document. What is checked here is the *seam*, which has two halves that
 * could each silently invert:
 *
 * - the whole rendered order goes up, as one field per union, because
 *   `lib/reorder-unions.ts` compares it against the rows it reads and refuses
 *   the move if they disagree;
 * - the pressed button identifies itself, which is a browser behaviour
 *   (`name`/`value` are sent only for the submitter) that React has to
 *   reproduce for a form with a function action. If it did not, every press
 *   would post the same move — or none.
 *
 * Mountable at all only because the action arrives as a prop: importing
 * `reorderUnionsAction` would reach Auth.js and `@/db`, neither of which
 * `npm test` has an environment for (docs/testing.md).
 */

const PERSON = "00000000-0000-4000-8000-0000000000ff";

function unionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function spouse(
  overrides: Partial<SpouseLink> & { unionId: string },
): SpouseLink {
  return {
    person: null,
    type: "marriage",
    endReason: "ongoing",
    start: null,
    end: null,
    ...overrides,
  };
}

const THOMAS = spouse({
  unionId: unionId(1),
  person: { id: "thomas", name: "Thomas Hale", lifespan: "1880–1931" },
});

const WALTER = spouse({
  unionId: unionId(2),
  person: { id: "walter", name: "Walter Byrne", lifespan: "1884–1949" },
});

/**
 * Mount with an action that records what it was sent and answers with
 * `reply`. The recorded `FormData` is what most of these assertions are about.
 */
function mount(
  spouses: readonly SpouseLink[],
  options: { reply?: UnionOrderState } = {},
) {
  const submissions: FormData[] = [];
  const action: ReorderUnionsFormAction = async (_previous, form) => {
    submissions.push(form);
    return options.reply ?? idleUnionOrderState;
  };

  const host = render(
    <UnionOrder action={action} personId={PERSON} spouses={spouses} />,
  );

  return { host, submissions, action };
}

/** The arrow buttons, in document order: up and down for each union in turn. */
function buttons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll("button")];
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(host).find(
    (button) => button.getAttribute("aria-label") === label,
  );
  if (!found) {
    throw new Error(
      `No button labelled "${label}". Found: ${buttons(host)
        .map((button) => button.getAttribute("aria-label"))
        .join(", ")}`,
    );
  }
  return found;
}

/** Press a button and let the action settle. */
async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

describe("UnionOrder", () => {
  it("renders nothing for a person with one union", () => {
    // There is no order to state, and a lone disabled pair of arrows would be
    // noise on the panel of everybody who married once.
    const { host } = mount([THOMAS]);
    expect(host.textContent).toBe("");
  });

  it("renders nothing for a person with no unions", () => {
    const { host } = mount([]);
    expect(host.textContent).toBe("");
  });

  it("lists the unions in the order it was given", () => {
    const { host } = mount([WALTER, THOMAS]);
    const items = [...host.querySelectorAll("li")].map(
      (item) => item.textContent ?? "",
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Walter Byrne");
    expect(items[1]).toContain("Thomas Hale");
  });

  it("says so when a partner was never recorded", () => {
    // Both partner columns are nullable, and the panel says "Unknown partner"
    // rather than dropping the union. This has to be orderable too.
    const { host } = mount([THOMAS, spouse({ unionId: unionId(3) })]);
    expect(host.textContent).toContain("Unknown partner");
  });

  it("gives two unrecorded partners buttons a reader can tell apart", async () => {
    // The name cannot distinguish these rows, so the accessible name carries
    // the position too. Without it both pairs read "Move an unrecorded
    // partner earlier" and a screen-reader user cannot say which they pressed.
    const first = spouse({ unionId: unionId(4) });
    const second = spouse({ unionId: unionId(5) });
    const { host, submissions } = mount([first, second]);

    await press(
      findButton(host, "Move an unrecorded partner from position 2 earlier"),
    );

    expect(reorderInputFromFormData(submissions[0]).move).toBe(
      formatMove("up", second.unionId),
    );
  });

  it("posts the whole order and the button that was pressed", async () => {
    const { host, submissions } = mount([THOMAS, WALTER]);

    await press(findButton(host, "Move Walter Byrne from position 2 earlier"));

    expect(submissions).toHaveLength(1);
    expect(reorderInputFromFormData(submissions[0])).toEqual({
      personId: PERSON,
      // The order as rendered, *not* the order being asked for: the server
      // re-reads the rows and applies the move itself.
      order: [THOMAS.unionId, WALTER.unionId],
      move: formatMove("up", WALTER.unionId),
    });
  });

  it("distinguishes the two buttons on one row", async () => {
    // The failure this guards against is one shared hidden `move` field, which
    // would make every arrow on the panel do whatever the last one rendered.
    const { host, submissions } = mount([THOMAS, WALTER]);

    await press(findButton(host, "Move Thomas Hale from position 1 later"));

    expect(reorderInputFromFormData(submissions[0]).move).toBe(
      formatMove("down", THOMAS.unionId),
    );
  });

  it("does not offer a move that would run off either end", () => {
    const { host } = mount([THOMAS, WALTER]);

    expect(
      findButton(host, "Move Thomas Hale from position 1 earlier").disabled,
    ).toBe(true);
    expect(
      findButton(host, "Move Thomas Hale from position 1 later").disabled,
    ).toBe(false);
    expect(
      findButton(host, "Move Walter Byrne from position 2 earlier").disabled,
    ).toBe(false);
    expect(
      findButton(host, "Move Walter Byrne from position 2 later").disabled,
    ).toBe(true);
  });

  it("shows the new order when the revalidated graph arrives", async () => {
    // The ticket's "visible in the tree immediately". Nothing optimistic
    // happens here: the action revalidates `/tree`, a fresh graph reaches the
    // canvas, and this list re-renders from the new `spouses` prop.
    const { host, action } = mount([THOMAS, WALTER]);

    await press(findButton(host, "Move Walter Byrne from position 2 earlier"));

    rerender(
      host,
      <UnionOrder
        action={action}
        personId={PERSON}
        spouses={[WALTER, THOMAS]}
      />,
    );

    const items = [...host.querySelectorAll("li")].map(
      (item) => item.textContent ?? "",
    );
    expect(items[0]).toContain("Walter Byrne");
    expect(items[1]).toContain("Thomas Hale");
  });

  it("reports a refusal without moving anything on screen", async () => {
    const { host } = mount([THOMAS, WALTER], {
      reply: failedUnionOrderState("The unions have changed."),
    });

    await press(findButton(host, "Move Walter Byrne from position 2 earlier"));

    expect(host.querySelector("[role='alert']")?.textContent).toBe(
      "The unions have changed.",
    );
    const items = [...host.querySelectorAll("li")].map(
      (item) => item.textContent ?? "",
    );
    expect(items[0]).toContain("Thomas Hale");
  });
});
