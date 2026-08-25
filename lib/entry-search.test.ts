import { describe, expect, it } from "vitest";

import {
  type EntrySearchRow,
  parseSnippet,
  SNIPPET_OPTIONS,
  SNIPPET_START,
  SNIPPET_STOP,
  toEntryMatches,
} from "@/lib/entry-search";

/**
 * The half of entry search (E8-T1, `YEO-55`) that is TypeScript. What ranks a
 * result, what matches it, and what a snippet contains are all Postgres's,
 * and are asserted against a real database in `lib/pages.db.test.ts`; what is
 * here is the reading of the string Postgres hands back.
 *
 * The inputs below are real `ts_headline` output, copied from a `psql`
 * session against the same options this module defines — the leading and
 * trailing spaces and the doubled ones where a tag used to be are the shape
 * Postgres actually produces, not a tidied approximation of it.
 */

/** `ts_headline` output for the given runs, marked ones wrapped. */
function headline(...runs: (string | { mark: string })[]): string {
  return runs
    .map((run) =>
      typeof run === "string"
        ? run
        : `${SNIPPET_START}${run.mark}${SNIPPET_STOP}`,
    )
    .join("");
}

function row(overrides: Partial<EntrySearchRow> = {}): EntrySearchRow {
  return {
    id: "rose-hall",
    slug: "rose-hall",
    title: "Rose Hall",
    snippet: "",
    ...overrides,
  };
}

describe("SNIPPET_OPTIONS", () => {
  /**
   * The coupling that would otherwise be invisible: `lib/pages.ts` asks
   * `ts_headline` to use these markers and `parseSnippet` looks for them, and
   * the two are only correct together. Changing `SNIPPET_START` without
   * changing the options string would not fail to compile — it would quietly
   * return every snippet as one unmarked run.
   */
  it("asks ts_headline for the markers parseSnippet reads", () => {
    expect(SNIPPET_OPTIONS).toContain(`StartSel=${SNIPPET_START}`);
    expect(SNIPPET_OPTIONS).toContain(`StopSel=${SNIPPET_STOP}`);
  });

  it("asks for fragments, so a snippet is context rather than a prefix", () => {
    expect(SNIPPET_OPTIONS).toContain("MaxFragments=2");
    expect(SNIPPET_OPTIONS).toContain("FragmentDelimiter=");
  });
});

describe("parseSnippet", () => {
  it("returns nothing for an entry with an empty body", () => {
    // `ts_headline` over `''` is `''` — every entry is created this way.
    expect(parseSnippet("")).toEqual([]);
  });

  it("returns one unmarked run when the term matched only the title", () => {
    // No marker anywhere: `ts_headline` fell back to the opening of the body.
    expect(parseSnippet(" A house near the river ")).toEqual([
      { text: "A house near the river", matched: false },
    ]);
  });

  it("marks the term Postgres matched, in context", () => {
    expect(
      parseSnippet(
        headline("Rose and Walter ", { mark: "married" }, " in 1902"),
      ),
    ).toEqual([
      { text: "Rose and Walter ", matched: false },
      { text: "married", matched: true },
      { text: " in 1902", matched: false },
    ]);
  });

  it("marks every occurrence across both fragments", () => {
    const segments = parseSnippet(
      headline(
        "the ",
        { mark: "fox" },
        " ran past the barn … caught the ",
        { mark: "fox" },
        " at dusk",
      ),
    );

    expect(segments.filter((segment) => segment.matched)).toEqual([
      { text: "fox", matched: true },
      { text: "fox", matched: true },
    ]);
    // The delimiter is text between them, so the two fragments read as two.
    expect(segments.map((segment) => segment.text).join("")).toContain("…");
  });

  it("closes an unterminated mark at the end of the snippet", () => {
    // Postgres does not produce this. A truncated string would, and a parser
    // that threw on it would take a whole results page down with it.
    expect(parseSnippet(`the ${SNIPPET_START}fox`)).toEqual([
      { text: "the ", matched: false },
      { text: "fox", matched: true },
    ]);
  });

  it("collapses the gaps ts_headline leaves where tags were", () => {
    // `<h2>Head</h2><p>one</p><p>two</p>` comes back like this: the tags are
    // gone, and a run of spaces is left standing where each one was.
    expect(parseSnippet(" Head  one  two ")).toEqual([
      { text: "Head one two", matched: false },
    ]);
  });

  it("keeps the spaces on either side of a mark", () => {
    // The reason whitespace is collapsed over the whole string before the
    // split rather than over each run after it: trimming run by run would
    // weld these three into "twofoxthree".
    expect(parseSnippet(headline("two ", { mark: "fox" }, " three"))).toEqual([
      { text: "two ", matched: false },
      { text: "fox", matched: true },
      { text: " three", matched: false },
    ]);
  });

  it("decodes the escapes a stored body still carries", () => {
    // `sanitizeHtml` re-escapes these four on the way out, and `ts_headline`
    // copies them through untouched. See `decodeHtmlEscapes`.
    expect(parseSnippet("Rose &amp; Walter said &quot;yes&quot;")).toEqual([
      { text: 'Rose & Walter said "yes"', matched: false },
    ]);
  });

  it("reads prose about markup as prose, not as a highlight", () => {
    // An author who writes about `<mark>` has it stored as `&lt;mark&gt;`,
    // which is why the split happens before the decode: after it, this string
    // would contain a marker that Postgres never wrote.
    expect(parseSnippet("the &lt;mark&gt; element is for highlights")).toEqual([
      { text: "the <mark> element is for highlights", matched: false },
    ]);
  });
});

describe("toEntryMatches", () => {
  it("keeps Postgres's order, which is the ranking", () => {
    const matches = toEntryMatches([
      row({ id: "a", slug: "a", title: "Best" }),
      row({ id: "b", slug: "b", title: "Also" }),
    ]);

    // Alphabetically the other way round — proof that nothing here re-sorts
    // what `ts_rank` ordered.
    expect(matches.map((match) => match.id)).toEqual(["a", "b"]);
  });

  it("builds the entry's own href", () => {
    expect(toEntryMatches([row({ slug: "rose-hall" })])[0].href).toBe(
      "/wiki/rose-hall",
    );
  });

  it("encodes a slug that kept its non-Latin characters", () => {
    // `lib/entry-slug.ts` keeps them, so an href has to survive them.
    expect(toEntryMatches([row({ slug: "日本語" })])[0].href).toBe(
      `/wiki/${encodeURIComponent("日本語")}`,
    );
  });

  it("parses each row's snippet", () => {
    const [match] = toEntryMatches([
      row({ snippet: headline("a ", { mark: "fox" }) }),
    ]);

    expect(match.snippet).toEqual([
      { text: "a ", matched: false },
      { text: "fox", matched: true },
    ]);
  });
});
