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
 * siblings — and, since `YEO-88`, the upper bound that turns a single point
 * into a range, with its own precision.
 *
 * All five are only ever meaningful together — a qualifier with no date says
 * nothing, an upper bound means nothing without knowing its own precision —
 * which is why the schema keeps the two precision columns `not null` and
 * lets only the two dates themselves be null. `upper` is null on every date
 * that is a single point, which is every row written before `YEO-88`.
 *
 * One object rather than five positional arguments, and that is not
 * cosmetic. Two of the five are `string | null` dates and two are
 * `DatePrecision` — a transposed pair of positional arguments would compile
 * silently. Named keys cannot be transposed the same way.
 *
 * Structural rather than an import of `GraphPerson` or `GraphUnion`, so a row
 * read any other way — an `IndividualFields` record, a fixture in a test —
 * is accepted as it stands. `birthOf`, `deathOf`, `unionStart` and
 * `unionEnd` below are the four places this shape is read off a real row, so
 * the five-column group is written down in exactly four places rather than
 * at every call site.
 */
export type QualifiedDate = {
  date: string | null;
  qualifier: DateQualifier;
  precision: DatePrecision;
  upper: string | null;
  upperPrecision: DatePrecision;
};

/** One endpoint of a date, at its own precision, with no qualifier prefix. */
function formatEndpoint(date: string, precision: DatePrecision): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  // A malformed value should read as the stored string rather than as
  // "Invalid Date", which tells a reader nothing about what is in the row.
  if (Number.isNaN(parsed.getTime())) return date;

  return new Intl.DateTimeFormat("en-GB", {
    ...PRECISION_OPTIONS[precision],
    timeZone: "UTC",
  }).format(parsed);
}

/**
 * A qualified date (E4-T3, `YEO-40`), and — since `YEO-88` — a qualified
 * range, in words: `1 January 1890`, `about 1890`, `between 1890 and 1900`,
 * `between March 1890 and 1900`.
 *
 * **Null is rendered as nothing** — never as "unknown", never as a dash. A
 * missing birth date is the ordinary state of a nineteenth-century record,
 * not a gap to apologise for, and a column of em dashes reads as a defect in
 * the tree rather than as the honest limit of what a source said.
 *
 * The result is deliberately something `parseDateInput` can read straight back
 * in: "about 1890" out of here goes into the date field and comes back as the
 * same three values, and "between 1890 and 1900" comes back as five. That
 * round trip is what lets the edit form prefill a free-text date box without
 * a second, quieter formatter written to serve it — and
 * `lib/parse-date.test.ts` asserts it closes.
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
 * reviewer has to notice to something the compiler refuses to build. `upper`
 * and `upperPrecision` are required for the identical reason: an optional
 * upper bound would ship green today and render a range as a bare single
 * date the day some call site forgot it.
 *
 * **A range renders with each endpoint at its own precision**, because the
 * two routinely come from different sources — `between March 1890 and 1900`
 * is a baptism in March and a census in 1900, and one precision for both
 * would have to throw the March away or invent one for 1900. No qualifier
 * prefix goes in front of "between": the only qualifier a stored range can
 * legally carry is `exact`, whose prefix is already the empty string. A row
 * with a non-`exact` qualifier beside a non-null upper is not a state
 * `validateIndividual`/`validateUnion` allow to be written — but a hand-made
 * `INSERT` can still produce one, and this function renders it honestly
 * (`about between 1890 and 1900`) rather than hiding a word the validator is
 * the actual gate for.
 *
 * @param qualifiedDate the date, its qualifier, its precision, and — when the
 *   date is a range — the upper bound and its own precision
 * @returns the date in words, or null when there is no date to render
 */
export function formatQualifiedDate(
  qualifiedDate: QualifiedDate,
): string | null {
  const { date, qualifier, precision, upper, upperPrecision } = qualifiedDate;
  if (!date) return null;

  const lower = formatEndpoint(date, precision);

  if (upper) {
    const upperFormatted = formatEndpoint(upper, upperPrecision);
    return `${QUALIFIER_PREFIX[qualifier]}between ${lower} and ${upperFormatted}`;
  }

  return `${QUALIFIER_PREFIX[qualifier]}${lower}`;
}

