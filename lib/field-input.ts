/**
 * Reading one untrusted field, for every module that validates a table.
 *
 * ## Why this exists
 *
 * `lib/individual-input.ts` (E3-T1, `YEO-29`) wrote these readers first, as
 * private helpers, because it was the only validator in the repository. The
 * add-spouse flow (E3-T4, `YEO-32`) is the second, and `unions` has the same
 * three kinds of field the `individuals` table has: text that may be blank, an
 * ISO date that has to be a day the calendar actually has, and a fixed
 * vocabulary that mirrors a Postgres enum. `unions` also carries two of the
 * same `date_qualifier` columns, and therefore the same "can these two dates
 * be in this order" comparison.
 *
 * Copying eighty lines of date parsing into the second validator would give
 * the app two answers to "is `2023-02-30` a date", and the wrong one would
 * win on whichever path nobody was looking at. So they moved here, and
 * `lib/individual-input.ts` imports them back — its public API is unchanged,
 * and `DATE_QUALIFIERS`, `DateQualifier` and `MAX_NOTES_LENGTH` are still
 * exported from there for the callers that already name it.
 *
 * ## The constraint that shapes all of it
 *
 * Nothing in this file may touch `headers()`, `cookies()`, `@/db`, or any
 * other ambient request state — the same rule `lib/individual-input.ts`
 * states and for the same reason: E6-T2's GEDCOM import runs over a file with
 * no session and no `FormData` and must be able to report per-row problems
 * without writing anything. This module has no imports at all, which is the
 * strongest form of that guarantee.
 *
 * Every reader below returns `undefined` for "present but unusable" and
 * `null` for "not given". That three-state answer is what lets a caller tell
 * an author's blank field apart from a caller's type error without either
 * throwing or guessing.
 */

/**
 * How much to trust the date sitting next to this qualifier — GEDCOM 5.5.1's
 * date modifiers, mirroring the `date_qualifier` enum in `db/schema.ts`.
 *
 * Deliberately re-declared rather than derived from the Drizzle table:
 * importing the schema — even for a type — drags postgres.js in with it, and
 * this module has to stay importable by a client component and by a test with
 * no `DATABASE_URL` (docs/testing.md).
 *
 * Structurally identical to `DateQualifier` in `lib/family-graph.ts`, which
 * declares its own for the *read* path. They are not shared because the
 * dependency would run the wrong way: `lib/family-graph.ts` imports `@/db`,
 * so a write-path module importing its type would make every consumer of this
 * file reach for postgres.js.
 */
export const DATE_QUALIFIERS = ["exact", "about", "before", "after"] as const;

export type DateQualifier = (typeof DATE_QUALIFIERS)[number];

/**
 * How much of the date sitting beside this was actually known (E4-T2,
 * `YEO-39`), mirroring the `date_precision` enum in `db/schema.ts`.
 *
 * A qualifier and a precision answer two different questions, and a record
 * needs both. The qualifier says how far the source can be trusted — "about
 * 1890" against a flat "1890". The precision says how much of a date the
 * source supplied at all: a headstone gives a year, a census gives a year, a
 * parish register gives a day. Neither `exact` nor `about` can say "the year
 * 1890, day unknown" — and stamping `exact` on a value whose day nobody typed
 * is how a third of a family tree ends up born on 1 January.
 *
 * Postgres `date` has no room for the distinction: the column must hold a real
 * calendar day or nothing at all. So a year-only date is stored as the **first
 * day of the year it names, with `precision = 'year'` in the column beside
 * it**, and that pair — never the day on its own — is what every reader goes
 * through. `dateRange` below widens the anchor back out to the whole year
 * before comparing anything; `formatQualifiedDate` renders `1890` rather than
 * `1 January 1890`. The anchor is a storage detail, not a claim about when
 * somebody was born, and nothing formats, compares or exports it as one.
 *
 * `day` is the default, which is what makes the column safe to add: every row
 * written before it existed came from an `<input type="date">` and therefore
 * carries a full date, so it keeps meaning exactly what it meant before.
 */
export const DATE_PRECISIONS = ["day", "month", "year"] as const;

export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/**
 * How long a free-text note may be.
 *
 * Larger than a name and much smaller than an essay, because an essay belongs
 * in a wiki entry (E1), which is versioned, searchable and formatted. Both
 * `individuals.notes` and `unions.notes` are the margin of the index card —
 * "adopted, per the 1911 census", "married at St Anne's" — and a limit that
 * says so is kinder than one that silently accepts a life story into a field
 * nothing renders well.
 *
 * The columns are `text` and therefore unbounded, and a server action is an
 * open POST endpoint, so without a limit here "notes" is a way to put a
 * megabyte into a row that every tree render then reads.
 */
export const MAX_NOTES_LENGTH = 2000;

