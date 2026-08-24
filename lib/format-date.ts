import type { DatePrecision, DateQualifier } from "./family-graph";

/**
 * Every date this application puts on a screen (E4-T3, `YEO-40`).
 *
 * ## One module, because a date is three columns
 *
 * A date in this schema is never one value. It is a `date`, a
 * `date_qualifier` and a `date_precision`, and it is only meaningful as all
 * three together — see "Date precision" in docs/architecture.md. Any surface
 * that reaches for `person.birthDate` on its own is one line away from
 * publishing a fact nobody recorded: the stored day of a year-precision date
 * is an *anchor* (1 January), not a birthday.
 *
 * That is the entire argument for this module existing. Formatting is not
 * hard; formatting is easy and therefore gets rewritten locally, and the
 * fourth local rewrite is where the anchor leaks out as an assertion. So
 * there is one place that turns the three columns into words, and the tree
 * node, the detail panel, the removal dialogue, the date field's echo and the
 * edit form's prefill all call it.
 *
 * ## Why it is a plain module with no imports but a type
 *
 * `npm test` — what CI runs — has no `DATABASE_URL` at all (docs/testing.md),
 * and `lib/family-graph.ts` imports `@/db`. `import type` erases entirely, so
 * nothing here drags postgres.js into a test, or into the browser bundle when
 * a client component imports it. `lib/person-format.ts` next door keeps the
 * same property for the same reason, and holds the half of "how a person
 * reads" that is not a date.
 */

/**
 * The words that go in front of a date, and what each one means.
 *
 * The four values are GEDCOM 5.5.1's date modifiers, which is why they can
 * survive a round trip through import and export instead of being flattened
 * into prose in the notes field. `exact` renders as nothing at all: an
 * unqualified date is the ordinary case, and prefixing it with "exactly"
 * would make the common reading look like the special one.
 */
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
 * **Null is rendered as nothing** — never as "unknown", never as a dash. A
 * missing birth date is the ordinary state of a nineteenth-century record,
 * not a gap to apologise for, and a column of em dashes reads as a defect in
 * the tree rather than as the honest limit of what a source said.
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
 * `precision` is **required, and deliberately has no default**. It defaulted
 * to `day` while E4-T2 was landing, and the cost of that convenience was a
 * bug: a call site that simply forgot the third argument rendered a year off
 * a headstone as "1 January 1890" — silently, plausibly, and in exactly the
 * voice of a recorded fact. It shipped green because every fixture at the
 * time used day precision. A required parameter moves that from something a
 * reviewer has to notice to something the compiler refuses to build.
 *
 * @param date ISO `YYYY-MM-DD`, or null when nothing is recorded
 * @param qualifier how far the date can be trusted
 * @param precision how much of the date the source actually gave
 * @returns the date in words, or null when there is no date to render
 */
export function formatQualifiedDate(
  date: string | null,
  qualifier: DateQualifier,
  precision: DatePrecision,
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

/**
 * The two dates that bound a life, as they are stored.
 *
 * Structural rather than a `GraphPerson`, so that a row read any other way —
 * an `IndividualFields` record, a fixture in a test — is accepted as it
 * stands. Both qualifiers are required for the same reason `precision` is
 * above: they are `not null` columns, so a caller that has a person has them,
 * and making them optional would only invite a surface to drop the one part
 * of a date that says how much to trust it.
 */
export type Lifespan = {
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
};

/**
 * The years under a name: `1899–1960`, `b. about 1890`, `d. before 1920`, or
 * nothing at all.
 *
 * This is the label that has to fit inside a 176px node and beside every link
 * in a relatives list, where the point is to tell two Thomas Hales apart at a
 * glance rather than to state the record. `formatQualifiedDate` states the
 * record, and the panel uses it for the birth and death rows themselves.
 *
 * ## Years only, and why that needs no precision
 *
 * It takes no `DatePrecision`, and that is not the omission the doc comment
 * above warns about — it is the reason there is nothing here to omit. Every
 * precision this schema holds is at least a year, and the anchor convention
 * puts the year in the same four characters whether the source gave a day, a
 * month or a year. So a year is the one part of a stored date that is always
 * genuinely recorded, and reading it back can never invent anything.
 *
 * ## Qualifiers, which it did not used to carry
 *
 * `b. 1890` and `b. about 1890` are different claims, and until E4-T3 the
 * node and the panel header made the first of them about a person whose
 * record only supported the second. Dropping the qualifier here was quietly
 * upgrading a guess into a fact on the most-read surface in the application.
 * When both dates are known the qualifiers sit inline — `about 1890–1962` —
 * which is longer than the bare span and true, and the node truncates rather
 * than lies.
 *
 * @param lifespan the person's two dates and their qualifiers
 * @returns the years in words, or `""` when neither date is recorded
 */
export function formatLifespan(lifespan: Lifespan): string {
  const born = year(lifespan.birthDate, lifespan.birthDateQualifier);
  const died = year(lifespan.deathDate, lifespan.deathDateQualifier);

  if (!born && !died) return "";
  if (born && died) return `${born}–${died}`;
  // A dangling en dash would read as "and still living", which is a claim the
  // absence of a death date does not make. The letter says which end is known.
  if (born) return `b. ${born}`;
  return `d. ${died}`;
}

/**
 * A stored date as its year alone, qualifier and all: `1933`, `about 1948`,
 * or null when there is no date.
 *
 * ## Why this one needs no precision, when `formatQualifiedDate` does
 *
 * Every precision this schema holds is at least a year, and the anchor
 * convention puts the year in the same four characters whether the source
 * gave a day, a month or a year. So the year is the one part of a stored date
 * that is always genuinely recorded, and reading it back can never invent
 * anything — which is exactly the argument `formatLifespan` above makes for
 * itself, extracted so that a second caller can make it too.
 *
 * That caller is E11-T5's infobox, whose spouse rows read "m. 1933; died
 * 1947". Wikipedia writes a union as years beside a name, and the full dates
 * `formatQualifiedDate` returns would make a summary line into a record. The
 * qualifier still comes with it: "m. about 1948" and "m. 1948" are different
 * claims, and dropping the word is how a guess becomes a fact.
 *
 * No malformed-value guard, and unlike `formatQualifiedDate`'s that is not an
 * omission. That function hands its string to `Date`, so it has to say what
 * happens when the parse fails; this one only ever takes the first four
 * characters, which needs no parser and cannot throw. The column is a
 * Postgres `date`, so what arrives is `YYYY-MM-DD` or null — there is no
 * third case for a guard to catch.
 *
 * @param date ISO `YYYY-MM-DD`, or null when nothing is recorded
 * @param qualifier how far the date can be trusted
 * @returns the qualified year, or null when there is no date
 */
export function formatQualifiedYear(
  date: string | null,
  qualifier: DateQualifier,
): string | null {
  if (!date) return null;
  return `${QUALIFIER_PREFIX[qualifier]}${date.slice(0, 4)}`;
}

/** One end of a lifespan: the qualified year, or the empty string. */
function year(date: string | null, qualifier: DateQualifier): string {
  return formatQualifiedYear(date, qualifier) ?? "";
}
