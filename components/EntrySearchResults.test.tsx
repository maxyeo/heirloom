// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { EntrySearchResults } from "@/components/EntrySearchResults";
import type { EntryMatch } from "@/lib/entry-search";
import { render } from "@/test/render";

/**
 * Only what needs a document. `app/search/page.tsx` is an `async` Server
 * Component and cannot be mounted at all, which is this component's reason
 * for existing separately — see its own docblock. What matters here is that
 * the matched term arrives as an element a reader and a screen reader can
 * both tell apart from the text around it, which is the last of E8-T1's
 * acceptance criteria; which entries match, and what their snippets say, is
 * `lib/pages.db.test.ts`'s.
 */

function match(overrides: Partial<EntryMatch> & { id: string }): EntryMatch {
  return {
    slug: overrides.id,
    title: "An entry",
    href: `/wiki/${overrides.id}`,
    snippet: [],
    ...overrides,
  };
}

describe("EntrySearchResults", () => {
  it("shows the matched term in context, marked", () => {
    const host = render(
      <EntrySearchResults
        matches={[
          match({
            id: "rose-hall",
            title: "Rose Hall",
            snippet: [
              { text: "Rose and Walter ", matched: false },
              { text: "married", matched: true },
              { text: " in 1902", matched: false },
            ],
          }),
        ]}
      />,
    );

    // The context, unbroken: the snippet reads as one sentence, not as three
    // fragments with the highlight punched out of it.
    expect(host.textContent).toContain("Rose and Walter married in 1902");

    const marks = [...host.querySelectorAll("mark")];
    expect(marks.map((element) => element.textContent)).toEqual(["married"]);
  });

  it("marks each occurrence separately", () => {
    const host = render(
      <EntrySearchResults
        matches={[
          match({
            id: "fox",
            snippet: [
              { text: "the ", matched: false },
              { text: "fox", matched: true },
              { text: " ran … caught the ", matched: false },
              { text: "fox", matched: true },
            ],
          }),
        ]}
      />,
    );

    expect(host.querySelectorAll("mark")).toHaveLength(2);
  });

  it("renders no snippet line for an entry with an empty body", () => {
    const host = render(
      <EntrySearchResults
        matches={[match({ id: "empty", title: "Empty", snippet: [] })]}
      />,
    );

    // Not a blank line under the title — nothing at all.
    expect(host.querySelector("p")).toBeNull();
    expect(host.textContent?.trim()).toBe("Empty");
  });

  it("links every result to its entry", () => {
    const host = render(
      <EntrySearchResults
        matches={[
          match({ id: "rose-hall", href: "/wiki/rose-hall" }),
          match({ id: "the-farm", href: "/wiki/the-farm" }),
        ]}
      />,
    );

    const hrefs = [...host.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/wiki/rose-hall", "/wiki/the-farm"]);
  });

  it("renders results in the order it was given them", () => {
    const host = render(
      <EntrySearchResults
        matches={[
          match({ id: "b", title: "Ranked first" }),
          match({ id: "a", title: "Ranked second" }),
        ]}
      />,
    );

    // The component must not re-sort what `ts_rank` ordered.
    const titles = [...host.querySelectorAll("li")].map(
      (item) => item.querySelector("a")?.textContent,
    );
    expect(titles).toEqual(["Ranked first", "Ranked second"]);
  });

  it("renders a list a screen reader can announce as one", () => {
    const host = render(<EntrySearchResults matches={[match({ id: "a" })]} />);
    expect(host.querySelector('[role="list"]')).not.toBeNull();
  });

  it("renders nothing at all for no matches", () => {
    const host = render(<EntrySearchResults matches={[]} />);
    expect(host.querySelectorAll("li")).toHaveLength(0);
  });
});
