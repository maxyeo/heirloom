import { Fragment } from "react";
import Link from "next/link";

import {
  type Anniversary,
  type AnniversaryPerson,
  formatAnniversaryEvent,
  formatYearsAgo,
} from "@/lib/on-this-day-feed";
import { treeHref } from "@/lib/tree-selection";

/**
 * The home page's "On this day" section as markup (E8-T5, `YEO-59`), taking
 * its rows as a prop.
 *
 * Split from `app/on-this-day.tsx` — the four lines that fetch — for the
 * reason `components/RecentChangesList.tsx` and
 * `components/EntrySearchResults.tsx` were split from their routes: an
 * `async` Server Component cannot be mounted by React or Vitest at all
 * (docs/testing.md), so everything worth asserting about what the section
 * *looks like* has to live in a plain synchronous component. Here that is two
 * of the ticket's four acceptance criteria — that a quiet day shows nothing at
 * all, and that every row links through to the person — which
 * `components/OnThisDayList.test.tsx` can then check as markup rather than as
 * a promise nobody can await.
 *
 * It renders the whole section, heading included, rather than only the `<ul>`.
 * That is what makes the quiet-day criterion checkable here: "shows nothing
 * rather than an empty heading" is a statement about the heading, and a
 * component handed only the list could not have suppressed one.
 */
export function OnThisDayList({
  anniversaries,
  todayYear,
}: {
  anniversaries: readonly Anniversary[];
  /**
   * The year it is now, from `todayAnniversary` — what "136 years ago" is
   * counted against.
   *
   * A prop rather than a `new Date()` inside this component, because a
   * component that read the clock would render differently on the server and
   * in a later hydration, and because the year has to be the *same* one the
   * query selected against. `app/on-this-day.tsx` reads the day once and hands
   * both halves the same answer.
   */
  todayYear: number;
}) {
  /*
    The ticket's third acceptance criterion, and the reason it is an early
    return rather than a conditional `<ul>`: on a quiet day this renders
    **nothing at all**. A `<section>` with a heading and no list would put a
    rule, a bold line and its top margin on the home page most days of the
    year, announcing that the family has no anniversaries today — which is a
    worse thing to say than nothing. `components/ArticleCategories.tsx` makes
    the same choice for an uncategorised entry, and both are asserted the same
    way: the rendered host's `innerHTML` is `""`, not merely a list with no
    items in it.

    Most days *are* quiet. A family archive of a few hundred people with
    recorded exact dates covers a minority of the calendar, so this branch is
    the common one rather than the edge case.
  */
  if (anniversaries.length === 0) return null;

  return (
    <section className="mt-8">
      {/* `h2` outside `.wiki-body`, matching `RecentChangesList` directly
          above it: this is a section of the home page rather than a heading
          within an article, and `globals.css` styles article headings only
          inside that class. Two adjacent sections that wore different
          headings would read as two different kinds of thing. */}
      <h2 className="mb-1 border-b border-rule pb-1 text-lg">On this day</h2>

      <p className="text-caption text-ink-muted">
        Anniversaries from the dates the family has recorded.
      </p>

      {/* `role="list"` restores what Tailwind's preflight takes away:
          stripping the markers also drops the list's implicit semantics in
          Safari and VoiceOver, which then announce a run of links instead of
          "list, N items". Established by `app/wiki/page.tsx`. */}
      <ul role="list" className="mt-3">
        {anniversaries.map((anniversary) => (
          <li
            key={anniversaryKey(anniversary)}
            className="border-b border-rule-soft py-1.5"
          >
            <AnniversaryNames anniversary={anniversary} />
            <AnniversaryByline
              anniversary={anniversary}
              todayYear={todayYear}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A stable React key for one row.
 *
 * Not the array index, and not the year: the index reorders under the reader
 * on the next render, and two anniversaries routinely share a year (see
 * `mergeAnniversaries`). The arm's own identity is unique within its table,
 * and the `kind` prefix makes it unique across the three — one person appears
 * in both the birth and the death query, and would otherwise key twice on the
 * same id on the day they were born and died.
 */
function anniversaryKey(anniversary: Anniversary): string {
  switch (anniversary.kind) {
    case "birth":
      return `birth:${anniversary.personId}`;
    case "death":
      return `death:${anniversary.personId}`;
    case "union-started":
      return `union-started:${anniversary.unionId}`;
  }
}

/**
 * Who the row is about: one name, or two joined by "and".
 *
 * A `switch` over the discriminated union rather than one shape with
 * conditional fields, which is the point of the union reaching this far — the
 * compiler checks that every arm is rendered, and a fourth arm added to
 * `Anniversary` later is a type error here rather than a row that silently
 * renders blank.
 *
 * The two person arms are identical *by coincidence rather than by rule* —
 * they name one person and link to them — so they share a return rather than
 * being written twice. What differs between a birth and a death is entirely in
 * the byline below.
 */
function AnniversaryNames({ anniversary }: { anniversary: Anniversary }) {
  switch (anniversary.kind) {
    case "birth":
    case "death":
      return <PersonName person={anniversary} />;

    case "union-started":
      /*
        A union names one or two people — `lib/on-this-day.ts` excludes the
        rows that would name none — so the separator has to come from the
        list rather than from a template with an "and" in the middle of it.
        `Fragment` with a key, because the separator sits *between* two
        siblings and React needs the pair keyed as one child.
      */
      return anniversary.partners.map((partner, index) => (
        <Fragment key={partner.personId}>
          {index > 0 ? " and " : null}
          <PersonName person={partner} />
        </Fragment>
      ));
  }
}

/**
 * One person's name, as the link the ticket's last criterion asks for.
 *
 * Through `treeHref`, so there is one place that knows the shape of the
 * `?person=` deep link — the same route `components/PersonSearchResults.tsx`
 * and `components/RecentChangesList.tsx` send a person to. That component's
 * own docblock settles why it is the tree rather than the person's entry:
 * "not every person has one, and the tree is where a person always exists."
 * A person who *does* have an entry is one click further from it than they
 * could be, and is never a dead link, which is the right way round.
 */
function PersonName({ person }: { person: AnniversaryPerson }) {
  return <Link href={treeHref(person.personId)}>{person.name}</Link>;
}

/**
 * The muted second line: what happened and in which year, then how long ago.
 *
 * The words carry the meaning on their own — "Born 1890", "Married 1912" —
 * so nothing here distinguishes one kind of anniversary from another by
 * colour or position alone, and the section reads the same in a screen reader
 * as it does on the page.
 *
 * The interval is dropped rather than rendered as "0 years ago" or a negative
 * number; `formatYearsAgo` returns null for both and its docblock says why.
 * The separator goes with it, so a row from this year ends after the year
 * rather than with a dangling middot.
 */
function AnniversaryByline({
  anniversary,
  todayYear,
}: {
  anniversary: Anniversary;
  todayYear: number;
}) {
  const yearsAgo = formatYearsAgo(anniversary.year, todayYear);

  return (
    <p className="text-note text-ink-muted">
      {formatAnniversaryEvent(anniversary)}
      {yearsAgo === null ? null : ` · ${yearsAgo}`}
    </p>
  );
}
