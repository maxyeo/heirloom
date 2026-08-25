import { describe, expect, it } from "vitest";

import type { EntryMatch } from "@/lib/entry-search";
import type { PersonMatch } from "@/lib/people-search";
import {
  MIN_SUGGESTION_QUERY,
  SEARCH_QUERY_PARAM,
  SUGGESTION_FETCH_LIMIT,
  SUGGESTION_LIMIT,
  emptySuggestions,
  parseSearchSuggestions,
  readSearchParam,
  readSearchQuery,
  searchEndpointUrl,
  searchPageUrl,
  suggestionCount,
  toSuggestions,
} from "@/lib/search-endpoint";

/**
 * The wire contract (E8-T3, `YEO-57`), asserted against literals with no
 * Postgres, no DOM and no `fetch` in the import graph — which is the whole
 * reason `lib/search-endpoint.ts` is a module rather than a handful of lines
 * inside `app/api/search/route.ts`.
 */

function person(id: string): PersonMatch {
  return {
    id,
    name: `Person ${id}`,
    lifespan: "1890–1950",
    href: `/tree?person=${id}`,
  };
}

function entry(id: string): EntryMatch {
  return {
    id,
    slug: `entry-${id}`,
    title: `Entry ${id}`,
    href: `/wiki/entry-${id}`,
    snippet: [{ text: "some prose", matched: false }],
  };
}

describe("reading the query parameter", () => {
  it("reads a single value and trims it", () => {
    expect(readSearchParam("  rose  ")).toBe("rose");
    expect(readSearchQuery(new URLSearchParams("q=%20rose%20"))).toBe("rose");
  });

  /**
   * The case both readers exist for. `?q=a&q=b` has no defensible answer, so
   * both ends give the same non-answer — see `readSearchParam`'s docblock.
   * `URLSearchParams.get` would silently return "a", which is exactly the
   * choice being refused.
   */
  it("refuses a repeated parameter rather than picking one", () => {
    expect(readSearchParam(["a", "b"])).toBe("");
    expect(readSearchQuery(new URLSearchParams("q=a&q=b"))).toBe("");
  });

  it("reads an absent or empty parameter as no query", () => {
    expect(readSearchParam(undefined)).toBe("");
    expect(readSearchParam("")).toBe("");
    expect(readSearchParam("   ")).toBe("");
    expect(readSearchQuery(new URLSearchParams(""))).toBe("");
    expect(readSearchQuery(new URLSearchParams("q="))).toBe("");
  });

  it("uses the same parameter name the results page posts", () => {
    expect(SEARCH_QUERY_PARAM).toBe("q");
  });
});

describe("building the two URLs", () => {
  it("encodes everything a query can contain", () => {
    // `&` would start a second parameter, `#` would start a fragment, `?` and
    // a space would both be read wrong — and a name is not always ASCII.
    const query = "a&b #c ? Ríos";
    for (const url of [searchEndpointUrl(query), searchPageUrl(query)]) {
      const parsed = new URL(url, "https://example.test");
      expect(parsed.searchParams.get("q")).toBe(query);
    }
  });

  it("points the two URLs at the two surfaces", () => {
    expect(searchEndpointUrl("rose").startsWith("/api/search?")).toBe(true);
    expect(searchPageUrl("rose").startsWith("/search?")).toBe(true);
  });
});

