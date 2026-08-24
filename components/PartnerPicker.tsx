"use client";

import { useMemo, useState } from "react";

import type { GraphPerson } from "@/lib/family-graph";
import { type PartnerCandidate, searchPartners } from "@/lib/partner-search";

/**
 * Choosing who somebody married (E3-T4, `YEO-32`).
 *
 * ## Why searching and creating are one control
 *
 * The ticket asks for a picker that "searches existing people **or** creates a
 * new one inline", and the word doing the work is *inline*. The alternative —
 * a picker that only finds people, and a separate "add a person" page to visit
 * when it does not — is the flow that makes a family tree tedious to enter:
 * the author is halfway through recording a marriage, discovers the wife is
 * not in the tree yet, and has to leave, add her, come back, and find her
 * again. Half the people in a real tree arrive as somebody's spouse, so that
 * detour is the common path rather than the exception.
 *
 * So the "not there yet" answer sits *underneath the results*, carrying what
 * was typed. It appears whether or not anything matched, because two people
 * with the same name is the normal case in genealogy and a list containing a
 * different Thomas Hale is not an answer.
 *
 * ## Why it holds no form field of its own
 *
 * This component reports a choice and renders nothing the form posts. The
 * hidden `partnerId` input lives in `AddSpouseForm`, next to the mode it
 * belongs with — which is what lets this file be mounted in a test with no
 * server action, no `useActionState`, and therefore no `@/db` anywhere in its
 * import graph (docs/testing.md, "npm test must never need a database").
 *
 * ## Why the search is not debounced
 *
 * There is nothing to debounce against. The graph is already in the browser
 * because the layout is computed there, and a family tree is hundreds of
 * people at most — so a keystroke costs one pass over an array, and a delay
 * would only make the list feel slower than the typing.
 */
export interface PartnerPickerProps {
  /** Everyone on the tree, as the canvas already holds them. */
  people: readonly GraphPerson[];
  /** People to leave out — the person gaining a spouse, above all. */
  excludeIds?: readonly string[];
  /** The person chosen so far, or null while the author is still looking. */
  selected: PartnerCandidate | null;
  onSelect: (candidate: PartnerCandidate) => void;
  /** Undo the choice and go back to searching. */
  onClear: () => void;
  /** "They are not in the tree yet" — carrying whatever was typed. */
  onCreateNew: (query: string) => void;
  /** So the caller's `<label>` can point at the search box. */
  inputId?: string;
  /** The id of a message to announce with the field, when there is one. */
  describedBy?: string;
  invalid?: boolean;
}

export function PartnerPicker({
  people,
  excludeIds,
  selected,
  onSelect,
  onClear,
  onCreateNew,
  inputId,
  describedBy,
  invalid = false,
}: PartnerPickerProps) {
  const [query, setQuery] = useState("");

  const results = useMemo(
    () => searchPartners(people, query, { excludeIds }),
    [people, query, excludeIds],
  );

  /**
   * Once somebody is chosen the search box is gone, replaced by the answer and
   * a way to undo it. Leaving the list on screen would let a second click
   * silently replace a choice the author had already made and stopped looking
   * at.
   */
  if (selected) {
    return (
      <div className="mt-1 flex items-center justify-between gap-2 rounded-panel border border-rule-soft bg-panel px-2 py-1.5">
        <span className="min-w-0 truncate">
          {selected.name}
          {selected.lifespan ? (
            <span className="text-ink-muted"> ({selected.lifespan})</span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 text-note text-link hover:underline"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name or year"
        // Off, because the browser's own history of what was typed into a
        // field called "partner" is noise over a list of actual family members.
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="mt-1 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink"
      />

      <ul
        aria-label="Matching people"
        className="mt-1 max-h-40 overflow-y-auto rounded-panel border border-rule-soft"
      >
        {results.length === 0 ? (
          <li className="px-2 py-1.5 text-note text-ink-muted">
            Nobody on the tree matches that.
          </li>
        ) : (
          results.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                onClick={() => onSelect(candidate)}
                className="block w-full px-2 py-1.5 text-left hover:bg-wash"
              >
                {candidate.name}
                {candidate.lifespan ? (
                  <span className="text-ink-muted"> ({candidate.lifespan})</span>
                ) : null}
              </button>
            </li>
          ))
        )}
      </ul>

      {/*
        Always offered, never only when the search came up empty. A list with
        a different Thomas Hale in it is not evidence that this Thomas Hale is
        already recorded, and in a family tree that is the likeliest way to
        attach a marriage to the wrong person.
      */}
      <button
        type="button"
        onClick={() => onCreateNew(query)}
        className="mt-2 text-note text-link hover:underline"
      >
        {query.trim()
          ? `Not here — add “${query.trim()}” as a new person`
          : "Not here — add them as a new person"}
      </button>
    </div>
  );
}
