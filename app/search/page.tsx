import type { Metadata } from "next";
import Form from "next/form";

import { EntrySearchResults } from "@/components/EntrySearchResults";
import { PersonSearchResults } from "@/components/PersonSearchResults";
import { DEFAULT_LIMIT as ENTRY_LIMIT } from "@/lib/entry-search";
import { searchEntries } from "@/lib/pages";
import { DEFAULT_LIMIT as PERSON_LIMIT } from "@/lib/people-search";
import { readSearchParam } from "@/lib/search-endpoint";
import { searchPeopleByName } from "@/lib/people";
import { requireSession } from "@/lib/session";

/**
 * Reads a session cookie and the `individuals` table, so — as with every
 * other database-backed route — there is nothing to prerender. Stated
 * explicitly, the way `app/wiki/page.tsx` and `app/tree/page.tsx` do, rather
 * than left to be inferred from the first request-time API this route
 * happens to touch.
 */
export const dynamic = "force-dynamic";

/**
 * Static, for the reason `app/wiki/page.tsx`'s own metadata gives: the title
 * is the same on every request regardless of what was searched for, so there
 * is no reason to make Next call a function for it — and no reason for that
 * function to open a second, unguarded door onto the data the way a
 * `generateMetadata` reading the query would. `robots: noindex` is inherited
 * from the root layout.
 */
export const metadata: Metadata = {
  title: "Search",
};

/**
 * Hand-written rather than the generated `PageProps<"/search">` helper, for
 * the reason every sibling route with a `searchParams` prop gives (see
 * `app/wiki/[slug]/history/compare/page.tsx`): that helper exists only after
 * `next dev`/`next build`/`next typegen` has run, and CI's `npm run
 * typecheck` runs on a fresh checkout before `npm run build`, when
 * `.next/types` does not exist yet.
 */
type SearchPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * How `?q=` is read is `lib/search-endpoint.ts`'s, not this file's, since
 * E8-T3 (`YEO-57`).
 *
 * This route used to hold a private `singleParam` making the argument for
 * itself: `?q=a&q=b` arrives as an array and there is no defensible way to
 * choose between the two, so it falls back to "no query" rather than 404ing
 * the way a compare page's malformed `?from=&to=` does. All of that still
 * holds — it has simply moved somewhere both readers of the parameter can
 * share it. The header's box (`components/SearchBox.tsx`) asks the same
 * question of the same parameter, and two controls that disagreed about what
 * a hand-edited URL meant would answer the same link two different ways
 * depending on which one read it.
 */

