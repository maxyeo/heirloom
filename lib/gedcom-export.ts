import type { ChildRelation } from "./child-input";
import type { DatePrecision, DateQualifier } from "./field-input";
import { SEX_CODES } from "./gedcom";
import { PEDIGREES } from "./gedcom-map";
import type { IndividualFields, Sex } from "./individual-input";
import type { UnionFields } from "./union-input";

/**
 * `individuals` / `unions` / `union_children` back out as GEDCOM 5.5.1
 * (E7-T1, `YEO-51`).
 *
 * ## What this is
 *
 * The other direction of `lib/gedcom-map.ts`. That module is the first point
 * that is true of the *schema*; this one walks back to the last point that is
 * true of the *file*, and `lib/gedcom-lines.ts`'s grammar note — "writing the
 * `@` delimiters back is one template literal on the export side" — is the
 * seam it was written against.
 *
 * Being able to get a tree back out again is the promise that makes it
 * reasonable to put decades of somebody's work in here in the first place, so
 * this is a feature of the data model rather than a convenience on top of it.
 *
 * ## It reverses the E6-T2 mapping rather than restating it
 *
 * That is an acceptance criterion, and it is the kind that decays quietly: a
 * second table saying `adopted` -> `adopted` typechecks forever and stops
 * agreeing with the first the day somebody adds a member to one of them.
 *
 * So the two vocabulary tables are **imported and inverted**, never copied.
 * `SEX_CODES` lives in `lib/gedcom.ts` and `PEDIGREES` in
 * `lib/gedcom-map.ts`; `invert` below turns each into a lookup this module
 * reads, and `lib/gedcom-export.test.ts` asserts that every member of `Sex`
 * and of `ChildRelation` comes back with a spelling — which is what makes
 * adding an enum member a test failure here rather than a silently missing
 * line in somebody's export.
 *
 * Two things genuinely cannot be inverted, and they are the two the import
 * side reads *many* spellings of. `QUALIFIER_PREFIXES` in
 * `lib/parse-date.ts` maps sixteen words onto four qualifiers and `MONTHS`
 * maps twenty-two onto twelve; an inverse would have to pick one spelling per
 * member, which is a choice about output rather than a fact recoverable from
 * the input table. `GEDCOM_QUALIFIERS` and `GEDCOM_MONTHS` below make that
 * choice explicitly — and the test holds them to the same standard the
 * inverted tables get for free, by parsing every string they can emit back
 * through `parseDateInput` and asserting it lands on the member it came from.
 *
 * ## Deterministic, because E7-T2 is a byte comparison
 *
 * E7-T2 (`YEO-52`) round-trips export -> import -> export and requires the
 * two texts to be **identical**. Three things follow, and each of them is a
 * decision this module cannot revisit casually.
 *
 * - **No clock, no randomness, no environment.** GEDCOM's header has a `DATE`
 *   for the moment of transmission and this file does not write one. It is
 *   optional in 5.5.1, and a timestamp would make every export of an
 *   unchanged tree a different file — which defeats the round trip, and also
 *   defeats the much more ordinary case of a person diffing two backups to
 *   see what changed.
 * - **Ordering is derived from what survives a round trip.** The row ids do
 *   not: an export writes `@I1@`, and re-importing mints fresh UUIDs, so a
 *   sort on `individuals.id` is stable within one process and meaningless
 *   across the trip. `orderIndividuals` and `orderUnions` therefore sort on
 *   values that are written into the file and read back out of it — surname,
 *   given name, dates, and each partner's position in the individual order —
 *   with the caller's own order as the final tie-break. Two records that are
 *   identical in every sorted field are the only case that falls through to
 *   it, and after one pass their file order *is* the caller's order, so the
 *   trip closes there too.
 * - **String comparison is by code unit, not by locale.** `localeCompare`
 *   depends on the ICU data the process happens to have; `<` does not.
 *
 * The xrefs are then positional — `I1`, `F1`, `U1` — which is what makes them
 * stable without being derived from an id that is not.
 *
 * ## What it does not write
 *
 * `notes` on either table, deliberately. GEDCOM has `NOTE` and the parser does
 * not read it, so a note written here would be dropped on the way back in and
 * absent from the second export — the round trip would fail on data this
 * module had itself invented a use for. E7-T4 (`YEO-54`) is the ticket that
 * puts entries and notes in a backup, as JSON beside the GEDCOM rather than
 * inside it, and `docs/epics.md` says why: the genealogy standard has nowhere
 * to put a wiki.
 *
 * Nothing else is dropped. Every column the mapping fills is written back,
 * including both bounds of a range and the `PEDI` on every child link.
 *
 * ## The three places a first export narrows
 *
 * All three are states the schema can hold and GEDCOM cannot, and all three
 * are **stable from the second pass on** — the loss happens once, on the way
 * out, and the file then round-trips unchanged. They are listed in
 * `docs/gedcom.md` beside the import side's own losses.
 *
 * - `union_type` has `partnership`, and GEDCOM's only word for a dated
 *   partnership is `MARR`. A partnership with a start date is written as a
 *   marriage and reads back as one — and so is any union that ended in a
 *   divorce, whatever its type, because `DIV` is meaningless without the
 *   `MARR` it dissolves. Both are written on the *first* pass, so the file
 *   states the narrowing rather than leaving a reader to infer it.
 * - `union_end_reason` has `separation` and `unknown`, and GEDCOM 5.5.1 has
 *   no family event for either. The reason and any `end_date` beside it are
 *   not written. `divorce` is `DIV` directly, and `death` is deliberately not
 *   written at all — `lib/gedcom-map.ts` infers it back from the partners'
 *   own death dates, which is where the date already lives.
 * - `unions.sequence` has no GEDCOM equivalent whatsoever, as E6-T2 found. It
 *   is re-derived on import from family order and marriage dates.
 *
 * ## It writes what it is given, and does not validate
 *
 * The round trip closes for every tree this application can produce, which is
 * every tree that went through `validateIndividual`, `validateUnion` and
 * `validateChildLink` — and, where a row can be written *around* them by hand,
 * this module still writes a file that says what a reader will read: a place
 * is collapsed and a name trimmed exactly as the parser would, a `FAM` with no
 * partner is not written because it is a record about nobody, and a `CHIL`
 * naming one of the family's own partners is not written because no reader can
 * resolve that contradiction.
 *
 * What it does **not** do is repair a row whose *values* the schema refuses. A
 * birth recorded as `BET 1900 AND 1890`, or a person in a union with
 * themselves, is written faithfully and then declined by `validateIndividual`
 * or `validateUnion` on the way back in, with a sentence on the import report
 * saying so. Silently reversing the bounds or dropping the partner would be
 * this module inventing a recovery policy that the import side deliberately
 * does not have, and hiding a broken row rather than surfacing it.
 *
 * ## Pure, like everything else in this pipeline
 *
 * No `@/db`, no React, no npm package — `lib/gedcom.purity.test.ts` walks this
 * module's import closure and asserts it, for the reason it gives for the
 * other two: E7-T2 round-trips export through import with no database in
 * sight, and a serialiser that needed one could only be tested against one.
 * `lib/export-tree.ts` is the thin half that reads the rows.
 */

