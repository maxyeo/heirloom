import { describe, expect, it } from "vitest";

import {
  describeDeparture,
  describeDivergenceFromCurrent,
  describeIncomingLinks,
  describeWhatIsKept,
} from "@/lib/retirement-copy";
import type { RetirementPreview } from "@/lib/retirement-preview";

/**
 * The confirmation's sentences (E1-T10, `YEO-122`).
 *
 * The ticket says the copy is the safety mechanism, which makes these
 * assertions about a product decision rather than about formatting. A reader
 * presses the button on the strength of "all 31 of its saved versions are
 * kept"; if that sentence ever says something the write does not do, the
 * feature has lied at the only moment it mattered.
 *
 * The unglamorous half is the counting. Five of these change shape on a
 * number, and "the 1 entries link to it" is the classic way a confirmation
 * stops being trusted — so every one of them is asserted at zero, one and
 * many.
 */

function preview(over: Partial<RetirementPreview> = {}): RetirementPreview {
  return {
    slug: "rose-hall",
    title: "Rose Hall",
    incomingLinks: [],
    revisionCount: 1,
    categories: [],
    subjectName: null,
    imageCount: 0,
    ...over,
  };
}

const entry = (slug: string) => ({ slug, title: slug });
const category = (slug: string) => ({ slug, name: slug });

describe("what retiring takes it out of", () => {
  it("is a predicate the component can put a bold title in front of", () => {
    // Not a whole sentence, on purpose: the subject is rendered in bold, so
    // this has to start where the bold ends. A change that made it
    // self-contained again would read as "Retiring Rose Hall Retiring this
    // entry takes it out of…" on the page and pass every other test here.
    expect(describeDeparture(preview())).toMatch(/^takes it out of/);
  });

  it("names the index and search when nothing is filed", () => {
    const text = describeDeparture(preview());

    expect(text).toContain("out of the index");
    expect(text).toContain("out of search");
    expect(text).not.toContain("category");
  });

  it("says one category in the singular", () => {
    expect(
      describeDeparture(preview({ categories: [category("a")] })),
    ).toContain("the one category it is filed under");
  });

  it("counts several", () => {
    const text = describeDeparture(
      preview({ categories: [category("a"), category("b"), category("c")] }),
    );

    expect(text).toContain("the 3 categories it is filed under");
  });
});

describe("the links that turn red", () => {
  it("says so plainly when there are none", () => {
    // The ordinary case in a young wiki, and it has to read as reassurance
    // rather than as an empty list heading.
    const text = describeIncomingLinks(preview());

    expect(text).toBe("No other entry links to it, so no link changes.");
    expect(text).not.toContain(":");
  });

  it("uses the singular for one, and ends ready for the name", () => {
    const text = describeIncomingLinks(
      preview({ incomingLinks: [entry("walter-hall")] }),
    );

    expect(text).toContain("One entry links to it");
    expect(text).not.toContain("1 entries");
    // The names are rendered as links by the component, so the sentence has to
    // hand off rather than finish. That is the whole reason this returns a
    // lead-in instead of a completed sentence.
    expect(text.endsWith(":")).toBe(true);
  });

  it("counts several, and still hands off", () => {
    const text = describeIncomingLinks(
      preview({ incomingLinks: [entry("a"), entry("b")] }),
    );

    expect(text).toContain("2 entries link to it");
    expect(text.endsWith(":")).toBe(true);
  });
});

