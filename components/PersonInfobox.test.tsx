// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { PersonInfobox } from "@/components/PersonInfobox";
import type {
  InfoboxPerson,
  PersonInfobox as PersonInfoboxData,
} from "@/lib/person-infobox";
import { render } from "@/test/render";

/**
 * The rendered box (E11-T5, `YEO-75`).
 *
 * jsdom rather than a plain module, because what is worth asserting here is
 * genuinely about the rendered table: that an absent fact produces *no row*
 * rather than an empty one, that an entry not about a person produces no
 * element at all, and that every name in it is a link of the right colour.
 * What the box *says* is decided in `lib/person-infobox.ts` and asserted
 * without a document there; these fixtures are literals for that reason.
 */

function personLink(
  id: string,
  name: string,
  slug: string | null = null,
): InfoboxPerson {
  return { id, name, slug };
}

const PORTRAIT_SRC = "/api/images/ab/abcdef01-2345-4678-89ab-cdef01234567.jpg";

const ROSE: PersonInfoboxData = {
  id: "00000000-0000-4000-8000-0000e11t5001",
  name: "Rose Bennett",
  // The ordinary case: most people in a real tree have no photograph, and the
  // box says so by leaving the figure out. `describe("the portrait")` below
  // overrides it for the case that does.
  portraitSrc: null,
  birth: { date: "30 May 1908", place: "Kilbride" },
  death: { date: "19 January 1989", place: "Ardmore" },
  spouses: [
    {
      unionId: "u2",
      person: personLink("thomas", "Thomas Hale", "thomas-hale"),
      detail: "m. 1933; died 1947",
    },
    {
      unionId: "u3",
      person: personLink("walter", "Walter Shaw", "walter-shaw"),
      detail: "m. about 1948",
    },
  ],
  children: [
    personLink("clara", "Clara Hale"),
    personLink("arthur", "Arthur Hale"),
  ],
  stepchildren: [personLink("edward", "Edward Hale", "edward-hale")],
  parents: [],
};

const EXISTING = new Set(["thomas-hale", "walter-shaw", "edward-hale"]);

function box(
  overrides: Partial<PersonInfoboxData> = {},
  existing: ReadonlySet<string> = EXISTING,
) {
  const host = render(
    <PersonInfobox
      infobox={{ ...ROSE, ...overrides }}
      existingSlugs={existing}
    />,
  );
  const element = host.querySelector("aside");
  if (!element) throw new Error("the infobox rendered nothing");
  return element;
}

/** The `<th>` labels of the rows that were rendered, in order. */
function rowTerms(element: Element): string[] {
  return [...element.querySelectorAll("th")].map(
    (th) => th.textContent?.trim() ?? "",
  );
}

function rowValue(element: Element, term: string): string {
  const row = [...element.querySelectorAll("tr")].find(
    (candidate) => candidate.querySelector("th")?.textContent?.trim() === term,
  );
  return row?.querySelector("td")?.textContent?.trim() ?? "";
}

describe("an entry that is not about a person", () => {
  it("renders no infobox and no gap", () => {
    // The criterion is "no infobox *and no gap*", so an empty wrapper with a
    // margin on it would fail it as surely as an empty bordered box would.
    expect(
      render(<PersonInfobox infobox={null} existingSlugs={EXISTING} />)
        .innerHTML,
    ).toBe("");
    expect(
      render(<PersonInfobox infobox={undefined} existingSlugs={EXISTING} />)
        .innerHTML,
    ).toBe("");
  });
});

