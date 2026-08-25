import { describe, expect, it } from "vitest";

import type { PersonMatch } from "@/lib/people-search";
import { emptySuggestions, toSuggestions } from "@/lib/search-endpoint";
import {
  SEE_ALL_OPTION_KEY,
  idleSuggestionState,
  nextOptionKey,
  requestFailed,
  requestStarted,
  responseArrived,
  shouldRequest,
  suggestionOptions,
  typed,
  type SuggestionState,
} from "@/lib/suggestion-state";

/**
 * The dropdown's reducer (E8-T3, `YEO-57`), in Node with no DOM, no timers
 * and no network. The four `describe` blocks below are the four invariants
 * `lib/suggestion-state.ts` names, and each test is named as the bug it
 * closes rather than as the function it calls.
 */

function person(id: string): PersonMatch {
  return { id, name: `Person ${id}`, lifespan: "", href: `/tree?person=${id}` };
}

/** A state with `query` asked and answered. */
function answered(
  query: string,
  people: PersonMatch[] = [person("a")],
): SuggestionState {
  return responseArrived(
    typed(idleSuggestionState, query),
    toSuggestions(query, people, []),
  );
}

describe("the status ladder", () => {
  it("opens as an invitation with nothing typed", () => {
    expect(idleSuggestionState.status).toBe("invitation");
    expect(idleSuggestionState.shown).toBeNull();
  });

  it("says a single character is too short rather than going quiet", () => {
    expect(typed(idleSuggestionState, "r").status).toBe("too-short");
  });

  it("returns to the invitation when the box is emptied", () => {
    expect(typed(answered("rose"), "").status).toBe("invitation");
  });

  it("is loading from the keystroke, before the request goes out", () => {
    expect(typed(idleSuggestionState, "rose").status).toBe("loading");
    expect(
      requestStarted(typed(idleSuggestionState, "rose"), "rose").status,
    ).toBe("loading");
  });

  it("distinguishes an answer of nothing from an answer of something", () => {
    const asking = typed(idleSuggestionState, "rose");
    expect(responseArrived(asking, emptySuggestions("rose")).status).toBe(
      "empty",
    );
    expect(
      responseArrived(asking, toSuggestions("rose", [person("a")], [])).status,
    ).toBe("results");
  });

  it("counts an entry-only answer as results", () => {
    const asking = typed(idleSuggestionState, "rose");
    const entries = [
      { id: "e", slug: "s", title: "T", href: "/wiki/s", snippet: [] },
    ];
    expect(
      responseArrived(asking, toSuggestions("rose", [], entries)).status,
    ).toBe("results");
  });

  it("reports a failure as an error", () => {
    expect(
      requestFailed(typed(idleSuggestionState, "rose"), "rose").status,
    ).toBe("error");
  });
});

describe("a response for a query that has since been retyped is dropped", () => {
  /**
   * Invariant 1. Aborting is best-effort: a response already on the wire
   * lands whether or not its request was abandoned, and without this it would
   * paint an answer to a question nobody is asking any more.
   */
  it("ignores an answer to the previous query", () => {
    const asking = typed(answered("rose"), "rosemary");
    const late = toSuggestions("rose", [person("stale")], []);

    expect(responseArrived(asking, late)).toBe(asking);
    expect(responseArrived(asking, late).shown?.query).toBe("rose");
    expect(responseArrived(asking, late).status).toBe("loading");
  });

  /**
   * And the case that makes echoing the query better than a sequence
   * counter: `cat` → `cats` → `cat` leaves the *first* response a correct
   * answer to the question now being asked. A sequence guard would throw it
   * away and re-ask; comparing the question accepts it.
   */
  it("accepts an out-of-order answer that happens to be the right one", () => {
    const asking = typed(
      typed(typed(idleSuggestionState, "cat"), "cats"),
      "cat",
    );
    const first = toSuggestions("cat", [person("a")], []);

    expect(responseArrived(asking, first).status).toBe("results");
    expect(responseArrived(asking, first).shown).toBe(first);
  });
});

describe("a failure for a stale query does not clobber fresh results", () => {
  /**
   * Invariant 2. The classic form: a cancelled request's rejection paints an
   * error banner over results that are correct and already on screen.
   */
  it("ignores a failure reported for the previous query", () => {
    const fresh = answered("rosemary");
    expect(requestFailed(fresh, "rose")).toBe(fresh);
    expect(requestFailed(fresh, "rose").status).toBe("results");
  });
});

describe("typing keeps the previous answer on screen", () => {
  /**
   * Invariant 3. The previous answer is still the best one available while
   * the next loads; blanking on every keystroke is a list that flickers.
   */
  it("carries the last answer through the next keystroke", () => {
    const next = typed(answered("rose"), "rosem");

    expect(next.status).toBe("loading");
    expect(next.shown?.query).toBe("rose");
    expect(next.shown?.people).toHaveLength(1);
  });

  /**
   * But not below the threshold, where there will never be an answer: leaving
   * the old rows standing under "keep typing" copy would be showing results
   * for a query nobody can see any more.
   */
  it("drops it when the query falls below the threshold", () => {
    expect(typed(answered("rose"), "r").shown).toBeNull();
    expect(typed(answered("rose"), "").shown).toBeNull();
  });
});

