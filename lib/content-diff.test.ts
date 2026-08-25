import { describe, expect, it } from "vitest";

import {
  contentBlockText,
  describeBlockKind,
  describeContentDiffSummary,
  diffContent,
  diffEntryContent,
  extractContentBlocks,
  hasContentChanges,
  summariseContentDiff,
  type ContentDiffRow,
} from "@/lib/content-diff";

/**
 * E1-T6's acceptance criteria, and the only place any of them can be checked
 * by `npm test`.
 *
 * The route that renders this is an `async` Server Component — not
 * unit-testable — and the two revisions it diffs come from `lib/revisions.ts`,
 * which imports `@/db`. So the criteria were pushed down into plain functions
 * over plain strings, and this file is what CI actually runs against them:
 *
 *   - the diff is over rendered content, not HTML source;
 *   - additions and removals are distinguishable (here, as statuses; the
 *     "without colour alone" half is markup, checked by eye and by
 *     `app/globals.test.ts`'s rule that no call site declares a colour);
 *   - a whole section moving produces sensible output.
 */

/** The statuses in row order — the shape almost every assertion below wants. */
function statuses(rows: ContentDiffRow[]): string[] {
  return rows.map((row) => row.status);
}

/** Rows as `status: text` pairs, for the assertions that care about both. */
function rowsAsText(rows: ContentDiffRow[]): string[] {
  return rows.map((row) => `${row.status}: ${row.block.text}`);
}

describe("extractContentBlocks", () => {
  it("reads a paragraph as its rendered text, not its markup", () => {
    // The ticket's first criterion in one assertion: what comes back is what
    // the reader sees, with the tags that produced it discarded.
    expect(
      extractContentBlocks(
        "<p>Rose was born in <strong>1912</strong>, in <em>Norfolk</em>.</p>",
      ),
    ).toEqual([
      { kind: "paragraph", text: "Rose was born in 1912, in Norfolk." },
    ]);
  });

  it("keeps headings apart from paragraphs, and apart from each other", () => {
    expect(
      extractContentBlocks(
        "<h2>Early life</h2><h3>Schooling</h3><p>She read.</p>",
      ),
    ).toEqual([
      { kind: "heading2", text: "Early life" },
      { kind: "heading3", text: "Schooling" },
      { kind: "paragraph", text: "She read." },
    ]);
  });

  it("reads a TipTap list item as one list item, not as a paragraph", () => {
    // TipTap wraps a list item's content in a paragraph — `<li><p>Alice</p>
    // </li>` — which is the shape `app/globals.css` already has a rule for.
    // Filing that inner paragraph as a paragraph would make every bullet
    // compare unequal to itself.
    expect(
      extractContentBlocks("<ul><li><p>Alice</p></li><li><p>Bob</p></li></ul>"),
    ).toEqual([
      { kind: "listItem", text: "Alice" },
      { kind: "listItem", text: "Bob" },
    ]);
  });

  it("reads a nested list as a flat run of list items", () => {
    // Nesting depth is deliberately not part of a block's identity. Indenting
    // a bullet is a change the diff will not report, which is the price of
    // the simplest thing that is never wrong about the text itself.
    expect(
      extractContentBlocks("<ul><li>Alice<ul><li>Bob</li></ul></li></ul>"),
    ).toEqual([
      { kind: "listItem", text: "Alice" },
      { kind: "listItem", text: "Bob" },
    ]);
  });

  it("treats a line break as a gap between words, not a new block", () => {
    expect(extractContentBlocks("<p>Rose Hale<br />1912-1998</p>")).toEqual([
      { kind: "paragraph", text: "Rose Hale 1912-1998" },
    ]);
  });

  it("collapses whitespace the way a browser renders it", () => {
    // Two revisions that differ only in how the HTML was pretty-printed are
    // the same article. Without this they would read as a rewritten one.
    expect(
      extractContentBlocks("<p>\n  Rose   was\tborn\n  in 1912.\n</p>"),
    ).toEqual([{ kind: "paragraph", text: "Rose was born in 1912." }]);
  });

  it("shows characters, never the entities that encoded them", () => {
    // Named, decimal, hex and `&nbsp;` all in one string. Only `&amp;`
    // survives the sanitiser as an entity at all — htmlparser2 decodes the
    // rest before this module ever sees them — so this asserts the whole
    // round trip rather than the four-escape table on its own.
    expect(
      extractContentBlocks(
        "<p>Hale &amp; Sons &#8212; Rose&#x2019;s firm&nbsp;&mdash; est. 1890</p>",
      ),
    ).toEqual([
      {
        kind: "paragraph",
        text: "Hale & Sons \u2014 Rose\u2019s firm \u2014 est. 1890",
      },
    ]);
  });

  it("decodes each escape exactly once", () => {
    // The re-entrancy trap: decoding `&amp;` before `&lt;` turns the literal
    // text `&amp;lt;` — which is how a real `&lt;` in the prose is stored —
    // into `<`, and a paragraph would then differ from itself depending on
    // how many times it had been round-tripped.
    expect(extractContentBlocks("<p>&amp;lt; stays text</p>")).toEqual([
      { kind: "paragraph", text: "&lt; stays text" },
    ]);
  });

  it("does not report an entity-only rewrite as a change", () => {
    // The practical consequence of the two above, and the reason they are
    // worth having: `&mdash;` and a literal em dash are the same character to
    // a reader, so re-saving one as the other is not an edit.
    expect(
      hasContentChanges(
        diffContent("<p>Rose &mdash; 1912</p>", "<p>Rose \u2014 1912</p>"),
      ),
    ).toBe(false);
  });

  it("drops blocks with nothing in them", () => {
    // TipTap writes `<p></p>` for a blank line. Reporting those as content
    // would bury the real edits under whitespace churn.
    expect(
      extractContentBlocks("<p>One.</p><p></p><p>  </p><p>Two.</p>"),
    ).toEqual([
      { kind: "paragraph", text: "One." },
      { kind: "paragraph", text: "Two." },
    ]);
  });

  it("does not show the contents of a script as prose", () => {
    // Why this module sanitises rather than trusting its caller to: without
    // it, a row written before `lib/sanitize-html.ts` existed — or by a
    // manual UPDATE — would print `alert(1)` in the diff as if an author had
    // typed it.
    expect(
      extractContentBlocks("<p>Safe.</p><script>alert(1)</script>"),
    ).toEqual([{ kind: "paragraph", text: "Safe." }]);
  });

  it("reads a body with no block tags at all as one paragraph", () => {
    // A row from before the editor existed, or one hand-written in SQL.
    expect(extractContentBlocks("Just some text.")).toEqual([
      { kind: "paragraph", text: "Just some text." },
    ]);
  });

  it("returns nothing for an empty or absent body", () => {
    // `pages.body_html` defaults to '', and a revision of a brand-new entry
    // has exactly that in it.
    expect(extractContentBlocks("")).toEqual([]);
    expect(extractContentBlocks(null)).toEqual([]);
    expect(extractContentBlocks(undefined)).toEqual([]);
  });
});

