// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { SearchSuggestions } from "@/components/SearchSuggestions";
import type { EntryMatch } from "@/lib/entry-search";
import type { PersonMatch } from "@/lib/people-search";
import { emptySuggestions, toSuggestions } from "@/lib/search-endpoint";
import {
  SEE_ALL_OPTION_KEY,
  idleSuggestionState,
  requestFailed,
  responseArrived,
  typed,
  type SuggestionState,
} from "@/lib/suggestion-state";
import { render } from "@/test/render";

/**
 * The dropdown's markup, ARIA and copy — and **no `fetch` anywhere in this
 * file**, which is the whole reason this component is split out of
 * `components/SearchBox.tsx`. The grouping and the four states are a pure
 * function of `SuggestionState`, so they are asserted against literals here;
 * the debouncing, aborting and keystroke handling are `SearchBox.test.tsx`'s.
 *
 * The group assertions deliberately resolve `aria-labelledby` rather than
 * looking for a class name or an `<h2>`. What the ticket asks for is "results
 * grouped under clear headings", and inside a `role="listbox"` what a screen
 * reader announces as the heading is whatever that attribute points at — see
 * `components/SearchSuggestions.tsx` for why a literal `<h2>` here would be
 * both invalid and silent.
 */

function person(overrides: Partial<PersonMatch> & { id: string }): PersonMatch {
  return {
    name: "Someone",
    lifespan: "",
    href: `/tree?person=${overrides.id}`,
    ...overrides,
  };
}

function entry(overrides: Partial<EntryMatch> & { id: string }): EntryMatch {
  return {
    slug: overrides.id,
    title: "An entry",
    href: `/wiki/${overrides.id}`,
    snippet: [],
    ...overrides,
  };
}

/** A state holding `people` and `entries` as the answer to `query`. */
function answered(
  query: string,
  people: PersonMatch[],
  entries: EntryMatch[],
): SuggestionState {
  return responseArrived(
    typed(idleSuggestionState, query),
    toSuggestions(query, people, entries),
  );
}

function show(state: SuggestionState, activeKey: string | null = null) {
  return render(
    <SearchSuggestions
      state={state}
      listboxId="listbox"
      optionId={(key) => `option-${key}`}
      activeKey={activeKey}
      statusId="status"
    />,
  );
}

/** The text a screen reader resolves for a group's accessible name. */
function groupLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[role="group"]')].map((group) => {
    const id = group.getAttribute("aria-labelledby");
    return id === null ? "" : (host.querySelector(`#${id}`)?.textContent ?? "");
  });
}

const bothGroups = answered(
  "rose",
  [person({ id: "p1", name: "Rose Hale", lifespan: "1910–1994" })],
  [entry({ id: "e1", title: "The Hale family" })],
);

describe("grouping", () => {
  it("puts the two kinds of answer under their own headings", () => {
    expect(groupLabels(show(bothGroups))).toEqual(["People", "Entries"]);
  });

  it("puts people before entries, as the results page does", () => {
    const host = show(bothGroups);
    const text = host.textContent ?? "";
    expect(text.indexOf("People")).toBeLessThan(text.indexOf("Entries"));
  });

  it("renders one listbox holding every option", () => {
    const host = show(bothGroups);
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    // Two results plus the row that leads to the full page.
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it("omits a group nothing matched in rather than showing an empty heading", () => {
    const peopleOnly = answered("rose", [person({ id: "p1" })], []);
    expect(groupLabels(show(peopleOnly))).toEqual(["People"]);
  });

  it("makes every option a real link, so a result can be opened in a new tab", () => {
    const options = [...show(bothGroups).querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.getAttribute("href"))).toEqual([
      "/tree?person=p1",
      "/wiki/e1",
      "/search?q=rose",
    ]);
    // Out of the tab order: the combobox is the single tab stop.
    expect(options.every((o) => o.getAttribute("tabindex") === "-1")).toBe(
      true,
    );
  });
});

describe("what a row shows", () => {
  it("shows a lifespan beside a person who has one", () => {
    expect(show(bothGroups).textContent).toContain("1910–1994");
  });

  it("renders no empty parenthetical for a person with no dates", () => {
    const host = show(
      answered("x", [person({ id: "p1", name: "Nobody" })], []),
    );
    expect(host.textContent).toContain("Nobody");
    expect(host.textContent).not.toContain("()");
    expect(host.textContent).not.toContain("–");
  });

  it("marks the matched run of an entry's snippet", () => {
    const host = show(
      answered(
        "hale",
        [],
        [
          entry({
            id: "e1",
            snippet: [
              { text: "the ", matched: false },
              { text: "Hale", matched: true },
              { text: " family", matched: false },
            ],
          }),
        ],
      ),
    );

    const marks = [...host.querySelectorAll("mark")];
    expect(marks.map((m) => m.textContent)).toEqual(["Hale"]);
    expect(host.textContent).toContain("the Hale family");
  });

  it("renders nothing under the title of an entry with an empty body", () => {
    // `parseSnippet` returns no segments for an entry never written into; a
    // blank line would read as a rendering fault. See `EntrySearchResults`.
    const host = show(answered("x", [], [entry({ id: "e1", snippet: [] })]));
    expect(host.querySelectorAll("mark")).toHaveLength(0);
  });
});

describe("the active row", () => {
  it("marks exactly one option selected", () => {
    const host = show(bothGroups, "entry-e1");
    const selected = [...host.querySelectorAll('[aria-selected="true"]')];

    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("id")).toBe("option-entry-e1");
  });

  it("marks none when nothing is active", () => {
    expect(
      show(bothGroups).querySelectorAll('[aria-selected="true"]'),
    ).toHaveLength(0);
  });
});

