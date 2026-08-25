import { type GedcomFile, parseGedcom } from "./gedcom";
import { type GedcomMapping, mapGedcom } from "./gedcom-map";
import type {
  GedcomIssue,
  GedcomIssueKind,
  GedcomUnknownTag,
} from "./gedcom-report";
import { formatPersonName } from "./person-format";

/**
 * What an import would do, before it does any of it (E6-T3, `YEO-48`).
 *
 * ## The sentence this module exists to make true
 *
 * > Uploading the wrong file must not be a database restore.
 *
 * Everything below is in service of one screen: the counts, a handful of
 * names, and the warnings, shown to somebody who has to decide whether the
 * file they just picked is the file they meant. The decision is only worth
 * asking for if the answer is legible, so a preview that said "1,842 records"
 * and stopped would be a confirmation dialogue in the sense that "are you
 * sure?" is one.
 *
 * ## Why this is a plain function and not the route handler
 *
 * The same reason `lib/image-upload.ts` gives for E5-T2, and one more.
 *
 * The E5-T2 reason: a route handler reaches `@/lib/session`, which reaches
 * `@/auth`, which calls `NextAuth()` at import time and does not load outside
 * the Next.js runtime — so a test of the handler begins by mocking the module
 * holding the security boundary, and everything after that is asserted about
 * a mocked-out world. A module that takes bytes and returns a value needs no
 * fixtures and no mocking (docs/testing.md).
 *
 * The reason particular to this ticket: **the preview must be incapable of
 * writing**, and "incapable" is a property of the import closure rather than
 * of anyone's intentions. `lib/gedcom.purity.test.ts` walks the closure of
 * this module transitively and asserts it reaches no database, no npm
 * package, and nothing else at all. That is the acceptance criterion
 * "cancelling leaves the database untouched" stated as a structural fact
 * rather than as a code path nobody happened to take: on the cancelling path
 * there is no reachable code that could write, whatever it did.
 *
 * ## What it does not do
 *
 * No parsing, no mapping and no reporting of its own. `lib/gedcom.ts` reads
 * the file, `lib/gedcom-map.ts` decides the rows, and `lib/gedcom-report.ts`
 * is the vocabulary both of them answer in. This module *summarises* those
 * answers, and where it needs a fact one of them already carries — an unknown
 * tag's count, an issue's line number and sentence — it passes the value
 * through rather than recomputing it. A preview that re-derived "how many
 * dates were unreadable" from anything but `issues` would be a second opinion
 * about a question that already has one, and the two would eventually differ.
 *
 * The single exception is {@link unnamedWarning}, and its docblock says why.
 */

/**
 * The largest `.ged` accepted, four mebibytes.
 *
 * The ceiling is the platform's rather than a preference, and
 * `lib/image-upload.ts` works it out in full: **a Vercel-hosted function can
 * receive a 4.5 MB request body**, enforced before this application's code
 * runs. The headroom below it is multipart framing, the field name and the
 * filename, which travel in the same body as the file — a cap set at the
 * ceiling is a cap the platform reaches first, as a bare 413 from an edge
 * this code never sees, with no message saying what the limit was.
 *
 * Four megabytes of GEDCOM is a large tree: `test/fixtures/gedcom/family.ged`
 * is five people in 1 KB, so the cap is somewhere north of ten thousand
 * people. A file that exceeds it is a real limitation rather than a fiddly
 * default, and the honest answer is the one {@link checkGedcomUpload} gives —
 * say the number, rather than fail at the edge.
 */
export const MAX_GEDCOM_BYTES = 4 * 1024 * 1024;

/**
 * The largest request body worth buffering.
 *
 * A courtesy the route can apply to `Content-Length` before reading anything,
 * exactly as `app/api/images/route.ts` does. Above {@link MAX_GEDCOM_BYTES}
 * for the same reason: a check that only ever *rejects* must never reject
 * something the real check would have accepted.
 */
export const MAX_REQUEST_BYTES = MAX_GEDCOM_BYTES + 64 * 1024;

