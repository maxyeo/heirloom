import type { GedcomFile } from "./gedcom";
import type { GedcomSkip, GedcomUnknownTag } from "./gedcom-report";
import {
  type GedcomRead,
  type ImportCounts,
  type ImportWarning,
  summariseWarnings,
  type WarningExample,
} from "./import-preview";

/**
 * What an import did, after it did it (E6-T5, `YEO-50`).
 *
 * ## The sentence this module exists to make true
 *
 * > Silence is the wrong answer.
 *
 * Real GEDCOM files are dirty, and the failure this prevents is a specific
 * one: the author assumes everything imported, and finds out otherwise months
 * later when somebody is missing from the tree. By then the file has moved
 * on, nobody remembers which upload it was, and the only way to find the gap
 * is to compare two trees by hand.
 *
 * So an import answers with an account of itself, in three parts the ticket
 * names — **what was created, what was skipped, what was approximated** — and
 * a fourth that is not a fault at all: the tags this application does not
 * read, listed so the gap is visible rather than assumed absent.
 *
 * ## It reports, it does not decide
 *
 * Nothing here is derived a second time. The skips are `lib/gedcom-map.ts`'s
 * own `skipped` issues, each already carrying the record it left out and the
 * validator's own sentence; the approximations are its `narrowed` issues,
 * passed through **byte for byte**, which `docs/gedcom.md` has asked for
 * since E6-T2 — those four losses are decisions with reasons, already worded
 * for the person who has to act on them, and re-describing them here would
 * give one loss two spellings in one report with no way to tell it was one
 * loss. The grouping of everything else is `summariseWarnings`, the same
 * function the preview screen uses, called with a larger limit.
 *
 * The one number this module does not take from the reading is
 * {@link ImportReport.created}, and that is the point of it: it is counted
 * off the rows the *write* inserted. A report that restated the preview's
 * prediction would be unable to tell anybody that the prediction was wrong.
 *
 * ## Why the report is a value and the download is text
 *
 * The screen renders sections out of {@link ImportReport}; the file somebody
 * keeps is {@link formatImportReport} run over the same value. Two
 * representations of one report, and the structured one is the source — which
 * is the opposite of the arrangement where a server sends prose and a screen
 * parses it back.
 *
 * The download is built in the browser rather than served by a route, and the
 * reason is particular to this flow rather than convenience. The report
 * describes bytes that exist only inside the request that produced it. A
 * route serving the file would need either a third upload of the same `.ged`
 * or somewhere to stash the parse — and `lib/import-endpoint.ts` already
 * rejected stashing by name, because it needs a store the preview must not
 * touch and turns a cancelled import into something to clean up later.
 *
 * `app/api/export/gedcom/route.ts` (E7-T3, `YEO-53`) is the opposite case and
 * does the opposite thing — a route handler with a `Content-Disposition`, no
 * client component, working with JavaScript off. The two are not a
 * disagreement about downloads: the difference is that its file exists in the
 * database and this one exists only for the length of one request.
 *
 * ## Pure, and outside the import closures
 *
 * No `@/db`, no React, no `next/*`. Not because `lib/gedcom.purity.test.ts`
 * walks this module — it does not, and it should not: this is the *consumer*
 * those four entry points were kept pure for — but because the client
 * component imports it to build the download, and because a report of a file
 * is exactly the kind of thing that should be testable by handing it a file.
 *
 * That is also why {@link buildImportReport} takes an `ImportCounts` rather
 * than `lib/gedcom-import.ts`'s `ImportedCounts`. Even an `import type` of
 * the latter would name a module that reaches `drizzle-orm`, and the purity
 * test's specifier scan does not distinguish a type import from a value one.
 * The route translates before calling in, which keeps that rule true for
 * every module on this side of the seam rather than true by accident.
 */

