// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { ArticleHatnote } from "@/components/ArticleHatnote";
import { HATNOTE_CLASS, type NamesakePerson } from "@/lib/hatnote";
import { NEW_LINK_CLASS } from "@/lib/red-links";
import { render } from "@/test/render";

/**
 * What a hatnote *says* is decided in `lib/hatnote.ts` and tested there, with
 * no DOM. What is left needs a document, because it is about the markup: that
 * an entry with nothing to say contributes no element at all, that two
 * hatnotes stack in the right order, and that a namesake with no entry comes
 * out as a red link.
 *
 * The first of those is the reason this file exists. "Omitted entirely when
 * empty — no stray whitespace above the lead" is invisible until somebody
 * notices a gap on one entry months later, and an empty `<div>` styled with a
 * bottom margin passes every test that only checks the text.
 */

function namesake(fields: Partial<NamesakePerson> = {}): NamesakePerson {
  return {
    id: "n1",
    givenName: "Rose",
    surname: "Whitfield",
    slug: null,
    birthDate: null,
    birthDateQualifier: "exact",
    birthDateUpper: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDateUpper: null,
    ...fields,
  };
}

const NOTHING_EXISTS: ReadonlySet<string> = new Set();

describe("an entry with no hatnote and no namesake", () => {
  it("renders no element and no whitespace at all", () => {
    const host = render(
      <ArticleHatnote
        hatnoteHtml=""
        subjectName="Rose Whitfield"
        namesakes={[]}
        extraNamesakes={0}
        existingSlugs={NOTHING_EXISTS}
      />,
    );

    // Not "no text" and not "no visible box": nothing in the DOM, so there is
    // no margin, no line box and nothing for the lead paragraph to sit under.
    expect(host.innerHTML).toBe("");
    expect(host.childNodes).toHaveLength(0);
  });

  it("renders nothing for an entry that is about no person", () => {
    const host = render(
      <ArticleHatnote
        hatnoteHtml=""
        subjectName={null}
        namesakes={[]}
        extraNamesakes={0}
        existingSlugs={NOTHING_EXISTS}
      />,
    );

    expect(host.innerHTML).toBe("");
  });

  it("renders nothing when the entry is about a person nobody shares a name with", () => {
    // The lookup returning nothing is the ordinary case, and it must produce
    // no line rather than an empty one.
    const host = render(
      <ArticleHatnote
        hatnoteHtml=""
        subjectName="Walter Hale"
        namesakes={[]}
        extraNamesakes={0}
        existingSlugs={NOTHING_EXISTS}
      />,
    );

    expect(host.innerHTML).toBe("");
  });
});

describe("the author's hatnote", () => {
  it("renders indented and italic above the lead, with its links intact", () => {
    const host = render(
      <ArticleHatnote
        hatnoteHtml='For the house, see <a href="/wiki/rose-hall">Rose Hall</a>.'
        subjectName={null}
        namesakes={[]}
        extraNamesakes={0}
        existingSlugs={NOTHING_EXISTS}
      />,
    );

    const notes = host.querySelectorAll(`.${HATNOTE_CLASS}`);
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe("For the house, see Rose Hall.");
    expect(notes[0].querySelector("a")?.getAttribute("href")).toBe(
      "/wiki/rose-hall",
    );
  });
});

describe("the automatic hatnote", () => {
  it("names the shared name and the people who share it", () => {
    const host = render(
      <ArticleHatnote
        hatnoteHtml=""
        subjectName="Rose Whitfield"
        namesakes={[
          namesake({
            id: "a",
            slug: "rose-whitfield-2",
            birthDate: "1890-01-01",
            deathDate: "1962-01-01",
          }),
          namesake({
            id: "b",
            slug: "rose-whitfield-3",
            birthDate: "1921-01-01",
          }),
        ]}
        extraNamesakes={0}
        existingSlugs={new Set(["rose-whitfield-2", "rose-whitfield-3"])}
      />,
    );

    expect(host.textContent).toBe(
      "For other people named Rose Whitfield, see Rose Whitfield (1890–1962) and Rose Whitfield (b. 1921).",
    );
  });

  it("counts the ones it does not name", () => {
    const host = render(
      <ArticleHatnote
        hatnoteHtml=""
        subjectName="Thomas Hale"
        namesakes={[
          namesake({ id: "a", givenName: "Thomas", surname: "Hale" }),
        ]}
        extraNamesakes={3}
        existingSlugs={NOTHING_EXISTS}
      />,
    );

    expect(host.textContent).toBe(
      "For other people named Thomas Hale, see Thomas Hale and 3 others.",
    );
  });

  it("makes a namesake with no entry a red link into the create flow", () => {
    // The purest red link there is: nobody has written about them, so there is
    // no address to have been written down. See `EntryLinkTarget`.
    const host = render(
      <ArticleHatnote
        hatnoteHtml=""
        subjectName="Mary Ford"
        namesakes={[
          namesake({
            id: "a",
            givenName: "Mary",
            surname: "Ford",
            birthDate: "1904-01-01",
          }),
        ]}
        extraNamesakes={0}
        existingSlugs={NOTHING_EXISTS}
      />,
    );

    const link = host.querySelector("a");
    expect(link?.className).toContain(NEW_LINK_CLASS);
    expect(link?.getAttribute("href")).toContain("/wiki/new?title=");
    // Pre-filled with what the link says, so the entry starts with a name.
    expect(link?.getAttribute("href")).toContain("Mary+Ford");
  });
});

describe("both at once", () => {
  it("stacks them, the author's first, as two separate lines", () => {
    const host = render(
      <ArticleHatnote
        hatnoteHtml="Not the ship."
        subjectName="Rose Whitfield"
        namesakes={[namesake({ id: "a", slug: "rose-whitfield-2" })]}
        extraNamesakes={0}
        existingSlugs={new Set(["rose-whitfield-2"])}
      />,
    );

    const notes = [...host.querySelectorAll(`.${HATNOTE_CLASS}`)];
    expect(notes).toHaveLength(2);
    // The author's sentence is not merged into the derived one: two elements,
    // in the order the page reads.
    expect(notes[0].textContent).toBe("Not the ship.");
    expect(notes[1].textContent).toBe(
      "For other people named Rose Whitfield, see Rose Whitfield.",
    );
  });
});
