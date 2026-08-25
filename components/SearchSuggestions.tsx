import Link from "next/link";

import {
  SEE_ALL_OPTION_KEY,
  type SuggestionState,
} from "@/lib/suggestion-state";

/**
 * What the header's search box shows underneath itself (E8-T3, `YEO-57`):
 * two groups of results under two headings, or the one sentence that says
 * why there are none.
 *
 * ## Why this is split out of `components/SearchBox.tsx`
 *
 * The same reason `components/PersonSearchResults.tsx` and
 * `components/EntrySearchResults.tsx` are split out of `app/search/page.tsx`,
 * one step further along. There the obstacle was that an `async` Server
 * Component cannot be mounted; here it is that a component which debounces,
 * fetches and aborts cannot be *asserted* without all three. Everything the
 * ticket's second and fourth acceptance criteria ask for — the grouping, the
 * headings, the empty and no-results copy — is a pure function of
 * `SuggestionState`, so it lives where `components/SearchSuggestions.test.tsx`
 * can render it against a literal with no `fetch` anywhere in sight.
 *
 * ## Why a listbox with groups, and not a dialogue with `<h2>`s
 *
 * The box is a `role="combobox"` (see `SearchBox`), which is the pattern
 * screen readers genuinely implement: NVDA and JAWS switch to forms mode on
 * entry, announce that suggestions are available, and read each option out as
 * `aria-activedescendant` moves — with focus never leaving the input, which
 * is what makes arrowing through results while still typing coherent.
 *
 * Inside a `role="listbox"` the only permitted children are `option` and
 * `group`. So "results grouped under clear headings" is `role="group"` with
 * `aria-labelledby` pointing at the label, and what a reader hears is
 * *"People, group, Rose Hale, 1 of 6"* — the criterion met in the form it is
 * actually consumed in. A literal `<h2>` in here would be invalid, and worse:
 * silently **not announced**, because forms mode is a mode in which headings
 * do not exist. The label is styled to read as a heading and marked
 * `role="presentation"` so it is announced once, as the group's name, rather
 * than twice.
 *
 * ## Why the options are links
 *
 * `role="option"` on an `<a href>` draws an objection — an option should not
 * be independently interactive — and the objection loses to what a reader
 * gives up otherwise: middle-click, ⌘-click to a new tab, "copy link
 * address", and the status bar telling you where a result goes before you
 * commit to it. A search result that cannot be opened in a new tab has
 * forgotten what it is. `role` replaces the accessibility role and does not
 * disable the browser's link behaviour, so the combobox owns the keyboard and
 * the browser keeps the mouse. `tabIndex={-1}` is what keeps them out of the
 * tab order, where the combobox is supposed to be the single stop.
 *
 * ## Why the rows are copied rather than imported
 *
 * `PersonSearchResults` and `EntrySearchResults` render `<ul role="list">`
 * with `<Link>` children, which is neither a `group` nor an `option`, so
 * reusing them here would mean parameterising both over their own markup.
 * The fifteen lines below are duplicated deliberately; what is shared is the
 * *decisions* — a lifespan rendered only when there is one, a snippet only
 * when the entry has a body — and each of those carries the pointer back to
 * where it was argued.
 */

/** The two group headings, and the ticket's "clear headings" in one place. */
const GROUP_LABELS = { people: "People", entries: "Entries" } as const;

