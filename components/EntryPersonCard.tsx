import Link from "next/link";

import type { EntryPerson } from "@/lib/entry-person";
import {
  formatLifespan,
  formatPersonName,
  formatQualifiedDate,
} from "@/lib/person-format";
import { personSearch } from "@/lib/tree-selection";

/**
 * The header card on an entry that is about somebody (E2-T3, `YEO-26`).
 *
 * "An entry about a person should know it is about a person" — this is the
 * whole of the ticket, and it is the reverse of E2-T2's panel link: there, a
 * person points at their entry; here, the entry says who it is about and
 * offers the way back to them on the tree.
 *
 * ## Everything here is read, nothing is authored
 *
 * Every value on the card comes from the `individuals` row (`getEntryPerson`),
 * so the lifespan above the article cannot drift from the lifespan in the tree
 * — there is one copy of it and this is a view of it. Nothing is written into
 * the entry body, which is what would put the two out of step the first time
 * anybody corrected a date on only one of them.
 *
 * ## Why it takes a person rather than an entry id
 *
 * Because it makes the card a plain function of a plain value, which is the
 * split docs/testing.md asks for: the query is in `lib/entry-person.ts`, the
 * page awaits it, and this renders. An `async` component that fetched its own
 * row would be untestable — React and Vitest do not support mounting one —
 * and every case worth asserting here is a formatting case.
 *
 * ## Why there is no heading element in it
 *
 * The name is a `<p>`, not an `<h2>`. E11-T3's table of contents is built from
 * the headings on the page, and a heading in the chrome above the article
 * would put "Rose Hale" in the contents of the entry about Rose Hale. The card
 * is an `<aside>` with an `aria-label` instead, which is what gives it a name
 * in the accessibility tree without inventing a section.
 */
export function EntryPersonCard({
  person,
}: {
  /**
   * The person this entry is about, or `undefined` when the entry is about a
   * place, an heirloom, or anything else nobody is linked to.
   *
   * Nullable rather than the page deciding, so the "no linked person" case is
   * one `return null` in one file. The alternative — a conditional at the call
   * site — is how an entry with no person ends up rendering an empty card, and
   * `app/wiki/[slug]/page.tsx` is a file three tickets are editing at once.
   */
  person: EntryPerson | null | undefined;
}) {
  if (!person) return null;

  const name = formatPersonName(person.givenName, person.surname);
  const lifespan = formatLifespan(person.birthDate, person.deathDate);

  /**
   * The one place in this feature a date is formatted, and `precision` is
   * passed explicitly at both call sites.
   *
   * `formatQualifiedDate` defaults it to `"day"`, which is right for the
   * callers that predate E4-T2 and wrong for anything written since: a
   * year-only date carries 1 January as an anchor, and a call that omits the
   * precision renders that anchor as though a source had stated it. E4-T3
   * (`YEO-40`) consolidates this formatter into `lib/format-date.ts`; keeping
   * both calls adjacent is what makes that a one-line repoint.
   */
  const birth = formatQualifiedDate(
    person.birthDate,
    person.birthDateQualifier,
    person.birthDatePrecision,
  );
  const death = formatQualifiedDate(
    person.deathDate,
    person.deathDateQualifier,
    person.deathDatePrecision,
  );

  return (
    <aside
      aria-label={`Tree record for ${name}`}
      className="mb-4 rounded-panel border border-rule bg-panel px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="font-serif text-h3">
          {name}
          {lifespan ? (
            <span className="ml-2 font-sans text-caption text-ink-muted">
              {lifespan}
            </span>
          ) : null}
        </p>

        {/*
          E2-T4's (`YEO-27`) deep link, built through its own module rather
          than by pasting `?person=` into a template — `personSearch` is what
          decides how a selection is spelled in a URL, and one place deciding
          that is what keeps this link and the canvas agreeing. It also encodes
          the id, which a template literal would not.
        */}
        <Link
          href={`/tree${personSearch("", person.id)}`}
          className="text-note text-link hover:underline"
        >
          View in tree
        </Link>
      </div>

      {/*
        The rows are omitted individually, and the list with them when neither
        is recorded: a person whose dates are unknown gets a card with their
        name and the way back to the tree, rather than an empty definition
        list under it. Half-known lives are the common case in genealogy, not
        the edge one.
      */}
      {birth || person.birthPlace || death || person.deathPlace ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
          <Fact term="Born" date={birth} place={person.birthPlace} />
          <Fact term="Died" date={death} place={person.deathPlace} />
        </dl>
      ) : null}
    </aside>
  );
}

/**
 * One recorded event, or nothing at all.
 *
 * The comma is conditional because either half can be missing on its own — a
 * date with no place, or "Died: Hastings" with no year — and the panel this
 * mirrors (`components/PersonPanel.tsx`) joins them the same way.
 */
function Fact({
  term,
  date,
  place,
}: {
  term: string;
  date: string | null;
  place: string | null;
}) {
  if (!date && !place) return null;

  return (
    <>
      <dt className="text-ink-muted">{term}</dt>
      <dd>
        {date}
        {date && place ? ", " : null}
        {place}
      </dd>
    </>
  );
}
