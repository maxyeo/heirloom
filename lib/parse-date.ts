/**
 * Reading a date the way a person actually writes one (E4-T2, `YEO-39`).
 *
 * ## The rule this module exists to enforce
 *
 * **Never make a non-technical author pick a qualifier from a dropdown before
 * typing a date.** They already know how to write "about 1890"; the field
 * should meet them there. So there is one text box per date, and this is what
 * stands behind it: text in, a date plus a qualifier plus a precision out, or
 * a sentence explaining why not.
 *
 * ## Why it is a module and not a hook
 *
 * Pure, with no imports beyond two types. That is what lets the whole of the
 * hard part be tested as a table of strings and expected records, with no DOM,
 * no database and no component — `lib/parse-date.test.ts` is the ticket's
 * acceptance criteria written out. `components/DateField.tsx` is then thin
 * enough to be obviously correct: it holds text, calls this, and renders
 * whichever of the two answers came back.
 *
 * It also has a second caller waiting. GEDCOM import (E6-T1, `YEO-46`) reads
 * `ABT 1890` / `BEF 1920` / `12 MAR 1890` out of a file, which is the same
 * grammar in capitals — so the parser had to be callable with no request, no
 * session and no React, exactly like `lib/field-input.ts` beside it.
 *
 * ## What it does not do
 *
 * It does not validate the date against the column. `readDate` in
 * `lib/field-input.ts` remains the single strict gate in front of the database
 * — this calls it rather than re-deciding whether 30 February exists, so a
 * hand-made POST and a typed form get the same answer. And it does not
 * *format*: the plain-language echo the field shows back is
 * `formatQualifiedDate` in `lib/format-date.ts`, which is the display side of
 * the same pair and, since E4-T3 (`YEO-40`), the one place every date on
 * screen goes through. Parsing and formatting stay separable and each is
 * written once.
 *
 * ## What it deliberately refuses
 *
 * `12/03/1890` is not accepted. It means 12 March to most of the world and 3
 * December to the United States, and a family wiki that guesses silently will
 * be wrong on a percentage of every tree ever imported into it — invisibly,
 * because both readings are plausible dates. Refusing with a sentence that
 * names both readings costs the author one retype; guessing costs somebody a
 * wrong birthday they may never notice.
 */

import {
  readDate,
  type DatePrecision,
  type DateQualifier,
} from "./field-input";

/**
 * One date, as this module understands it: the three columns a date occupies.
 *
 * `date` is always a real ISO `YYYY-MM-DD` day, because that is the only thing
 * a Postgres `date` column can hold. When `precision` is coarser than `day`
 * that value is an *anchor* — the first day of the month or year the author
 * named — and it is never to be read as the day itself. See `DATE_PRECISIONS`
 * in `lib/field-input.ts` for why the pair is stored this way and what keeps
 * the anchor from leaking out as an assertion.
 */
export type ParsedDate = {
  /** ISO `YYYY-MM-DD`. An anchor, not a claim, unless `precision` is `day`. */
  date: string;
  qualifier: DateQualifier;
  precision: DatePrecision;
};

/**
 * Either a date, deliberately-no-date, or the reason there is neither.
 *
 * The three-way answer matters. A blank field is `{ ok: true, value: null }`
 * — "this person's birth date is not recorded" is an ordinary, extremely
 * common state in genealogy, not a failure. Text that could not be read is
 * `ok: false` with a sentence, which is what the field renders inline. What
 * this type makes impossible is the third thing, and the one the ticket was
 * written against: text that quietly became no date at all.
 */
export type DateParse =
  { ok: true; value: ParsedDate | null } | { ok: false; message: string };

/**
 * The words an author puts in front of a date, and what each one means.
 *
 * Drawn from what people actually type and from what GEDCOM files actually
 * contain, not from a specification: `abt`, `c.` and `circa` all appear in
 * real parish transcriptions, and an author who learned "c. 1890" from a
 * museum label should not have to learn ours instead.
 *
 * `est` maps to `about` because the schema has four qualifiers and GEDCOM's
 * `EST` has no home among them. Losing the distinction between "estimated"
 * and "about" costs almost nothing — both mean *roughly* — whereas refusing
 * the word would send the author back to a field they had already answered.
 *
 * Order matters: the list is searched top to bottom, so a longer prefix has to
 * appear before any shorter one it begins with — `circa` before `ca` before
 * `c.`, or "circa 1890" would be read as "about" followed by the unreadable
 * "irca 1890". `lib/parse-date.test.ts` asserts every spelling here parses,
 * which is what keeps a reordering from going unnoticed.
 */