/** An `individuals` row. A Drizzle row satisfies this as it comes back. */
export type ExportIndividual = IndividualFields & { id: string };

/** A `unions` row. */
export type ExportUnion = UnionFields & { id: string };

/** A `union_children` row. */
export type ExportChild = {
  unionId: string;
  childId: string;
  relation: ChildRelation;
};

/** A whole tree, in this schema's terms. */
export type GedcomExportInput = {
  individuals: readonly ExportIndividual[];
  unions: readonly ExportUnion[];
  unionChildren: readonly ExportChild[];
};

/**
 * Everything the writers look records up by, built once before any line is
 * written.
 *
 * Without it each `INDI` would scan the whole child-link list and the whole
 * union list to find its own `FAMC` and `FAMS` lines, and each `FAM` would
 * scan the link list again for its `CHIL` — quadratic in the size of the tree,
 * on the one operation whose whole job is to walk it. The lists are built from
 * the already-ordered arrays, so every value in here is in the order it will
 * be written and nothing re-sorts.
 */
type ExportIndex = {
  positionOfIndividual: ReadonlyMap<string, number>;
  positionOfUnion: ReadonlyMap<string, number>;
  /** Child links by the child they name, for that person's `FAMC` lines. */
  linksByChild: ReadonlyMap<string, readonly ExportChild[]>;
  /** Child links by the family they belong to, for its `CHIL` lines. */
  linksByUnion: ReadonlyMap<string, readonly ExportChild[]>;
  /** The families a person is a partner in, by position, for their `FAMS`. */
  familiesOfPartner: ReadonlyMap<string, readonly number[]>;
};

/**
 * CRLF, which GEDCOM 5.5.1 specifies and which is fixed here rather than
 * taken from the platform. `os.EOL` would make the same tree export
 * differently on a developer's Mac and on CI, and E7-T2 compares bytes.
 * `lib/gedcom-lines.ts` splits on all three endings, so nothing on the way
 * back in depends on this choice.
 */
const NEWLINE = "\r\n";

/**
 * How much value fits on one line before `CONC` takes over.
 *
 * 5.5.1 caps a whole line at 255 characters, and the longest prefix this
 * module writes is `2 CONC ` at seven. 200 leaves room that no arithmetic has
 * to be trusted for, and it is also `MAX_NAME_LENGTH` — so every value that
 * came through `validateIndividual` fits on one line and the splitting is
 * reached only by a row that was written around it.
 */