/**
 * How many names the preview shows.
 *
 * Enough to recognise a family and not enough to be a list. The question this
 * sample answers is "is this my tree or somebody else's", and a dozen names
 * in file order answers it in a glance — where forty would be scrolled past
 * and three could all be Smiths from the same page of the file.
 */
export const SAMPLE_SIZE = 12;

/**
 * How many examples each warning group shows.
 *
 * The count is the fact; the examples are there so the count can be checked.
 * Five is enough to see whether "83 unreadable dates" is one broken program
 * writing `12/03/1890` throughout or eighty-three separate mistakes, which is
 * the only decision the reader is making here.
 */
export const EXAMPLES_SHOWN = 5;

/**
 * How many unknown-tag rows the preview shows.
 *
 * `summariseUnknownTags` has already ordered them by count descending, so the
 * first rows describe most of what is being left behind, and the total is
 * carried separately in {@link ImportPreview.unknownTagTotal} so the list is
 * never mistaken for the whole answer.
 */
export const UNKNOWN_TAGS_SHOWN = 8;

/** What the import would write, per table. */
export type ImportCounts = {
  /** `individuals` rows. */
  people: number;
  /** `unions` rows. */
  unions: number;
  /** `union_children` rows. */
  children: number;
};

/**
 * The kinds of warning a preview groups by.
 *
 * `GedcomIssueKind` plus one. `unnamed` is not an issue kind because the
 * parser and mapper are right not to have invented one — the mapper reports a
 * missing first name as `value`, which is the honest classification ("a fact
 * with nowhere to go"). But the acceptance criterion names *people with no
 * name* as its own warning, and rightly: it is the one warning here that
 * changes what a person will be **called** in the tree afterwards, where the
 * rest change what is recorded about them.
 */
export type ImportWarningKind = GedcomIssueKind | "unnamed";

/** One example of a warning, so the count above it can be checked. */
export type WarningExample = {
  /** 1-based, or `0` for something true of the file rather than of a line. */
  line: number;
  /** The sentence the parser or mapper wrote, passed through unchanged. */
  message: string;
};

/** Everything of one kind that the import would do differently to the file. */
export type ImportWarning = {
  kind: ImportWarningKind;
  /** A heading, in the words of somebody who has a file rather than a schema. */
  label: string;
  /** How many there are in the whole file, not how many are listed below. */
  count: number;
  /** The first {@link EXAMPLES_SHOWN}, in file order. */
  examples: WarningExample[];
};

/** Everything the preview screen renders. */
export type ImportPreview = {
  /** The character set the file was actually read in. */
  encoding: GedcomFile["encoding"];
  /**
   * What the file's `HEAD.CHAR` claimed, when that is not what it turned out
   * to be. `null` when the file agreed with itself or said nothing.
   *
   * Only the disagreement is carried, because only the disagreement is worth
   * a line on the screen — and it is worth one, since a file read as ANSEL
   * against its own declaration is exactly the file whose accented names are
   * about to be either right or mojibake.
   */
  misdeclaredEncoding: string | null;
  /** What would be written. */
  counts: ImportCounts;
  /** What the file contains, whether or not it can be written. */
  found: { people: number; unions: number };
  /**
   * Records the file contains that the import would leave out.
   *
   * `found` minus `counts`, computed here rather than by the reader. These
   * are the records `validateIndividual` or `validateUnion` refused — a death
   * before a birth, a name of six hundred characters — and every one of them
   * has a `value` warning naming it. Shown as a number of its own anyway,
   * because "148 of 152 people" is the fact somebody decides on, and finding
   * it by subtracting two numbers on the same screen is not the same as being
   * told.
   */
  refused: { people: number; unions: number };
  /** Up to {@link SAMPLE_SIZE} names, in file order, as they would be written. */
  sample: string[];
  /**
   * In the order the screen should show them: what is wrong with the file,
   * then what this application cannot hold, then what it holds imprecisely.
   */
  warnings: ImportWarning[];
  /**
   * Valid GEDCOM this application has nowhere to put, as the parser
   * aggregated it — the first {@link UNKNOWN_TAGS_SHOWN} rows.
   *
   * A separate list from `warnings`, and deliberately so;
   * `lib/gedcom-report.ts` gives the argument in full. In short: an unknown
   * tag is a scope statement, not a fault, and a file with 4,000 `SOUR` tags
   * and one unreadable birth date must not report 4,001 problems with the one
   * that matters on page forty.
   */
  unknownTags: GedcomUnknownTag[];
  /** How many distinct unknown paths there are, so the list above is not mistaken for all of them. */
  unknownTagTotal: number;
  /** How many tag occurrences that is, which is the number worth saying out loud. */
  unknownTagOccurrences: number;
};

