import Link from "next/link";
import type { ReactNode } from "react";

import {
  type InfoboxEvent,
  type InfoboxPerson,
  NAMED_RELATIVE_LIMIT,
  type PersonInfobox as PersonInfoboxData,
} from "@/lib/person-infobox";
import { entryLinkProps } from "@/lib/red-links";
import { personSearch } from "@/lib/tree-selection";

/**
 * Wikipedia's infobox, top right of an article about a person (E11-T5,
 * `YEO-75`).
 *
 * ## It renders; it does not reason
 *
 * Every fact and every ordering decision is made in `lib/person-infobox.ts`,
 * which derives them from `individuals` / `unions` / `union_children` at
 * render time. This file turns that value into a table, and the only rules it
 * keeps are presentational: which rows exist, and whether a row names people
 * or counts them.
 *
 * The consequence worth stating is the one the ticket leads with: **there is
 * no infobox markup anywhere in this application**. The author never types
 * one, cannot edit one, and cannot leave one contradicting the tree — add a
 * spouse in E3-T4 and the next render of this article says so.
 *
 * ## Omit the row rather than say "unknown"
 *
 * Each row below is a conditional. A person with no recorded parents gets no
 * Parents row — not an empty one, and not "unknown". Most people in the older
 * generations of a real tree are missing most fields, and a box that rendered
 * every absence would be a column of blanks with a name on top.
 *
 * ## The styling is Vector 2022's, expressed in tokens
 *
 * `bg-panel` is the infobox fill the acceptance criteria name and
 * `border-rule` is its border, both declared once in `app/globals.css` and
 * never repeated at a call site — docs/design-tokens.md has the values, and
 * `app/globals.test.ts` fails the build on a colour written anywhere else
 * (including in a comment here, which is how it should be). The width is
 * `--container-infobox`, the same token layer, so "how wide is an infobox" is
 * answered in the stylesheet rather than in an arbitrary class.
 *
 * Below `sm` it stops floating and goes full width above the article, because
 * a 20.5rem float in a phone-width column leaves a two-word measure beside it
 * — the same answer, at the same breakpoint, that `.wiki-body figure` gives in
 * `app/globals.css`.
 *
 * ## Where the portrait goes
 *
 * The first row in the ticket is the portrait, and E5 — the images epic — is
 * unbuilt: there is no upload, no storage and no column to read one from. So
 * the row is left out rather than faked, and the seam is marked below: a
 * `<figure>` between the name and the table, which is where the reference
 * mockup puts it and what E5-T4 has to fill in.
 *
 * ## Why it is not a heading, and why the name is repeated
 *
 * Same reason `EntryPersonCard` gave before this replaced it: E11-T3 builds
 * the table of contents from the headings on the page, so a heading in the
 * chrome would put "Rose Bennett" in the contents of the entry about Rose
 * Bennett. It is an `<aside>` with an `aria-label`, which names it in the
 * accessibility tree without inventing a section.
 */
