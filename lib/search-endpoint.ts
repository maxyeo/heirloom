import type { EntryMatch } from "@/lib/entry-search";
import type { PersonMatch } from "@/lib/people-search";

/**
 * The contract between the one search box and the one search endpoint
 * (E8-T3, `YEO-57`): the URL, the parameter, the limits, and the shape of
 * what comes back.
 *
 * ## Why a module rather than two ends that happen to agree
 *
 * `lib/tree-selection.ts`'s `treeHref` is the precedent and states the rule:
 * "exactly one place that knows the `?person=` contract's shape". Here there
 * are two ends of a *network* boundary rather than two callers of a link
 * builder, which makes the same rule stricter rather than looser — a
 * disagreement between `app/api/search/route.ts` and
 * `components/SearchBox.tsx` is not a type error, it is a shape that
 * typechecks on both sides and is wrong in the middle.
 *
 * Everything here is pure and free of `@/db`, `@/auth` and the DOM, which is
 * what lets `lib/search-endpoint.test.ts` assert the whole contract against
 * literals in plain Node — docs/testing.md, "prefer no DOM".
 *
 * ## What deliberately is not here
 *
 * Any searching. `searchPeopleByName` (`lib/people.ts`) and `searchEntries`
 * (`lib/pages.ts`) are the two backends E8-T2 and E8-T1 landed, and this
 * ticket calls them rather than re-querying around them. What this module
 * owns is only what happens to their answers on the way to a dropdown:
 * truncation, and saying so.
 */

/**
 * Where the browser asks. One route handler, and the first this application
 * has ever had that is not Auth.js's own — see `app/api/search/route.ts` for
 * why a typeahead cannot be a server action.
 */
export const SEARCH_ENDPOINT = "/api/search";

/**
 * The query parameter, shared with `/search` itself.
 *
 * The same `q` that `app/search/page.tsx`'s `<input name="q">` posts, so a
 * reader who looks at one URL has learned the other. Naming them separately
 * would be inventing a second convention for one question.
 */
export const SEARCH_QUERY_PARAM = "q";

/**
 * How many results per group the header's dropdown shows — deliberately not
 * the twenty `/search` shows, and the difference is disclosed rather than
 * hidden.
 *
 * `lib/entry-search.ts` argues twenty for a page: "a full page with room to
 * scroll". A dropdown pinned under a 3rem header is bounded by the viewport
 * instead. On the 667px phone `components/SiteHeader.tsx` already sizes
 * itself against, two group labels plus five person rows plus five two-line
 * entry rows plus the footer row comes to roughly 560px — five is where the
 * panel stops needing a scrollbar of its own competing with the page's, and
 * where "the answer is in this list" is a glance rather than a scan.
 *
 * What keeps this honest is `peopleHasMore`/`entriesHasMore` and the "See
 * all results" row: the dropdown never implies it is the whole answer.
 */
export const SUGGESTION_LIMIT = 5;

/**
 * The shortest query worth asking the database about.
 *
 * One character is the beginning of a name, not a name, and both backends
 * answer it badly for different reasons. `websearch_to_tsquery` finds no
 * lexemes at all in a single stop word, so entries come back empty; and
 * `searchPeople` given `"a"` matches most of the family through its literal
 * prefix tier and returns an arbitrary slice of it. Neither is an answer, and
 * asking costs a full read of `individuals` (see `lib/people.ts`).
 *
 * `components/SearchSuggestions.tsx` says so rather than showing nothing —
 * a box that goes quiet without explaining itself is the thing this avoids.
 */
export const MIN_SUGGESTION_QUERY = 2;

/**
 * One query's worth of answer, as it crosses the wire.
 *
 * `people` before `entries`, under those names and in that order, because
 * those are `app/search/page.tsx`'s two `<h2>`s in the page's order — and its
 * reason ("people first because a family wiki is a family: the commonest
 * thing to search for is a person") is settled and should not be
 * re-litigated by a second surface rendering the same two groups.
 *
 * `query` is echoed back, and it is load-bearing rather than a convenience:
 * it is how `lib/suggestion-state.ts` knows whether an answer that has just
 * landed is an answer to the question currently in the box. See
 * `responseArrived` there for why that beats a sequence counter.
 *
 * The two `hasMore` flags are booleans rather than totals. A true total would
 * mean widening `searchPeople`'s return type — it ranks the whole table in
 * TypeScript, so it has the number for free — and a second `count(*)` on the
 * Postgres side, where it does not. That is real churn on two landed tickets
 * for a number nothing renders: the dropdown says "See all results", not
 * "See the other 43".
 */