const MAX_VALUE_LENGTH = 200;

/** GEDCOM's month abbreviations, in calendar order. */
const GEDCOM_MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/**
 * The one spelling each qualifier is written as, and the empty string for
 * `exact`, which GEDCOM says by writing no modifier at all.
 *
 * Not derived from `QUALIFIER_PREFIXES`: that table reads `abt`, `ca.`,
 * `circa`, `est` and a dozen more onto four members, so its inverse is a
 * choice rather than a fact. These four are GEDCOM 5.5.1's own, and the test
 * parses each of them back through the shared grammar to prove the choice
 * lands where it started.
 */
const GEDCOM_QUALIFIERS: Readonly<Record<DateQualifier, string>> = {
  exact: "",
  about: "ABT ",
  before: "BEF ",
  after: "AFT ",
};

/** `SEX_CODES` read the other way: `male` -> `M`. */
const SEX_TAGS: ReadonlyMap<Sex, string> = invert(SEX_CODES);

/** `PEDIGREES` read the other way: `biological` -> `birth`. */
const PEDIGREE_TAGS: ReadonlyMap<ChildRelation, string> = invert(PEDIGREES);

/**
 * `YYYY-MM-DD`, the only shape a `date` column holds.
 *
 * Matched rather than assumed: this module takes rows, and a row assembled by
 * hand can carry anything. A date that does not match is written as no `DATE`
 * line, which is the same thing an absent date produces.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Serialise a tree as GEDCOM 5.5.1 text.
 *
 * Pure and total: the same input always produces the same string, byte for
 * byte, and nothing throws. A row that is malformed in a way the validators
 * would have refused loses the field it is malformed in rather than the
 * record it sits on — see `writePoint`.
 *
 * The result ends with a newline, so it is a complete file rather than a
 * fragment a caller has to finish.
 *
 * @param tree the three tables, in any order; this function imposes its own
 */
export function writeGedcom(tree: GedcomExportInput): string {
  const individuals = orderIndividuals(tree.individuals);
  const positionOfIndividual = positions(individuals);

  const unions = orderUnions(tree.unions, positionOfIndividual);
  const positionOfUnion = positions(unions);

  const links = orderChildren(
    tree.unionChildren,
    unions,
    positionOfUnion,
    positionOfIndividual,
  );

  const index: ExportIndex = {
    positionOfIndividual,
    positionOfUnion,
    linksByChild: groupBy(links, (link) => link.childId),
    linksByUnion: groupBy(links, (link) => link.unionId),
    familiesOfPartner: familiesByPartner(unions),
  };

  const lines: string[] = [];

  writeHeader(lines);

  for (const [position, individual] of individuals.entries()) {
    writeIndividual(lines, individual, position, index);
  }

  for (const [position, union] of unions.entries()) {
    writeFamily(lines, union, position, index);
  }

  emit(lines, 0, "TRLR");

  return lines.map((line) => `${line}${NEWLINE}`).join("");
}

/** `@I1@` — the xref an individual at this position is written as. */
export function individualXref(position: number): string {
  return `I${position + 1}`;
}

/** `@F1@` — the xref a union at this position is written as. */
export function familyXref(position: number): string {
  return `F${position + 1}`;
}

/**
 * The header, plus the submitter record it is required to point at.
 *
 * 5.5.1 makes `SOUR`, `SUBM`, `GEDC` and `CHAR` all mandatory, and `SUBM` is
 * a pointer — so a header alone is not a valid file, and the record it names
 * has to exist. Gramps and the strict validators check both. The submitter is
 * this application rather than a person: nothing in this schema records who
 * exported the file, and inventing a name for them would be worse than
 * naming the program that wrote it.
 *
 * `CHAR UTF-8` is the one deliberate departure from 5.5.1, which lists only
 * `ANSEL`, `UNICODE` and `ASCII`. Every reader written this century takes
 * UTF-8 — it is what 5.5.5 went on to require — and the alternative is
 * writing ANSEL, which cannot represent most of the world's names and is the
 * character set `lib/ansel.ts` exists to rescue people *from*.
 */
function writeHeader(lines: string[]): void {
  const submitter = "U1";

  emit(lines, 0, "HEAD");
  // An APPROVED_SYSTEM_ID, which is a single token rather than a title.
  emit(lines, 1, "SOUR", "HEIRLOOM");
  emit(lines, 2, "NAME", "Heirloom");
  emit(lines, 1, "SUBM", pointer(submitter));
  emit(lines, 1, "GEDC");
  emit(lines, 2, "VERS", "5.5.1");
  emit(lines, 2, "FORM", "LINEAGE-LINKED");
  emit(lines, 1, "CHAR", "UTF-8");

  record(lines, submitter, "SUBM");
  emit(lines, 1, "NAME", "Heirloom");
}

