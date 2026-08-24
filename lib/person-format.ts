import type { DatePrecision, DateQualifier } from "./family-graph";

/**
 * How a person's recorded facts are rendered as text.
 *
 * Deliberately a plain module with no imports beyond a type: `npm test` — what
 * CI runs — has no `DATABASE_URL` at all (docs/testing.md), and
 * `lib/family-graph.ts` imports `@/db`. `import type` erases entirely, so
 * nothing here drags postgres.js into a test, or into the browser bundle when
 * the detail panel imports it.
 *
 * It exists as its own module because two callers need the same strings.
 * `lib/tree-layout.ts` puts a name and a lifespan on every node; the detail
 * panel (E2-T1) repeats both in its header and again for every relative it
 * links to. Two copies of "join the names, drop the empty one" is exactly how
 * a node and its own panel end up disagreeing about what somebody is called.
 */

/**
 * A person's full name.
 *
 * `surname` is nullable in the schema, and for the oldest generations it is
 * routinely unknown, so the join has to drop the empty half rather than leave
 * a trailing space behind the given name.
 */
export function formatPersonName(
  givenName: string,
  surname: string | null,
): string {
  return [givenName, surname].filter(Boolean).join(" ");
}

/**
 * The years under a name: `1899–1960`, `b. 1910`, `d. 1988`, or nothing.
 *
 * Years only, and no qualifier. This is the label that has to fit inside a
 * 176px node and beside every link in a relatives list, where the point is to
 * tell two Thomas Hales apart at a glance rather than to state the record.
 * `formatQualifiedDate` is what states the record, and the panel uses it for
 * the birth and death rows themselves.
 */
export function formatLifespan(
  birthDate: string | null,
  deathDate: string | null,
): string {
  const born = birthDate?.slice(0, 4);
  const died = deathDate?.slice(0, 4);
  if (!born && !died) return "";
  if (born && died) return `${born}–${died}`;
  if (born) return `b. ${born}`;
  return `d. ${died}`;
}

const QUALIFIER_PREFIX: Record<DateQualifier, string> = {
  exact: "",
  about: "about ",
  before: "before ",
  after: "after ",
};

/**
 * How much of the date to show, per `date_precision` (E4-T2, `YEO-39`).
 *
 * This table is the whole of what stops a year-only date from being displayed
 * as 1 January. The stored day is an anchor — see `DATE_PRECISIONS` in
 * `lib/field-input.ts` — and showing parts of it the author never typed would
 * be inventing a fact and then attributing it to them.
 */
const PRECISION_OPTIONS: Record<DatePrecision, Intl.DateTimeFormatOptions> = {
  day: { dateStyle: "long" },
  month: { year: "numeric", month: "long" },
  year: { year: "numeric" },
};

/**
 * A date column read together with its `date_qualifier` and `date_precision`
 * siblings.
 *
 * The three are only ever meaningful together — a qualifier with no date says
 * nothing, which is why the schema stores "no date at all" as a null `date`
 * and keeps the other two `not null`. So this takes them all and returns null
 * when there is no date, and callers decide whether to render a row at all.
 *
 * The result is deliberately something `parseDateInput` can read straight back
 * in: "about 1890" out of here goes into the date field and comes back as the
 * same three values. That round trip is what lets the edit form prefill a
 * free-text date box without a second, quieter formatter written to serve it
 * — and `lib/parse-date.test.ts` asserts it closes.
 *
 * Pinned to `en-GB` and UTC for the same reason `formatRevisionTimestamp` is:
 * `Intl` otherwise defaults to the *environment's* locale and zone, so the
 * identical row could render differently on the machine that builds this and
 * the machine that serves it. A `date` column has no time part, and parsing
 * `YYYY-MM-DD` as UTC then formatting it as UTC is what keeps a birthday from
 * sliding to the previous day west of Greenwich.
 *
 * `precision` defaults to `day`, which matches the column default and means
 * every caller written before E4-T2 keeps its existing behaviour untouched.
 * E4-T3 (`YEO-40`) is where this becomes `lib/format-date.ts` and the last
 * places still rendering a raw date go through it.
 */
export function formatQualifiedDate(
  date: string | null,
  qualifier: DateQualifier,
  precision: DatePrecision = "day",
): string | null {
  if (!date) return null;

  const parsed = new Date(`${date}T00:00:00Z`);
  // A malformed value should read as the stored string rather than as
  // "Invalid Date", which tells a reader nothing about what is in the row.
  if (Number.isNaN(parsed.getTime())) return date;

  const formatted = new Intl.DateTimeFormat("en-GB", {
    ...PRECISION_OPTIONS[precision],
    timeZone: "UTC",
  }).format(parsed);

  return `${QUALIFIER_PREFIX[qualifier]}${formatted}`;
}