describe("the way to the full results page", () => {
  /**
   * The disclosure that keeps `SUGGESTION_LIMIT` honest: five per group here
   * against twenty there, said out loud rather than implied.
   */
  it("offers it whenever there is an answer", () => {
    const host = show(bothGroups);
    expect(host.textContent).toContain("See all results for “rose”");
    expect(
      host.querySelector(`#option-${SEE_ALL_OPTION_KEY}`)?.getAttribute("href"),
    ).toBe("/search?q=rose");
  });

  /** A page that will also be empty is a dead end dressed as an escape hatch. */
  it("does not offer it when nothing matched", () => {
    const none = responseArrived(
      typed(idleSuggestionState, "zzz"),
      emptySuggestions("zzz"),
    );
    expect(show(none).textContent).not.toContain("See all results");
  });
});

describe("the states that show no rows", () => {
  it("invites a query before anything is typed", () => {
    const host = show(idleSuggestionState);
    expect(host.textContent).toContain("Search people and entries");
    expect(host.textContent).toContain("spelling variants");
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(0);
  });

  it("says why one letter is not enough, rather than going quiet", () => {
    expect(show(typed(idleSuggestionState, "r")).textContent).toContain(
      "one letter is the beginning of a name",
    );
  });

  it("names the query that matched nothing, and says where it looked", () => {
    const none = responseArrived(
      typed(idleSuggestionState, "zzz"),
      emptySuggestions("zzz"),
    );
    const text = show(none).textContent ?? "";

    expect(text).toContain("Nothing matches “zzz”");
    expect(text).toContain("Spelling variants are already tried");
    expect(text).toContain("entries are searched on their whole text");
  });

  /**
   * The one state that both explains and repairs: the form is still a real
   * GET form, so Enter reaches `/search` — and if the cause was an expired
   * session, that page sends the reader to `/signin`, which is correct.
   */
  it("tells the reader what still works when search is not answering", () => {
    const failed = requestFailed(typed(idleSuggestionState, "rose"), "rose");
    const text = show(failed).textContent ?? "";

    expect(text).toContain("Search is not answering just now");
    expect(text).toContain("Press Enter");
  });

  it("says it is searching when there is nothing to show yet", () => {
    expect(show(typed(idleSuggestionState, "rose")).textContent).toContain(
      "Searching…",
    );
  });
});

describe("what is announced", () => {
  it("counts both groups in a polite region outside the listbox", () => {
    const host = show(bothGroups);
    const status = host.querySelector("#status");

    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("1 person and 1 entry match “rose”.");
    // Prose is not permitted inside a listbox, and the listbox is only read
    // as it is arrowed through in any case.
    expect(host.querySelector('[role="listbox"] #status')).toBeNull();
  });

  it("pluralises each group on its own", () => {
    const host = show(
      answered("rose", [person({ id: "a" }), person({ id: "b" })], []),
    );
    expect(host.querySelector("#status")?.textContent).toBe(
      "2 people and 0 entries match “rose”.",
    );
  });
});

describe("a request in flight over results already on screen", () => {
  /**
   * Invariant 3 in `lib/suggestion-state.ts`, from the rendering end: the
   * previous answer stays put and one attribute says a better one is coming.
   * Blanking to a spinner on every keystroke is a list that flickers.
   */
  it("keeps the rows and marks the listbox busy", () => {
    const host = show(typed(bothGroups, "rosem"));

    expect(host.textContent).toContain("Rose Hale");
    expect(
      host.querySelector('[role="listbox"]')?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("is not busy once the answer has landed", () => {
    expect(
      show(bothGroups)
        .querySelector('[role="listbox"]')
        ?.getAttribute("aria-busy"),
    ).toBe("false");
  });
});
