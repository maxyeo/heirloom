import {
  MIN_SUGGESTION_QUERY,
  searchPageUrl,
  type SearchSuggestions,
  suggestionCount,
} from "@/lib/search-endpoint";

/**
 * What the search dropdown is showing, and how a keystroke or an answer
 * changes it (E8-T3, `YEO-57`).
 *
 * ## Why it is a `-state` module, and how it differs from the others
 *
 * `lib/removal-state.ts`, `lib/entry-link-state.ts`, `lib/merge-state.ts` and
 * `lib/union-order-state.ts` are all here for one reason: a `"use server"`
 * module may only export async functions, so a `useActionState` shape has to
 * live somewhere else. This module is not that. It is a reducer for a
 * **client-side asynchronous read**, which is the first one in this codebase
 * — because until this ticket nothing in this application fetched anything.
 *
 * What it shares with them is the thing worth sharing: the decisions are
 * plain functions over plain values, so `lib/suggestion-state.test.ts`
 * asserts them in Node with no DOM, no timers and no network, and
 * `components/SearchBox.tsx` is left holding only the wiring.
 *
 * ## The four invariants, each of which is a real bug
 *
 * Every function below exists to close one, and the test names say so:
 *
 * 1. **A late answer to an old question is dropped.** Aborting is
 *    best-effort; a response already on the wire lands whether or not its
 *    request was abandoned. `responseArrived` compares the payload's own
 *    echoed `query` against what is in the box now.
 * 2. **A late *failure* for an old question is dropped too.** The classic
 *    form of this is a cancelled request's rejection painting an error banner
 *    over fresh, correct results.
 * 3. **Typing never blanks what is on screen.** The previous answer is still
 *    the best one available while the next loads, and a list that empties on
 *    every keystroke is a list that flickers.
 * 4. **Nothing is asked twice.** Typing a trailing space and deleting it
 *    should cost nothing, and `searchPeopleByName` reads the whole
 *    `individuals` table per call.
 */

/**
 * Which of the dropdown's states is showing.
 *
 * `invitation` and `too-short` are distinct on purpose: both show no results,
 * but only one of them is the box refusing to answer yet, and a box that goes
 * quiet without saying why is the thing the fourth acceptance criterion is
 * about. See `components/SearchSuggestions.tsx` for the copy.
 */
export type SuggestionStatus =
  "invitation" | "too-short" | "loading" | "results" | "empty" | "error";

export type SuggestionState = {
  /** What is in the box, trimmed. The question currently being asked. */
  query: string;
  /**
   * The last answer accepted, which may be to an *earlier* query while the
   * current one is still in flight. That gap is invariant 3, not a bug: the
   * component shows these rows with `aria-busy` set rather than blanking.
   */
  shown: SearchSuggestions | null;
  status: SuggestionStatus;
};

/**
 * Nothing typed, nothing asked, nothing shown.
 *
 * Frozen for the reason the `-state` family freezes its own initial values: a
 * module-level object handed to every mount is a shared mutable default, and
 * the failure it produces — one search box's state leaking into the next
 * page's — is the kind that shows up once in a hundred navigations.
 */
export const idleSuggestionState: SuggestionState = Object.freeze({
  query: "",
  shown: null,
  status: "invitation",
});

/** Which state a query with no request behind it should be resting in. */
function quietStatus(query: string): SuggestionStatus {
  if (query === "") return "invitation";
  return query.length < MIN_SUGGESTION_QUERY ? "too-short" : "loading";
}

/**
 * The box changed.
 *
 * **`shown` is carried through untouched** — invariant 3. Only `query` moves,
 * and `status` follows it: emptied back to the invitation, one character to
 * the "keep typing" note, anything longer to `loading` because a request is
 * about to be scheduled for it.
 *
 * @param query the raw contents of the input; trimmed here so that every
 *   comparison downstream is against the same normalised form
 */
export function typed(state: SuggestionState, query: string): SuggestionState {
  const trimmed = query.trim();
  if (trimmed === state.query) return state;

  // Below the threshold there will never be an answer, so the previous one is
  // dropped rather than left standing under copy that says nothing matched.
  const keepsResults = trimmed.length >= MIN_SUGGESTION_QUERY;
  const shown = keepsResults ? state.shown : null;

  /**
   * The answer already on screen *is* the answer to this query — a trailing
   * space typed and deleted, or a word retyped after a detour. Nothing is
   * loading, so nothing should say it is: without this branch the status
   * would sit at `loading` forever, because `shouldRequest` (correctly)
   * declines to ask again and so no response ever arrives to move it on.
   */
  if (shown !== null && shown.query === trimmed) {
    return {
      query: trimmed,
      shown,
      status: suggestionCount(shown) === 0 ? "empty" : "results",
    };
  }

  return { query: trimmed, shown, status: quietStatus(trimmed) };
}