/** One `INDI` record. */
function writeIndividual(
  lines: string[],
  individual: ExportIndividual,
  position: number,
  index: ExportIndex,
): void {
  record(lines, individualXref(position), "INDI");

  writeName(lines, individual);
  emit(lines, 1, "SEX", SEX_TAGS.get(individual.sex) ?? "U");

  writeEvent(lines, "BIRT", {
    date: individual.birthDate,
    qualifier: individual.birthDateQualifier,
    precision: individual.birthDatePrecision,
    upper: individual.birthDateUpper,
    upperPrecision: individual.birthDateUpperPrecision,
    place: individual.birthPlace,
  });

  writeEvent(lines, "DEAT", {
    date: individual.deathDate,
    qualifier: individual.deathDateQualifier,
    precision: individual.deathDatePrecision,
    upper: individual.deathDateUpper,
    upperPrecision: individual.deathDateUpperPrecision,
    place: individual.deathPlace,
  });

  // `FAMC` before `FAMS`, and both in family order. The edge itself is written
  // on the `FAM` side, which `docs/gedcom.md` has called the authoritative one
  // since the parser — these are the redundant half, and they are written
  // because a file without them is one most programs read as a tree of
  // unrelated people, and because `reportOneSidedLinks` cross-checks them on
  // the way back in.
  for (const link of index.linksByChild.get(individual.id) ?? []) {
    const family = index.positionOfUnion.get(link.unionId);
    if (family === undefined) continue;

    emit(lines, 1, "FAMC", pointer(familyXref(family)));

    // `PEDI` lives on the child's `FAMC` and not on the family's `CHIL`,
    // which is finding four of E6-T2: one column, written on two records.
    const pedigree = PEDIGREE_TAGS.get(link.relation);
    if (pedigree !== undefined) emit(lines, 2, "PEDI", pedigree);
  }

  for (const family of index.familiesOfPartner.get(individual.id) ?? []) {
    emit(lines, 1, "FAMS", pointer(familyXref(family)));
  }
}

/**
 * `1 NAME John Henry /Smith/`, with the parts spelled out underneath.
 *
 * The slash notation alone is lossy in one direction this schema can produce:
 * a given name containing a `/` breaks the split, and a surname containing one
 * cannot be written at all. `GIVN` and `SURN` say the same thing unambiguously
 * and the parser prefers them when they are present, so writing all three
 * makes the value readable by a program that only knows the slashes and exact
 * for the one that reads the sub-tags.
 *
 * A person with no surname is written as a bare given name rather than as
 * `John /`, because the parser reads a name with no slashes as all-given,
 * which is what the row says.
 */
function writeName(lines: string[], individual: ExportIndividual): void {
  const given = trimmed(individual.givenName);
  const surname = trimmed(individual.surname);

  const full = [given, surname === null ? null : `/${surname}/`]
    .filter((part) => part !== null)
    .join(" ");

  emit(lines, 1, "NAME", full);
  if (given !== null) emit(lines, 2, "GIVN", given);
  if (surname !== null) emit(lines, 2, "SURN", surname);
}

/**
 * A name as the parser will read it back, which is to say trimmed.
 *
 * `lib/gedcom.ts` reads `NAME`, `GIVN` and `SURN` through `blankToNull`, and
 * `readText` in `lib/field-input.ts` trims on the way into the column too — so
 * a stored name with a leading space is a row written around the validators.
 * Written verbatim it would come back trimmed and the second export would
 * disagree with the first, which is the round trip E7-T2 (`YEO-52`) tests.
 *
 * Trimmed and not collapsed, unlike a place: the parser does not collapse a
 * name, so `John  Henry` with two spaces survives the trip exactly as stored
 * and there is nothing here to repair.
 */
