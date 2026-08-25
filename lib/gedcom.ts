import {
  decodeGedcom,
  readDeclaredCharacterSet,
  type GedcomEncoding,
} from "./gedcom-encoding";
import { readGedcomTree, readPointer, type GedcomNode } from "./gedcom-lines";
import {
  summariseUnknownTags,
  type GedcomIssue,
  type GedcomUnknownTag,
} from "./gedcom-report";
import type { Sex } from "./individual-input";
import { parseDateInput, type ParsedDate } from "./parse-date";

/**
 * A `.ged` file, as plain data (E6-T1, `YEO-46`).
 *
 * ## What this is and what it deliberately is not
 *
 * Bytes in, records out. No database, no session, no `FormData`, no React —
 * the only imports are three sibling modules and a type. That constraint is
 * the ticket, not an implementation detail, and two later tickets rest on it:
 *
 * - **E7-T2 (`YEO-52`), the round-trip test.** Export → import → export
 *   producing identical output is the claim that this application does not
 *   quietly lose people's data. A parser that needed a database to run could
 *   only be tested against one, which would make the round trip a test of the
 *   schema rather than of the format.
 * - **E6-T3 (`YEO-48`), the import preview.** Counts and a sample *before*
 *   anything is written. That is only possible if reading a file and writing
 *   rows are separate operations, and this is the half that reads.
 *
 * So the mapping to `individuals`, `unions` and `union_children` is not here.
 * That is E6-T2 (`YEO-47`), and `docs/architecture.md` explains why it should
 * be near-mechanical: the data model was designed around GEDCOM's own insight
 * that the *union* is the entity, so `FAM` already lines up with `unions` and
 * `CHIL` with `union_children`. This module's job is to stop at the last point
 * that is still true of the file rather than of our schema.
 *
 * ## The subset, and why a subset is the right answer
 *
 * `INDI`, `FAM`, `HUSB`, `WIFE`, `CHIL`, `NAME`, `SEX`, `BIRT`, `DEAT`,
 * `MARR`, `DIV`, `PLAC`, `DATE`. That is the whole of what this application
 * can store, and supporting more would mean inventing places to put it.
 *
 * What makes a subset acceptable rather than lossy is the other half of the
 * output: every tag outside it is **counted and reported**, not dropped. See
 * `lib/gedcom-report.ts`. An author gets told that their 1,842 source
 * citations were left behind, which is a decision they can make, instead of
 * discovering it a year later.
 *
 * ## Dates
 *
 * `ABT`, `BEF`, `AFT` and `EST`, and dates with only a year or only a month
 * and year, all go through `parseDateInput` in `lib/parse-date.ts` — the same
 * function standing behind the date field a person types into. That module was
 * written for E4-T2 (`YEO-39`) with this ticket named in its own doc comment
 * as the second caller, and its qualifier table already maps GEDCOM's
 * modifiers onto the `date_qualifier` enum from E4-T1 (`YEO-38`).
 *
 * Sharing it is not merely less code. It means an imported "ABT 1890" and a
 * typed "about 1890" become the same three column values, so a person cannot
 * tell from the data which route a date came in by — which is the property the
 * round-trip test needs and the one a second, GEDCOM-only date grammar would
 * quietly break the first time the two disagreed.
 */

export type { GedcomEncoding } from "./gedcom-encoding";
export type {
  GedcomIssue,
  GedcomIssueKind,
  GedcomUnknownTag,
} from "./gedcom-report";

/**
 * One name, in GEDCOM's slash notation.
 *
 * A person can have several: a birth name and a married name, a religious
 * name, an anglicised spelling. The file records them as repeated `NAME`
 * lines with no marking of which is preferred, so the array is in file order
 * and the first is conventionally the primary one.
 */
export type GedcomName = {
  /**
   * The name as one string, with the surname slashes removed —
   * `John /Smith/ Jr` becomes `John Smith Jr`.
   *
   * Kept alongside the split parts because it is the only lossless field of
   * the three: a suffix, a patronymic, or a name whose file gives no slashes
   * at all survives here and in nothing else.
   */
  full: string;
  /** Everything before the surname, or `null` when the file gave none. */
  given: string | null;
  /** What was between the slashes, or in a `SURN` sub-tag. */
  surname: string | null;
};

/** A dated, placed event: `BIRT`, `DEAT`, `MARR` or `DIV`. */
export type GedcomEvent = {
  /**
   * The parsed date, or `null` when there was none or it could not be read.
   *
   * `null` from an unreadable date is never silent — it comes with a `date`
   * issue naming the text — and `dateText` below still holds what the file
   * said, so nothing is lost even when nothing is understood.
   */
  date: ParsedDate | null;
  /** The `DATE` value verbatim, for the report and for a round trip. */
  dateText: string | null;
  /** The `PLAC` value, trimmed. */
  place: string | null;
};