/**
 * `birthOf`, `deathOf`, `unionStart` and `unionEnd` — the four places a
 * `QualifiedDate` is read off a real row.
 *
 * Structural parameter types rather than `GraphPerson`/`GraphUnion`, for the
 * same reason `QualifiedDate` itself is structural: a fixture, an
 * `IndividualFields` record and a `GraphPerson` all carry the five columns
 * under the same names, and none of them needs to *be* a `GraphPerson` to be
 * read here.
 */
type BirthFields = {
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  birthDatePrecision: DatePrecision;
  birthDateUpper: string | null;
  birthDateUpperPrecision: DatePrecision;
};

type DeathFields = {
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
  deathDatePrecision: DatePrecision;
  deathDateUpper: string | null;
  deathDateUpperPrecision: DatePrecision;
};

type UnionStartFields = {
  startDate: string | null;
  startDateQualifier: DateQualifier;
  startDatePrecision: DatePrecision;
  startDateUpper: string | null;
  startDateUpperPrecision: DatePrecision;
};

type UnionEndFields = {
  endDate: string | null;
  endDateQualifier: DateQualifier;
  endDatePrecision: DatePrecision;
  endDateUpper: string | null;
  endDateUpperPrecision: DatePrecision;
};

export function birthOf(person: BirthFields): QualifiedDate {
  return {
    date: person.birthDate,
    qualifier: person.birthDateQualifier,
    precision: person.birthDatePrecision,
    upper: person.birthDateUpper,
    upperPrecision: person.birthDateUpperPrecision,
  };
}

export function deathOf(person: DeathFields): QualifiedDate {
  return {
    date: person.deathDate,
    qualifier: person.deathDateQualifier,
    precision: person.deathDatePrecision,
    upper: person.deathDateUpper,
    upperPrecision: person.deathDateUpperPrecision,
  };
}

export function unionStart(union: UnionStartFields): QualifiedDate {
  return {
    date: union.startDate,
    qualifier: union.startDateQualifier,
    precision: union.startDatePrecision,
    upper: union.startDateUpper,
    upperPrecision: union.startDateUpperPrecision,
  };
}

export function unionEnd(union: UnionEndFields): QualifiedDate {
  return {
    date: union.endDate,
    qualifier: union.endDateQualifier,
    precision: union.endDatePrecision,
    upper: union.endDateUpper,
    upperPrecision: union.endDateUpperPrecision,
  };
}

/**
 * The two dates that bound a life, as they are stored — and, since
 * `YEO-88`, the upper bound of either one, when it is a range.
 *
 * Structural rather than a `GraphPerson`, so that a row read any other way —
 * an `IndividualFields` record, a fixture in a test — is accepted as it
 * stands. Both qualifiers are required for the same reason `precision` is
 * above: they are `not null` columns, so a caller that has a person has them,
 * and making them optional would only invite a surface to drop the one part
 * of a date that says how much to trust it. `birthDateUpper`/`deathDateUpper`
 * carry no precision alongside them — `formatQualifiedYear` below takes only
 * the first four characters of any date at any precision, so there is
 * nothing for a precision to change.
 */
export type Lifespan = {
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  birthDateUpper: string | null;
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
  deathDateUpper: string | null;
};

/**
 * The years under a name: `1899–1960`, `b. about 1890`, `d. before 1920`,
 * `b. 1890–1900, d. 1962`, or nothing at all.
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
 * ## A range breaks the compact form (`YEO-88`)
 *
 * The bare `1890–1962` form's en dash already means "birth year, death
 * year". If the birth or the death is *itself* a range — `1890–1900` — a
 * third year cannot share that one dash without becoming unreadable as to
 * which end is which. So when either date is a range, both switch to the
 * labelled form: `b. 1890–1900, d. 1962`, `b. 1890, d. 1950–1955`, or
 * `b. 1890–1900` alone. Neither date a range still gets the compact
 * `1890–1962` unchanged — this is the common case, and it does not pay for
 * the rare one.
 *
 * @param lifespan the person's two dates, their qualifiers, and either
 *   date's upper bound when it is a range
 * @returns the years in words, or `""` when neither date is recorded
 */