/**
 * How many rows any one section of the report lists.
 *
 * Larger than the preview's {@link EXAMPLES_SHOWN} by two orders of
 * magnitude, because the two are answering different questions: five examples
 * are enough to check a count against before deciding, and a file somebody
 * keeps in order to go and fix their `.ged` needs the actual list.
 *
 * Capped all the same, and the cap is a correctness matter rather than
 * tidiness. `lib/gedcom-lines.ts` raises one issue per unreadable line, so
 * four mebibytes of something that is not GEDCOM is on the order of a hundred
 * thousand issues, each with a sentence — tens of megabytes of JSON, produced
 * in the same invocation that has just held a pooled connection through a
 * transaction. The platform caps a function's body at 4.5 MB in either
 * direction (`lib/import-preview.ts`), so an uncapped report would fail at
 * the edge on exactly the dirtiest files this epic exists for.
 *
 * Five hundred is chosen to be past the point of usefulness rather than at
 * it: a person acting on a list of five hundred skips has a systematic
 * problem with their file, and the five hundred and first tells them nothing
 * the count above it did not. Every section carries its full `total` beside
 * the rows, so the cap is never mistaken for the answer.
 */
export const REPORT_ROWS_SHOWN = 500;

/**
 * One section of the report: what it can show, and how much there was.
 *
 * `total` is the whole file's count and `rows` is at most
 * {@link REPORT_ROWS_SHOWN} of them. The two are separate fields rather than
 * a length because they routinely differ, and a report whose reader has to
 * work out whether a list is complete is a report that will be believed when
 * it is not.
 */
export type ReportRows<T> = {
  total: number;
  rows: T[];
};

/** Everything an import did, in the order a reader should be told it. */
export type ImportReport = {
  /**
   * What reached the three tables, counted off the insert rather than
   * predicted.
   */
  created: ImportCounts;
  /** What the file contained, so `created` can be read as a proportion. */
  found: { people: number; unions: number };
  /** The character set the file was actually read in. */
  encoding: GedcomFile["encoding"];
  /** What its `HEAD.CHAR` claimed, when that is not what it turned out to be. */
  misdeclaredEncoding: string | null;
  /**
   * Every record and link this import refused, each naming the record.
   *
   * The acceptance criterion in one field. `GedcomSkip.record` is a value —
   * the tag, the xref, and the name the file gave — rather than a phrase
   * inside the sentence, so this list can be grouped, counted and searched
   * without anybody parsing English.
   */
  skipped: ReportRows<GedcomSkip>;
  /**
   * What was stored, and stored less precisely than the file wrote it.
   *
   * The mapper's `narrowed` issues unchanged. Its own list, well away from
   * the skips, because the two are opposite news: a skip says somebody is
   * missing and an approximation says nothing needs fixing.
   */
  approximated: ReportRows<WarningExample>;
  /**
   * Everything else worth a line, grouped as the preview groups it — minus
   * the two groups above, which have sections of their own.
   */
  warnings: ImportWarning[];
  /**
   * Valid GEDCOM this application has nowhere to put, as the parser
   * aggregated it.
   *
   * "Listed, so the gap is visible rather than assumed absent" is the
   * criterion, and the word doing the work is *assumed*. Somebody whose file
   * is full of `SOUR` citations has not lost them — they are still in their
   * `.ged` — but they will believe this application holds them unless it says
   * otherwise, and they will believe it hardest on the day they delete the
   * original.
   */
  unsupportedTags: ReportRows<GedcomUnknownTag>;
  /** How many tag occurrences that is, which is the number worth saying out loud. */
  unsupportedTagOccurrences: number;
};

/** What the download's header needs and the report itself cannot know. */
export type ReportHeading = {
  /** The name of the file as the browser gave it. */
  fileName: string;
  /** When the import ran. */
  importedAt: Date;
};

/**
 * The report, from one read file and what the write actually inserted.
 *
 * Takes the whole {@link GedcomRead} rather than a file and a mapping,
 * because the preview beside them has already settled two questions this
 * would otherwise answer a second time — which character set the file turned
 * out to be in, and whether it contradicted its own declaration. Those are
 * the preview's words and they should stay one set of words.
 *
 * @param read the file, its mapping and its preview, from `readGedcom`
 * @param created what `importGedcom` inserted, in the screen's vocabulary
 */