describe("a query that is already shown is not re-requested", () => {
  /**
   * Invariant 4. Typing a trailing space and deleting it should cost nothing
   * — `searchPeopleByName` reads the whole `individuals` table per call.
   */
  it("does not re-ask for the answer already on screen", () => {
    expect(shouldRequest(answered("rose"), "rose")).toBe(false);
    expect(shouldRequest(answered("rose"), "  rose  ")).toBe(false);
  });

  it("asks for anything else long enough to be a name", () => {
    expect(shouldRequest(answered("rose"), "rosemary")).toBe(true);
    expect(shouldRequest(idleSuggestionState, "ro")).toBe(true);
  });

  it("never asks below the threshold", () => {
    expect(shouldRequest(idleSuggestionState, "r")).toBe(false);
    expect(shouldRequest(idleSuggestionState, "")).toBe(false);
    expect(shouldRequest(idleSuggestionState, " ")).toBe(false);
  });

  it("normalises the query so the same question is asked once", () => {
    expect(typed(idleSuggestionState, "  rose  ").query).toBe("rose");
    expect(typed(answered("rose"), "  rose  ")).toEqual(answered("rose"));
  });
});

describe("the initial state", () => {
  /**
   * The `-state` family's shared-mutable-default argument: one module-level
   * object handed to every mount is one object every mount can write to.
   */
  it("is frozen", () => {
    expect(Object.isFrozen(idleSuggestionState)).toBe(true);
  });
});

describe("the rows a keyboard can reach", () => {
  const withBoth = responseArrived(
    typed(idleSuggestionState, "rose"),
    toSuggestions(
      "rose",
      [person("a"), person("b")],
      [{ id: "e1", slug: "s1", title: "T1", href: "/wiki/s1", snippet: [] }],
    ),
  );

  it("flattens both groups and ends with the way to the full page", () => {
    expect(suggestionOptions(withBoth).map((o) => o.key)).toEqual([
      "person-a",
      "person-b",
      "entry-e1",
      SEE_ALL_OPTION_KEY,
    ]);
  });

  it("prefixes the keys by group, since two tables can share a uuid", () => {
    const clash = responseArrived(
      typed(idleSuggestionState, "rose"),
      toSuggestions(
        "rose",
        [person("x")],
        [{ id: "x", slug: "s", title: "T", href: "/wiki/s", snippet: [] }],
      ),
    );
    const keys = suggestionOptions(clash).map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("points the last row at the results page for the same query", () => {
    const seeAll = suggestionOptions(withBoth).at(-1);
    expect(seeAll?.href).toBe("/search?q=rose");
  });

  /**
   * No rows, and in particular no "See all results": a page that will also
   * be empty is a dead end dressed as an escape hatch.
   */
  it.each([
    [
      "nothing matched",
      responseArrived(
        typed(idleSuggestionState, "rose"),
        emptySuggestions("rose"),
      ),
    ],
    [
      "the request failed",
      requestFailed(typed(idleSuggestionState, "rose"), "rose"),
    ],
    ["nothing is typed", idleSuggestionState],
    ["the query is too short", typed(idleSuggestionState, "r")],
  ])("offers nothing to arrow through when %s", (_label, state) => {
    expect(suggestionOptions(state)).toEqual([]);
  });

  /**
   * Rows that are still on screen while the next answer loads (invariant 3)
   * stay usable: they are real links to real people, and a better answer
   * being on its way does not make them inert. Drawing them and not listing
   * them here would make them mouse-only.
   */
  it("keeps the rows reachable while the next answer is in flight", () => {
    const loading = typed(withBoth, "rosem");
    expect(loading.status).toBe("loading");
    expect(suggestionOptions(loading).map((o) => o.key)).toEqual([
      "person-a",
      "person-b",
      "entry-e1",
    ]);
  });

  /**
   * But not the footer, which names the *current* query — offering "See all
   * results for “rosem”" above the rows for "rose" would be a lie, and it is
   * the one row whose target depends on the query rather than on a result.
   */
  it("withholds the way to the full page until the answer has settled", () => {
    expect(
      suggestionOptions(typed(withBoth, "rosem")).map((o) => o.key),
    ).not.toContain(SEE_ALL_OPTION_KEY);
  });

  it("moves down and up, wrapping at both ends", () => {
    const options = suggestionOptions(withBoth);
    expect(nextOptionKey(options, null, 1)).toBe("person-a");
    expect(nextOptionKey(options, "person-a", 1)).toBe("person-b");
    expect(nextOptionKey(options, SEE_ALL_OPTION_KEY, 1)).toBe("person-a");
    expect(nextOptionKey(options, "person-a", -1)).toBe(SEE_ALL_OPTION_KEY);
  });

  /** Nothing active is the position before the first row, in both directions. */
  it("puts the first ArrowUp on the last row", () => {
    expect(nextOptionKey(suggestionOptions(withBoth), null, -1)).toBe(
      SEE_ALL_OPTION_KEY,
    );
  });

  it("leaves the keystroke alone when there is nothing to move through", () => {
    expect(nextOptionKey([], null, 1)).toBeNull();
  });

  it("starts over when the active row has gone from under it", () => {
    expect(nextOptionKey(suggestionOptions(withBoth), "person-gone", 1)).toBe(
      "person-a",
    );
  });
});

describe("returning to a query already answered", () => {
  /**
   * Without this the status would sit at `loading` forever: `shouldRequest`
   * declines to ask again, so no response ever arrives to move it on, and the
   * dropdown shows its results under a spinner that never stops.
   */
  it("goes straight back to results rather than loading", () => {
    const detour = typed(answered("rose"), "rosemary");
    const back = typed(detour, "rose");

    expect(back.status).toBe("results");
    expect(back.shown?.query).toBe("rose");
    expect(shouldRequest(back, "rose")).toBe(false);
  });

  it("does the same for a query that answered with nothing", () => {
    const none = responseArrived(
      typed(idleSuggestionState, "zzz"),
      emptySuggestions("zzz"),
    );
    expect(typed(typed(none, "zzzz"), "zzz").status).toBe("empty");
  });
});