describe("diffContent", () => {
  it("reports no changes between two copies of the same body", () => {
    const rows = diffContent(
      "<p>One.</p><p>Two.</p>",
      "<p>One.</p><p>Two.</p>",
    );

    expect(statuses(rows)).toEqual(["unchanged", "unchanged"]);
    expect(hasContentChanges(rows)).toBe(false);
  });

  it("reports no changes when only the markup changed", () => {
    // The headline property of diffing rendered content instead of source.
    // Bolding a word, or the editor re-emitting the same sentence with its
    // tags nested differently, is not something the reader can see — so it is
    // not something this view should claim happened.
    const rows = diffContent(
      "<p>Rose was born in 1912.</p>",
      "<p>Rose was born in <strong>1912</strong>.</p>",
    );

    expect(hasContentChanges(rows)).toBe(false);
  });

  it("reports a promoted heading as a change", () => {
    // The other side of that coin. Heading level is structure the reader can
    // see, so the levels are kept apart in a block's identity.
    const rows = diffContent("<h3>Early life</h3>", "<h2>Early life</h2>");

    expect(statuses(rows)).toEqual(["removed", "added"]);
  });

  it("reports an inserted paragraph as one addition", () => {
    const rows = diffContent(
      "<p>One.</p><p>Three.</p>",
      "<p>One.</p><p>Two.</p><p>Three.</p>",
    );

    expect(rowsAsText(rows)).toEqual([
      "unchanged: One.",
      "added: Two.",
      "unchanged: Three.",
    ]);
  });

  it("reports a deleted paragraph as one removal", () => {
    const rows = diffContent(
      "<p>One.</p><p>Two.</p><p>Three.</p>",
      "<p>One.</p><p>Three.</p>",
    );

    expect(rowsAsText(rows)).toEqual([
      "unchanged: One.",
      "removed: Two.",
      "unchanged: Three.",
    ]);
  });

  it("reports a rewritten paragraph as the old one then the new one", () => {
    // The deliberate limit the ticket asks for: whole blocks, no word-level
    // pass. What it costs is that a one-word edit prints the sentence twice.
    // What it buys is that the two lines are always exactly what was saved.
    // The order matters — what it said, then what it says.
    const rows = diffContent(
      "<p>Rose was born in 1912.</p>",
      "<p>Rose was born in 1913.</p>",
    );

    expect(rowsAsText(rows)).toEqual([
      "removed: Rose was born in 1912.",
      "added: Rose was born in 1913.",
    ]);
  });

  it("reports a section that moved as moved, not as deleted and rewritten", () => {
    // The ticket's fourth criterion. A plain subsequence diff is not *wrong*
    // here — it says two paragraphs left the top and two arrived at the
    // bottom — but the author then has to compare them by eye to work out
    // that nothing was lost. Both ends are labelled instead.
    const before =
      "<h2>Early life</h2><p>She read.</p><h2>Later</h2><p>She wrote.</p>";
    const after =
      "<h2>Later</h2><p>She wrote.</p><h2>Early life</h2><p>She read.</p>";

    const rows = diffContent(before, after);

    expect(rowsAsText(rows)).toEqual([
      "moved-out: Early life",
      "moved-out: She read.",
      "unchanged: Later",
      "unchanged: She wrote.",
      "moved-in: Early life",
      "moved-in: She read.",
    ]);

    // Nothing was added and nothing was deleted, and the summary says so.
    expect(summariseContentDiff(rows)).toEqual({
      unchanged: 2,
      added: 0,
      removed: 0,
      moved: 2,
    });
  });

  it("still reports a genuine deletion alongside a move", () => {
    // The move pass pairs off only as many as both sides can supply. Three
    // copies of a paragraph deleted and one added back is one move and two
    // deletions, not three moves.
    const rows = diffContent(
      "<p>Same.</p><p>Same.</p><p>Same.</p><p>Anchor.</p>",
      "<p>Anchor.</p><p>Same.</p>",
    );

    expect(statuses(rows)).toEqual([
      "moved-out",
      "removed",
      "removed",
      "unchanged",
      "moved-in",
    ]);
    expect(summariseContentDiff(rows)).toEqual({
      unchanged: 1,
      added: 0,
      removed: 2,
      moved: 1,
    });
  });

  it("reports every block of a first save as an addition", () => {
    // Comparing a brand-new entry's empty body against its first real save.
    const rows = diffContent("", "<p>One.</p><p>Two.</p>");

    expect(statuses(rows)).toEqual(["added", "added"]);
    expect(hasContentChanges(rows)).toBe(true);
  });

  it("reports an emptied entry as all removals", () => {
    const rows = diffContent("<p>One.</p><p>Two.</p>", "");

    expect(statuses(rows)).toEqual(["removed", "removed"]);
  });

  it("reports nothing at all when both revisions are empty", () => {
    const rows = diffContent("", "");

    expect(rows).toEqual([]);
    expect(hasContentChanges(rows)).toBe(false);
    expect(summariseContentDiff(rows)).toEqual({
      unchanged: 0,
      added: 0,
      removed: 0,
      moved: 0,
    });
  });

  it("keeps unchanged blocks in the diff, in document order", () => {
    // Context is not elided. An entry here is a few screens of prose, and a
    // diff that showed only the changed blocks would leave the author
    // guessing where in the article each one sits.
    const rows = diffContent(
      "<h2>Early life</h2><p>One.</p><p>Two.</p>",
      "<h2>Early life</h2><p>One.</p><p>Two point five.</p>",
    );

    expect(rowsAsText(rows)).toEqual([
      "unchanged: Early life",
      "unchanged: One.",
      "removed: Two.",
      "added: Two point five.",
    ]);
  });
});