/**
 * Everything read out of one uploaded file, in one pass.
 *
 * The mapping travels beside the preview rather than being thrown away and
 * re-derived, because the confirming half of this flow needs exactly it: E6-T4
 * (`YEO-49`) writes `mapping` and has nothing left to resolve. Parsing a file
 * twice to show it once and write it once would also be two chances for the
 * screen somebody approved and the rows that get written to disagree.
 */
export type GedcomRead = {
  file: GedcomFile;
  mapping: GedcomMapping;
  preview: ImportPreview;
};

/** An upload the endpoint should refuse, with the status to refuse it with. */
export type RejectedGedcom = {
  ok: false;
  status: number;
  /** Written for the person who picked the file, naming the limit. */
  message: string;
};

export type CheckedGedcom = { ok: true } | RejectedGedcom;

/**
 * Whether an uploaded file is worth reading at all.
 *
 * Only two answers, and the absence of a third is the interesting part:
 * **there is no format check here.** GEDCOM has no magic bytes, and more to
 * the point it does not need one — `parseGedcom` is total, and its own
 * docblock says what happens to bytes that are not GEDCOM: "a file that is
 * not GEDCOM comes back with no records and an issue per line, which is what
 * the import preview needs in order to say so." A sniff would replace a
 * preview reading *"0 people, 0 unions, 214 lines that are not GEDCOM"* with
 * a one-line rejection saying less, and would refuse a valid file whose first
 * bytes some program wrote differently.
 *
 * So the only things refused before parsing are the two that are not about
 * the format: a file too large to buffer, and no file at all.
 *
 * @param size the uploaded file's length in bytes
 */
export function checkGedcomUpload(size: number): CheckedGedcom {
  if (size === 0) {
    return {
      ok: false,
      status: 400,
      message: "That file is empty.",
    };
  }

  if (size > MAX_GEDCOM_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `That file is larger than ${MAX_GEDCOM_BYTES / (1024 * 1024)} MB, which is the most this can accept.`,
    };
  }

  return { ok: true };
}

/**
 * Read an uploaded `.ged`: parse it, map it, and summarise what that would do.
 *
 * Pure, total, and does not throw, because both halves it is made of are. A
 * file of pure noise produces empty counts and a warning per line, which is a
 * preview, not an error.
 */
export function readGedcom(bytes: Uint8Array): GedcomRead {
  const file = parseGedcom(bytes);
  const mapping = mapGedcom(file);
  return { file, mapping, preview: summariseImport(file, mapping) };
}

/**
 * The preview, from a file and its mapping.
 *
 * Split from {@link readGedcom} so that the summary can be tested against
 * literal values — a mapping with two individuals and one refused record is
 * three lines to write and no bytes to encode.
 */