export default async function SearchPage({ searchParams }: SearchPageProps) {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  await requireSession();

  const trimmed = readSearchParam((await searchParams).q);

  // Two reads of two tables that have nothing to do with each other, so they
  // are issued together rather than one after the other: awaiting them in
  // sequence would make the page as slow as the sum of them for no reason.
  //
  // No query issues no query at all. `searchEntries` makes the same decision
  // for itself, but reading the whole `individuals` table to rank it against
  // nothing would be work spent producing the same "type a name" invitation
  // this renders without it.
  const [people, entries] =
    trimmed === ""
      ? [[], []]
      : await Promise.all([
          searchPeopleByName(trimmed),
          searchEntries(trimmed),
        ]);

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Search</h1>

      {/*
        A GET form, not a client-side input with its own state: this is what
        makes a search bookmarkable and shareable, and what lets the back
        button return to a previous query rather than an empty box. `next/
        form` gives that native behaviour progressive enhancement — prefetch
        of this route, and a client-side transition on submit rather than a
        full reload — without this route needing to be a Client Component.
        See `node_modules/next/dist/docs/01-app/03-api-reference/
        02-components/form.md`.
      */}
      <Form action="/search" className="mt-4 flex gap-2">
        {/*
          "Search by name" until E8-T1 (`YEO-55`) put the entries beside the
          people: the box now asks one question of both, so labelling it after
          only one of them would be telling a screen-reader user the narrower
          of two truths.
        */}
        <label className="sr-only" htmlFor="search-query">
          Search people and entries
        </label>
        <input
          id="search-query"
          type="search"
          name="q"
          defaultValue={trimmed}
          placeholder="Search people and entries"
          autoComplete="off"
          className="block w-full max-w-96 rounded-panel border border-rule bg-paper px-2 py-1.5 text-ink"
        />
        <button
          type="submit"
          className="shrink-0 rounded-panel border border-rule px-4 py-1.5 font-medium transition hover:bg-panel"
        >
          Search
        </button>
      </Form>

      {/*
        Two groups, one per kind of thing the wiki holds, under one query —
        the shape this page was written to make room for when E8-T2
        (`YEO-56`) landed with only the first of them, and which E8-T3
        (`YEO-57`) has now finished. What was settled here first is that a
        search is one question with two kinds of answer, not two search
        experiences.

        E8-T3 built the second surface on that same shape rather than a
        second experience: `components/SearchBox.tsx` in the header asks the
        same question of the same two backends, groups the answer under these
        same two headings, and shows five per group instead of twenty —
        ending with a row that leads here for the rest. This page is where
        the answer has room to breathe; the dropdown is where it is a glance.
        The copy below is the long version, and the dropdown's is borrowed
        from it rather than the other way round.

        No interleaving. It was considered and declined: a single ranked list
        would need a comparison between "how well does this name match" and
        "what `ts_rank` said about this document", and those two numbers mean
        nothing to each other. Two honest groups beat one invented ordering.

        People first because a family wiki is a family: the commonest thing
        to search for is a person, and an entry about them is very often the
        second result rather than the thing being looked for.
      */}
      <h2 className="mt-8">People</h2>

      {trimmed === "" ? (
        <p className="mt-2 text-ink-muted">
          Search for a person by given name or surname. Spelling variants are
          already tried — searching “Catherine” finds a “Katharine” recorded in
          the tree, and a name transcribed slightly differently is not a reason
          to come up empty.
        </p>
      ) : people.length === 0 ? (
        <p className="mt-2 text-ink-muted">
          {`Nobody matches “${trimmed}”. Spelling variants are already tried, so this is checked against how the name might have been transcribed as well as how it was typed — the family tree simply does not have anyone by this name yet.`}
        </p>
      ) : (
        <>
          {/*
            "The first 20" rather than "20 found" when the cap is what is
            being shown. `searchPeopleByName` stops at `PERSON_LIMIT`, so at
            exactly that many the number is the limit rather than the answer —
            and a query matching fifty people saying "20 people found" is the
            page stating a total it does not know. Below the cap the count is
            a real total and says so.
          */}
          <p className="text-caption text-ink-muted">
            {people.length === PERSON_LIMIT
              ? `The first ${PERSON_LIMIT} people. Narrow the query to see fewer.`
              : `${people.length === 1 ? "1 person" : `${people.length} people`} found.`}
          </p>
          <PersonSearchResults matches={people} />
        </>
      )}

      <h2 className="mt-8">Entries</h2>

      {trimmed === "" ? (
        <p className="mt-2 text-ink-muted">
          Search the text of every entry. Words are matched by their stem, so
          “marriages” finds an entry that says “married”, and an entry whose
          title matches comes before one that only mentions the word.
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-2 text-ink-muted">
          {`No entry mentions “${trimmed}”. This searches what is written in every entry, not just the titles, so the words are simply not in the wiki yet.`}
        </p>
      ) : (
        <>
          {/* The same, and the same limit — see `PERSON_LIMIT` above. */}
          <p className="text-caption text-ink-muted">
            {entries.length === ENTRY_LIMIT
              ? `The first ${ENTRY_LIMIT} entries. Narrow the query to see fewer.`
              : `${entries.length === 1 ? "1 entry" : `${entries.length} entries`} found.`}
          </p>
          <EntrySearchResults matches={entries} />
        </>
      )}
    </main>
  );
}