describe("describeContentDiffSummary", () => {
  /** The counts a diff produces, with everything unstated left at zero. */
  const summary = (counts: {
    added?: number;
    removed?: number;
    moved?: number;
    unchanged?: number;
  }) => ({ unchanged: 0, added: 0, removed: 0, moved: 0, ...counts });

  it("says so plainly when nothing visible changed", () => {
    // Not "0 additions, 0 removals" — the whole point of diffing rendered
    // content is that a markup-only save has an answer, and this is it.
    expect(describeContentDiffSummary(summary({ unchanged: 4 }))).toBe(
      "No change to the rendered content.",
    );
  });

  it("uses the singular for one of a thing", () => {
    expect(describeContentDiffSummary(summary({ added: 1 }))).toBe(
      "1 addition.",
    );
    expect(describeContentDiffSummary(summary({ removed: 1 }))).toBe(
      "1 removal.",
    );
    expect(describeContentDiffSummary(summary({ moved: 1 }))).toBe("1 move.");
  });

  it("joins two with a word and three with a comma and a word", () => {
    expect(describeContentDiffSummary(summary({ added: 2, removed: 1 }))).toBe(
      "2 additions and 1 removal.",
    );
    expect(
      describeContentDiffSummary(summary({ added: 2, removed: 1, moved: 3 })),
    ).toBe("2 additions, 1 removal and 3 moves.");
  });

  it("omits the kinds that did not happen", () => {
    expect(
      describeContentDiffSummary(summary({ moved: 2, unchanged: 9 })),
    ).toBe("2 moves.");
  });

  it("describes a real diff's own summary", () => {
    // End to end, so the counting and the wording cannot drift apart.
    const rows = diffContent(
      "<h2>Early life</h2><p>She read.</p><p>Cut this.</p>",
      "<p>She read.</p><h2>Early life</h2><p>Added this.</p>",
    );

    expect(describeContentDiffSummary(summariseContentDiff(rows))).toBe(
      "1 addition, 1 removal and 1 move.",
    );
  });
});