export function summariseImport(
  file: GedcomFile,
  mapping: GedcomMapping,
): ImportPreview {
  const unknownTagOccurrences = file.unknownTags.reduce(
    (total, tag) => total + tag.count,
    0,
  );

  return {
    encoding: file.encoding,
    /**
     * Only reported when the file contradicted itself. `declaredEncoding` is
     * present on every file that has a `HEAD.CHAR` line, and repeating
     * "declared UTF-8, read as UTF-8" on the screen would train the reader to
     * skip the line on the day it says something else.
     */
    misdeclaredEncoding:
      file.declaredEncoding !== null &&
      file.declaredEncoding.toLowerCase() !== file.encoding
        ? file.declaredEncoding
        : null,
    counts: {
      people: mapping.individuals.length,
      unions: mapping.unions.length,
      children: mapping.unionChildren.length,
    },
    found: { people: file.individuals.length, unions: file.families.length },
    refused: {
      people: file.individuals.length - mapping.individuals.length,
      unions: file.families.length - mapping.unions.length,
    },
    sample: mapping.individuals
      .slice(0, SAMPLE_SIZE)
      .map((individual) =>
        formatPersonName(
          individual.values.givenName,
          individual.values.surname,
        ),
      ),
    warnings: summariseWarnings(file, mapping.issues),
    unknownTags: file.unknownTags.slice(0, UNKNOWN_TAGS_SHOWN),
    unknownTagTotal: file.unknownTags.length,
    unknownTagOccurrences,
  };
}

/**
 * The heading each kind of warning gets.
 *
 * Written for somebody holding a file, not for somebody holding this schema —
 * "Links to records that are not in the file" rather than "pointer". The
 * per-warning sentences underneath are the parser's and the mapper's, which
 * were written to the same standard and quote the offending value; these
 * headings only have to say what the group *is* so a reader can decide
 * whether to open it.
 */
const WARNING_LABELS: Readonly<Record<ImportWarningKind, string>> = {
  encoding: "Character set",
  line: "Lines that are not GEDCOM",
  date: "Dates that could not be read",
  unnamed: "People with no name in the file",
  pointer: "Links to records that are not in the file",
  value: "Facts this tree has nowhere to put",
  narrowed: "Dates recorded slightly less precisely",
};

/**
 * The order the screen shows the groups in: worst first, and `narrowed` last.
 *
 * The ordering is an editorial claim about what the reader should look at
 * before deciding, and the two ends are the ones worth arguing.
 *
 * `encoding` leads because it is true of the whole file rather than of a line
 * in it: a file read as the wrong character set has every accented name in it
 * wrong, and no other warning on the screen matters until that is settled.
 *
 * `narrowed` is last because it is the one group that means *nothing to fix*
 * — `lib/gedcom-report.ts` is explicit that it is "never fatal, by
 * construction", the field is populated, and the value is true and slightly
 * poorer than the file's. Sorting it up among the failures would be the
 * report burying its own bad news, which is the failure `gedcom-report.ts`
 * split its two lists to avoid.
 */
const WARNING_ORDER: readonly ImportWarningKind[] = [
  "encoding",
  "line",
  "date",
  "unnamed",
  "pointer",
  "value",
  "narrowed",
];

/** Every non-empty warning group, in {@link WARNING_ORDER}. */
function summariseWarnings(
  file: GedcomFile,
  issues: readonly GedcomIssue[],
): ImportWarning[] {
  const byKind = new Map<ImportWarningKind, ImportWarning>();

  const unnamed = unnamedIndividuals(file);
  const warning = unnamedWarning(unnamed);
  if (warning) byKind.set("unnamed", warning);

  /**
   * The lines the group above is about, so that the `value` group does not
   * report the same people a second time.
   *
   * `lib/gedcom-map.ts` reports a missing first name as `value`, which is the
   * right classification for its own report and the wrong one for this
   * screen: with both groups rendered, a file with two unnamed people would
   * list them under *People with no name in the file* and again under *Facts
   * this tree has nowhere to put*, which is exactly the "one loss, two
   * spellings, and no way to know it was one loss" that `gedcom-report.ts`
   * split its own two lists to avoid.
   *
   * Claimed by line rather than by matching the sentence, because the
   * sentence is written for a person to read and should stay free to be
   * reworded. **At most one per line**, and that bound is what makes this
   * exact rather than approximately right: a person can raise a second
   * `value` issue at the same line — the one for a file that records three
   * names for them — and the mapper appends the missing-name issue first.
   * That order is the guarantee being relied on, stated here rather than
   * assumed, the way `summariseUnknownTags` states its own.
   */
  const unclaimed = new Set(unnamed.map((individual) => individual.line));

  // In file order, which `GedcomMapping.issues` preserves — the parser's list
  // followed by the mapper's, each in the order it was produced. So the first
  // five appended to a group are the first five a reader would find by
  // opening the file and scrolling, which is what makes an example useful.
  for (const issue of issues) {
    // `delete` answers "was it there" and claims it in one step.
    if (issue.kind === "value" && unclaimed.delete(issue.line)) continue;

    const group = byKind.get(issue.kind);
    if (group === undefined) {
      byKind.set(issue.kind, {
        kind: issue.kind,
        label: WARNING_LABELS[issue.kind],
        count: 1,
        examples: [{ line: issue.line, message: issue.message }],
      });
      continue;
    }

    group.count += 1;
    if (group.examples.length < EXAMPLES_SHOWN) {
      group.examples.push({ line: issue.line, message: issue.message });
    }
  }

  return WARNING_ORDER.map((kind) => byKind.get(kind)).filter(
    (warning): warning is ImportWarning => warning !== undefined,
  );
}

