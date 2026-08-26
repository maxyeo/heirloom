// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { ArticleCategories } from "@/components/ArticleCategories";
import type { NamedCategory } from "@/lib/category-name";
import { render } from "@/test/render";

/**
 * The bar at the foot of an article (E11-T8, `YEO-78`).
 *
 * Two of the ticket's acceptance criteria are about what this renders, and
 * both are statements about a document rather than about a value — "an entry
 * with no categories shows no bar" in particular cannot be checked any other
 * way, since the difference between an empty box and no box is exactly the
 * thing a returned value would not distinguish. So this is mounted, and
 * everything it does *not* decide (the order, the names) is asserted next to
 * `lib/category-name.ts`. See docs/testing.md, "prefer no DOM".
 */

const THREE: NamedCategory[] = [
  { name: "Born in Kilkenny", slug: "born-in-kilkenny" },
  { name: "Emigrated to Canada", slug: "emigrated-to-canada" },
  { name: "Whitfield family", slug: "whitfield-family" },
];

function links(host: HTMLElement) {
  return [...host.querySelectorAll("a")];
}

describe("an entry with no categories", () => {
  it("renders no bar at all — not an empty one", () => {
    const host = render(<ArticleCategories categories={[]} />);

    /**
     * The acceptance criterion, and the reason it is `innerHTML` rather than a
     * query for the element: an empty `<nav>` would satisfy "there are no
     * links" while still putting a bordered strip and its top margin at the
     * foot of every uncategorised entry, which is most of them.
     */
    expect(host.innerHTML).toBe("");
  });
});

describe("an entry with categories", () => {
  it("reads the way Wikipedia's does", () => {
    const host = render(<ArticleCategories categories={THREE} />);

    // The shape the ticket asks for, pipes and all — asserted on the whole
    // string rather than on its parts, because the separators and the spacing
    // around them are the thing that makes it read as Wikipedia's bar.
    expect(host.textContent).toBe(
      "Categories: Born in Kilkenny | Emigrated to Canada | Whitfield family",
    );
  });

  it("links each one to its listing page", () => {
    const host = render(<ArticleCategories categories={THREE} />);

    expect(links(host).map((link) => link.getAttribute("href"))).toEqual([
      "/wiki/category/born-in-kilkenny",
      "/wiki/category/emigrated-to-canada",
      "/wiki/category/whitfield-family",
    ]);
  });

  it("encodes a slug that holds something a URL would read as punctuation", () => {
    // The column is `text`; nothing in the schema stops a slug holding a `#`,
    // and interpolating one raw would turn the rest of the href into a
    // fragment.
    const host = render(
      <ArticleCategories categories={[{ name: "Odd", slug: "a#b c" }]} />,
    );

    expect(links(host)[0].getAttribute("href")).toBe(
      "/wiki/category/a%23b%20c",
    );
  });

  it("says Category, singular, for one", () => {
    const host = render(<ArticleCategories categories={[THREE[0]]} />);

    expect(host.textContent).toBe("Category: Born in Kilkenny");
  });

  it("is a labelled landmark holding a list", () => {
    /**
     * Both halves matter to a reader who is not looking at it. The landmark is
     * what makes the bar reachable by name rather than as a second unlabelled
     * navigation region beside the sidebar's; the list is what makes it "three
     * items" rather than a run of links with pipes read out between them.
     */
    const host = render(<ArticleCategories categories={THREE} />);

    const nav = host.querySelector("nav");
    expect(nav).not.toBeNull();

    const labelId = nav?.getAttribute("aria-labelledby");
    expect(host.querySelector(`#${labelId}`)?.textContent).toContain(
      "Categories",
    );

    expect(host.querySelectorAll("li")).toHaveLength(3);
    // The separators are decoration, and are hidden rather than read out.
    for (const separator of host.querySelectorAll('[aria-hidden="true"]')) {
      expect(separator.textContent).toBe(" | ");
    }
  });

  it("clears the floated infobox rather than wrapping around it", () => {
    /**
     * The article's own clearfix is an `::after` pseudo-element, which comes
     * after this bar in the box order — so on a short entry about a person
     * with a long family, a bar without this class renders beside the
     * still-floating infobox instead of beneath it.
     */
    const host = render(<ArticleCategories categories={THREE} />);

    expect(host.querySelector("nav")?.className).toContain("clear-both");
  });
});