export type SearchSuggestions = {
  query: string;
  people: PersonMatch[];
  peopleHasMore: boolean;
  entries: EntryMatch[];
  entriesHasMore: boolean;
};

/** The answer to a query nothing was asked about. */
export function emptySuggestions(query: string): SearchSuggestions {
  return {
    query,
    people: [],
    peopleHasMore: false,
    entries: [],
    entriesHasMore: false,
  };
}

/**
 * One search parameter, or nothing.
 *
 * `?q=a&q=b` arrives as two values and there is no defensible way to choose
 * between them — the argument is `app/search/page.tsx`'s, which used to make
 * it with a private `singleParam` and now calls this instead. That sharing is
 * the point: the header's box and the results page must not disagree about
 * what a hand-edited URL means, or the same link would answer two different
 * questions depending on which control read it.
 *
 * @param value one `searchParams` entry, as Next hands it to a page
 * @returns the query, trimmed; `""` for absent, empty, or repeated
 */
export function readSearchParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The same rule against a `URLSearchParams`, which is what a route handler
 * has. `getAll` rather than `get`, because `get` silently returns the first
 * of a repeated parameter — which is precisely the choice `readSearchParam`
 * refuses to make.
 */
export function readSearchQuery(params: URLSearchParams): string {
  const values = params.getAll(SEARCH_QUERY_PARAM);
  return values.length === 1 ? values[0].trim() : "";
}

/** Where the browser asks for `query`. The only place this URL is built. */
export function searchEndpointUrl(query: string): string {
  return `${SEARCH_ENDPOINT}?${SEARCH_QUERY_PARAM}=${encodeURIComponent(query)}`;
}

/** Where "See all results" goes: the full page, same query, same parameter. */
export function searchPageUrl(query: string): string {
  return `/search?${SEARCH_QUERY_PARAM}=${encodeURIComponent(query)}`;
}

/**
 * Cut each group to `SUGGESTION_LIMIT` and say whether anything was cut.
 *
 * The caller asks both backends for `SUGGESTION_LIMIT + 1` and hands the
 * answers here. Asking for six and showing five is what makes "See all
 * results" an honest affordance rather than a decoration — without the extra
 * row there is no way to distinguish "exactly five matched" from "five of
 * forty", and the dropdown would either always promise more or never.
 *
 * @param query what was asked, echoed into the payload
 * @param people up to `SUGGESTION_LIMIT + 1` ranked people
 * @param entries up to `SUGGESTION_LIMIT + 1` ranked entries
 */
export function toSuggestions(
  query: string,
  people: readonly PersonMatch[],
  entries: readonly EntryMatch[],
): SearchSuggestions {
  return {
    query,
    people: people.slice(0, SUGGESTION_LIMIT),
    peopleHasMore: people.length > SUGGESTION_LIMIT,
    entries: entries.slice(0, SUGGESTION_LIMIT),
    entriesHasMore: entries.length > SUGGESTION_LIMIT,
  };
}

/** How many results a payload holds, across both groups. */
export function suggestionCount(suggestions: SearchSuggestions): number {
  return suggestions.people.length + suggestions.entries.length;
}

/**
 * Read what came back off the wire, or `null` if it is not this shape.
 *
 * `Response.json()` is typed `any`, and this is the only place in the
 * application where a value crosses a network boundary without a compiler on
 * both ends of it at the same moment: a deploy that changes this payload
 * while a tab is open hands the old client the new shape. Narrowing here
 * turns that into `components/SearchSuggestions.tsx`'s error copy — "Search
 * is not answering just now" — instead of a `TypeError` thrown out of a
 * render on `undefined.map`.
 *
 * Deliberately shallow. It checks that the five fields exist and are the
 * right *kinds* of thing, not that every `PersonMatch` is well formed: the
 * rows come from this application's own two backends, and a per-field walk
 * would be re-declaring `PersonMatch` and `EntryMatch` in a second place
 * where they could drift. What is guarded is the shape a render iterates.
 */
export function parseSearchSuggestions(
  value: unknown,
): SearchSuggestions | null {
  if (typeof value !== "object" || value === null) return null;

  const payload = value as Record<string, unknown>;
  if (typeof payload.query !== "string") return null;
  if (!Array.isArray(payload.people) || !Array.isArray(payload.entries)) {
    return null;
  }
  if (
    typeof payload.peopleHasMore !== "boolean" ||
    typeof payload.entriesHasMore !== "boolean"
  ) {
    return null;
  }

  return {
    query: payload.query,
    people: payload.people as PersonMatch[],
    peopleHasMore: payload.peopleHasMore,
    entries: payload.entries as EntryMatch[],
    entriesHasMore: payload.entriesHasMore,
  };
}