/**
 * People the file does not name, counted off the file rather than the report.
 *
 * This is the one place in the module that derives a fact instead of passing
 * one through, and the alternative was worse in a way worth writing down.
 * `lib/gedcom-map.ts` does report every one of these — as `kind: "value"`,
 * alongside a person with three names and a `SEX` nobody recognises — so the
 * only way to pull them back out of `issues` is to match on the wording of a
 * sentence written for a human to read. That is a coupling with no compiler
 * behind it: rewording a message for clarity, which is a thing somebody
 * should be free to do, would silently empty this warning.
 *
 * The file answers the same question directly and cannot drift: a person the
 * file gives no `NAME` for, or a `NAME` with nothing before the surname
 * (`1 NAME /Smith/`, which is an ordinary way to record a woman known by her
 * married surname), is a person this tree will call "Unknown" because
 * `individuals.given_name` is `not null`. See
 * `docs/architecture.md#what-gedcom-has-that-this-schema-does-not`.
 *
 * Counted over every `INDI` in the file, including ones the validator went on
 * to refuse. The reader is being told what the *file* is like — a file that
 * names nobody is the same finding whether or not those records also failed
 * some other check.
 */
function unnamedIndividuals(file: GedcomFile): GedcomFile["individuals"] {
  return file.individuals.filter(
    (individual) => (individual.names[0]?.given ?? null) === null,
  );
}

/** {@link unnamedIndividuals} as a warning, or nothing when the file names everybody. */
function unnamedWarning(
  unnamed: GedcomFile["individuals"],
): ImportWarning | null {
  if (unnamed.length === 0) return null;

  return {
    kind: "unnamed",
    label: WARNING_LABELS.unnamed,
    count: unnamed.length,
    examples: unnamed.slice(0, EXAMPLES_SHOWN).map((individual) => {
      const surname = individual.names[0]?.surname ?? null;
      return {
        line: individual.line,
        message:
          surname === null
            ? 'No name is recorded, so this person is imported as "Unknown".'
            : `Only a surname is recorded, so this person is imported as "Unknown ${surname}".`,
      };
    }),
  };
}

/**
 * A file's SHA-256, as lowercase hex.
 *
 * The confirming request carries the file a second time — there is nowhere on
 * a stateless function to have left the first copy — so something has to
 * establish that the bytes being imported are the bytes that were previewed.
 * A digest is that something: the preview answers with one, the confirmation
 * sends it back beside the file, and the endpoint recomputes it. A reader who
 * changed the file input after reading the preview gets a new preview instead
 * of an import, which is the acceptance criterion's *explicit confirm step*
 * meaning what it says rather than meaning "a second button was pressed".
 *
 * `crypto.subtle` is a global on every runtime this application targets, so
 * this stays inside the import-closure rule — see `lib/gedcom.purity.test.ts`,
 * which asserts this module imports no package at all.
 */
export async function gedcomDigest(bytes: Uint8Array): Promise<string> {
  // `BufferSource` wants an `ArrayBuffer`, and a `Uint8Array` may be a window
  // onto a larger one — `formData()` returns views into a buffer holding the
  // whole multipart body. Slicing takes exactly this file's bytes.
  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