const QUALIFIER_PREFIXES: ReadonlyArray<readonly [string, DateQualifier]> = [
  ["approximately", "about"],
  ["approx.", "about"],
  ["approx", "about"],
  ["about", "about"],
  ["around", "about"],
  ["abt.", "about"],
  ["abt", "about"],
  ["ab.", "about"],
  ["circa", "about"],
  ["ca.", "about"],
  ["ca", "about"],
  ["c.", "about"],
  ["c", "about"],
  ["estimated", "about"],
  ["est.", "about"],
  ["est", "about"],
  ["~", "about"],
  ["before", "before"],
  ["bef.", "before"],
  ["bef", "before"],
  ["prior to", "before"],
  ["<", "before"],
  ["after", "after"],
  ["aft.", "after"],
  ["aft", "after"],
  [">", "after"],
];

/** Month names and the abbreviations that appear in registers and in GEDCOM. */
const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/**
 * The sentence shown when nothing else fits.
 *
 * Four examples rather than a grammar, because the field is for someone
 * holding a photocopied parish register, not for someone reading a manual.
 * Each example is a *different shape* — a bare year, a qualified year, a
 * qualified year with a different qualifier, a full date — so the list teaches
 * the range rather than four spellings of the same thing.
 */
const UNREADABLE =
  "That date could not be read. Try 1890, about 1890, before 1920, or 12 March 1890.";

const AMBIGUOUS =
  "Dates like 12/03/1890 could mean March or December depending on where they were written. Write 12 March 1890, or 1890-03-12.";

const NO_YEAR = "A date needs a year. Try 1890, March 1890, or 12 March 1890.";

const NO_SUCH_DAY =
  "That is not a day the calendar has. Check the day against the month.";

/** `12/03/1890`, `12.03.1890` — day and month in an order nobody can recover. */
const AMBIGUOUS_NUMERIC = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/;

/** `1890`, and nothing else. */
const YEAR_ONLY = /^(\d{4})$/;

/** `1890-03`, `1890-3`. */
const ISO_YEAR_MONTH = /^(\d{4})-(\d{1,2})$/;

/** `1890-03-12`, `1890-3-12`. */
const ISO_FULL = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** `12 March 1890`, `12 Mar 1890`, `12th March 1890`. */
const DAY_MONTH_YEAR = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s+(\d{4})$/i;

/** `March 12, 1890`, `Mar 12 1890` — how the same date is written elsewhere. */
const MONTH_DAY_YEAR = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i;

/** `March 1890`, `Mar 1890`. */
const MONTH_YEAR = /^([a-z]+)\.?\s+(\d{4})$/i;

/** A day and a month, or a bare month, with no year at all: `12 March`, `March`. */
const YEARLESS = /^(?:\d{1,2}(?:st|nd|rd|th)?\s+)?([a-z]+)\.?$/i;

/**
 * Turn what somebody typed into a date, a qualifier and a precision.
 *
 * Pure and total: every input produces one of the three answers in
 * `DateParse`, and none of them is a throw. Callers render the outcome rather
 * than catching anything.
 *
 * @param input the raw text of the field, exactly as typed
 */
export function parseDateInput(input: string): DateParse {
  // Collapse runs of whitespace so "12   March  1890" and a value pasted with
  // a newline in it read as what the author obviously meant. Every pattern
  // below can then assume single spaces.
  const text = input.replace(/\s+/g, " ").trim();
  if (text === "") return { ok: true, value: null };

  const { qualifier, rest } = splitQualifier(text);
  if (rest === "") return { ok: false, message: UNREADABLE };

  const parts = readDateParts(rest);
  if (!parts.ok) return parts;

  // Through `readDate` rather than around it: the question "is 1890-02-30 a
  // day" already has one answer in this repository, and this is not the place
  // to write a second.
  const date = readDate(parts.iso);
  if (typeof date !== "string") {
    return { ok: false, message: NO_SUCH_DAY };
  }

  return { ok: true, value: { date, qualifier, precision: parts.precision } };
}