describe("the rows", () => {
  it("names the person and orders the rows as Wikipedia does", () => {
    const element = box();

    expect(element.getAttribute("aria-label")).toBe("Infobox for Rose Bennett");
    expect(element.textContent).toContain("Rose Bennett");
    expect(rowTerms(element)).toEqual([
      "Born",
      "Died",
      "Spouses",
      "Children",
      "Stepchild",
    ]);
  });

  it("puts the place under the date", () => {
    const element = box();

    expect(rowValue(element, "Born")).toContain("30 May 1908");
    expect(rowValue(element, "Born")).toContain("Kilbride");
    expect(rowValue(element, "Died")).toContain("19 January 1989");
    expect(rowValue(element, "Died")).toContain("Ardmore");
  });

  it("omits a row with no data rather than saying 'unknown'", () => {
    // Rose has no parents in the fixture. The row is *absent* — this is the
    // acceptance criterion the ticket calls out as easier to see than to read.
    const element = box();

    expect(rowTerms(element)).not.toContain("Parents");
    expect(element.textContent).not.toContain("unknown");
    expect(element.textContent).not.toContain("—");
  });

  it("omits the date rows too when neither is recorded", () => {
    const element = box({ birth: null, death: null });

    expect(rowTerms(element)).toEqual(["Spouses", "Children", "Stepchild"]);
  });

  it("renders nothing but a name for a person with no facts at all", () => {
    const element = box({
      birth: null,
      death: null,
      spouses: [],
      children: [],
      stepchildren: [],
      parents: [],
    });

    expect(rowTerms(element)).toEqual([]);
    expect(element.textContent).toContain("Rose Bennett");
  });

  it("says 'Spouse' and 'Parent' when there is one of them", () => {
    const element = box({
      spouses: [ROSE.spouses[0]],
      parents: [personLink("mary", "Mary Ellis")],
    });

    expect(rowTerms(element)).toContain("Spouse");
    expect(rowTerms(element)).toContain("Parent");
  });

  it("carries the line under a spouse's name", () => {
    expect(rowValue(box(), "Spouses")).toContain("m. 1933; died 1947");
    // A qualifier survives to the page: a marriage remembered as "about 1948"
    // is not a marriage recorded in 1948.
    expect(rowValue(box(), "Spouses")).toContain("m. about 1948");
  });
});

describe("naming relatives, or counting them", () => {
  it("names them while there are few", () => {
    expect(rowValue(box(), "Children")).toBe("Clara Hale, Arthur Hale");
  });

  it("gives the number once there are many", () => {
    // The reference mockup's own row: Rose's ten children are "10". A summary
    // box holding ten links is a directory, and the article's Children section
    // is where that reading belongs.
    const ten = Array.from({ length: 10 }, (_unused, index) =>
      personLink(`child-${index}`, `Child ${index}`),
    );

    expect(rowValue(box({ children: ten }), "Children")).toBe("10");
  });

  it("links every person it does name", () => {
    const element = box();
    const named = [...element.querySelectorAll("td a")].map(
      (anchor) => anchor.textContent,
    );

    expect(named).toEqual([
      "Thomas Hale",
      "Walter Shaw",
      "Clara Hale",
      "Arthur Hale",
      "Edward Hale",
    ]);
  });
});

describe("the links", () => {
  function anchor(element: Element, text: string): HTMLAnchorElement {
    const found = [...element.querySelectorAll("a")].find(
      (candidate) => candidate.textContent === text,
    );
    if (!found) throw new Error(`no link reading "${text}"`);
    return found;
  }

  it("points at the entry of somebody who has one", () => {
    const link = anchor(box(), "Thomas Hale");

    expect(link.getAttribute("href")).toBe("/wiki/thomas-hale");
    expect(link.className).toBe("");
    expect(link.getAttribute("title")).toBeNull();
  });

  it("offers to write the entry of somebody who has none", () => {
    // The purest red link there is: Clara's `individuals.page_id` is empty, so
    // no address for her has ever been written down.
    const link = anchor(box(), "Clara Hale");

    expect(link.getAttribute("href")).toBe("/wiki/new?title=Clara+Hale");
    expect(link.className).toBe("new");
    expect(link.getAttribute("title")).toBe("page does not exist");
  });

  it("turns red when the entry a person names has gone", () => {
    // The slug is on the person, but no entry answers to it. Resolution is
    // the route's one `findExistingSlugs` call, so this is what a deleted
    // entry looks like on the next render — with nothing to re-save.
    const link = anchor(box({}, new Set()), "Thomas Hale");

    expect(link.className).toBe("new");
  });

  it("keeps the way back to the tree", () => {
    // E2-T4's deep link, inherited from the header card this box replaced.
    const link = anchor(box(), "View in family tree");

    expect(link.getAttribute("href")).toBe(`/tree?person=${ROSE.id}`);
  });
});

