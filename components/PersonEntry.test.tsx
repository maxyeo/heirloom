// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import { PersonEntry } from "@/components/PersonEntry";
import type { EntryLink } from "@/lib/entry-link";
import {
  type EntryLinkState,
  failedEntryLinkState,
  idleEntryLinkState,
  type PersonEntryActions,
} from "@/lib/entry-link-state";
import { render } from "@/test/render";

/**
 * The panel's entry control, mounted for the things no pure module can prove
 * (E2-T2, `YEO-25`).
 *
 * The lookups are in `lib/entry-link.ts` and asserted there with no document.
 * What is checked here is the *seam*: that a linked person gets an anchor
 * pointing at their entry rather than a form, that an unlinked one gets the
 * offer to write, and that each of the three forms posts the references its
 * action expects — a mistyped field name is invisible to the compiler and
 * fatal at runtime, since `app/tree/actions.ts` reads them out of `FormData`.
 *
 * Mountable at all only because the actions arrive as props: importing them
 * would reach Auth.js and `@/db`, neither of which `npm test` has an
 * environment for (docs/testing.md).
 */

const PERSON = "00000000-0000-4000-8000-0000000000ff";

const ROSE_ENTRY: EntryLink = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "rose-hale",
  title: "Rose Hale",
};

const THOMAS_ENTRY: EntryLink = {
  id: "00000000-0000-4000-8000-000000000002",
  slug: "thomas-hale",
  title: "Thomas Hale",
};

type Submission = { door: keyof PersonEntryActions; form: FormData };

/**
 * Mount with three actions that record which door they were sent through and
 * what they were given, and answer with `reply`.
 */
function mount(
  options: {
    entry?: EntryLink | null;
    entries?: readonly EntryLink[];
    reply?: EntryLinkState;
    withActions?: boolean;
  } = {},
) {
  const submissions: Submission[] = [];

  const door =
    (name: keyof PersonEntryActions) =>
    async (_previous: EntryLinkState, form: FormData) => {
      submissions.push({ door: name, form });
      return options.reply ?? idleEntryLinkState;
    };

  const actions: PersonEntryActions = {
    create: door("create"),
    link: door("link"),
    unlink: door("unlink"),
  };

  const host = render(
    <PersonEntry
      personId={PERSON}
      personName="Rose Hale"
      entry={options.entry ?? null}
      options={options.entries ?? []}
      actions={options.withActions === false ? undefined : actions}
    />,
  );

  return { host, submissions };
}

function buttonReading(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button reading "${text}"`);
  return found;
}

function selectOption(host: HTMLElement, value: string): void {
  const control = host.querySelector("select");
  if (!control) throw new Error("no select");
  act(() => {
    // React tracks the last value it wrote to the node, so going through the
    // prototype setter is what makes the change visible to it.
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

describe("PersonEntry", () => {
  describe("when the person has an entry", () => {
    it("links to it by slug", () => {
      const { host } = mount({ entry: ROSE_ENTRY });
      const link = host.querySelector("a");

      expect(link?.getAttribute("href")).toBe("/wiki/rose-hale");
      expect(link?.textContent).toBe("Rose Hale");
    });

    it("escapes an address that needs it", () => {
      // A title in a non-Latin script produces a non-Latin slug; see
      // `lib/entry-slug.ts`. The href has to remain a valid URL.
      const { host } = mount({
        entry: { ...ROSE_ENTRY, slug: "розa-хейл" },
      });

      expect(host.querySelector("a")?.getAttribute("href")).toBe(
        `/wiki/${encodeURIComponent("розa-хейл")}`,
      );
    });

    it("does not offer to write another one", () => {
      const { host } = mount({ entry: ROSE_ENTRY, entries: [THOMAS_ENTRY] });

      expect(host.textContent).not.toContain("Write about this person");
      expect(host.querySelector("select")).toBeNull();
    });

    it("unlinks by posting the person, and says the entry is kept", async () => {
      const { host, submissions } = mount({ entry: ROSE_ENTRY });

      expect(host.textContent).toContain("The entry itself is kept");
      await press(buttonReading(host, "Unlink"));

      expect(submissions).toHaveLength(1);
      expect(submissions[0].door).toBe("unlink");
      expect(submissions[0].form.get("personId")).toBe(PERSON);
    });
  });

  describe("when the person has no entry", () => {
    it("says so, naming them", () => {
      // An omitted section would read as "this panel does not show entries";
      // what is true is that nobody has written one.
      const { host } = mount();
      expect(host.textContent).toContain("No entry yet for Rose Hale.");
    });

    it("starts one by posting only the person", async () => {
      // The title is not a field: `createEntryForPerson` reads the name off
      // the row, so a direct POST cannot choose what the entry is called.
      const { host, submissions } = mount();

      await press(buttonReading(host, "Write about this person"));

      expect(submissions).toHaveLength(1);
      expect(submissions[0].door).toBe("create");
      expect([...submissions[0].form.keys()]).toEqual(["personId"]);
      expect(submissions[0].form.get("personId")).toBe(PERSON);
    });

    it("offers no picker when every entry is taken", () => {
      // `unlinkedEntries` has already filtered the list; an empty one means
      // there is nothing to point at, and a select of nothing is noise.
      const { host } = mount({ entries: [] });
      expect(host.querySelector("select")).toBeNull();
    });

    it("links an existing entry by posting both references", async () => {
      const { host, submissions } = mount({
        entries: [ROSE_ENTRY, THOMAS_ENTRY],
      });

      selectOption(host, THOMAS_ENTRY.id);
      await press(buttonReading(host, "Link this entry"));

      expect(submissions).toHaveLength(1);
      expect(submissions[0].door).toBe("link");
      expect(submissions[0].form.get("personId")).toBe(PERSON);
      expect(submissions[0].form.get("pageId")).toBe(THOMAS_ENTRY.id);
    });

    it("keeps the chosen entry selected after a refusal", async () => {
      /**
       * React resets a form with an action on every submission, before the
       * action runs — and a reset reverts a `<select>` to its first option,
       * which here is the empty prompt. `FormSelect` is what keeps the DOM
       * default in step; without it the author reads why their choice was
       * refused while the control quietly forgets it.
       */
      const { host } = mount({
        entries: [ROSE_ENTRY, THOMAS_ENTRY],
        reply: failedEntryLinkState("That entry is already about Thomas Hale."),
      });

      selectOption(host, THOMAS_ENTRY.id);
      await press(buttonReading(host, "Link this entry"));

      expect(host.querySelector("select")?.value).toBe(THOMAS_ENTRY.id);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "already about Thomas Hale",
      );
    });
  });

  it("shows the entry but no controls when it is given no actions", () => {
    // A read-only canvas — which is what `npm test` mounts — still has to
    // show the link. That is the read half of this ticket.
    const { host } = mount({
      entry: ROSE_ENTRY,
      entries: [THOMAS_ENTRY],
      withActions: false,
    });

    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/wiki/rose-hale",
    );
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("form")).toBeNull();
  });
});