/**
 * Whether `query` is worth a round trip right now.
 *
 * Two refusals, and the second is invariant 4: below the minimum there is no
 * answer worth having (see `MIN_SUGGESTION_QUERY`), and a query whose answer
 * is already the thing on screen has already been asked.
 */
export function shouldRequest(state: SuggestionState, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < MIN_SUGGESTION_QUERY) return false;
  return state.shown?.query !== trimmed;
}

/** A request went out for `query`. Only the status moves. */
export function requestStarted(
  state: SuggestionState,
  query: string,
): SuggestionState {
  const trimmed = query.trim();
  if (trimmed !== state.query) return state;
  if (state.status === "loading") return state;
  return { ...state, status: "loading" };
}

/**
 * An answer landed — invariant 1.
 *
 * The payload's own `query`, echoed by `app/api/search/route.ts`, is what
 * decides whether it is still wanted. That is strictly better than a sequence
 * counter, and the case that proves it is ordinary: typing `cat` → `cats` →
 * `cat` leaves the *first* response as a perfectly correct answer to the
 * question now being asked, which a sequence guard would throw away and then
 * re-ask for. Comparing the question rather than the ordinal accepts it.
 */
export function responseArrived(
  state: SuggestionState,
  response: SearchSuggestions,
): SuggestionState {
  if (response.query !== state.query) return state;

  return {
    query: state.query,
    shown: response,
    status: suggestionCount(response) === 0 ? "empty" : "results",
  };
}

/**
 * A request failed — invariant 2.
 *
 * Stale failures are dropped exactly as stale successes are. What this must
 * never see is an *abort*: every keystroke cancels the request before it, and
 * every cancellation rejects that request's promise, so routing aborts here
 * would paint the error state on every keystroke while the correct results
 * render behind it. That check belongs at the fetch site, where the signal
 * is, and `components/SearchBox.tsx` makes it there and says why.
 */
export function requestFailed(
  state: SuggestionState,
  query: string,
): SuggestionState {
  if (query.trim() !== state.query) return state;
  return { ...state, status: "error" };
}

/**
 * One navigable row in the dropdown: a stable key for
 * `aria-activedescendant`, and where Enter goes.
 *
 * Flattened across both groups because that is how a keyboard moves through
 * a listbox — ArrowDown from the last person lands on the first entry, and
 * the group boundary is something a screen reader announces rather than
 * something the cursor stops at.
 */
export type SuggestionOption = {
  key: string;
  href: string;
};

/** The key of the row that opens the full results page. */
export const SEE_ALL_OPTION_KEY = "see-all";

/**
 * Every row a keystroke can reach, in the order it is rendered.
 *
 * Empty unless there is actually an answer on screen. That covers the two
 * cases that would otherwise be navigable and shouldn't be: an `empty`
 * status has no rows at all, and it deliberately carries **no "See all
 * results"** either — sending somebody to a page that will also be empty is
 * a dead end dressed as an escape hatch.
 *
 * The keys are prefixed by group rather than being the ids alone: a person
 * and an entry are different tables and nothing stops them sharing a uuid.
 */
export function suggestionOptions(state: SuggestionState): SuggestionOption[] {
  if (state.status !== "results" || state.shown === null) return [];

  return [
    ...state.shown.people.map((match) => ({
      key: `person-${match.id}`,
      href: match.href,
    })),
    ...state.shown.entries.map((match) => ({
      key: `entry-${match.id}`,
      href: match.href,
    })),
    { key: SEE_ALL_OPTION_KEY, href: searchPageUrl(state.shown.query) },
  ];
}

/**
 * Where ArrowUp/ArrowDown goes from here.
 *
 * Wraps at both ends, and — the part worth having a function for — treats
 * "nothing active" as the position *before* the first row, so the first
 * ArrowDown lands on the first result and the first ArrowUp lands on the
 * last. Returns `null` when there is nothing to move through, which is the
 * caller's signal to leave the keystroke to the browser.
 */
export function nextOptionKey(
  options: readonly SuggestionOption[],
  activeKey: string | null,
  delta: 1 | -1,
): string | null {
  if (options.length === 0) return null;

  const current = options.findIndex((option) => option.key === activeKey);
  if (current === -1)
    return delta === 1 ? options[0].key : options[options.length - 1].key;

  const next = (current + delta + options.length) % options.length;
  return options[next].key;
}