/**
 * Take the leading qualifier word off, if there is one.
 *
 * A word prefix has to be followed by a space (`about 1890`) or, when it ends
 * in a full stop, by anything at all (`c.1890`) — otherwise `may` would be
 * read as a qualifier the moment somebody wrote `May 1890`, and `circa` would
 * swallow the start of a word it merely happens to begin. The three symbol
 * prefixes (`~`, `<`, `>`) need no separator because no date starts with one.
 */
function splitQualifier(text: string): {
  qualifier: DateQualifier;
  rest: string;
} {
  const lower = text.toLowerCase();

  for (const [prefix, qualifier] of QUALIFIER_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;

    const rest = text.slice(prefix.length);
    const isSymbol = !/[a-z]/.test(prefix);
    const separated = isSymbol || rest.startsWith(" ") || prefix.endsWith(".");
    if (!separated) continue;

    // "about" on its own is not a date, and neither is "~". Falling through
    // leaves it to be reported as unreadable, which is the truthful answer.
    const trimmed = rest.trim();
    if (trimmed === "") continue;

    return { qualifier, rest: trimmed };
  }

  return { qualifier: "exact", rest: text };
}

/**
 * The date itself, with the qualifier already removed.
 *
 * Returns the ISO day to store and how much of it the author actually
 * supplied. A coarse precision anchors to the first day of the month or year,
 * which is the convention `DATE_PRECISIONS` documents and every reader
 * undoes.
 */
function readDateParts(
  rest: string,
):
  | { ok: true; iso: string; precision: DatePrecision }
  | { ok: false; message: string } {
  // Checked before anything else so that a date which *could* be read one way
  // is still refused. `12/03/1890` matches nothing below, but saying so with
  // the generic message would leave the author retyping it in a different
  // ambiguous format.
  if (AMBIGUOUS_NUMERIC.test(rest)) {
    return { ok: false, message: AMBIGUOUS };
  }

  const yearOnly = YEAR_ONLY.exec(rest);
  if (yearOnly) {
    return { ok: true, iso: `${yearOnly[1]}-01-01`, precision: "year" };
  }

  const isoYearMonth = ISO_YEAR_MONTH.exec(rest);
  if (isoYearMonth) {
    const [, year, month] = isoYearMonth;
    return { ok: true, iso: iso(year, Number(month), 1), precision: "month" };
  }

  const isoFull = ISO_FULL.exec(rest);
  if (isoFull) {
    const [, year, month, day] = isoFull;
    return {
      ok: true,
      iso: iso(year, Number(month), Number(day)),
      precision: "day",
    };
  }

  const dayMonthYear = DAY_MONTH_YEAR.exec(rest);
  if (dayMonthYear) {
    const [, day, name, year] = dayMonthYear;
    const month = MONTHS[name.toLowerCase()];
    if (month === undefined) return { ok: false, message: UNREADABLE };
    return { ok: true, iso: iso(year, month, Number(day)), precision: "day" };
  }

  const monthDayYear = MONTH_DAY_YEAR.exec(rest);
  if (monthDayYear) {
    const [, name, day, year] = monthDayYear;
    const month = MONTHS[name.toLowerCase()];
    if (month === undefined) return { ok: false, message: UNREADABLE };
    return { ok: true, iso: iso(year, month, Number(day)), precision: "day" };
  }

  const monthYear = MONTH_YEAR.exec(rest);
  if (monthYear) {
    const [, name, year] = monthYear;
    const month = MONTHS[name.toLowerCase()];
    if (month === undefined) return { ok: false, message: UNREADABLE };
    return { ok: true, iso: iso(year, month, 1), precision: "month" };
  }

  // Last, and only when a real month name is the whole of what is left:
  // "the year is missing" is a far more useful sentence than the general one,
  // but only when a month is genuinely what was typed. "hello" is not a date
  // with a year missing, and telling its author to add one would send them
  // looking in the wrong place.
  const yearless = YEARLESS.exec(rest);
  if (yearless && MONTHS[yearless[1].toLowerCase()] !== undefined) {
    return { ok: false, message: NO_YEAR };
  }

  return { ok: false, message: UNREADABLE };
}

/** `YYYY-MM-DD`, zero-padded, which is the only shape `readDate` accepts. */
function iso(year: string, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