export function formatLifespan(lifespan: Lifespan): string {
  const born =
    formatQualifiedYear({
      date: lifespan.birthDate,
      qualifier: lifespan.birthDateQualifier,
      upper: lifespan.birthDateUpper,
    }) ?? "";
  const died =
    formatQualifiedYear({
      date: lifespan.deathDate,
      qualifier: lifespan.deathDateQualifier,
      upper: lifespan.deathDateUpper,
    }) ?? "";

  if (!born && !died) return "";

  // A range renders with its own en dash (`1890–1900`), which is what makes
  // this check enough to detect one: the compact form below has no other way
  // to produce that character.
  const isRange = born.includes("–") || died.includes("–");
  if (isRange) {
    if (born && died) return `b. ${born}, d. ${died}`;
    if (born) return `b. ${born}`;
    return `d. ${died}`;
  }

  if (born && died) return `${born}–${died}`;
  // A dangling en dash would read as "and still living", which is a claim the
  // absence of a death date does not make. The letter says which end is known.
  if (born) return `b. ${born}`;
  return `d. ${died}`;
}

/**
 * A stored date as its year alone, qualifier and all: `1933`, `about 1948`,
 * `1890–1900`, or null when there is no date.
 *
 * ## Why this one needs no precision, when `formatQualifiedDate` does
 *
 * Every precision this schema holds is at least a year, and the anchor
 * convention puts the year in the same four characters whether the source
 * gave a day, a month or a year. So the year is the one part of a stored date
 * that is always genuinely recorded, and reading it back can never invent
 * anything — which is exactly the argument `formatLifespan` above makes for
 * itself, extracted so that a second caller can make it too. The same holds
 * for `upper`: whatever precision the upper bound itself carries, its first
 * four characters are its year.
 *
 * That caller is E11-T5's infobox, whose spouse rows read "m. 1933; died
 * 1947". Wikipedia writes a union as years beside a name, and the full dates
 * `formatQualifiedDate` returns would make a summary line into a record. The
 * qualifier still comes with it: "m. about 1948" and "m. 1948" are different
 * claims, and dropping the word is how a guess becomes a fact.
 *
 * **A same-year range collapses to one year.** `BET MAR 1890 AND JUN 1890`
 * is `1890`, not `1890–1890` — a range that starts and ends in the same year
 * says nothing a bare year does not already say.
 *
 * No malformed-value guard, and unlike `formatQualifiedDate`'s that is not an
 * omission. That function hands its string to `Date`, so it has to say what
 * happens when the parse fails; this one only ever takes the first four
 * characters, which needs no parser and cannot throw. The column is a
 * Postgres `date`, so what arrives is `YYYY-MM-DD` or null — there is no
 * third case for a guard to catch.
 *
 * @param qualifiedYear the date, its qualifier, and — when the date is a
 *   range — its upper bound
 * @returns the qualified year (or year range), or null when there is no date
 */
export function formatQualifiedYear(qualifiedYear: {
  date: string | null;
  qualifier: DateQualifier;
  upper: string | null;
}): string | null {
  const { date, qualifier, upper } = qualifiedYear;
  if (!date) return null;

  const lowerYear = date.slice(0, 4);
  if (upper) {
    const upperYear = upper.slice(0, 4);
    if (upperYear !== lowerYear) {
      return `${QUALIFIER_PREFIX[qualifier]}${lowerYear}–${upperYear}`;
    }
  }

  return `${QUALIFIER_PREFIX[qualifier]}${lowerYear}`;
}