export function PersonInfobox({
  infobox,
  existingSlugs,
}: {
  /**
   * The box, or null when the entry is about a place, an heirloom or a story.
   *
   * Nullable rather than the route deciding: "an entry not linked to a person
   * renders with no infobox and no gap" is an acceptance criterion, and one
   * `return null` in one file is how it stays true. A conditional at the call
   * site is how an unlinked entry ends up with an empty bordered box, and
   * `app/wiki/[slug]/page.tsx` is a file several tickets edit at once.
   */
  infobox: PersonInfoboxData | null | undefined;
  /**
   * Which entry slugs exist, from the article route's single
   * `findExistingSlugs` call — the body's links and this box's are resolved
   * together. Every link below goes through `entryLinkProps` with this set, so
   * a name whose entry exists is blue and one whose entry does not is red and
   * offers to create it.
   */
  existingSlugs: ReadonlySet<string>;
}) {
  if (!infobox) return null;

  const { birth, death, spouses, children, stepchildren, parents } = infobox;

  return (
    <aside
      aria-label={`Infobox for ${infobox.name}`}
      className="mb-4 w-full border border-rule bg-panel text-caption sm:float-right sm:clear-right sm:mt-1 sm:ml-5 sm:w-infobox sm:max-w-full"
    >
      <p className="border-b border-rule-soft px-2 py-2 text-center font-serif text-h3">
        {infobox.name}
      </p>

      {/*
        The portrait row (E5-T4, `YEO-44`) belongs here, between the name and
        the table — a `<figure>` with the image and its caption, as the
        reference mockup has it. E5 is unbuilt, so there is nothing to render
        and nothing is rendered: no placeholder silhouette, which would be a
        picture of somebody nobody uploaded.
      */}

      <table className="w-full border-collapse">
        <tbody>
          <EventRow term="Born" event={birth} />
          <EventRow term="Died" event={death} />

          {spouses.length > 0 ? (
            <Row term={spouses.length === 1 ? "Spouse" : "Spouses"}>
              {spouses.map((spouse) => (
                <div key={spouse.unionId}>
                  <PersonLink
                    person={spouse.person}
                    existingSlugs={existingSlugs}
                  />
                  {spouse.detail ? <Sub>{spouse.detail}</Sub> : null}
                </div>
              ))}
            </Row>
          ) : null}

          <PeopleRow
            singular="Child"
            plural="Children"
            people={children}
            existingSlugs={existingSlugs}
          />
          <PeopleRow
            singular="Stepchild"
            plural="Stepchildren"
            people={stepchildren}
            existingSlugs={existingSlugs}
          />
          <PeopleRow
            singular="Parent"
            plural="Parents"
            people={parents}
            existingSlugs={existingSlugs}
          />
        </tbody>
      </table>

      {/*
        E2-T4's (`YEO-27`) deep link, kept from the header card this box
        replaced: the article says who it is about, and this is the way back to
        them on the canvas. Built through `personSearch` rather than by pasting
        `?person=` into a template, so one module decides how a selection is
        spelled in a URL — and encodes the id, which a template literal would
        not.
      */}
      <p className="border-t border-rule-soft px-2 py-1 text-note">
        <Link href={`/tree${personSearch("", infobox.id)}`}>
          View in family tree
        </Link>
      </p>
    </aside>
  );
}

/**
 * A birth or a death: the date, and the place under it.
 *
 * The place is its own line rather than appended after a comma, which is what
 * the reference mockup does and what keeps a long place name from pushing the
 * date out of a 20.5rem box. Either half can be missing on its own — a date
 * with no place, a place with no date — and the row is rendered as long as one
 * of them is there.
 */
function EventRow({
  term,
  event,
}: {
  term: string;
  event: InfoboxEvent | null;
}) {
  if (!event) return null;

  return (
    <Row term={term}>
      {event.date}
      {event.place ? <Sub>{event.place}</Sub> : null}
    </Row>
  );
}

/**
 * A row of relatives: their names when there are few, their number when there
 * are many.
 *
 * The threshold is `NAMED_RELATIVE_LIMIT`, and the reference mockup shows why
 * it exists — Rose's ten children render as "10". Every person this *does*
 * name is a link, which is the acceptance criterion; a count names nobody and
 * so links nothing.
 */
function PeopleRow({
  singular,
  plural,
  people,
  existingSlugs,
}: {
  singular: string;
  plural: string;
  people: InfoboxPerson[];
  existingSlugs: ReadonlySet<string>;
}) {
  if (people.length === 0) return null;

  return (
    <Row term={people.length === 1 ? singular : plural}>
      {people.length > NAMED_RELATIVE_LIMIT
        ? people.length
        : people.map((person, index) => (
            <span key={person.id}>
              {index > 0 ? ", " : null}
              <PersonLink person={person} existingSlugs={existingSlugs} />
            </span>
          ))}
    </Row>
  );
}

/**
 * One person, as a link.
 *
 * `entryLinkProps` (E11-T6, `YEO-76`) decides where it points and whether it
 * is red, from the same resolved set the article body is rewritten against —
 * so "what a red link is" has one description and this file is not a second
 * one. A person with no entry has a null slug, which is the case that API's
 * `slug` field is nullable for: nobody has ever written their address down,
 * so the link offers to create the entry instead of pointing at one.
 */
function PersonLink({
  person,
  existingSlugs,
}: {
  person: InfoboxPerson;
  existingSlugs: ReadonlySet<string>;
}) {
  return (
    <Link
      {...entryLinkProps(
        { slug: person.slug, text: person.name },
        existingSlugs,
      )}
    >
      {person.name}
    </Link>
  );
}

/** A label and its value, ruled off from the row above it. */
function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <tr className="border-t border-rule-soft first:border-t-0">
      <th scope="row" className="w-24 px-2 py-1 text-left align-top font-bold">
        {term}
      </th>
      <td className="px-2 py-1 align-top">{children}</td>
    </tr>
  );
}

/** The quieter second line of a cell: a place, or when a marriage ended. */
function Sub({ children }: { children: ReactNode }) {
  return <div className="text-ink-muted">{children}</div>;
}
