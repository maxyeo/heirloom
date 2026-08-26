// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { RecentChangesList } from "@/components/RecentChangesList";
import type { RecentChange } from "@/lib/recent-changes-feed";
import { render } from "@/test/render";

/**
 * What a feed row says, as markup.
 *
 * This component exists to be mountable — `app/recent-changes.tsx` is an
 * `async` Server Component and neither React nor Vitest can mount one
 * (docs/testing.md), so without the split none of E8-T4's acceptance criteria
 * would be checked anywhere a test can reach. What is asserted here is
 * therefore the criteria themselves: that a row says who changed what and
 * when, and that a person joining the tree is reported beside an entry being
 * edited.
 *
 * Not asserted here: ordering and limiting, which are
 * `lib/recent-changes-feed.test.ts`'s, and which sources a row comes from,
 * which is `lib/recent-changes.db.test.ts`'s. This file is handed the rows.
 */

const WHEN = new Date("2026-08-23T12:00:00.000Z");

const entry: RecentChange = {
  kind: "entry-changed",
  slug: "Rose Whitfield",
  title: "Rose Whitfield",
  when: WHEN,
  editor: "rose@example.com",
};

/**
 * A person with nobody to name — a row from before `individuals.created_by`
 * existed (`YEO-104`), which is what every person in every real database was
 * until that migration ran.
 */
const person: RecentChange = {
  kind: "person-added",
  personId: "00000000-0000-4000-8000-000000000001",
  name: "Agnes",
  when: WHEN,
};

/** The same row for somebody a signed-in member typed in. */
const attributedPerson: RecentChange = {
  ...person,
  personId: "00000000-0000-4000-8000-000000000003",
  name: "Thomas Whitfield",
  addedBy: "rose@example.com",
};

const imported: RecentChange = {
  kind: "people-imported",
  importId: "00000000-0000-4000-8000-000000000002",
  fileName: "whitfield.ged",
  personCount: 12,
  when: WHEN,
  importedBy: "walter@example.com",
};

describe("RecentChangesList", () => {
  it("says who changed an entry, and when", () => {
    const host = render(<RecentChangesList changes={[entry]} />);

    expect(host.textContent).toContain("Rose Whitfield");
    expect(host.textContent).toContain("edited by rose@example.com");
    expect(host.textContent).toContain("23 August 2026 at 12:00 UTC");
  });

  it("links an entry to itself, with the slug encoded", () => {
    const host = render(<RecentChangesList changes={[entry]} />);
    const link = host.querySelector("a");

    // The slug in the fixture holds a space, which is legal in a `text`
    // column and would otherwise truncate the href — `app/wiki/page.tsx`
    // makes the same argument for its own list.
    expect(link?.getAttribute("href")).toBe("/wiki/Rose%20Whitfield");
  });

  it("carries the exact instant in the time element", () => {
    const host = render(<RecentChangesList changes={[entry]} />);

    // The machine-readable half, beside the rounded string a reader sees.
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-23T12:00:00.000Z",
    );
  });

  it("says Unknown for an entry whose author was never recorded", () => {
    const host = render(
      <RecentChangesList changes={[{ ...entry, editor: null }]} />,
    );

    // `pages.updated_by` is nullable — seeded and hand-written rows have no
    // author — and a byline reading "edited by " would look like a bug.
    expect(host.textContent).toContain("edited by Unknown");
  });

  it("reports a person added to the tree, and links to them", () => {
    const host = render(<RecentChangesList changes={[person]} />);

    expect(host.textContent).toContain("Agnes");
    expect(host.textContent).toContain("added to the family tree");
    // Through `treeHref`, the same deep link a search result uses.
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/tree?person=00000000-0000-4000-8000-000000000001",
    );
  });

  it("names the member who added a person, when the row records one", () => {
    const host = render(<RecentChangesList changes={[attributedPerson]} />);

    // `YEO-104`: the criterion "shows who changed what and when", now met for
    // the source that could not meet it before.
    expect(host.textContent).toContain(
      "added to the family tree by rose@example.com",
    );
  });

  it("claims no author for a person, rather than an unknown one", () => {
    const host = render(<RecentChangesList changes={[person]} />);

    /*
      The point of `RecentChange`'s author being *optional* rather than
      nullable. This row records nobody — it predates `individuals.created_by`
      — so it must not say "Unknown", which reads as a name that went missing
      where the truth is a column that was never written. It must not trail a
      dangling "by" either. This is the assertion that would fail if somebody
      flattened the arm or reached for `formatChangeAuthor`.
    */
    expect(host.textContent).toContain("added to the family tree");
    expect(host.textContent).not.toContain("Unknown");
    expect(host.textContent).not.toContain(" by ");
  });

  it("reports an import as one line naming the file, the count and who ran it", () => {
    const host = render(<RecentChangesList changes={[imported]} />);

    // One row, not twelve — the whole reason this arm exists.
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(host.textContent).toContain("12 people imported from whitfield.ged");
    expect(host.textContent).toContain("imported by walter@example.com");
  });

  it("does not link an import, because there is no page for one", () => {
    const host = render(<RecentChangesList changes={[imported]} />);

    expect(host.querySelector("a")).toBeNull();
  });

  it("does not say 1 people", () => {
    const host = render(
      <RecentChangesList changes={[{ ...imported, personCount: 1 }]} />,
    );

    expect(host.textContent).toContain("1 person imported");
  });

  it("describes an import whose file arrived without a name", () => {
    const host = render(
      <RecentChangesList changes={[{ ...imported, fileName: null }]} />,
    );

    // `FormData.get()` only promises a `Blob`, and only a `File` carries a
    // name, so the sentence still has to finish.
    expect(host.textContent).toContain("imported from a GEDCOM file");
  });

  it("renders the three kinds together, one row each", () => {
    const host = render(
      <RecentChangesList changes={[entry, person, imported]} />,
    );

    // The acceptance criterion that the feed is not only entries.
    expect(host.querySelectorAll("li")).toHaveLength(3);
    expect(host.textContent).toContain("Rose Whitfield");
    expect(host.textContent).toContain("Agnes");
    expect(host.textContent).toContain("whitfield.ged");
  });

  it("keeps the list announced as a list", () => {
    const host = render(<RecentChangesList changes={[entry]} />);

    // Preflight strips the markers, and Safari/VoiceOver drop the implicit
    // list semantics with them. See `app/wiki/page.tsx`.
    expect(host.querySelector("ul")?.getAttribute("role")).toBe("list");
  });

  it("invites rather than reporting nothing on a fresh install", () => {
    const host = render(<RecentChangesList changes={[]} />);

    // The state every install starts in. The heading stays, so the section
    // does not vanish and reappear as the first entry is written.
    expect(host.querySelector("h2")?.textContent).toBe("Recently changed");
    expect(host.textContent).toContain("Nothing has been written yet");
    expect(host.querySelector("ul")).toBeNull();
  });
});
