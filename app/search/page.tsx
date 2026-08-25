import type { Metadata } from "next";
import Form from "next/form";

import { EntrySearchResults } from "@/components/EntrySearchResults";
import { PersonSearchResults } from "@/components/PersonSearchResults";
import { searchEntries } from "@/lib/pages";
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
 * One search parameter, or nothing.
 *
 * `?q=a&q=b` arrives as an array, and there is no defensible way to choose
 * between the two — see `app/wiki/[slug]/history/compare/page.tsx`'s own
 * `singleParam` for the fuller argument. Here the consequence of getting it
 * wrong would only be a confusing query rather than a wrong answer served
 * confidently, so this falls back to "no query" rather than a 404: a
 * hand-edited `/search?q=a&q=b` is not a broken link the way a compare page's
 * malformed `?from=&to=` is, it is simply not a query this route can honour.
 */
function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  await requireSession();

  const query = singleParam((await searchParams).q) ?? "";
  const trimmed = query.trim();

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
          defaultValue={query}
          placeholder="Search people and entries"
          autoComplete="off"
          className="block w-full max-w-96 rounded-panel border border-rule-soft bg-paper px-2 py-1.5 text-ink"
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
        the shape `app/search/page.tsx` was written to make room for when
        E8-T2 (`YEO-56`) landed with only the first of them. E8-T3 (`YEO-57`)
        still owns what remains: the header's search box becoming live, and
        whatever ordering or interleaving one combined box wants. What is
        settled here is that a search is one question with two kinds of
        answer, not two search experiences.

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
          <p className="text-caption text-ink-muted">
            {people.length === 1 ? "1 person" : `${people.length} people`}{" "}
            found.
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
          <p className="text-caption text-ink-muted">
            {entries.length === 1 ? "1 entry" : `${entries.length} entries`}{" "}
            found.
          </p>
          <EntrySearchResults matches={entries} />
        </>
      )}
    </main>
  );
}
