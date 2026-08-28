import { describe, expect, it } from "vitest";

import {
  type EntryText,
  previewRetirement,
  type RetirementFacts,
} from "@/lib/retirement-preview";

/**
 * The confirmation's arithmetic (E1-T10, `YEO-122`), checked with no database
 * and no DOM — the same bargain `lib/removal-preview.test.ts` strikes, and for
 * the same reason: the cases that are easy to get wrong here are cases about
 * *text*, and text is something a literal can hold.
 *
 * The one worth naming before the tests is the near-miss. An implementation
 * that answered "which entries link here" with a SQL `like '%/wiki/rose-hall%'`
 * would be cheaper, would pass a casual reading, and would report every entry
 * linking to `rose-hall-2` as an entry linking to `rose-hall`. The
 * confirmation would then name entries whose links are not going to turn red,
 * on the one screen whose entire job is to be believed.
 */

/** An entry with nothing in it, so each test states only what it is about. */
function entry(over: Partial<EntryText> & Pick<EntryText, "slug">): EntryText {
  return { title: over.slug, bodyHtml: "", hatnote: "", ...over };
}

/** A link to `slug`, in the shape `lib/entry-links.ts` writes and reads. */
function linkTo(slug: string): string {
  return `<p>See <a href="/wiki/${slug}">someone</a>.</p>`;
}

/** Facts with nothing going on, for a test to override one field of. */
function facts(over: Partial<RetirementFacts> = {}): RetirementFacts {
  return {
    entry: entry({ slug: "rose-hall", title: "Rose Hall" }),
    otherEntries: [],
    revisionCount: 0,
    categories: [],
    subjectName: null,
    ...over,
  };
}

describe("incoming links", () => {
  it("finds a link written in another entry's body", () => {
    const preview = previewRetirement(
      facts({
        otherEntries: [
          entry({
            slug: "walter-hall",
            title: "Walter Hall",
            bodyHtml: linkTo("rose-hall"),
          }),
        ],
      }),
    );

    expect(preview.incomingLinks).toEqual([
      { slug: "walter-hall", title: "Walter Hall" },
    ]);
  });

  it("finds a link written in another entry's hatnote", () => {
    // The half a body-only scan would miss, and it is not the rare half: a
    // hatnote is where one entry most often points at another ("not to be
    // confused with…"), which makes it exactly where a link to the entry
    // somebody is retiring is most likely to be.
    const preview = previewRetirement(
      facts({
        otherEntries: [
          entry({
            slug: "walter-hall",
            title: "Walter Hall",
            hatnote: linkTo("rose-hall"),
          }),
        ],
      }),
    );

    expect(preview.incomingLinks.map((e) => e.slug)).toEqual(["walter-hall"]);
  });

  it("does not report an entry that links to itself", () => {
    // Ordinary, and not a link that turns red: after the retirement nothing
    // renders this entry's body, so there is nobody it could turn red for.
    const preview = previewRetirement(
      facts({
        entry: entry({
          slug: "rose-hall",
          title: "Rose Hall",
          bodyHtml: linkTo("rose-hall"),
        }),
        // The caller reads "every live entry", a set this entry is still in at
        // the moment it asks, so the function has to exclude it by slug.
        otherEntries: [
          entry({
            slug: "rose-hall",
            title: "Rose Hall",
            bodyHtml: linkTo("rose-hall"),
          }),
        ],
      }),
    );

    expect(preview.incomingLinks).toEqual([]);
  });

  it("counts an entry that links here nine times once", () => {
    // A confirmation naming Walter Hall nine times would read as nine entries.
    const preview = previewRetirement(
      facts({
        otherEntries: [
          entry({
            slug: "walter-hall",
            title: "Walter Hall",
            bodyHtml: linkTo("rose-hall").repeat(9),
          }),
        ],
      }),
    );

    expect(preview.incomingLinks).toHaveLength(1);
  });

  it("does not mistake a longer slug for this one", () => {
    /**
     * The case the rejected `like '%/wiki/rose-hall%'` gets wrong, and the
     * reason `entryLinkSlugs` is the parser rather than a pattern: this
     * repository's own disambiguation produces exactly these pairs.
     * `lib/create-page.ts` mints `rose-hall-2` the moment a second Rose Hall
     * is written, so an entry linking to the second one is not an entry
     * linking to the first, and a substring match cannot tell them apart.
     */
    const preview = previewRetirement(
      facts({
        otherEntries: [
          entry({
            slug: "walter-hall",
            title: "Walter Hall",
            bodyHtml: linkTo("rose-hall-2"),
          }),
        ],
      }),
    );

    expect(preview.incomingLinks).toEqual([]);
  });

  it("ignores a link that leaves the wiki", () => {
    const preview = previewRetirement(
      facts({
        otherEntries: [
          entry({
            slug: "walter-hall",
            title: "Walter Hall",
            bodyHtml:
              '<p><a href="https://example.com/wiki/rose-hall">x</a></p>',
          }),
        ],
      }),
    );

    expect(preview.incomingLinks).toEqual([]);
  });

  it("names them in the order the index would", () => {
    // The same comparator the entry index and every category listing use, so
    // an entry sits in the same place in this list as it does in those — and
    // so the order is the application's rather than the database's collation.
    // See `lib/page-index.ts`.
    const preview = previewRetirement(
      facts({
        otherEntries: [
          entry({
            slug: "z",
            title: "Zoe Hall",
            bodyHtml: linkTo("rose-hall"),
          }),
          entry({
            slug: "a",
            title: "ada hall",
            bodyHtml: linkTo("rose-hall"),
          }),
          entry({
            slug: "e",
            title: "Émile Hall",
            bodyHtml: linkTo("rose-hall"),
          }),
        ],
      }),
    );

    expect(preview.incomingLinks.map((e) => e.title)).toEqual([
      "ada hall",
      "Émile Hall",
      "Zoe Hall",
    ]);
  });

  it("says nothing links here when nothing does", () => {
    // The ordinary case in a young wiki, and the one the copy has a whole
    // branch for.
    expect(previewRetirement(facts()).incomingLinks).toEqual([]);
  });
});