function trimmed(value: string | null): string | null {
  if (value === null) return null;

  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * The five columns one event's date occupies — exactly the shape `ParsedDate`
 * arrives in on the import side, so the two halves of the pipeline describe a
 * date the same way.
 */
type ExportDate = {
  date: string | null;
  qualifier: DateQualifier;
  precision: DatePrecision;
  upper: string | null;
  upperPrecision: DatePrecision;
};

/** A date and a place, as one of GEDCOM's event structures. */
type ExportEvent = ExportDate & { place: string | null };

/**
 * `1 BIRT` / `2 DATE` / `2 PLAC`, written only when there is something to say.
 *
 * An event with neither a date nor a place is not written at all: `1 BIRT`
 * standing alone asserts that a birth is *recorded*, and a row where both
 * columns are null records nothing. Every person was born, so the tag would be
 * true of everybody and informative about nobody.
 */
function writeEvent(lines: string[], tag: string, event: ExportEvent): void {
  const date = writeGedcomDate(event);
  const place = writePlace(event.place);

  if (date === null && place === null) return;

  emit(lines, 1, tag);
  if (date !== null) emit(lines, 2, "DATE", date);
  if (place !== null) emit(lines, 2, "PLAC", place);
}

/**
 * A place, in the form the parser will read it back as.
 *
 * `lib/gedcom.ts` reads `PLAC` through `collapse` — runs of whitespace become
 * one space — and `readText` in `lib/field-input.ts`, which is what a place
 * goes through on the way *into* the column, only trims. So a place can
 * legitimately be stored as `Whitby,  Yorkshire`, with two spaces, or with a
 * tab or a newline in it, and writing that out verbatim makes the round trip
 * E7-T2 (`YEO-52`) tests fail on the second pass: the first export writes two
 * spaces, the import collapses them, and the second export writes one.
 *
 * Collapsing here rather than widening the parser, because the parser is
 * right. A place is one line of text in every genealogy program there has ever
 * been, and `1 PLAC` is a line-oriented tag whose leading and trailing spaces
 * no two readers agree about. What this loses is a run of whitespace inside a
 * place name, which is a typo in every case anybody can name; what it buys is
 * that the file says exactly what every reader will read out of it.
 *
 * `null` for a place that is nothing but whitespace, which `readText` already
 * refuses on the way in. Writing a bare `2 PLAC` for it would be a third
 * spelling of "no place recorded" and would not survive the trip either.
 */
function writePlace(place: string | null): string | null {
  if (place === null) return null;

  const collapsed = place.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/** One `FAM` record. */
function writeFamily(
  lines: string[],
  union: ExportUnion,
  position: number,
  index: ExportIndex,
): void {
  record(lines, familyXref(position), "FAM");

  writePartner(lines, "HUSB", union.partnerAId, index.positionOfIndividual);
  writePartner(lines, "WIFE", union.partnerBId, index.positionOfIndividual);

  for (const link of index.linksByUnion.get(union.id) ?? []) {
    const child = index.positionOfIndividual.get(link.childId);
    if (child === undefined) continue;

    emit(lines, 1, "CHIL", pointer(individualXref(child)));
  }

  writeMarriage(lines, union);
  writeDivorce(lines, union);
}

/** `1 HUSB @I1@`, or nothing at all when the column is null. */
function writePartner(
  lines: string[],
  tag: "HUSB" | "WIFE",
  partnerId: string | null,
  positionOfIndividual: ReadonlyMap<string, number>,
): void {
  if (partnerId === null) return;

  const position = positionOfIndividual.get(partnerId);
  if (position === undefined) return;

  emit(lines, 1, tag, pointer(individualXref(position)));
}

/**
 * Whether this union is one the file will claim a `DIV` for.
 *
 * Read by both event writers rather than by `writeDivorce` alone, because
 * `MARR` and `DIV` are not independent: see `writeMarriage`.
 */
function divorced(union: ExportUnion): boolean {
  return union.endReason === "divorce";
}

/**
 * `1 MARR`, written when the union says there was a marriage, when it has a
 * start date that has nowhere else to go, or when a `DIV` is about to claim
 * there was a marriage to end.
 *
 * The three conditions are the reverse of `unionType` in `lib/gedcom-map.ts`,
 * which reads `marriage` from the presence of `MARR` or `DIV` and `unknown`
 * from their absence — so a `marriage` written with no date reads back as
 * `marriage`, and an `unknown` with no dates writes no tag and reads back as
 * `unknown`. Both are lossless.
 *
 * **The third condition was missing until E7-T2 (`YEO-52`).** The reverse was
 * documented and not implemented: this side considered only the type and the
 * start date, so a `partnership` or an `unknown` that ended in a divorce and
 * had no start date was written as a bare `DIV`. That is a file saying a
 * couple divorced without ever saying they married — incoherent to any
 * reader, and read back by our own mapper as a marriage, so the *second*
 * export grew a `MARR Y` the first did not have and the round trip did not
 * close. `lib/gedcom-round-trip.test.ts` is the test that found it and
 * `lib/gedcom-export.test.ts` holds the case.
 *
 * The narrowing case is a `partnership`, which GEDCOM has no tag for: with a
 * start date, or with a divorce to record, it is written as a marriage,
 * because dropping the fact to protect a distinction the format cannot carry
 * loses more than it keeps. With neither it writes nothing and reads back as
 * `unknown`.
 *
 * `Y` is 5.5.1's way of asserting that an event happened when nothing is
 * recorded about it, and a bare `1 MARR` with no substructure is what strict
 * readers complain about. `lib/gedcom.ts` reads the event from its children
 * and ignores the value, so the two forms are the same file to us.
 */
function writeMarriage(lines: string[], union: ExportUnion): void {
  const date = writeGedcomDate({
    date: union.startDate,
    qualifier: union.startDateQualifier,
    precision: union.startDatePrecision,
    upper: union.startDateUpper,
    upperPrecision: union.startDateUpperPrecision,
  });

  if (union.type !== "marriage" && date === null && !divorced(union)) return;

  if (date === null) {
    emit(lines, 1, "MARR", "Y");
    return;
  }

  emit(lines, 1, "MARR");
  emit(lines, 2, "DATE", date);
}

/**
 * `1 DIV`, written for the one end reason GEDCOM has a tag for.
 *
 * `death` is deliberately not written: `lib/gedcom-map.ts` infers it from a
 * partner's own death date, which is where the date already lives and the only
 * place it should be corrected. `separation` and `unknown` have no tag, so
 * they and any `end_date` beside them are not written — the alternative is
 * writing `DIV` for a couple who did not divorce, which is a claim the file
 * would then be making on this application's behalf.
 */
function writeDivorce(lines: string[], union: ExportUnion): void {
  if (!divorced(union)) return;

  const date = writeGedcomDate({
    date: union.endDate,
    qualifier: union.endDateQualifier,
    precision: union.endDatePrecision,
    upper: union.endDateUpper,
    upperPrecision: union.endDateUpperPrecision,
  });

  if (date === null) {
    emit(lines, 1, "DIV", "Y");
    return;
  }

  emit(lines, 1, "DIV");
  emit(lines, 2, "DATE", date);
}

/**
 * The five date columns as one `DATE` value, or `null` when there is no date.
 *
 * A range is written as `BET x AND y` and never as `FROM x TO y`. The schema
 * stores the two forms identically — `docs/gedcom.md` has said since E6-T2
 * that a third-party file's `FROM 1912 TO 1918` comes back out as
 * `BET 1912 AND 1918` — so one of the two has to be the one written, and
 * `BET` is the form that means what the columns mean: two bounds, not a
 * duration.
 *
 * A range's qualifier is dropped, which is not a loss on any row a validator
 * accepted: `validateIndividual` and `validateUnion` both refuse a non-`exact`
 * qualifier beside an upper bound, because a range already says how uncertain
 * a date is. A hand-written `INSERT` can still produce one, and this reads it
 * the way `db/schema.ts` says a stored range reads — as its two bounds.
 */
function writeGedcomDate(value: ExportDate): string | null {
  if (value.date === null) return null;

  const lower = writePoint(value.date, value.precision);
  if (lower === null) return null;

  if (value.upper !== null) {
    const upper = writePoint(value.upper, value.upperPrecision);
    if (upper !== null) return `BET ${lower} AND ${upper}`;
  }

  return `${GEDCOM_QUALIFIERS[value.qualifier]}${lower}`;
}

/**
 * One stored anchor at the precision it was recorded to: `1890`, `MAR 1890`
 * or `12 MAR 1890`.
 *
 * The anchor is never written as a day it does not claim to be, which is the
 * rule `DATE_PRECISIONS` in `lib/field-input.ts` states and the reason the
 * pair is stored the way it is — an export that wrote `1 JAN 1890` for a
 * year-only birth would put an invented birthday into every other program
 * that read the file.
 *
 * The year keeps its four ISO digits rather than being trimmed. `0850` is a
 * year the parser reads and `850` is not, because the shared grammar's
 * `YEAR_ONLY` wants exactly four — so the padding is what makes a mediaeval
 * date survive its own round trip.
 *
 * `null` for anything that is not a real `YYYY-MM-DD`, and for a day outside
 * the calendar's own range. `readDate` refuses both before a row is written,
 * so the only way to arrive here with one is a row written around the
 * validators; losing the date is better than writing `0 MAR 1890`, which no
 * reader can parse.
 */
function writePoint(iso: string, precision: DatePrecision): string | null {
  const match = ISO_DATE.exec(iso);
  if (match === null) return null;

  const [, year, month, day] = match;
  if (precision === "year") return year;

  const name = GEDCOM_MONTHS[Number(month) - 1];
  if (name === undefined) return year;
  if (precision === "month") return `${name} ${year}`;

  const dayOfMonth = Number(day);
  if (dayOfMonth < 1 || dayOfMonth > 31) return `${name} ${year}`;

  return `${dayOfMonth} ${name} ${year}`;
}

/**
 * Individuals in the order they are written, which has to survive a round
 * trip.
 *
 * Surname, then given name, then the two dates — every one of them a value
 * this file carries and gets back. The caller's own order breaks a tie, and
 * only a pair of people identical in all four reaches it; after one pass
 * their file order is this order, so the second export agrees with the first.
 *
 * Sorting by surname also happens to group a family together in the file,
 * which is what somebody opening it in a text editor expects to see. That is a
 * pleasant side effect of the constraint rather than the reason for it.
 */
function orderIndividuals(
  individuals: readonly ExportIndividual[],
): readonly ExportIndividual[] {
  return stableSort(individuals, (individual) => [
    individual.surname ?? "",
    individual.givenName,
    individual.birthDate ?? "",
    individual.deathDate ?? "",
  ]);
}

/**
 * Unions in the order they are written.
 *
 * Keyed on where each partner sits in the individual order, which survives the
 * trip because it is derived from the same values `orderIndividuals` sorted
 * on — not on `unions.sequence`, which does not survive at all: GEDCOM has no
 * equivalent, so `lib/gedcom-map.ts` re-derives it on the way back in and a
 * sort on it would put the second export in a different order from the first.
 *
 * A union with no partners, or with one this tree does not contain, sorts
 * last. It is a row nothing points at, and having it at the end keeps it from
 * moving the numbering of the families that do.
 */
function orderUnions(
  unions: readonly ExportUnion[],
  positionOfIndividual: ReadonlyMap<string, number>,
): readonly ExportUnion[] {
  const place = (partnerId: string | null): number =>
    partnerId === null
      ? UNPLACED
      : (positionOfIndividual.get(partnerId) ?? UNPLACED);

  const written = unions.filter(
    (union) =>
      place(union.partnerAId) !== UNPLACED ||
      place(union.partnerBId) !== UNPLACED,
  );

  return stableSort(written, (union) => [
    place(union.partnerAId),
    place(union.partnerBId),
    union.startDate ?? "",
    union.endDate ?? "",
  ]);
}

/**
 * Child links in the order their `CHIL` and `FAMC` lines are written: by
 * family, then by the child's own position.
 *
 * One list rather than a map per family, because it is read twice from two
 * directions — once per `FAM` for the `CHIL` lines and once per `INDI` for the
 * `FAMC` — and both readers want the same order for the same reason.
 *
 * A link naming a union or a person this tree does not contain sorts last and
 * is then skipped by both writers. That is a broken foreign key rather than
 * anything this module can repair.
 */
function orderChildren(
  links: readonly ExportChild[],
  unions: readonly ExportUnion[],
  positionOfUnion: ReadonlyMap<string, number>,
  positionOfIndividual: ReadonlyMap<string, number>,
): readonly ExportChild[] {
  const unionById = new Map(unions.map((union) => [union.id, union]));
  const seen = new Set<string>();

  const written = links.filter((link) => {
    const union = unionById.get(link.unionId);
    if (union === undefined) return false;

    // `union_children` is keyed on the pair, so a repeat is not a row that can
    // exist — and a second `CHIL` naming the same person is one
    // `lib/gedcom-map.ts` refuses by name on the way back in.
    const pair = `${link.unionId}\u0000${link.childId}`;
    if (seen.has(pair)) return false;
    seen.add(pair);

    // A person cannot be a child of a family they are a partner in. Writing
    // both would put `1 WIFE @I2@` and `1 CHIL @I2@` in one record — a
    // contradiction no reader can resolve, and one `lib/gedcom-map.ts` refuses
    // by name on the way back in, so the link would not survive the trip
    // either. `lib/save-child.ts` refuses it on the typed path as
    // `child-is-partner`; this is the same rule, applied where the file is
    // written rather than where a form is posted.
    return (
      link.childId !== union.partnerAId && link.childId !== union.partnerBId
    );
  });

  return stableSort(written, (link) => [
    positionOfUnion.get(link.unionId) ?? UNPLACED,
    positionOfIndividual.get(link.childId) ?? UNPLACED,
  ]);
}

/**
 * Where a row sorts when it has no place in the order at all — a union whose
 * partners this tree does not contain, or a link naming a record that is not
 * here. Last, so that a broken foreign key cannot shift the numbering of the
 * records that are intact.
 */
const UNPLACED = Number.MAX_SAFE_INTEGER;

/** A sort key: the fields to compare, in order, before falling back to input order. */
type SortKey = readonly (string | number)[];

/**
 * Sort by a key, with the input order as the last tie-break.
 *
 * `Array.prototype.sort` has been stable since ES2019, and this does not rely
 * on it: the index is part of the comparison. That is the difference between
 * a property the specification guarantees and one this module can point at,
 * and the round trip rests on it.
 *
 * Strings compare with `<` rather than `localeCompare`, which depends on
 * whatever ICU data the process was built with — the same tree would then sort
 * differently on a laptop and on CI, and E7-T2 compares bytes.
 */
function stableSort<T>(items: readonly T[], keyOf: (item: T) => SortKey): T[] {
  return items
    .map((item, index) => ({ item, index, key: keyOf(item) }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.index - b.index)
    .map(({ item }) => item);
}

/** Two sort keys, field by field. */
function compareKeys(a: SortKey, b: SortKey): number {
  for (const [index, left] of a.entries()) {
    const right = b[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left) < String(right) ? -1 : 1;
  }

  return 0;
}

/** Group a list by a key, keeping each group in the list's own order. */
function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [item]);
    else group.push(item);
  }

  return grouped;
}