/** `YYYY-MM-DD`, the only date format stored or accepted. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Read a text field: trim it, and treat blank as absent.
 *
 * The blank-is-null rule is the one that matters. An HTML form posts every
 * field it contains, so a place nobody filled in arrives as `""` — and `""`
 * stored in a nullable column is a third state that means the same as null
 * but does not compare, sort, or coalesce like it. Collapsing it here means
 * "unknown" has exactly one representation in the database.
 *
 * @returns the trimmed text, `null` for blank or absent, or `undefined` when
 *   the value was present but not text at all, which is a caller error rather
 *   than an author's
 */
export function readText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Whether a `YYYY-MM-DD` string names a day that exists.
 *
 * The pattern alone accepts `2023-02-30` and `2024-13-01`, and Postgres would
 * reject both with `date/time field value out of range` — a thrown error from
 * the driver rather than a message the author can act on. Round-tripping
 * through `Date.UTC` and comparing the parts back is what separates a date
 * that is merely well-shaped from one that happened: JavaScript rolls
 * February 30th forward to March 2nd, so a mismatch on any part means the
 * input named a day the calendar does not have.
 *
 * UTC rather than local time throughout, so the answer does not depend on the
 * `TZ` of whatever machine is running the import.
 */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  // Year zero is not a year in the proleptic Gregorian calendar Postgres uses,
  // and `Date.UTC` maps 0..99 to 1900..1999 — so it would round-trip as 1900
  // and quietly pass.
  if (year < 1) return false;

  const stamp = new Date(Date.UTC(year, month - 1, day));
  return (
    stamp.getUTCFullYear() === year &&
    stamp.getUTCMonth() === month - 1 &&
    stamp.getUTCDate() === day
  );
}

/**
 * Read a date field.
 *
 * Only ISO `YYYY-MM-DD` is accepted, which is exactly what `<input
 * type="date">` submits — so a form needs no conversion, and the stored value
 * needs no interpretation.
 *
 * What this deliberately does *not* do is parse "abt 1890" or "before 1920".
 * That is `lib/parse-date.ts` (E4-T2, `YEO-39`), whose whole job is to turn
 * what a person types into a date, a qualifier and a precision — the three the
 * validators then check. Putting a second, looser parser here would give the
 * app two answers to "what does `1890` mean", and the one nobody could see
 * would win on the import path.
 *
 * That division survived the free-text date field rather than being undone by
 * it. `lib/parse-date.ts` runs in the browser and hands this an ISO day; this
 * stays the single strict gate in front of the column, so a hand-made POST
 * gets the same answer as a form. When the text cannot be parsed the field
 * posts it unchanged, which is what turns "I cannot read that" into an
 * ordinary validation issue against the date rather than a silently empty
 * column.
 *
 * @returns the date, `null` when absent, or `undefined` when it is not a
 *   usable date — the caller turns that into an issue
 */
export function readDate(value: unknown): string | null | undefined {
  const text = readText(value);
  if (text === null || text === undefined) return text;

  const match = ISO_DATE_PATTERN.exec(text);
  if (!match) return undefined;

  const [, year, month, day] = match;
  if (!isRealCalendarDay(Number(year), Number(month), Number(day))) {
    return undefined;
  }

  return text;
}

/**
 * Read one of the fixed vocabularies mirroring a Postgres enum.
 *
 * An absent or blank value takes the given fallback rather than failing:
 * every enum in this schema has a member that means "nothing was said"
 * (`unknown`, `exact`, `ongoing`), so a caller that omits the field entirely
 * is expressing something the schema can already hold. Anything else present
 * but unrecognised *is* an error — it can only come from a hand-made POST or
 * from a bug, and silently defaulting it would write a value nobody chose.
 */
export function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T | undefined {
  const text = readText(value);
  if (text === null) return fallback;
  if (text === undefined) return undefined;

  return (allowed as readonly string[]).includes(text)
    ? (text as T)
    : undefined;
}

/**
 * The earliest and latest day a date-plus-qualifier could actually mean.
 *
 * This is what makes "death not before birth" — and "a marriage did not end
 * before it began" — defensible rather than annoying. A qualifier is not
 * decoration: `before 1920` genuinely asserts nothing about how much earlier,
 * and `about 1890` asserts nothing precise in either direction. Comparing the
 * stored days alone would reject a perfectly ordinary record — born *about*
 * 1890-01-01, died 1889-12-01, which any genealogist would read as "born
 * around 1889 or 1890" and accept.
 *
 * So each date becomes an interval and the rule fires only when the intervals
 * cannot overlap. The precision widens the stored anchor day into the span it
 * stands for first, and the qualifier is then read against that span:
 *
 * | precision | anchor `1890-01-01` stands for |
 * | --- | --- |
 * | `day` | `[1890-01-01, 1890-01-01]` |
 * | `month` | `[1890-01-01, 1890-01-31]` |
 * | `year` | `[1890-01-01, 1890-12-31]` |
 *
 * | qualifier | means | interval, over that span `[s, e]` |
 * | --- | --- | --- |
 * | `exact` | somewhere in the span | `[s, e]` |
 * | `before` | at some point up to then | `(−∞, e]` |
 * | `after` | at some point from then on | `[s, +∞)` |
 * | `about` | roughly then, unquantified | `(−∞, +∞)` |
 *
 * Widening by precision is not a nicety. A year-only date is stored on the
 * first of January (see `DATE_PRECISIONS`), so without it a person born
 * 1890-06-01 who died "in 1890" would be refused — the death's anchor,
 * 1890-01-01, reads as five months before the birth. Comparing spans is what
 * keeps the anchor from being mistaken for an assertion.
 *
 * `about` widening to everything is the conservative reading, and the right
 * one for a validator: the alternative is inventing a tolerance (five years?
 * ten?) and refusing records that fall outside a number nobody chose.
 *
 * `null` for a bound means unbounded in that direction.
 */