describe("photographs", () => {
  it("counts the images in the entry's own text", () => {
    const preview = previewRetirement(
      facts({
        entry: entry({
          slug: "rose-hall",
          title: "Rose Hall",
          bodyHtml:
            '<p><img src="/api/images/entries/a.jpg"></p>' +
            '<p><img src="/api/images/entries/b.jpg"></p>',
        }),
      }),
    );

    expect(preview.imageCount).toBe(2);
  });

  it("counts one photograph shown twice once", () => {
    const preview = previewRetirement(
      facts({
        entry: entry({
          slug: "rose-hall",
          title: "Rose Hall",
          bodyHtml:
            '<p><img src="/api/images/entries/a.jpg"></p>' +
            '<p><img src="/api/images/entries/a.jpg"></p>',
        }),
      }),
    );

    // "The 2 photographs in it stay where they are" would be a false sentence
    // about one file, on the screen whose job is to be believed.
    expect(preview.imageCount).toBe(1);
  });
});

describe("the rest of the facts", () => {
  it("passes the counts and the subject through", () => {
    const preview = previewRetirement(
      facts({ revisionCount: 31, subjectName: "Thomas Whitfield" }),
    );

    expect(preview.revisionCount).toBe(31);
    expect(preview.subjectName).toBe("Thomas Whitfield");
  });

  it("orders the categories the way a reader reads them", () => {
    const preview = previewRetirement(
      facts({
        categories: [
          { slug: "z", name: "Whitfield family" },
          { slug: "a", name: "Emigrated to Canada" },
        ],
      }),
    );

    expect(preview.categories.map((c) => c.name)).toEqual([
      "Emigrated to Canada",
      "Whitfield family",
    ]);
  });

  it("does not sort the caller's array in place", () => {
    // `facts.categories` is `readonly`, and the copy is what makes that true
    // at runtime as well as at compile time: the caller in
    // `lib/retire-page.ts` hands over the array `readEntryCategories`
    // returned, which is already in its own order for its own reasons.
    const categories = [
      { slug: "z", name: "Whitfield family" },
      { slug: "a", name: "Emigrated to Canada" },
    ];

    previewRetirement(facts({ categories }));

    expect(categories.map((c) => c.name)).toEqual([
      "Whitfield family",
      "Emigrated to Canada",
    ]);
  });

  it("carries the entry's own identity, not the caller's idea of it", () => {
    const preview = previewRetirement(
      facts({ entry: entry({ slug: "rose-hall", title: "Rose Hall" }) }),
    );

    expect(preview).toMatchObject({ slug: "rose-hall", title: "Rose Hall" });
  });
});