describe("truncating a group and saying so", () => {
  it("shows every result and promises no more when the group fits", () => {
    const people = Array.from({ length: SUGGESTION_LIMIT }, (_, i) =>
      person(`p${i}`),
    );
    const result = toSuggestions("rose", people, []);

    expect(result.people).toHaveLength(SUGGESTION_LIMIT);
    expect(result.peopleHasMore).toBe(false);
  });

  /**
   * The reason the route asks each backend for `SUGGESTION_LIMIT + 1`:
   * without the extra row there is no way to tell "exactly five matched" from
   * "five of forty", and "See all results" would either always promise more
   * or never.
   */
  it("cuts the extra row and promises more when it is there", () => {
    const people = Array.from({ length: SUGGESTION_LIMIT + 1 }, (_, i) =>
      person(`p${i}`),
    );
    const result = toSuggestions("rose", people, []);

    expect(result.people).toHaveLength(SUGGESTION_LIMIT);
    expect(result.peopleHasMore).toBe(true);
  });

  it("decides each group independently", () => {
    const result = toSuggestions(
      "rose",
      [person("a")],
      Array.from({ length: SUGGESTION_LIMIT + 1 }, (_, i) => entry(`e${i}`)),
    );

    expect(result.peopleHasMore).toBe(false);
    expect(result.entriesHasMore).toBe(true);
  });

  it("echoes the query back, which is how a stale answer is recognised", () => {
    expect(toSuggestions("rose", [], []).query).toBe("rose");
    expect(emptySuggestions("rose").query).toBe("rose");
  });

  it("counts both groups together", () => {
    expect(
      suggestionCount(toSuggestions("q", [person("a")], [entry("b")])),
    ).toBe(2);
    expect(suggestionCount(emptySuggestions("q"))).toBe(0);
  });
});

describe("narrowing what came back off the wire", () => {
  /**
   * The only place in this application where a value crosses a network
   * boundary untyped. Every case below is a deploy that changed the payload
   * while a tab was open — the alternative to returning `null` is a
   * `TypeError` thrown out of a render on `undefined.map`.
   */
  it("accepts a well-formed payload", () => {
    const payload = JSON.parse(
      JSON.stringify(toSuggestions("rose", [person("a")], [])),
    );
    expect(parseSearchSuggestions(payload)).toEqual(payload);
  });

  it.each([
    ["null", null],
    ["a string", "rose"],
    ["a number", 3],
    ["an array", []],
    [
      "a payload with no query",
      { people: [], entries: [], peopleHasMore: false, entriesHasMore: false },
    ],
    [
      "a payload whose groups are not arrays",
      {
        query: "a",
        people: null,
        entries: [],
        peopleHasMore: false,
        entriesHasMore: false,
      },
    ],
    [
      "a payload whose flags are not booleans",
      {
        query: "a",
        people: [],
        entries: [],
        peopleHasMore: "no",
        entriesHasMore: false,
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseSearchSuggestions(value)).toBeNull();
  });
});

describe("the limits", () => {
  /**
   * Five rather than the page's twenty, deliberately — and the two numbers
   * disagreeing is the point rather than an oversight, which is why it is
   * pinned. See `SUGGESTION_LIMIT`'s docblock and the "See all results" row.
   */
  it("shows fewer per group than the results page does", () => {
    expect(SUGGESTION_LIMIT).toBe(5);
    expect(MIN_SUGGESTION_QUERY).toBe(2);
  });

  /**
   * The pairing the "See all results" disclosure rests on, pinned so it
   * cannot be broken silently. Asking for exactly `SUGGESTION_LIMIT` would
   * never fetch the row that distinguishes "five matched" from "five of
   * forty" — `hasMore` would be false forever and the dropdown would start
   * implying it is the whole answer, with no symptom anywhere.
   */
  it("asks each backend for exactly one more than it shows", () => {
    expect(SUGGESTION_FETCH_LIMIT).toBe(SUGGESTION_LIMIT + 1);

    const full = Array.from({ length: SUGGESTION_FETCH_LIMIT }, (_, i) =>
      person(`p${i}`),
    );
    const result = toSuggestions(
      "rose",
      full,
      full.map((_, i) => entry(`e${i}`)),
    );

    // A full fetch is exactly what "there is more" has to look like.
    expect(result.peopleHasMore).toBe(true);
    expect(result.entriesHasMore).toBe(true);
    expect(result.people).toHaveLength(SUGGESTION_LIMIT);
  });
});