function dateRange(
  date: string,
  qualifier: DateQualifier,
  precision: DatePrecision,
): { earliest: string | null; latest: string | null } {
  const { start, end } = precisionSpan(date, precision);

  switch (qualifier) {
    case "exact":
      return { earliest: start, latest: end };
    case "before":
      return { earliest: null, latest: end };
    case "after":
      return { earliest: start, latest: null };
    case "about":
      return { earliest: null, latest: null };
  }
}

/**
 * The first and last day the stored anchor stands for, given its precision.
 *
 * A malformed anchor is left alone rather than repaired: `readDate` has
 * already refused anything that is not a real `YYYY-MM-DD`, so the only way to
 * arrive here with one is a row written before that check existed, and
 * inventing a span for it would be worse than treating it as the single day it
 * claims to be.
 */
function precisionSpan(
  date: string,
  precision: DatePrecision,
): { start: string; end: string } {
  const match = ISO_DATE_PATTERN.exec(date);
  if (!match || precision === "day") return { start: date, end: date };

  const [, year, month] = match;
  if (precision === "year") {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }

  // Day 0 of the *next* month is the last day of this one, which is how the
  // length of February gets decided by the calendar rather than by a table.
  const lastDay = new Date(
    Date.UTC(Number(year), Number(month), 0),
  ).getUTCDate();
  return {
    start: `${year}-${month}-01`,
    end: `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * A date column read together with its `date_qualifier` and `date_precision`
 * siblings.
 *
 * `precision` is optional and defaults to `day`, which is both the column
 * default and the only thing a caller that predates E4-T2 could have meant.
 */
export type QualifiedDate = {
  date: string;
  qualifier: DateQualifier;
  precision?: DatePrecision;
};

/**
 * Whether `later` could not possibly have come at or after `first`.
 *
 * True only when the *latest* `later` could have been is still earlier than
 * the *earliest* `first` could have been — the one case that is wrong under
 * every reading of the qualifiers. A death before a birth is the case this
 * was written for; a marriage that ended before it started is the same shape.
 *
 * Same-day is allowed, and that is not an oversight: an infant who lived
 * hours is a record a family wiki has to be able to hold, and a validator
 * that refused it would be telling a bereaved family their data is invalid.
 * A marriage that ended the day it began is rarer and no less real.
 *
 * ISO `YYYY-MM-DD` is fixed-width and zero-padded, so its lexicographic order
 * is its chronological order and no parsing is needed to compare two of them.
 */
export function isImpossibleOrder(
  first: QualifiedDate,
  later: QualifiedDate,
): boolean {
  const firstEarliest = dateRange(
    first.date,
    first.qualifier,
    first.precision ?? "day",
  ).earliest;
  const laterLatest = dateRange(
    later.date,
    later.qualifier,
    later.precision ?? "day",
  ).latest;

  if (firstEarliest === null || laterLatest === null) return false;
  return laterLatest < firstEarliest;
}

/**
 * Take the fields of a form whose names share a prefix, with the prefix
 * stripped.
 *
 * A form that creates a person *inside* another record's flow posts two
 * records at once, and both have a `notes` field. Namespacing the person's
 * inputs as `partner.notes` (E3-T4) or `child.notes` (E3-T5) is what keeps
 * them apart; stripping the prefix here is what lets
 * `individualInputFromFormData` — which knows the *unprefixed* field names and
 * is the only thing that should know them — read them unchanged.
 *
 * A second `FormData` rather than a mapped object, so the person's field names
 * stay written down in exactly one place.
 *
 * Here rather than beside either flow's validator because both need it and
 * neither owns it: `lib/union-input.ts` wrote it first for the add-spouse
 * form, and `lib/child-input.ts` needs precisely the same function. Two copies
 * would be two places for the prefix rule to drift.
 */
export function withoutPrefix(form: FormData, prefix: string): FormData {
  const stripped = new FormData();
  for (const [key, value] of form.entries()) {
    if (key.startsWith(prefix))
      stripped.append(key.slice(prefix.length), value);
  }
  return stripped;
}
