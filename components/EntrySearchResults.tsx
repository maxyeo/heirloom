import Link from "next/link";

import type { EntryMatch } from "@/lib/entry-search";

/**
 * The entries half of a `/search` results page (E8-T1, `YEO-55`), beside
 * `components/PersonSearchResults.tsx` and split out for the same reason it
 * was: `app/search/page.tsx` is an `async` Server Component, and neither
 * React nor Vitest can mount one, so everything worth asserting about what a
 * result *looks like* has to live in a plain synchronous component. Here that
 * is the acceptance criterion about snippets — the matched term, shown in
 * context — which `components/EntrySearchResults.test.tsx` can then check as
 * markup rather than as a string.
 *
 * A different row shape from the person list, because the two results are
 * different shapes of answer. A person is a name and a lifespan, which fit on
 * one line with the years pushed to the right. An entry is a title and a
 * sentence out of its middle, which is two lines: the link, then the snippet
 * under it. Both keep the ruled row and the muted secondary text that
 * `app/wiki/page.tsx` established for a list of entries.
 */
export function EntrySearchResults({
  matches,
}: {
  matches: readonly EntryMatch[];
}) {
  return (
    // `role="list"` restores what Tailwind's preflight takes away by
    // stripping list markers — Safari and VoiceOver otherwise drop a `<ul>`'s
    // implicit list semantics along with its bullets, and announce a run of
    // links instead of "list, N items". See `app/wiki/page.tsx`.
    <ul role="list" className="mt-4">
      {matches.map((match) => (
        <li key={match.id} className="border-b border-rule-soft py-1.5">
          <Link href={match.href}>{match.title}</Link>

          {/*
            The snippet, rendered only when there is one. An entry created but
            never written into has an empty body, so `ts_headline` has nothing
            to excerpt and `parseSnippet` returns no segments at all — and a
            blank line under the title would read as a rendering fault rather
            than as an entry with nothing in it yet.
          */}
          {match.snippet.length > 0 ? (
            <p className="text-caption text-ink-muted">
              {match.snippet.map((segment, index) =>
                segment.matched ? (
                  /*
                    `<mark>` is the element for "this is here because of the
                    reader's query", which is exactly what Postgres marked —
                    so a screen reader can be told about it, and the
                    highlight is not colour alone.

                    Styled bold on the page's own background rather than left
                    to the browser's yellow: Wikipedia's search results bold
                    the matched term and nothing else, and a highlighter
                    stripe is not in this palette (docs/design-tokens.md).
                    `text-ink` puts it back to full-strength ink against the
                    muted snippet around it, which is the other half of the
                    emphasis.
                  */
                  <mark
                    key={index}
                    className="bg-transparent font-semibold text-ink"
                  >
                    {segment.text}
                  </mark>
                ) : (
                  /*
                    Keyed by index, which is safe here and generally is not:
                    these segments are derived from one string, rendered in
                    order, and never reordered, inserted into, or edited in
                    place — a re-render replaces the whole list or none of it.
                  */
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
