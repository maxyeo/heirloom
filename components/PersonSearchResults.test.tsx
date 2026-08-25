// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { PersonSearchResults } from "@/components/PersonSearchResults";
import type { PersonMatch } from "@/lib/people-search";
import { render } from "@/test/render";

/**
 * Only what needs a document: `app/search/page.tsx` is an `async` Server
 * Component and cannot be mounted at all, which is this component's entire
 * reason for existing separately — see its own docblock. What is worth
 * asserting here is rendering, not ranking: `lib/people-search.test.ts`
 * already owns which matches come back and in what order.
 */

function match(overrides: Partial<PersonMatch> & { id: string }): PersonMatch {
  return {
    name: "Someone",
    lifespan: "",
    href: `/tree?person=${overrides.id}`,
    ...overrides,
  };
}

describe("PersonSearchResults", () => {
  it("renders the lifespan beside a result that has one", () => {
    const host = render(
      <PersonSearchResults
        matches={[
          match({ id: "rose", name: "Rose Hale", lifespan: "1910–1994" }),
        ]}
      />,
    );

    expect(host.textContent).toContain("Rose Hale");
    expect(host.textContent).toContain("1910–1994");
  });

  it("renders no empty parenthetical for a person with no dates", () => {
    const host = render(
      <PersonSearchResults
        matches={[match({ id: "walter", name: "Walter", lifespan: "" })]}
      />,
    );

    // Not "()" and not a dash — nothing at all, per `formatLifespan`'s own
    // rule about an unrecorded date.
    expect(host.textContent).not.toContain("(");
    expect(host.textContent?.trim()).toBe("Walter");
  });

  it("links every result to its E2-T4 deep link", () => {
    const host = render(
      <PersonSearchResults
        matches={[
          match({ id: "rose", href: "/tree?person=rose" }),
          match({ id: "walter", href: "/tree?person=walter" }),
        ]}
      />,
    );

    const hrefs = [...host.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/tree?person=rose", "/tree?person=walter"]);
  });

  it("renders a list a screen reader can announce as one", () => {
    const host = render(<PersonSearchResults matches={[match({ id: "a" })]} />);
    expect(host.querySelector('[role="list"]')).not.toBeNull();
  });

  it("renders nothing at all for no matches", () => {
    const host = render(<PersonSearchResults matches={[]} />);
    expect(host.querySelectorAll("li")).toHaveLength(0);
  });
});