/** A person. */
export type GedcomIndividual = {
  /**
   * The record's identifier, without `@` — or `null` for a record that had
   * none.
   *
   * A record with no identifier cannot be pointed at, so it can have no
   * relationships. It is kept anyway rather than skipped: an unreferenced
   * person is still a person in the file, and losing one silently is the exact
   * failure this parser is written to avoid.
   */
  xref: string | null;
  /** The line the record starts on, for the report. */
  line: number;
  /** In file order; the first is conventionally the primary name. */
  names: GedcomName[];
  sex: Sex;
  birth: GedcomEvent | null;
  death: GedcomEvent | null;
  /**
   * `FAMS` — the families this person appears in as a spouse, by xref.
   *
   * Not in the ticket's tag list, and carried anyway, because the alternative
   * is worse in both directions. These pointers are redundant: the same edges
   * are written on the `FAM` side as `HUSB`/`WIFE`, which is where E6-T2 will
   * read them from. Reporting them as unknown tags would therefore put "we
   * ignored 240 things" into a report where nothing was actually lost — the
   * report's credibility is the whole point of having one. Dropping them
   * unreported would break the rule outright.
   *
   * Kept, they also give a later ticket something the `FAM` side cannot: a
   * file whose `FAMS` and `HUSB` disagree is a file whose tree will import
   * wrong, and the cross-check is only possible if both halves survive.
   */
  familiesAsSpouse: string[];
  /**
   * `FAMC` — the families this person appears in as a child. See above.
   *
   * A list of records rather than of xrefs, unlike `familiesAsSpouse`, because
   * of where GEDCOM puts `PEDI`. The *edge* is written on the `FAM` side as
   * `CHIL`; the *kind* of that edge — birth, adopted, foster — is written on
   * the child's side, under this tag. `union_children.relation` needs both
   * records to fill one column, so the second half has to survive the parse.
   * See `lib/gedcom-map.ts`, which is the module that joins them.
   */
  familiesAsChild: GedcomChildLink[];
};

/**
 * One `FAMC` — a family this person is a child in, and how.
 *
 * `pedigree` is the raw `PEDI` value, lower-cased and nothing more. Turning
 * `birth` into `biological` is a statement about *our* enum rather than about
 * the file, and this module stops at the last point that is still true of the
 * file. `lib/gedcom-map.ts` does the translation, and is where an unreadable
 * value gets reported.
 */
export type GedcomChildLink = {
  /** The family's identifier, without `@`. */
  family: string;
  /** `PEDI`, lower-cased, or `null` when the file gave none. */
  pedigree: string | null;
  /** The line the `FAMC` sits on, so the report can point at it. */
  line: number;
};

/** A partnership and its children — GEDCOM's `FAM`. */
export type GedcomFamily = {
  /** The record's identifier, without `@`. See `GedcomIndividual.xref`. */
  xref: string | null;
  line: number;
  /** `HUSB`, by xref, or `null`. */
  husband: string | null;
  /** `WIFE`, by xref, or `null`. */
  wife: string | null;
  /** `CHIL`, by xref, in file order. */
  children: string[];
  marriage: GedcomEvent | null;
  divorce: GedcomEvent | null;
};

/** Everything a `.ged` file turned out to contain. */
export type GedcomFile = {
  /** The character set the file was actually read in. */
  encoding: GedcomEncoding;
  /** What the file's `HEAD.CHAR` line claimed, which is not always the same. */
  declaredEncoding: string | null;
  /** In file order, which is what makes a round trip comparable. */
  individuals: GedcomIndividual[];
  families: GedcomFamily[];
  /** Tags outside the subset, aggregated by path. */
  unknownTags: GedcomUnknownTag[];
  /** Places where the imported tree will differ from the file. */
  issues: GedcomIssue[];
};

/**
 * GEDCOM's `SEX` codes and the `sex` enum members they mean.
 *
 * Exported so that E7-T1 (`YEO-51`) can write it the other way round rather
 * than keep a second copy. An export needs `male` -> `M`, which is this table
 * inverted — and a second table saying so would typecheck forever and stop
 * agreeing with this one the day `sex` gains a member. See `invert` in
 * `lib/gedcom-export.ts`.
 */
export const SEX_CODES: Readonly<Record<string, Sex>> = {
  M: "male",
  F: "female",
  // Not in 5.5.1, which offers only M, F and U — but written by more than one
  // modern program, and `other` is a member of our enum, so reading it costs
  // nothing and refusing it would lose a fact the file went out of its way to
  // record.
  X: "other",
  U: "unknown",
};

