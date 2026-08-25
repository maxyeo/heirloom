import Link from "next/link";
import { Fragment } from "react";

import {
  describeExtraNamesakes,
  formatNamesake,
  HATNOTE_CLASS,
  namesakeHatnoteLead,
  namesakeSeparator,
  type NamesakePerson,
} from "@/lib/hatnote";
import { entryLinkProps } from "@/lib/red-links";

/**
 * The hatnote (E11-T9, `YEO-79`) — the indented italic line above the lead
 * paragraph, which tells a reader whether they are on the right entry before
 * they start reading.
 *
 * ## It renders; it does not reason
 *
 * The same line `components/PersonInfobox.tsx` draws for itself. What a
 * hatnote *says* is decided in `lib/hatnote.ts` (pure, checkable by `npm
 * test`) and what a namesake *is* is decided in `lib/namesakes.ts` (one
 * indexed query). This file turns those two values into two divs.
 *
 * ## Nothing, when there is nothing
 *
 * The acceptance criterion is "omitted entirely when empty — no stray
 * whitespace above the lead", and the only way to be sure of that is to return
 * `null` rather than to render an element and style it away. An empty
 * `<div class="hatnote">` still occupies its own margin, and the gap it leaves
 * above the first paragraph is exactly the kind of defect that ships green and
 * is noticed months later on one entry. `ArticleHatnote.test.tsx` asserts that
 * the component contributes no markup at all in that case.
 *
 * `normaliseHatnote` is what makes the manual half of that test one
 * comparison: a hatnote that holds only markup, only whitespace or only an
 * empty link has already become `""` by the time it reaches this component.
 *
 * ## Both, when there are both
 *
 * Manual first, automatic second, each in its own `.hatnote` — which is what
 * MediaWiki does with stacked hatnotes, and what makes them read as two
 * statements rather than one run-on sentence. `lib/hatnote.ts` argues why
 * neither suppresses the other.
 */
export interface ArticleHatnoteProps {
  /**
   * The author's hatnote, already through `normaliseHatnote` — so text and
   * anchors only, and `""` when there is none.
   *
   * Rendered with `dangerouslySetInnerHTML` for the reason the article body is:
   * it holds links, and links are markup. It is the same allowlist, applied by
   * the same function, on write and again on read — see `lib/hatnote.ts`.
   */
  hatnoteHtml: string;
  /**
   * The name the automatic hatnote is about — this entry's subject, as
   * `formatPersonName` renders them — or `null` when the entry is not about a
   * person.
   */
  subjectName: string | null;
  /** Who else is called that, at most `NAMESAKE_LIMIT` of them. */
  namesakes: readonly NamesakePerson[];
  /** How many more share the name than are listed. Zero in the ordinary case. */
  extraNamesakes: number;
  /**
   * The slugs that exist, from the page's one `findExistingSlugs` call.
   *
   * Passed in rather than resolved here, which is what keeps a page to one
   * query however many things on it link to entries — the argument
   * `entryLinkProps` makes for taking the whole set. A namesake with no entry
   * is then a red link inviting somebody to write one, which is the right
   * answer rather than a name with nothing behind it.
   */
  existingSlugs: ReadonlySet<string>;
}

export function ArticleHatnote({
  hatnoteHtml,
  subjectName,
  namesakes,
  extraNamesakes,
  existingSlugs,
}: ArticleHatnoteProps) {
  const hasManual = hatnoteHtml !== "";
  const hasAutomatic = subjectName !== null && namesakes.length > 0;

  // No element, no margin, no whitespace. See the header.
  if (!hasManual && !hasAutomatic) return null;

  return (
    <>
      {hasManual ? (
        <div
          className={HATNOTE_CLASS}
          dangerouslySetInnerHTML={{ __html: hatnoteHtml }}
        />
      ) : null}

      {hasAutomatic ? (
        <div className={HATNOTE_CLASS}>
          {namesakeHatnoteLead(subjectName)}
          {namesakes.map((person, index) => (
            <Fragment key={person.id}>
              {namesakeSeparator(index, namesakes.length, extraNamesakes > 0)}
              <Link
                {...entryLinkProps(
                  { slug: person.slug, text: formatNamesake(person) },
                  existingSlugs,
                )}
              >
                {formatNamesake(person)}
              </Link>
            </Fragment>
          ))}
          {extraNamesakes > 0
            ? ` ${describeExtraNamesakes(extraNamesakes)}`
            : null}
          .
        </div>
      ) : null}
    </>
  );
}