/**
 * The hatnote (E11-T9, `YEO-79`) is content, and it lives in its own column
 * rather than in the body — so the diff has to reach it explicitly or a
 * hatnote-only save writes a revision that reports no change.
 */
describe("diffEntryContent", () => {
  it("reports a hatnote that was added", () => {
    const rows = diffEntryContent(
      { bodyHtml: "<p>One.</p>" },
      { bodyHtml: "<p>One.</p>", hatnote: "Not the ship." },
    );

    expect(rows).toEqual([
      { status: "added", block: { kind: "hatnote", text: "Not the ship." } },
      { status: "unchanged", block: { kind: "paragraph", text: "One." } },
    ]);
    expect(hasContentChanges(rows)).toBe(true);
  });

  it("reports a hatnote that was cleared", () => {
    const rows = diffEntryContent(
      { bodyHtml: "<p>One.</p>", hatnote: "Not the ship." },
      { bodyHtml: "<p>One.</p>" },
    );

    expect(rows[0]).toEqual({
      status: "removed",
      block: { kind: "hatnote", text: "Not the ship." },
    });
  });

  it("leads with the hatnote, because that is where the page reads it", () => {
    const rows = diffEntryContent(
      { bodyHtml: "<h2>Life</h2>", hatnote: "See also." },
      { bodyHtml: "<h2>Life</h2>", hatnote: "See also." },
    );

    expect(rows.map((row) => row.block.kind)).toEqual(["hatnote", "heading2"]);
    expect(hasContentChanges(rows)).toBe(false);
  });

  it("does not mistake a hatnote for a paragraph saying the same words", () => {
    // Two blocks are the same only when kind *and* text match, so moving a
    // sentence out of the hatnote and into the lead is a real edit rather than
    // an unchanged row.
    const rows = diffEntryContent(
      { bodyHtml: "", hatnote: "Not the ship." },
      { bodyHtml: "<p>Not the ship.</p>" },
    );

    expect(rows.map((row) => row.status)).toEqual(["removed", "added"]);
  });

  it("compares what a reader sees, not the markup", () => {
    // Re-pointing a link without changing a word is not a change, exactly as
    // it is not one for a paragraph in the body.
    const rows = diffEntryContent(
      { bodyHtml: "", hatnote: '<a href="/wiki/a">Rose</a> Hall' },
      { bodyHtml: "", hatnote: '<a href="/wiki/b">Rose</a> Hall' },
    );

    expect(hasContentChanges(rows)).toBe(false);
  });

  it("narrows a stored hatnote that predates the narrowing", () => {
    const rows = diffEntryContent(
      { bodyHtml: "", hatnote: "<p>Not the <strong>ship</strong>.</p>" },
      { bodyHtml: "", hatnote: "Not the ship." },
    );

    expect(hasContentChanges(rows)).toBe(false);
  });
});

describe("describeBlockKind", () => {
  it("names the hatnote in the interface", () => {
    expect(describeBlockKind("hatnote")).toBe("Hatnote");
  });

  it("names a photograph in the reader's word, not the tag's", () => {
    expect(describeBlockKind("image")).toBe("Photograph");
  });
});

/**
 * Photographs in the diff (E5-T3, `YEO-43`).
 *
 * `img` reached `lib/sanitize-html.ts`'s allowlist with that ticket, and this
 * module's own docblock states the obligation that follows: "if a tag is added
 * there, it belongs in `BLOCK_TAGS` below too". A photograph is the first
 * piece of content a reader sees that carries no text, so without a kind of
 * its own every one of the assertions below would have read "no change" — for
 * the one thing in an entry nobody can retype from memory.
 */