export function buildImportReport(
  read: GedcomRead,
  created: ImportCounts,
): ImportReport {
  const { file, mapping, preview } = read;

  const skipped = mapping.issues.filter(
    (issue): issue is GedcomSkip => issue.kind === "skipped",
  );

  const approximated = mapping.issues.filter(
    (issue) => issue.kind === "narrowed",
  );

  return {
    created,
    found: preview.found,
    encoding: preview.encoding,
    misdeclaredEncoding: preview.misdeclaredEncoding,
    skipped: rows(skipped),
    approximated: rows(
      approximated.map((issue) => ({
        line: issue.line,
        message: issue.message,
      })),
    ),
    // Grouped by the preview's own function so that a kind is labelled and
    // ordered the same way before and after an import. The two groups with
    // sections of their own are dropped rather than repeated: one loss, one
    // place, which is the rule `lib/gedcom-report.ts` split its two lists for.
    warnings: summariseWarnings(file, mapping.issues, REPORT_ROWS_SHOWN).filter(
      (warning) => warning.kind !== "skipped" && warning.kind !== "narrowed",
    ),
    unsupportedTags: rows(file.unknownTags),
    unsupportedTagOccurrences: file.unknownTags.reduce(
      (total, tag) => total + tag.count,
      0,
    ),
  };
}

/** A list as a section: everything counted, at most {@link REPORT_ROWS_SHOWN} kept. */
function rows<T>(all: readonly T[]): ReportRows<T> {
  return { total: all.length, rows: all.slice(0, REPORT_ROWS_SHOWN) };
}

/**
 * The report as the plain text somebody downloads.
 *
 * Plain text rather than the JSON behind it, or a PDF, or the HTML of the
 * screen. The reader of this file is somebody with a `.ged` open in an
 * editor, going down the list and fixing lines; what they need is line
 * numbers and xrefs they can search for, in something every machine can open
 * and nothing needs to render. It is also the format that will still be
 * readable in twenty years, which is the same argument
 * `docs/architecture.md` makes for being able to export the tree at all.
 *
 * Every section is printed even when it is empty, and that is deliberate. An
 * empty *Skipped* heading says that nothing was skipped; an absent one says
 * nothing at all, and the difference between those two is the whole reason
 * this ticket exists.
 */
