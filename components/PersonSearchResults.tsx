import Link from "next/link";

import type { PersonMatch } from "@/lib/people-search";

/**
 * The people half of a `/search` results page (E8-T2, `YEO-56`), split out
 * from `app/search/page.tsx` for one reason: `app/search/page.tsx` is an
 * `async` Server Component, and React and Vitest cannot render one — there
 * is nothing `render()` from `test/render.tsx` can mount. Everything the
 * ticket's last two acceptance criteria ask for — a lifespan for
 * disambiguation, a link that deep-links the tree — is about what gets
 * rendered for a given `PersonMatch[]`, which is exactly the part a plain,
 * synchronous component can hold and a jsdom test can assert against. The
 * route is left with nothing but fetching the matches and choosing which of
 * three states to show.
 *
 * Mirrors `app/wiki/page.tsx`'s list — a ruled row per result, the secondary
 * fact in `text-ink-muted` beside the primary one — and `PartnerPicker.tsx`'s
 * shape for a candidate row: name, then years in muted text if there are
 * any, nothing if there are not.
 */
export function PersonSearchResults({
  matches,
}: {
  matches: readonly PersonMatch[];
}) {
  return (
    // `role="list"` restores what Tailwind's preflight takes away by
    // stripping list markers — Safari and VoiceOver otherwise drop a `<ul>`'s
    // implicit list semantics along with its bullets, and announce a run of
    // links instead of "list, N items". See `app/wiki/page.tsx`.
    <ul role="list" className="mt-4">
      {matches.map((match) => (
        <li
          key={match.id}
          className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-rule-soft py-1.5"
        >
          {/*
            The E2-T4 deep link (`lib/tree-selection.ts`'s `treeHref`): every
            result is already the answer to "take me to this person on the
            tree", which is the ticket's last acceptance criterion.
          */}
          <Link href={match.href}>{match.name}</Link>

          {/*
            The disambiguation criterion: two relatives can share a name, and
            the years are what tells them apart. Rendered only when there is
            one — `match.lifespan` is `""` for somebody with no dates
            recorded, and an empty parenthetical would read as a defect
            rather than as an honest gap in the record (see
            `formatLifespan`'s own docblock).
          */}
          {match.lifespan ? (
            <span className="text-note text-ink-muted">{match.lifespan}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