export function SearchSuggestions({
  state,
  listboxId,
  optionId,
  activeKey,
  statusId,
}: {
  state: SuggestionState;
  /** The id the combobox points `aria-controls` at. */
  listboxId: string;
  /** A row key from `suggestionOptions` to the DOM id rendered for it. */
  optionId: (key: string) => string;
  /** The row `aria-activedescendant` names, or `null` for none. */
  activeKey: string | null;
  /** The live region's id, so the combobox can `aria-describedby` it. */
  statusId: string;
}) {
  const shown = state.shown;
  const people = shown?.people ?? [];
  const entries = shown?.entries ?? [];

  /**
   * Results stay on screen while the next request is in flight — see
   * invariant 3 in `lib/suggestion-state.ts`. `aria-busy` is how that is
   * announced without the list flickering: same rows, same order, one
   * attribute saying a better answer is coming.
   */
  const busy = state.status === "loading";

  /**
   * Whether to draw the rows at all — and it is a question about the
   * **status**, not only about whether `shown` happens to hold something.
   *
   * `requestFailed` deliberately keeps `shown`, so that a failure for a query
   * that has since been retyped cannot clobber results that are still
   * correct (invariant 2). The consequence, if this branched on `shown`
   * alone, is the inverse bug and a worse one: a request for the *current*
   * query fails, `shown` still holds the previous query's answer, and the
   * panel renders those rows as though they were the answer to what was just
   * typed — with the error sentence reaching only the live region, so a
   * screen-reader user is told search is down while a sighted user is shown
   * confident, wrong results.
   *
   * So `error` and `empty` fall through to `quietMessage` no matter what is
   * cached behind them. `loading` keeps its rows, which is the whole of
   * invariant 3.
   */
  const hasResults =
    (state.status === "results" || state.status === "loading") &&
    (people.length > 0 || entries.length > 0);

  /**
   * The "See all results" row exists only for a settled answer, which makes
   * this exactly `suggestionOptions`' own condition — and that agreement is
   * the point rather than a coincidence. `suggestionOptions` returns `[]` for
   * any other status, so a row rendered here while loading would be visible
   * and clickable by mouse and unreachable by keyboard, which is an
   * operability failure rather than a cosmetic one. It would also be a lie:
   * "See all results for “rosemary”" sitting above the rows for "rose".
   */
  const showSeeAll = state.status === "results";

  return (
    <div className="max-h-[min(70vh,32rem)] overflow-y-auto overscroll-contain rounded-panel border border-rule bg-paper p-2 shadow-lg">
      {/*
        What is actually spoken. The listbox itself is only read as it is
        arrowed through, so a count of what arrived has to be announced
        separately — `components/DateField.tsx` is the precedent for a polite
        region beside a control rather than inside it. Outside the listbox,
        because a `role="listbox"` may not contain prose.
      */}
      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {spokenStatus(state)}
      </p>

      {hasResults ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Search suggestions"
          aria-busy={busy}
        >
          {people.length > 0 ? (
            <Group label={GROUP_LABELS.people} name={`${listboxId}-people`}>
              {people.map((match) => (
                <Option
                  key={match.id}
                  id={optionId(`person-${match.id}`)}
                  href={match.href}
                  selected={activeKey === `person-${match.id}`}
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-ink">{match.name}</span>
                    {/*
                      Rendered only when there is one. `match.lifespan` is `""`
                      for somebody with no dates recorded, and an empty
                      parenthetical reads as a defect rather than as an honest
                      gap — see `formatLifespan`.
                    */}
                    {match.lifespan ? (
                      <span className="text-note text-ink-muted">
                        {match.lifespan}
                      </span>
                    ) : null}
                  </span>
                </Option>
              ))}
            </Group>
          ) : null}

          {entries.length > 0 ? (
            <Group label={GROUP_LABELS.entries} name={`${listboxId}-entries`}>
              {entries.map((match) => (
                <Option
                  key={match.id}
                  id={optionId(`entry-${match.id}`)}
                  href={match.href}
                  selected={activeKey === `entry-${match.id}`}
                >
                  <span className="block text-ink">{match.title}</span>
                  {/*
                    An entry created but never written into has an empty body,
                    so `ts_headline` has nothing to excerpt and `parseSnippet`
                    returns no segments — a blank line under the title would
                    read as a rendering fault. See `EntrySearchResults`.
                  */}
                  {match.snippet.length > 0 ? (
                    <span className="line-clamp-2 block text-caption text-ink-muted">
                      {match.snippet.map((segment, index) =>
                        segment.matched ? (
                          <mark
                            key={index}
                            className="bg-transparent font-semibold text-ink"
                          >
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={index}>{segment.text}</span>
                        ),
                      )}
                    </span>
                  ) : null}
                </Option>
              ))}
            </Group>
          ) : null}

          {/*
            The disclosure that keeps `SUGGESTION_LIMIT` honest: this panel
            shows five per group where `/search` shows twenty, and it says so
            rather than implying it is the whole answer. Present whenever
            there is a settled answer — not only when a group overflowed —
            because the page is also where the snippets have room to breathe.
          */}
          {showSeeAll ? (
            <Option
              id={optionId(SEE_ALL_OPTION_KEY)}
              href={`/search?q=${encodeURIComponent(state.query)}`}
              selected={activeKey === SEE_ALL_OPTION_KEY}
            >
              <span className="text-caption text-link">
                {`See all results for “${state.query}”`}
              </span>
            </Option>
          ) : null}
        </div>
      ) : (
        // No listbox at all rather than an empty one: an expanded listbox
        // holding nothing is announced as an empty listbox, which is a worse
        // answer than a collapsed one. The panel is still shown, because the
        // sentence in it is the point. See `SearchBox`'s `aria-expanded`.
        <p className="px-2 py-1.5 text-caption text-ink-muted">
          {quietMessage(state)}
        </p>
      )}
    </div>
  );
}

