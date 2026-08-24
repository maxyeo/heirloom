// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { ArticleHeading } from "@/components/ArticleHeading";
import { render } from "@/test/render";

describe("ArticleHeading", () => {
  it("puts the tagline under the title", () => {
    const host = render(<ArticleHeading title="Rose Bennett" />);

    expect(host.querySelector("h1")?.textContent).toBe("Rose Bennett");
    expect(host.querySelector("p")?.textContent).toBe(
      "From Heirloom, the family wiki",
    );
  });

  it("moves the rule from the title to the pair", () => {
    // globals.css rules every h1, which is right for a heading standing alone
    // and wrong here: on a Wikipedia page the line is under the title *and*
    // its provenance, not between them. Getting this wrong is invisible in a
    // diff and obvious on the page.
    const host = render(<ArticleHeading title="Rose Bennett" />);

    expect(host.querySelector("h1")?.className).toContain("border-b-0");
    expect(host.querySelector("p")?.className).toContain("border-b");
  });

  it("takes a tagline of its own where the page is not an article", () => {
    const host = render(
      <ArticleHeading
        title="Editing Rose Bennett"
        tagline="Nothing is lost."
      />,
    );

    expect(host.querySelector("p")?.textContent).toBe("Nothing is lost.");
  });
});