describe("photographs", () => {
  const ROSE = "images/ab/8f14e45f-ea0f-4b76-9d7c-1a2b3c4d5e6f.jpg";
  const WALTER = "images/cd/1b2c3d4e-5f60-4a71-8293-a4b5c6d7e8f9.jpg";

  const img = (key: string, alt?: string) =>
    `<img src="/api/images/${key.slice("images/".length)}"${
      alt === undefined ? "" : ` alt="${alt}"`
    }>`;

  it("is a block of its own, carrying its alt text and its key", () => {
    expect(
      extractContentBlocks(`<p>Before.</p>${img(ROSE, "Rose at Southwold")}`),
    ).toEqual([
      { kind: "paragraph", text: "Before." },
      { kind: "image", text: "Rose at Southwold", source: ROSE },
    ]);
  });

  it("survives having no alt text, which an empty block would not", () => {
    // `flush()` drops an empty block on purpose — right for TipTap's `<p></p>`
    // and exactly wrong for a picture, which is why `img` does not go through
    // it.
    expect(extractContentBlocks(img(ROSE))).toEqual([
      { kind: "image", text: "", source: ROSE },
    ]);
  });

  it("does not swallow the text around it", () => {
    expect(
      extractContentBlocks(`<p>Before.</p>${img(ROSE)}<p>After.</p>`),
    ).toEqual([
      { kind: "paragraph", text: "Before." },
      { kind: "image", text: "", source: ROSE },
      { kind: "paragraph", text: "After." },
    ]);
  });

  it("reports adding one as an addition", () => {
    const rows = diffContent("<p>Rose.</p>", `<p>Rose.</p>${img(ROSE)}`);

    expect(summariseContentDiff(rows)).toEqual({
      unchanged: 1,
      added: 1,
      removed: 0,
      moved: 0,
    });
  });

  it("reports removing one as a removal", () => {
    const rows = diffContent(`<p>Rose.</p>${img(ROSE)}`, "<p>Rose.</p>");

    expect(summariseContentDiff(rows)).toEqual({
      unchanged: 1,
      added: 0,
      removed: 1,
      moved: 0,
    });
  });

  it("reports swapping one for another, even when both are undescribed", () => {
    // The case the `source` field exists for. Both blocks have the same kind
    // and the same (empty) text, so an identity of kind-plus-text would call
    // this unchanged and the history would show a photograph being replaced as
    // nothing having happened.
    const rows = diffContent(img(ROSE), img(WALTER));

    expect(summariseContentDiff(rows)).toEqual({
      unchanged: 0,
      added: 1,
      removed: 1,
      moved: 0,
    });
    expect(hasContentChanges(rows)).toBe(true);
  });

  it("reports re-describing one as a change", () => {
    // Same picture, new alt text. It is a change a reader using a screen
    // reader hears, so it is a change.
    const rows = diffContent(img(ROSE), img(ROSE, "Rose at Southwold, 1952"));

    expect(hasContentChanges(rows)).toBe(true);
  });

  it("says nothing changed when nothing did", () => {
    const rows = diffContent(
      `<p>Rose.</p>${img(ROSE, "Rose")}`,
      `<p>Rose.</p>${img(ROSE, "Rose")}`,
    );

    expect(hasContentChanges(rows)).toBe(false);
  });

  it("ignores an img the sanitiser would have dropped anyway", () => {
    // Unreachable from a stored body — `sanitizeHtml` runs first and discards
    // the whole tag — so this is about the check being made rather than
    // assumed.
    expect(
      extractContentBlocks(
        '<p>Rose.</p><img src="https://evil.example/x.png">',
      ),
    ).toEqual([{ kind: "paragraph", text: "Rose." }]);
  });
});

describe("contentBlockText", () => {
  it("is the block's own text for everything that has some", () => {
    expect(
      contentBlockText({ kind: "paragraph", text: "Rose married Walter." }),
    ).toBe("Rose married Walter.");
  });

  it("says a picture is there when nobody described it", () => {
    // An unchanged row draws no kind label, so without this a picture that had
    // never been described would render as a completely blank line — which
    // reads as a bug rather than as a photograph.
    expect(
      contentBlockText({ kind: "image", text: "", source: "images/ab/x.jpg" }),
    ).toBe("Photograph with no description");
  });

  it("prefers the description when there is one", () => {
    expect(
      contentBlockText({
        kind: "image",
        text: "Rose at Southwold",
        source: "images/ab/x.jpg",
      }),
    ).toBe("Rose at Southwold");
  });
});