export function formatImportReport(
  report: ImportReport,
  heading: ReportHeading,
): string {
  const lines: string[] = [
    "IMPORT REPORT",
    `File: ${heading.fileName}`,
    `Imported: ${heading.importedAt.toISOString()}`,
    `Read as: ${report.encoding}`,
  ];

  if (report.misdeclaredEncoding !== null) {
    lines.push(
      `  The file declares ${report.misdeclaredEncoding} and its own bytes say ` +
        `${report.encoding}. Accented names are worth checking.`,
    );
  }

  lines.push(
    "",
    section("WHAT WAS CREATED"),
    `  ${count(report.created.people, "person", "people")}, of ${report.found.people} in the file`,
    `  ${count(report.created.unions, "union", "unions")}, of ${report.found.unions} in the file`,
    `  ${count(report.created.children, "child link", "child links")}`,
    "",
    section(`WHAT WAS SKIPPED (${report.skipped.total})`),
  );

  if (report.skipped.total === 0) {
    lines.push("  Nothing. Every record in the file is in the tree.");
  } else {
    lines.push(
      "  Each of these was in the file and is not in the tree.",
      "",
      ...report.skipped.rows.flatMap((skip) => [
        `  ${describeRecord(skip)}`,
        `    ${skip.message}`,
      ]),
      ...more(report.skipped, "skip", "skips"),
    );
  }

  lines.push(
    "",
    section(`WHAT WAS APPROXIMATED (${report.approximated.total})`),
  );

  if (report.approximated.total === 0) {
    lines.push(
      "  Nothing. Every date was stored exactly as the file wrote it.",
    );
  } else {
    lines.push(
      "  Stored, and slightly poorer than the file wrote it. Nothing here",
      "  needs fixing unless the lost detail mattered to you.",
      "",
      ...report.approximated.rows.map(
        (example) => `  ${place(example.line)}${example.message}`,
      ),
      ...more(report.approximated, "date", "dates"),
    );
  }

  lines.push(
    "",
    section(
      `TAGS THIS APPLICATION DOES NOT READ (${report.unsupportedTags.total})`,
    ),
  );

  if (report.unsupportedTags.total === 0) {
    lines.push("  None. Every tag in the file is one this application reads.");
  } else {
    lines.push(
      `  ${count(report.unsupportedTagOccurrences, "line", "lines")} of valid`,
      "  GEDCOM that this application has nowhere to put. Nothing is wrong",
      "  with them and they are still in your file; they are simply outside",
      "  what this records.",
      "",
      ...report.unsupportedTags.rows.map(
        (tag) =>
          `  ${tag.path} — ${count(tag.count, "time", "times")}, first at line ${tag.firstLine}`,
      ),
      ...more(report.unsupportedTags, "kind", "kinds"),
    );
  }

  for (const warning of report.warnings) {
    lines.push(
      "",
      section(`${warning.label.toUpperCase()} (${warning.count})`),
      ...warning.examples.map(
        (example) => `  ${place(example.line)}${example.message}`,
      ),
    );

    if (warning.count > warning.examples.length) {
      lines.push(`  … and ${warning.count - warning.examples.length} more`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * The name of the downloaded file.
 *
 * Built from the `.ged`'s own name so that a folder of six imports is six
 * distinguishable reports rather than `import-report (3).txt`.
 */
export function importReportFilename(fileName: string): string {
  // The three steps below are order-dependent, which is easy to miss because
  // each one reads correctly on its own. The extension has to go first or
  // `.ged` is not at the end to match; the dot-trim has to go last, because
  // the substitution before it can *create* a leading dot — `..\.ged` becomes
  // `..-` only after the separator is replaced. Swapping the last two reopens
  // the hidden-file case that `lib/import-report.test.ts` pins.
  const stem = fileName
    .replace(/\.(ged|gedcom)$/i, "")
    // Anything that is not a word character, a dot or a dash becomes a dash,
    // which is what takes `/` and `\` out — a `download` attribute is not a
    // path and must not be able to look like one.
    .replace(/[^\w.-]+/g, "-")
    // Leading dots make a hidden file on every Unix, and a name that arrives
    // as `..ged` would otherwise produce one. Trailing ones are just untidy.
    .replace(/^[.]+|[.]+$/g, "");
  return `${stem || "gedcom"}-import-report.txt`;
}

/** `INDI I42 (Ada Reed), line 812` — the record, in the file's own terms. */
function describeRecord(skip: GedcomSkip): string {
  const { tag, xref, label } = skip.record;
  const named = [tag, xref].filter(Boolean).join(" ");
  return [
    label === null ? named : `${named} (${label})`,
    skip.line > 0 ? `line ${skip.line}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** `Line 91: `, or nothing for something true of the file rather than a line. */
function place(line: number): string {
  return line > 0 ? `Line ${line}: ` : "";
}

/** The tail that keeps a capped section from being read as a complete one. */
function more(
  section: ReportRows<unknown>,
  one: string,
  many: string,
): string[] {
  const hidden = section.total - section.rows.length;
  return hidden > 0
    ? ["", `  … and ${count(hidden, one, many)} not listed`]
    : [];
}

/** An underlined heading, so the sections are findable by eye in a long file. */
function section(title: string): string {
  return `${title}\n${"-".repeat(title.length)}`;
}

/** "1 person", "3 people". */
function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}
