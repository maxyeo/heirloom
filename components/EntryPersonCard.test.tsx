// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { EntryPersonCard } from "@/components/EntryPersonCard";
import type { EntryPerson } from "@/lib/entry-person";
import { render } from "@/test/render";

/**
 * The header card an entry about a person carries (E2-T3, `YEO-26`).
 *
 * jsdom rather than a plain module, because what is worth asserting here is
 * genuinely about the rendered card: that an unlinked entry produces *no*
 * element at all, that the deep link is the one E2-T4 built, and that the
 * dates on it say only as much as the source did. The formatters themselves
 * are already covered without a document in `lib/person-format.test.ts`; what
 * these check is that this component calls them with the right arguments,
 * which is where the invented-day bug lives.
 *
 * `EntryPerson` is imported with `import type` for the reason
 * docs/testing.md gives: `lib/entry-person.ts` reaches `@/db`, and `npm test`
 * runs with no `DATABASE_URL`. The type erases; the module is never loaded.
 */

/**
 * A fully recorded person, spread and overridden per test.
 *
 * `precision: "day"` here matches every other fixture in the suite — which is
 * exactly why the precision cases below override it explicitly rather than
 * relying on this default to exercise them.
 */
const ROSE: EntryPerson = {
  id: "00000000-0000-4000-8000-0000e2530001",
  givenName: "Rose",
  surname: "Hale",
  birthDate: "1899-03-12",
  birthDateQualifier: "exact",
  birthDatePrecision: "day",
  birthPlace: "Kentish Town, London",
  deathDate: "1960-08-04",
  deathDateQualifier: "exact",
  deathDatePrecision: "day",
  deathPlace: "Hastings, Sussex",
};

describe("EntryPersonCard", () => {
  it("names the person, their lifespan and both places", () => {
    const host = render(<EntryPersonCard person={ROSE} />);
    const card = host.querySelector("aside");

    expect(card?.getAttribute("aria-label")).toBe("Tree record for Rose Hale");
    expect(card?.textContent).toContain("Rose Hale");
    expect(card?.textContent).toContain("1899–1960");
    expect(card?.textContent).toContain("12 March 1899, Kentish Town, London");
    expect(card?.textContent).toContain("4 August 1960, Hastings, Sussex");
  });

  it("deep-links the person on the tree, the way E2-T4 spells it", () => {
    const host = render(<EntryPersonCard person={ROSE} />);
    const link = host.querySelector("a");

    expect(link?.textContent).toBe("View in tree");
    expect(link?.getAttribute("href")).toBe(`/tree?person=${ROSE.id}`);
  });

  it("renders nothing at all for an entry with no linked person", () => {
    // The acceptance criterion in its own words: an entry about a place or an
    // heirloom must read exactly as it did before this ticket. An empty
    // bordered box above the article is worse than no card, and it is what a
    // component that returned a shell for a null person would produce.
    expect(render(<EntryPersonCard person={null} />).innerHTML).toBe("");
    expect(render(<EntryPersonCard person={undefined} />).innerHTML).toBe("");
  });

  it("does not invent a day the source never recorded", () => {
    // The bug this guards is a call that omits `precision`: it defaults to
    // `day`, and the anchor date a year-only record stores then renders as
    // "1 January 1890" — a fact nobody entered, stated as though they had.
    const host = render(
      <EntryPersonCard
        person={{
          ...ROSE,
          birthDate: "1890-01-01",
          birthDateQualifier: "about",
          birthDatePrecision: "year",
        }}
      />,
    );

    expect(host.textContent).toContain("about 1890");
    expect(host.textContent).not.toContain("1 January 1890");
  });

  it("does not invent a day from a month-precision record either", () => {
    const host = render(
      <EntryPersonCard
        person={{
          ...ROSE,
          deathDate: "1960-08-01",
          deathDatePrecision: "month",
        }}
      />,
    );

    expect(host.textContent).toContain("August 1960");
    expect(host.textContent).not.toContain("1 August 1960");
  });

  it("keeps the card, and drops the rows, for a life nobody dated", () => {
    // Half-known lives are the common case in genealogy. The name and the way
    // back to the tree are still worth showing; an empty definition list under
    // them is not.
    const host = render(
      <EntryPersonCard
        person={{
          ...ROSE,
          birthDate: null,
          birthPlace: null,
          deathDate: null,
          deathPlace: null,
        }}
      />,
    );

    expect(host.querySelector("aside")?.textContent).toContain("Rose Hale");
    expect(host.querySelector("dl")).toBeNull();
  });

  it("renders a place recorded without a date, and drops the comma", () => {
    const host = render(
      <EntryPersonCard person={{ ...ROSE, deathDate: null }} />,
    );

    const rows = [...host.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(rows).toContain("Hastings, Sussex");
    expect(rows).not.toContain(", Hastings, Sussex");
  });

  it("carries no heading, so the entry's contents stay the entry's", () => {
    // E11-T3 builds the table of contents from the page's headings. A heading
    // in the chrome above the article would list "Rose Hale" in the contents
    // of the entry about Rose Hale.
    const host = render(<EntryPersonCard person={ROSE} />);

    expect(host.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
  });

  it("joins a name whose surname was never recorded", () => {
    const host = render(
      <EntryPersonCard person={{ ...ROSE, surname: null }} />,
    );

    expect(host.querySelector("aside")?.getAttribute("aria-label")).toBe(
      "Tree record for Rose",
    );
  });
});