/**
 * The families each person is a partner in, by position, in family order.
 *
 * A union is counted once per person even when both of its partner columns
 * name them — a row `validateUnion` refuses, and one that would otherwise
 * write the same `FAMS` line twice.
 */
function familiesByPartner(
  unions: readonly ExportUnion[],
): ReadonlyMap<string, readonly number[]> {
  const families = new Map<string, number[]>();

  for (const [position, union] of unions.entries()) {
    for (const partnerId of new Set([union.partnerAId, union.partnerBId])) {
      if (partnerId === null) continue;

      const found = families.get(partnerId);
      if (found === undefined) families.set(partnerId, [position]);
      else found.push(position);
    }
  }

  return families;
}

/** Where each row ended up, by id, for the pointers that name it. */
function positions(
  rows: readonly { id: string }[],
): ReadonlyMap<string, number> {
  return new Map(rows.map((row, index) => [row.id, index]));
}

/**
 * Read a table of GEDCOM spellings the other way round.
 *
 * The first spelling of a member wins, which matters for a table that is not
 * a bijection — none of the two this module inverts is such a table today, and
 * `lib/gedcom-export.test.ts` asserts that both cover their enum completely,
 * so a member losing its spelling is a test failure rather than a missing
 * line in an export.
 *
 * A `Map` rather than a `Record`, because a `Record<Member, string>` would be
 * claiming a totality no inversion can prove at the type level. The claim is
 * made by the test instead, and the call sites carry a fallback that the same
 * test shows is unreachable.
 */