/** One heading and the rows under it. */
function Group({
  label,
  name,
  children,
}: {
  label: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={name} className="mb-1 last:mb-0">
      {/*
        `role="presentation"` so this is announced once — as the group's
        accessible name, via `aria-labelledby` — rather than a second time as
        a stray text node inside the listbox.
      */}
      <div
        id={name}
        role="presentation"
        className="border-b border-rule-soft px-2 pt-1 pb-0.5 text-note font-bold text-ink-muted uppercase"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * One navigable row. See the docblock above for why it is a link at all.
 *
 * `next/link` rather than a bare `<a>`, which is what makes Enter on a
 * highlighted row a client-side transition instead of a full page load — and
 * it is also why `components/SearchBox.tsx` needs no `useRouter`: activating
 * the row *is* clicking the link, so there is one navigation path rather than
 * two that have to be kept in step.
 *
 * `prefetch={false}` deliberately. A dropdown re-renders up to eleven of
 * these on every debounce tick, and Next's default would have each one fetch
 * its route as it entered the viewport — turning a search for a common
 * surname into a burst of route requests for pages nobody has chosen to
 * visit. The transition is fast enough without it.
 */
function Option({
  id,
  href,
  selected,
  children,
}: {
  id: string;
  href: string;
  selected: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      href={href}
      prefetch={false}
      className={`block rounded-panel px-2 py-1.5 hover:no-underline ${
        selected ? "bg-wash" : ""
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * The one sentence shown when there are no rows.
 *
 * Every branch says something the reader can act on, which is the fourth
 * acceptance criterion. The voice is `app/search/page.tsx`'s — that page owns
 * the long version of each of these, and this borrows from it rather than the
 * other way round.
 */
function quietMessage(state: SuggestionState): string {
  switch (state.status) {
    case "invitation":
      return "Search people and entries. Names are matched through spelling variants, and entries are matched on what is written in them, not just their titles.";
    case "too-short":
      // Honest about *why* nothing is happening, which is the thing a box
      // that simply goes quiet never tells anybody. See MIN_SUGGESTION_QUERY.
      return "Keep typing — one letter is the beginning of a name, not a name.";
    case "loading":
      return "Searching…";
    case "error":
      /**
       * The only copy here that both explains and repairs. The form around
       * this panel is a real GET form, so Enter still reaches `/search` — and
       * if the cause was a session that expired in another tab, that page's
       * own `requireSession()` sends the reader to `/signin`, which is the
       * correct outcome. That is why this points at Enter rather than at a
       * Retry button that would fail the same way.
       */
      return "Search is not answering just now. Press Enter to search the full page instead.";
    default:
      return `Nothing matches “${state.query}”. Spelling variants are already tried for names, and entries are searched on their whole text — so this is not in the wiki yet.`;
  }
}

/** What the live region announces: a count, or the reason there is not one. */
function spokenStatus(state: SuggestionState): string {
  if (state.shown === null || state.status !== "results") {
    return quietMessage(state);
  }

  const people = state.shown.people.length;
  const entries = state.shown.entries.length;

  return `${people === 1 ? "1 person" : `${people} people`} and ${
    entries === 1 ? "1 entry" : `${entries} entries`
  } match “${state.query}”.`;
}