/**
 * Parse a `.ged` file.
 *
 * Total: any bytes produce a `GedcomFile`, and nothing throws. A file that is
 * not GEDCOM comes back with no records and an issue per line, which is what
 * the import preview needs in order to say so.
 *
 * @param bytes the raw file contents, e.g. from `File.arrayBuffer()`
 */
export function parseGedcom(bytes: Uint8Array): GedcomFile {
  const decoded = decodeGedcom(bytes);

  return {
    ...readTree(decoded.text, decoded.issues),
    encoding: decoded.encoding,
    declaredEncoding: decoded.declared,
  };
}

/**
 * Parse GEDCOM that is already text.
 *
 * The entry point for anything holding a string rather than a file: the
 * round-trip test (E7-T2, `YEO-52`), whose exporter produces one, and every
 * test in this repository, which would otherwise have to encode a literal to
 * bytes and back to assert something about a tag.
 */
export function parseGedcomText(text: string): GedcomFile {
  return {
    ...readTree(text, []),
    encoding: "utf-8",
    declaredEncoding: readDeclaredCharacterSet(text),
  };
}

/** A sighting of a tag outside the subset, before aggregation. */
type Sighting = { path: string; line: number };

/** Everything the two entry points share, once there is text to read. */
function readTree(
  text: string,
  priorIssues: GedcomIssue[],
): Omit<GedcomFile, "encoding" | "declaredEncoding"> {
  const tree = readGedcomTree(text);
  const issues: GedcomIssue[] = [...priorIssues, ...tree.issues];
  const unknown: Sighting[] = [];

  const individuals: GedcomIndividual[] = [];
  const families: GedcomFamily[] = [];

  for (const record of tree.records) {
    switch (record.tag) {
      case "INDI":
        individuals.push(readIndividual(record, issues, unknown));
        break;
      case "FAM":
        families.push(readFamily(record, issues, unknown));
        break;
      case "HEAD":
        readHeader(record, unknown);
        break;
      case "TRLR":
        // The end-of-file marker. Structure, carrying nothing.
        break;
      default:
        // A whole record type outside the subset — `SUBM`, `SOUR`, `REPO`,
        // `OBJE`, or a vendor extension. Counted once, at the record, without
        // descending: its children are part of the same unread structure, and
        // listing them separately would turn one honest "we ignored the
        // submitter record" into six rows that say the same thing.
        unknown.push({ path: record.tag, line: record.line });
    }
  }

  reportDuplicateXrefs(individuals, families, issues);

  return {
    individuals,
    families,
    unknownTags: summariseUnknownTags(unknown),
    issues,
  };
}

function readIndividual(
  record: GedcomNode,
  issues: GedcomIssue[],
  unknown: Sighting[],
): GedcomIndividual {
  const individual: GedcomIndividual = {
    xref: record.xref,
    line: record.line,
    names: [],
    sex: "unknown",
    birth: null,
    death: null,
    familiesAsSpouse: [],
    familiesAsChild: [],
  };

  for (const child of record.children) {
    switch (child.tag) {
      case "NAME":
        individual.names.push(readName(child, unknown));
        break;

      case "SEX":
        individual.sex = readSex(child, issues);
        break;

      case "BIRT":
        individual.birth = readEvent(
          child,
          individual.birth,
          "birth",
          "INDI.BIRT",
          issues,
          unknown,
        );
        break;

      case "DEAT":
        individual.death = readEvent(
          child,
          individual.death,
          "death",
          "INDI.DEAT",
          issues,
          unknown,
        );
        break;

      case "FAMS":
        collectPointer(child, "INDI.FAMS", individual.familiesAsSpouse, issues);
        break;

      case "FAMC":
        readChildLink(child, individual.familiesAsChild, issues, unknown);
        break;

      default:
        unknown.push({ path: `INDI.${child.tag}`, line: child.line });
    }
  }

  return individual;
}

function readFamily(
  record: GedcomNode,
  issues: GedcomIssue[],
  unknown: Sighting[],
): GedcomFamily {
  const family: GedcomFamily = {
    xref: record.xref,
    line: record.line,
    husband: null,
    wife: null,
    children: [],
    marriage: null,
    divorce: null,
  };

  for (const child of record.children) {
    switch (child.tag) {
      case "HUSB":
        family.husband = readPartner(child, "FAM.HUSB", family.husband, issues);
        break;

      case "WIFE":
        family.wife = readPartner(child, "FAM.WIFE", family.wife, issues);
        break;

      case "CHIL":
        collectPointer(child, "FAM.CHIL", family.children, issues);
        break;

      case "MARR":
        family.marriage = readEvent(
          child,
          family.marriage,
          "marriage",
          "FAM.MARR",
          issues,
          unknown,
        );
        break;

      case "DIV":
        family.divorce = readEvent(
          child,
          family.divorce,
          "divorce",
          "FAM.DIV",
          issues,
          unknown,
        );
        break;

      default:
        unknown.push({ path: `FAM.${child.tag}`, line: child.line });
    }
  }

  return family;
}