function invert<Member extends string>(
  table: Readonly<Record<string, Member>>,
): ReadonlyMap<Member, string> {
  const inverted = new Map<Member, string>();

  for (const [spelling, member] of Object.entries(table)) {
    if (!inverted.has(member)) inverted.set(member, spelling);
  }

  return inverted;
}

/** `@I1@` — an xref used as a value. */
function pointer(xref: string): string {
  return `@${xref}@`;
}

/** `0 @I1@ INDI` — the line that opens a record. */
function record(lines: string[], xref: string, tag: string): void {
  lines.push(`0 @${xref}@ ${tag}`);
}

/**
 * One tagged line, and the `CONT`/`CONC` continuations it needs.
 *
 * The two continuation tags are grammar rather than vocabulary, as
 * `lib/gedcom-lines.ts` puts it, and they are exactly reversible: `CONT`
 * restores a newline and `CONC` restores nothing, so a value split here is
 * rejoined there character for character and split identically on the way out
 * again.
 *
 * Splitting walks code points rather than UTF-16 units, so a break can never
 * fall between the halves of a surrogate pair and turn an emoji or an
 * extended-plane character into two replacement characters.
 *
 * A value of `null` writes a bare tag — `1 BIRT` — which is a line that says a
 * structure follows rather than one whose value is empty. `lib/gedcom-lines.ts`
 * makes the same distinction from the other side and gives its reason there.
 */
