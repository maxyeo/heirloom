import { decodeGedcom, type GedcomEncoding } from "./gedcom-encoding";
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
  /** `FAMC` — the families this person appears in as a child. See above. */
  familiesAsChild: string[];
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

/** GEDCOM's `SEX` codes and the `sex` enum members they mean. */
const SEX_CODES: Readonly<Record<string, Sex>> = {
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
          issues,
          unknown,
        );
        break;

      case "DEAT":
        individual.death = readEvent(
          child,
          individual.death,
          "death",
          issues,
          unknown,
        );
        break;

      case "FAMS":
        collectPointer(child, "INDI.FAMS", individual.familiesAsSpouse, issues);
        break;

      case "FAMC":
        collectPointer(child, "INDI.FAMC", individual.familiesAsChild, issues);
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
          issues,
          unknown,
        );
        break;

      case "DIV":
        family.divorce = readEvent(
          child,
          family.divorce,
          "divorce",
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
 */
function readEvent(
  node: GedcomNode,
  existing: GedcomEvent | null,
  label: string,
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
        unknown.push({
          path: `${node.tag}.${child.tag}`,
          line: child.line,
        });
    }
  }

  return event;
}

/**
 * Read a `DATE` into an event.
 *
 * The text is kept whatever happens. GEDCOM has date forms this application
 * has no column for — `BET 1890 AND 1900`, `FROM 1912 TO 1918`, `INT 1890
 * (baptism)` — and they are out of scope on purpose: a range is two dates and
 * `individuals` has one. What must not happen is a range being read as one of
 * its endpoints, which would turn "some time in that decade" into a
 * false certainty. `parseDateInput` refuses them, so they arrive here as an
 * issue with the text intact, which is the honest outcome.
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

  const parsed = parseDateInput(text);
  if (!parsed.ok) {
    issues.push({
      kind: "date",
      line: node.line,
      message: `The ${label} date "${text}" could not be read, so it was left blank. ${parsed.message}`,
    });
    return;
  }

  event.date = parsed.value;
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

/**
 * The `HEAD.CHAR` value, for the text entry point.
 *
 * `parseGedcomText` never decodes anything — its caller already holds a string
 * — but the field is still reported, because a round trip has to be able to
 * write back the character set the file declared.
 */
function readDeclaredCharacterSet(text: string): string | null {
  const match = /^\s*\d+\s+CHAR\s+(\S+)\s*$/im.exec(text.slice(0, 1024));
  return match === null ? null : match[1].toUpperCase();
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