describe("what is kept", () => {
  it("leads with the promise the whole feature rests on", () => {
    expect(describeWhatIsKept(preview())).toMatch(/^Nothing is deleted\./);
  });

  it("says nothing about versions when the row has none", () => {
    // Not reachable through this application — `createPageIn` writes the first
    // revision with the entry — but reachable by a row that arrived another
    // way, and "All 0 of its saved versions are kept" is both ungrammatical
    // and a promise about nothing. "Nothing is deleted." is the whole truth
    // for a row with no history, so the clause is dropped rather than
    // reworded.
    const text = describeWhatIsKept(preview({ revisionCount: 0 }));

    expect(text).not.toContain("saved version");
    expect(text).not.toContain("All 0");
    expect(text).not.toContain("history");
    expect(text).toMatch(/^Nothing is deleted\./);
  });

  it("says one version in the singular", () => {
    const text = describeWhatIsKept(preview({ revisionCount: 1 }));

    expect(text).toContain("Its one saved version is kept");
    expect(text).not.toContain("1 of its");
  });

  it("counts several versions", () => {
    expect(describeWhatIsKept(preview({ revisionCount: 31 }))).toContain(
      "All 31 of its saved versions are kept",
    );
  });

  it("says nothing about photographs when there are none", () => {
    // Most entries have none, and a sentence about zero photographs would be
    // noise in the middle of the sentences that matter.
    expect(describeWhatIsKept(preview({ imageCount: 0 }))).not.toContain(
      "photograph",
    );
  });

  it("says one photograph in the singular", () => {
    expect(describeWhatIsKept(preview({ imageCount: 1 }))).toContain(
      "The photograph in it stays exactly where it is.",
    );
  });

  it("counts several photographs", () => {
    // §2 of the ticket, said out loud to the reader: the sweep will not
    // reclaim these, because `lib/image-references.ts` goes on counting a
    // retired entry's body as a reference.
    expect(describeWhatIsKept(preview({ imageCount: 4 }))).toContain(
      "The 4 photographs in it stay exactly where they are.",
    );
  });

  it("names the person whose entry it is, when there is one", () => {
    // The last acceptance criterion, stated to the reader it applies to:
    // `individuals.page_id` is left alone, so the link survives and comes back.
    const text = describeWhatIsKept(
      preview({ subjectName: "Thomas Whitfield" }),
    );

    expect(text).toContain("Thomas Whitfield");
    expect(text).toContain("keeps its link to this entry");
  });

  it("says nothing about a person for an entry about a place", () => {
    // Most entries in a family wiki are about a place, an heirloom or a story.
    expect(describeWhatIsKept(preview({ subjectName: null }))).not.toContain(
      "family tree",
    );
  });

  it("ends by saying it can be undone", () => {
    // The sentence that makes retiring a thing somebody is willing to do at
    // all — see `components/EntryRestoration.tsx` on why the two directions
    // deliberately do not cost the same.
    expect(describeWhatIsKept(preview())).toMatch(
      /It can be restored at any time, at this same address\.$/,
    );
  });
});

/**
 * The other end of the same feature (`YEO-126`): not what the confirmation
 * promises before the write, but what a page goes on saying after it.
 *
 * `YEO-123` fixed two of the three panels on `/wiki/[slug]/history/[revisionId]`
 * — it put `components/RetiredEntryNotice.tsx` above the historical banner and
 * stopped the link below it offering a tombstone as "the current version" —
 * and left the banner between them ending "It may differ significantly from
 * the current version" on an entry that has none. This is the assertion the
 * route cannot carry itself: it is an async Server Component, so nothing in
 * `npm test` can mount it, and `lib/pages.route-decisions.test.ts` can only
 * see that it reads `deletedAt`, never what it then says.
 */
describe("what the historical banner says about the current version", () => {
  const retired = new Date("2026-02-11T09:30:00Z");

  it("warns a reader of a live entry that it may have moved on", () => {
    // The whole point of the banner, and the reason it is MediaWiki's wording:
    // somebody who arrived from a search result or a bookmark has to be told
    // that what they are reading is not what the entry says now.
    expect(describeDivergenceFromCurrent(null)).toContain(
      "may differ significantly from the current version",
    );
  });

  it("says nothing once the entry itself is retired", () => {
    // Dropped rather than reworded. "This is an old revision of this entry,
    // saved <date> by <author>." is still true and is the whole of what the
    // banner has to say when the address it would compare against answers with
    // a tombstone — and the panel directly above it has already said the rest.
    expect(describeDivergenceFromCurrent(retired)).toBeNull();
  });

  it("never promises a current version to a retired entry", () => {
    // The acceptance criterion itself, written so that it outlives the
    // decision above: if a later change gives the retired case a sentence of
    // its own, that sentence still may not offer a version at an address that
    // is a tombstone. This is the assertion that would have failed on the code
    // `YEO-123` left behind.
    expect(describeDivergenceFromCurrent(retired) ?? "").not.toContain(
      "current version",
    );
  });
});