function emit(
  lines: string[],
  level: number,
  tag: string,
  value: string | null = null,
): void {
  if (value === null || value === "") {
    lines.push(`${level} ${tag}`);
    return;
  }

  for (const [index, segment] of value.split("\n").entries()) {
    const continued = index > 0;

    for (const [position, text] of chunk(segment).entries()) {
      // Every continuation sits one level deeper than the line it continues,
      // and they do not nest: a `CONC` after a `CONT` continues the same
      // original tag, not the `CONT`. `lib/gedcom-lines.ts` reads them that
      // way — it folds into `stack[level - 1]` and never pushes itself — so a
      // chain of them stays at one level throughout.
      const continuation = continued || position > 0;
      const lineLevel = continuation ? level + 1 : level;
      const lineTag = position > 0 ? "CONC" : continued ? "CONT" : tag;

      lines.push(
        text === ""
          ? `${lineLevel} ${lineTag}`
          : `${lineLevel} ${lineTag} ${text}`,
      );
    }
  }
}

/**
 * Split a value into pieces that fit on a line, by code point.
 *
 * Always at least one piece, so an empty segment still writes its `CONT` — a
 * value with a blank line in the middle of it keeps the blank line.
 */
function chunk(text: string): string[] {
  const points = [...text];
  if (points.length <= MAX_VALUE_LENGTH) return [text];

  const chunks: string[] = [];
  for (let start = 0; start < points.length; start += MAX_VALUE_LENGTH) {
    chunks.push(points.slice(start, start + MAX_VALUE_LENGTH).join(""));
  }

  return chunks;
}