describe("the Wikipedia styling", () => {
  it("is a filled panel inside a ruled border, from the tokens", () => {
    // The acceptance criteria's fill and border, reached as `--color-panel`
    // and `--color-rule`. No colour is written here: `app/globals.test.ts`
    // fails the build on a hex anywhere but the stylesheet.
    const element = box();

    expect(element.className).toContain("bg-panel");
    expect(element.className).toContain("border-rule");
  });

  it("floats right of the article, and goes full width on a phone", () => {
    const element = box();

    expect(element.className).toContain("sm:float-right");
    expect(element.className).toContain("sm:w-infobox");
    // Mobile first: the unprefixed width is the full-width one, so a narrow
    // screen gets the box above the article rather than beside it.
    expect(element.className).toContain("w-full");
  });

  it("puts no heading in the document", () => {
    // E11-T3 builds the table of contents from the page's headings, and a
    // heading here would put "Rose Bennett" in the contents of the entry about
    // Rose Bennett.
    expect(box().querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
  });
});

/**
 * The portrait (`YEO-97`) — the row the box was built with a hole for.
 *
 * What is worth a document here is the *absence*: that no portrait produces
 * no element rather than a silhouette, which is the acceptance criterion and
 * the opposite of what the tree node does on purpose. The `src` itself is
 * decided in `lib/person-infobox.ts` and asserted there without a DOM.
 */
describe("the portrait", () => {
  function figure(element: Element): HTMLElement | null {
    return element.querySelector("figure");
  }

  it("renders a figure between the name and the table", () => {
    const element = box({ portraitSrc: PORTRAIT_SRC });
    const found = figure(element);
    if (!found) throw new Error("no figure rendered");

    // Source order is the reading order: name, portrait, table.
    const children = [...element.children].map((child) =>
      child.tagName.toLowerCase(),
    );
    expect(children).toEqual(["p", "figure", "table", "p"]);
  });

  it("renders nothing at all when there is no portrait", () => {
    // Not an empty figure, not a placeholder silhouette — which would be a
    // picture of somebody nobody uploaded. The tree node reserves its box for
    // layout stability; an article is ordinary flow and needs no such thing.
    const element = box({ portraitSrc: null });

    expect(figure(element)).toBeNull();
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("svg")).toBeNull();
  });

  it("loads it through this application's own image route", () => {
    // Never a storage URL: the sanitiser drops one and a signed one expires
    // fifteen minutes after it is minted.
    const image = box({ portraitSrc: PORTRAIT_SRC }).querySelector("img");
    if (!image) throw new Error("no image rendered");

    // `next/image` reassigns `img.src = img.src` after mount, which
    // absolutises the attribute in jsdom; the path is what this application
    // controls and what the criterion is about.
    const raw = image.getAttribute("src") ?? "";
    expect(new URL(raw, "http://localhost").pathname).toBe(PORTRAIT_SRC);
  });

  it("names whose face it is", () => {
    const image = box({ portraitSrc: PORTRAIT_SRC }).querySelector("img");

    expect(image?.getAttribute("alt")).toBe(`Portrait of ${ROSE.name}`);
  });

  it("reserves a square before the image arrives", () => {
    // The box floats, so a figure that grew on load would re-wrap the article
    // text around it. Nothing stores a photograph's dimensions, so the ratio
    // is reserved rather than discovered. jsdom has no layout engine and
    // cannot measure the reflow; the reserved ratio is the property that
    // entails its absence.
    const found = figure(box({ portraitSrc: PORTRAIT_SRC }));
    const frame = found?.firstElementChild;

    expect(frame?.className).toContain("aspect-square");
    // Capped at the floated width, so the box below `sm` — where it is as
    // wide as the article — does not open on a portrait that tall.
    expect(frame?.className).toContain("max-w-infobox");
  });
});