/**
 * The header, which is read for exactly one thing and reports the rest.
 *
 * `CHAR` has already been acted on — `lib/gedcom-encoding.ts` reads it out of
 * the raw bytes, because the file cannot be decoded without it. It is named
 * here only so that the one tag this parser genuinely used does not appear in
 * the report as a tag it ignored.
 */
function readHeader(record: GedcomNode, unknown: Sighting[]): void {
  for (const child of record.children) {
    if (child.tag === "CHAR") continue;
    unknown.push({ path: `HEAD.${child.tag}`, line: child.line });
  }
}

/**
 * One `NAME` line.
 *
 * GEDCOM writes the surname between slashes — `John /Smith/` — because a
 * surname cannot otherwise be found in a name whose word order varies by
 * culture. `GIVN` and `SURN` sub-tags say the same thing explicitly and are
 * preferred when present, since a file that bothered to write them is more
 * trustworthy than slash-splitting.
 */
function readName(node: GedcomNode, unknown: Sighting[]): GedcomName {
  const text = (node.value ?? "").trim();

  const slashes = /^([^/]*)\/([^/]*)\/(.*)$/.exec(text);
  let given = slashes === null ? blankToNull(text) : blankToNull(slashes[1]);
  let surname = slashes === null ? null : blankToNull(slashes[2]);

  for (const child of node.children) {
    switch (child.tag) {
      case "GIVN":
        given = blankToNull(child.value ?? "") ?? given;
        break;
      case "SURN":
        surname = blankToNull(child.value ?? "") ?? surname;
        break;
      default:
        unknown.push({ path: `INDI.NAME.${child.tag}`, line: child.line });
    }
  }

  return { full: collapse(text.replace(/\//g, " ")), given, surname };
}

function readSex(node: GedcomNode, issues: GedcomIssue[]): Sex {
  const code = (node.value ?? "").trim().toUpperCase();
  const sex = SEX_CODES[code];

  if (sex === undefined) {
    issues.push({
      kind: "value",
      line: node.line,
      message: `"${code}" is not a sex this import understands, so it was recorded as unknown. Expected M, F, X or U.`,
    });
    return "unknown";
  }

  return sex;
}

/**
 * One event, with the `DATE` handed to the shared date grammar.
 *
 * `existing` is what has already been read for this event on this record. A
 * second `BIRT` inside one `INDI` is not legal GEDCOM and the schema has one
 * birth date per person, so the first wins and the second is reported rather
 * than overwriting it — overwriting would make the imported date depend on
 * file order, which is the kind of thing nobody notices until two runs
 * disagree.
 *
 * `path` is the event's own dotted path — `INDI.BIRT`, `FAM.MARR` — and is
 * carried in rather than taken from `node.tag` so that a tag inside the event
 * is reported as `INDI.BIRT.SOUR` rather than `BIRT.SOUR`. The record type has
 * to be the first segment for every row in the report, or E6-T5 cannot group
 * on it without special-casing events. That `BIRT` happens to occur only in
 * `INDI` today makes the short form unambiguous by coincidence, not by rule.
 */
function readEvent(
  node: GedcomNode,
  existing: GedcomEvent | null,
  label: string,
  path: string,
  issues: GedcomIssue[],
  unknown: Sighting[],
): GedcomEvent {
  if (existing !== null) {
    issues.push({
      kind: "value",
      line: node.line,
      message: `This record already has a ${label}, so the second one was ignored.`,
    });
    return existing;
  }

  const event: GedcomEvent = { date: null, dateText: null, place: null };

  for (const child of node.children) {
    switch (child.tag) {
      case "DATE":
        readEventDate(child, event, label, issues);
        break;
      case "PLAC":
        event.place = blankToNull(collapse(child.value ?? ""));
        break;
      default:
        unknown.push({ path: `${path}.${child.tag}`, line: child.line });
    }
  }

  return event;
}

/**
 * Read a `DATE` into an event.
 *
 * The text is kept whatever happens, because the shared grammar cannot hold
 * everything GEDCOM writes and the report is where the difference goes.
 *
 * Ranges are stored whole (`YEO-88`). `BET 1890 AND 1900` and `FROM 1912 TO
 * 1918` are two dates and this schema now has two date columns per event, so
 * both bounds land in the row, each at its own precision, and neither raises
 * an issue — there is nothing to raise one about. This comment used to
 * describe a collapse onto `after` the lower bound; that was built and
 * rejected, and docs/architecture.md records why.
 *
 * `narrowed` still exists, for the three cases where something genuinely goes:
 * an endpoint's own modifier (`BET ABT 1890 AND 1900`), an unreadable upper
 * bound, and an `INT` interpretation phrase. Each names the text it read and
 * what it wrote.
 *
 * What must never happen is a range being read as a *single* date. Under the
 * old collapse the qualifier prevented it; now the upper bound does, and
 * `formatQualifiedDate` renders any row that has one as "between ... and ...".
 *
 * Anything the grammar cannot read — including a range whose *lower* bound is
 * unreadable, where taking the upper one would be choosing an endpoint at
 * random — still arrives as a `date` issue with the text intact and the field
 * left blank.
 */
function readEventDate(
  node: GedcomNode,
  event: GedcomEvent,
  label: string,
  issues: GedcomIssue[],
): void {
  const text = collapse(node.value ?? "");

  if (event.dateText !== null) {
    issues.push({
      kind: "value",
      line: node.line,
      message: `This ${label} already has a date, so "${text}" was ignored.`,
    });
    return;
  }

  event.dateText = text;

  const spanned = readGedcomDateSpan(text, label);
  const parsed = spanned ?? parseDateInput(text);

  if (!parsed.ok) {
    issues.push({
      kind: "date",
      line: node.line,
      message: `The ${label} date "${text}" could not be read, so it was left blank. ${parsed.message}`,
    });
    return;
  }

  event.date = parsed.value;

  const narrowed =
    spanned !== null && spanned.ok
      ? spanned.narrowed
      : estimateNarrowing(text, label, parsed.value);

  if (narrowed !== null) {
    issues.push({ kind: "narrowed", line: node.line, message: narrowed });
  }
}

/** `EST`, which `lib/parse-date.ts` has always read as `about`. */
const ESTIMATED = /^EST\b\s*/i;

/**
 * Say so when `EST` became `about` (E6-T2, `YEO-47`).
 *
 * The reading itself is older than this ticket and is not changing:
 * `lib/parse-date.ts` maps `est` onto `about` because `date_qualifier` has
 * four members and "estimated" is not one of them, and both words mean
 * *roughly*. What was missing is the report line. `EST 1918` was the one
 * lossy date form in the whole pipeline that went through without a word,
 * which made "how much did this import narrow" a question the report could
 * not answer honestly — `INT`, an endpoint modifier and an unreadable upper
 * bound all announced themselves, and the oldest loss of the four did not.
 *
 * Why here and not in `lib/parse-date.ts`: that module is shared with the
 * date field a person types into, where there is nowhere for an issue to go
 * and nobody to read it — an author who typed "est 1918" is looking at the
 * echo underneath the box, which already says "about 1918". The GEDCOM import
 * report is the only surface in the application with somewhere to put it.
 *
 * Only a *top-level* `EST` reports. `BET EST 1890 AND 1900` is already
 * reported by the endpoint-modifier rule in `readTwoPointSpan`, and saying it
 * twice would double-count one loss — which is why the caller reaches for
 * this only when the text was not a span.
 */
function estimateNarrowing(
  text: string,
  label: string,
  value: ParsedDate | null,
): string | null {
  if (value === null || !ESTIMATED.test(text)) return null;

  const estimated = text.replace(ESTIMATED, "");
  return `The ${label} date "${text}" is an estimate, and this schema records dates as exact, about, before or after. "${estimated}" was stored, qualified as "${value.qualifier}"; that it was an estimate rather than an approximation is not stored.`;
}

/** `BET x AND y` and `FROM x TO y`: two dates, only the lower one stored. */
type GedcomDateSpan =
  | { ok: true; value: ParsedDate; narrowed: string | null }
  | { ok: false; message: string };

/** `BET x AND y`, case-insensitive, splitting on the first `AND`. */
const BET_AND = /^BET\s+(.+?)\s+AND\s+(.+)$/i;
/** `FROM x TO y`, case-insensitive, splitting on the first `TO`. */
const FROM_TO = /^FROM\s+(.+?)\s+TO\s+(.+)$/i;
/** `FROM x` with no `TO` — lossless, stored as `after x`. */
const FROM_ONLY = /^FROM\s+(.+)$/i;
/** `TO y` with no `FROM` — lossless, stored as `before y`. */
const TO_ONLY = /^TO\s+(.+)$/i;
/** `INT d` or `INT d (phrase)`. */
const INTERPRETED = /^INT\s+(.+?)(?:\s*\((.*)\))?$/i;

/**
 * GEDCOM's multi-date forms, split into the two bounds a range now has
 * (`YEO-88`).
 *
 * Returns the date to store — both bounds, for a two-point form — and, when
 * something was still dropped, the sentence that says so. Returns `null` when
 * the text is none of these forms and belongs to `parseDateInput` unchanged.
 *
 * Neither endpoint is parsed by a grammar of its own. Each is handed to
 * `parseDateInput` like any other date, which is what keeps `1890`,
 * `MAR 1890` and `12 MAR 1890` meaning the same three things inside a range as
 * outside one — and what lets `BET MAR 1890 AND 1900` keep the March on one
 * side and the plain year on the other, rather than forcing one bound's
 * precision onto both. A second endpoint grammar would drift from the first
 * the day somebody fixed a bug in only one of them, and the drift would be
 * invisible.
 *
 * Both endpoints are read now, where under the collapse this ticket reversed
 * only the lower one was. The upper bound is stored, not just quoted in an
 * issue — see `readTwoPointSpan`.
 */
function readGedcomDateSpan(
  text: string,
  label: string,
): GedcomDateSpan | null {
  const betAnd = BET_AND.exec(text);
  if (betAnd !== null) {
    return readTwoPointSpan(text, label, "range", betAnd[1], betAnd[2]);
  }

  const fromTo = FROM_TO.exec(text);
  if (fromTo !== null) {
    return readTwoPointSpan(text, label, "period", fromTo[1], fromTo[2]);
  }

  const fromOnly = FROM_ONLY.exec(text);
  if (fromOnly !== null) {
    return readOnePointSpan(text, label, "after", fromOnly[1]);
  }

  const toOnly = TO_ONLY.exec(text);
  if (toOnly !== null) {
    return readOnePointSpan(text, label, "before", toOnly[1]);
  }

  const interpreted = INTERPRETED.exec(text);
  if (interpreted !== null) {
    return readInterpretedDate(text, label, interpreted[1], interpreted[2]);
  }

  return null;
}

/**
 * `BET x AND y` / `FROM x TO y`: both bounds stored, each at its own
 * precision, with the whole date's qualifier `exact` — the reading
 * `db/schema.ts` settles for a stored range (`YEO-88`).
 *
 * A modifier on either endpoint (`BET ABT 1890 AND 1900`) has no column to
 * go in — a fuzzy edge on a bound of an interval has no reader anywhere in
 * this application — so it is dropped and reported, the same trade an `INT`
 * phrase makes below. An unreadable *upper* bound falls back to the old
 * collapse path: the lower bound is a real date the file gave, so it is
 * stored as `after` it and the upper text is reported rather than losing the
 * whole row. An unreadable *lower* bound is refused outright — see the
 * caller.
 */
function readTwoPointSpan(
  text: string,
  label: string,
  form: "range" | "period",
  lowerText: string,
  upperText: string,
): GedcomDateSpan {
  const lower = lowerText.trim();
  const upper = upperText.trim();

  const parsedLower = parseDateInput(lower);
  if (!parsedLower.ok) return { ok: false, message: parsedLower.message };
  if (parsedLower.value === null) {
    return {
      ok: false,
      message: `The ${label} date "${text}" has no lower bound to read.`,
    };
  }

  const parsedUpper = parseDateInput(upper);

  // The upper bound could not be read at all — the collapse this ticket
  // reversed survives as the fallback here, because a lower bound the file
  // genuinely gave is still worth keeping.
  if (!parsedUpper.ok || parsedUpper.value === null) {
    return {
      ok: true,
      value: {
        date: parsedLower.value.date,
        qualifier: "after",
        precision: parsedLower.value.precision,
        upper: null,
        upperPrecision: "day",
      },
      narrowed: `The ${label} date "${text}" is a ${form} whose upper bound could not be read. Only "${lower}" was stored, as an "after" date; "${upper}" is not stored.`,
    };
  }

  // A range's qualifier is always `exact` (`db/schema.ts`); an endpoint's own
  // modifier is dropped, and, when one was, reported by name.
  const droppedModifiers = [
    parsedLower.value.qualifier === "exact"
      ? null
      : { qualifier: parsedLower.value.qualifier, text: lower },
    parsedUpper.value.qualifier === "exact"
      ? null
      : { qualifier: parsedUpper.value.qualifier, text: upper },
  ].filter((modifier) => modifier !== null);

  const value: ParsedDate = {
    date: parsedLower.value.date,
    qualifier: "exact",
    precision: parsedLower.value.precision,
    upper: parsedUpper.value.date,
    upperPrecision: parsedUpper.value.precision,
  };

  if (droppedModifiers.length === 0) {
    return { ok: true, value, narrowed: null };
  }

  const modifierClause = droppedModifiers
    .map((modifier) => `the "${modifier.qualifier}" on "${modifier.text}"`)
    .join(" and ");

  return {
    ok: true,
    value,
    narrowed: `The ${label} date "${text}" is a ${form}, and a range's endpoints are already bounds. "${lower}" and "${upper}" were stored as the two ends; ${modifierClause} is not stored.`,
  };
}

/**
 * `FROM x` / `TO y`: one bound, which becomes an `after` or `before` date.
 *
 * The bound itself is lossless — one date in, one date out, at its own
 * precision — so the ordinary forms raise nothing.
 *
 * **A modifier that says something else is not.** `FROM ABT 1912` and
 * `FROM EST 1912` both become `after 1912`: the qualifier column has room for one word and
 * `after` is the one the span form claims, so whatever the bound said about
 * itself is overwritten. That is the same loss `readTwoPointSpan` reports for
 * an endpoint of a two-point span — a fuzzy edge on a bound of an interval
 * has no reader anywhere in this application — and it is reported here for
 * the same reason, in the same words. Review of E6-T2 (`YEO-47`) found it
 * going through in silence, which had made "a modifier on a range endpoint is
 * not stored" a rule that held for `BET ABT 1890 AND 1900` and quietly failed
 * for `FROM ABT 1890`. One rule, both shapes.
 *
 * The redundant spellings are the other half of getting that right, and the
 * first version of this fix got them wrong: `FROM AFT 1912` and `TO BEF 1918`
 * agree with the qualifier the span form already stores, so nothing is lost
 * and nothing is said. Reporting them named one word as both what was stored
 * and what was not.
 */
function readOnePointSpan(
  text: string,
  label: string,
  qualifier: "after" | "before",
  boundText: string,
): GedcomDateSpan {
  const bound = boundText.trim();

  const parsedBound = parseDateInput(bound);
  if (!parsedBound.ok) return { ok: false, message: parsedBound.message };
  if (parsedBound.value === null) {
    return { ok: false, message: `"${bound}" is not a date.` };
  }

  const value: ParsedDate = { ...parsedBound.value, qualifier };
  const dropped = parsedBound.value.qualifier;

  // Nothing was dropped when the bound carried no modifier — and equally when
  // it carried the *same* one the span form stores. `FROM AFT 1912` and
  // `TO BEF 1918` are the redundant spellings real files contain, and the
  // stored value is exactly what they said; reporting them produced a
  // sentence naming one word as both what was stored and what was not. A
  // report whose value is that it only speaks when something is wrong cannot
  // afford a false alarm, which is the same reason `lib/gedcom-map.ts`
  // accumulates its cross-check maps rather than overwriting them.
  if (dropped === "exact" || dropped === qualifier) {
    return { ok: true, value, narrowed: null };
  }

  return {
    ok: true,
    value,
    // `qualified as "${qualifier}"` rather than an indefinite article, for the
    // reason `readInterpretedDate` spells out: `about`/`before`/`after` do not
    // all take the same one.
    narrowed: `The ${label} date "${text}" gives one bound, and a bound is already a bound. "${bound}" was stored, qualified as "${qualifier}"; the "${dropped}" on it is not stored.`,
  };
}

/**
 * `INT d` / `INT d (phrase)`: `d` is stored as `about`, unless `d` carries its
 * own `BEF`/`AFT`, which is a more specific true statement than "roughly" and
 * survives rather than being flattened (Rule A, `YEO-88`). An interpretation
 * phrase is reported and never stored; its absence raises no issue, since
 * nothing author-written was dropped — the same trade `EST` already makes
 * silently.
 */
function readInterpretedDate(
  text: string,
  label: string,
  innerText: string,
  phraseText: string | undefined,
): GedcomDateSpan {
  const inner = innerText.trim();
  const phrase = phraseText === undefined ? null : phraseText.trim();

  const parsedInner = parseDateInput(inner);
  if (!parsedInner.ok) return { ok: false, message: parsedInner.message };
  if (parsedInner.value === null) {
    return {
      ok: false,
      message: `The ${label} date "${text}" has no date to interpret.`,
    };
  }

  const qualifier =
    parsedInner.value.qualifier === "before" ||
    parsedInner.value.qualifier === "after"
      ? parsedInner.value.qualifier
      : "about";

  const value: ParsedDate = { ...parsedInner.value, qualifier };

  if (phrase === null || phrase === "") {
    return { ok: true, value, narrowed: null };
  }

  return {
    ok: true,
    value,
    // `qualified as "${qualifier}"` rather than `stored as an "${qualifier}"
    // date`: the latter needs an indefinite article that depends on the word
    // that follows it, and `about`/`before`/`after` do not all take the same
    // one — "an \"before\" date" was the bug this phrasing has no way to
    // reintroduce, for any of the four members, forever. A ternary picking
    // "a" or "an" would fix today's three words and break the day a fifth
    // arrives.
    narrowed: `The ${label} date "${text}" was interpreted from a phrase. Only "${inner}" was stored, qualified as "${qualifier}"; the note "${phrase}" is not stored.`,
  };
}

/** `HUSB` or `WIFE`: at most one, and it has to be a pointer. */
function readPartner(
  node: GedcomNode,
  path: string,
  existing: string | null,
  issues: GedcomIssue[],
): string | null {
  const pointer = readPointer(node.value);

  if (pointer === null) {
    issues.push({
      kind: "pointer",
      line: node.line,
      message: `${path} should point at an individual, but says ${describeValue(node.value)}.`,
    });
    return existing;
  }

  if (existing !== null) {
    issues.push({
      kind: "value",
      line: node.line,
      message: `This family already has a ${path.split(".")[1]}, so ${pointer} was ignored.`,
    });
    return existing;
  }

  return pointer;
}

/** `CHIL`, `FAMS`, `FAMC`: a repeated tag whose value is a pointer. */
function collectPointer(
  node: GedcomNode,
  path: string,
  into: string[],
  issues: GedcomIssue[],
): void {
  const pointer = readPointer(node.value);

  if (pointer === null) {
    issues.push({
      kind: "pointer",
      line: node.line,
      message: `${path} should point at a record, but says ${describeValue(node.value)}.`,
    });
    return;
  }

  into.push(pointer);
}

/**
 * `FAMC`, which is a pointer with something hanging off it.
 *
 * Not `collectPointer`, and the difference is why `PEDI` was invisible until
 * now: `collectPointer` reads a node's *value* and never looks at its
 * children, so every sub-tag of a `FAMC` fell through without even reaching
 * the unknown-tag list. That breaks the one rule this pipeline has — nothing
 * a real file contains is dropped in silence — and `PEDI` is the sub-tag that
 * is not merely unreported but load-bearing: it is the only place
 * `union_children.relation` can come from.
 *
 * So this reads the pointer the same way, keeps `PEDI` verbatim, and hands
 * everything else to the unknown-tag list under `INDI.FAMC.<TAG>`.
 */
function readChildLink(
  node: GedcomNode,
  into: GedcomChildLink[],
  issues: GedcomIssue[],
  unknown: Sighting[],
): void {
  const pointer = readPointer(node.value);

  if (pointer === null) {
    issues.push({
      kind: "pointer",
      line: node.line,
      message: `INDI.FAMC should point at a record, but says ${describeValue(node.value)}.`,
    });
    return;
  }

  let pedigree: string | null = null;

  for (const child of node.children) {
    if (child.tag === "PEDI") {
      // 5.5.1 allows one `PEDI` per `FAMC`, so the first wins and a second is
      // unread structure rather than a contradiction worth its own vocabulary.
      pedigree ??= blankToNull((child.value ?? "").toLowerCase());
      continue;
    }
    unknown.push({ path: `INDI.FAMC.${child.tag}`, line: child.line });
  }

  into.push({ family: pointer, pedigree, line: node.line });
}

/**
 * Report identifiers used twice.
 *
 * Two records sharing an identifier makes every pointer to it ambiguous, and
 * the ambiguity is silent: whichever one a later mapper happens to index last
 * wins, so half a family attaches to the wrong person. Both records are kept —
 * they hold two people's data — and the collision is named so a person can
 * fix the file.
 */
function reportDuplicateXrefs(
  individuals: readonly GedcomIndividual[],
  families: readonly GedcomFamily[],
  issues: GedcomIssue[],
): void {
  for (const [kind, records] of [
    ["individual", individuals],
    ["family", families],
  ] as const) {
    const seen = new Map<string, number>();

    for (const record of records) {
      if (record.xref === null) {
        issues.push({
          kind: "pointer",
          line: record.line,
          message: `This ${kind} record has no identifier, so nothing in the file can refer to it.`,
        });
        continue;
      }

      const first = seen.get(record.xref);
      if (first !== undefined) {
        issues.push({
          kind: "pointer",
          line: record.line,
          message: `${record.xref} is already used by the ${kind} record on line ${first}, so references to it are ambiguous.`,
        });
        continue;
      }

      seen.set(record.xref, record.line);
    }
  }
}

/** A value, quoted, or a phrase for the absence of one. */
function describeValue(value: string | null): string {
  return value === null ? "nothing" : `"${value.trim()}"`;
}

/** Runs of whitespace to single spaces, and trimmed. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Blank is absent — the same rule `readText` states in `lib/field-input.ts`. */
function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
