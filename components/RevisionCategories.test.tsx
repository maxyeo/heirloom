// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { RevisionCategories } from "@/components/RevisionCategories";
import { render } from "@/test/render";

/**
 * The bar at the foot of an old revision (`YEO-106`).
 *
 * Mounted rather than asserted as a value, for the reason
 * `ArticleCategories.test.tsx` gives for its own sibling: the two decisions
 * worth holding in place here are "renders nothing rather than an empty box"
 * and "renders no links", and neither is a question a returned value answers.
 * The second is the whole reason this component exists apart from the article
 * bar — a category named by a revision may have been retired since, so its
 * address is not one that can be trusted to answer.
 */

const THREE = ["Born in Kilkenny", "Emigrated to Canada", "Whitfield family"];

describe("a revision filed under nothing", () => {
  it("renders no bar at all — not an empty one", () => {
    const host = render(<RevisionCategories categories={[]} />);

    // `innerHTML` rather than a query for the element: an empty `<nav>` would
    // satisfy "there are no names" while still putting a bordered strip at the
    // foot of every revision of every uncategorised entry, which is most of
    // them.
    expect(host.innerHTML).toBe("");
  });
});

describe("a revision with a filing", () => {
  it("names every category it was filed under, in the order given", () => {
    const host = render(<RevisionCategories categories={THREE} />);

    expect(
      [...host.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual([
      "Born in Kilkenny",
      " | Emigrated to Canada",
      " | Whitfield family",
    ]);
  });

  it("renders no links, because a retired category has no page", () => {
    const host = render(<RevisionCategories categories={THREE} />);

    // The decision this component exists for. `revisions.categories` holds
    // names, not ids, precisely so that retiring a category cannot rewrite
    // history — and the price of that is that a name here may address nothing.
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });

  it("says when the filing was, not just what it was", () => {
    const host = render(<RevisionCategories categories={THREE} />);
    const nav = host.querySelector("nav");

    // The label is the landmark's accessible name, and on a page whose entire
    // subject is "this is not the current version" it has to carry the tense.
    expect(nav?.textContent).toContain("Categories at this revision:");
  });

  it("uses the singular for one category", () => {
    const host = render(
      <RevisionCategories categories={["Whitfield family"]} />,
    );

    expect(host.textContent).toContain("Category at this revision:");
    expect(host.textContent).not.toContain("Categories at this revision:");
  });

  it("labels the landmark, so it is not a second unnamed navigation region", () => {
    const host = render(<RevisionCategories categories={THREE} />);
    const nav = host.querySelector("nav");
    const label = nav?.getAttribute("aria-labelledby");

    expect(label).toBe("revision-categories-label");
    expect(host.querySelector(`#${label}`)).not.toBeNull();
  });
});
