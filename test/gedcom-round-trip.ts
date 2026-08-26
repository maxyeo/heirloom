import { type GedcomFile, parseGedcom, parseGedcomText } from "@/lib/gedcom";
import { type GedcomExportInput, writeGedcom } from "@/lib/gedcom-export";
import { type GedcomMapping, mapGedcom } from "@/lib/gedcom-map";
import { type ImportRows, rowsFromMapping } from "@/lib/import-rows";

/**
 * The round trip, and a diff that says which record broke it (E7-T2,
 * `YEO-52`).
 *
 * ## What the round trip is
 *
 * `writeGedcom` -> `parseGedcomText` -> `mapGedcom` -> `rowsFromMapping` ->
 * `writeGedcom`. Every one of those is the real thing rather than a stand-in:
 * the last step is the same serialiser as the first, and the flattening in
 * the middle is the one `lib/gedcom-import.ts` inserts from. The only part of
 * a real import this does not do is open a transaction, which is the part
 * that cannot change what the rows say — see `lib/import-rows.ts`.
 *
 * The property is that the **second export equals the first, byte for byte**.
 * It is a strong property because it is a fixed point: anything the file
 * fails to say, or says in a way the parser reads differently, shows up as a
 * difference on the second pass. A test that only checked the rows survived
 * would miss a place whose whitespace the parser collapses, which is exactly
 * the defect E7-T1 shipped and then caught.
 *
 * It is deliberately **not** "the second export equals the input file". A
 * first export narrows — `docs/gedcom.md` lists where — and `FROM x TO y` is
 * stored identically to `BET x AND y` and written back as the latter, so a
 * file using periods is not byte-identical to its own first export and never
 * could be. The loss happens once, on the way out; the fixed point is what
 * says it happens *only* once.
 *
 * ## Why the diff is a module and not `expect(a).toBe(b)`
 *
 * "Failures name the specific record that diverged" is an acceptance
 * criterion, and a bare byte comparison of two multi-kilobyte strings does
 * not meet it: the reader gets two walls of text and a caret somewhere in the
 * middle, and has to count `0 @I…@` lines by hand to find out whose record it
 * is. Since the whole point of this ticket is that somebody will one day run
 * it against a real family's file and need to know *who* went missing, the
 * report is part of the deliverable.
 *
 * So the comparison is done over records rather than over characters. A
 * GEDCOM file is a flat list of level-0 records with an identifier on each,
 * which is a structure a diff can key on — and the four things that can go
 * wrong (a record missing, a record appearing, a record's contents changing,
 * the records reordering) each get a sentence naming the xref.
 *
 * ## Pure, and in `test/` rather than `lib/`
 *
 * Nothing here is used by the application; it is test support, and it sits
 * beside `test/route-inventory.ts` for the same reason. It imports no
 * database and no test framework — the assertions live in
 * `lib/gedcom-round-trip.test.ts`, which lets the reporter itself be tested
 * against divergences that are constructed rather than hoped for.
 */

/**
 * CRLF, split on exactly, and never normalised.
 *
 * `writeGedcom` fixes CRLF because 5.5.1 does, so a line ending that is not
 * one is itself a divergence this diff should surface rather than smooth
 * over. Splitting on `/\r?\n/` would hide precisely that.
 */
const NEWLINE = "\r\n";

/** `0 @I1@ INDI` and `0 HEAD` — the two shapes a level-0 line comes in. */
const RECORD_START = /^0 (?:(@[^@]*@) )?(\S*)/;

/** One level-0 record: its identifying line, and everything under it. */
export type GedcomRecord = {
  /**
   * What this record is keyed on across the two exports.
   *
   * The xref where there is one, because that is what the rest of the file
   * points at, and the tag otherwise — `HEAD` and `TRLR` are unique by tag.
   * A key that somehow repeats within one file is disambiguated by
   * occurrence, so a duplicated xref is reported as a changed record rather
   * than silently shadowing the first one.
   */
  key: string;
  /** How the record is named in a message: `@I3@ INDI`. */
  label: string;
  /** 1-based line number of the record's `0` line in the whole file. */
  line: number;
  /** The record's lines, its own `0` line first. */
  lines: string[];
};

/** One reason two exports are not the same file. */
export type GedcomDivergence = {
  kind: "missing" | "added" | "changed" | "moved" | "unlocated";
  /** The record it is about, or null for a whole-file difference. */
  label: string | null;
  /** A complete sentence, naming the record. */
  message: string;
};

/**
 * Cut a GEDCOM file into its level-0 records.
 *
 * Total: anything before the first level-0 line is collected under a record
 * labelled `«before the first record»` rather than dropped, because a diff
 * that discards bytes cannot be trusted to prove two files are the same.
 */
export function splitRecords(text: string): GedcomRecord[] {
  // A file ends with a terminated line, so the split leaves a trailing "".
  const lines = text.split(NEWLINE);
  if (lines.at(-1) === "") lines.pop();

  const records: GedcomRecord[] = [];
  const seen = new Map<string, number>();

  const start = (key: string, label: string, line: number) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    records.push({
      key: count === 1 ? key : `${key} #${count}`,
      label: count === 1 ? label : `${label} (occurrence ${count})`,
      line,
      lines: [],
    });
  };

  for (const [index, line] of lines.entries()) {
    const match = RECORD_START.exec(line);

    if (match !== null) {
      const [, xref, tag] = match;
      const key = xref ?? tag ?? "";
      const label = xref === undefined ? (tag ?? "") : `${xref} ${tag ?? ""}`;
      start(key, label.trim(), index + 1);
    } else if (records.length === 0) {
      start("«preamble»", "«before the first record»", index + 1);
    }

    (records.at(-1) as GedcomRecord).lines.push(line);
  }

  return records;
}

/**
 * Why two exports differ, record by record.
 *
 * Empty exactly when the two strings are equal. The last check is the
 * safety net: if the texts differ and nothing above found it, that is a blind
 * spot in this diff and it says so rather than reporting success.
 */
export function diffGedcom(first: string, second: string): GedcomDivergence[] {
  if (first === second) return [];

  const divergences: GedcomDivergence[] = [];

  const before = splitRecords(first);
  const after = splitRecords(second);
  const afterByKey = new Map(after.map((record) => [record.key, record]));
  const beforeByKey = new Map(before.map((record) => [record.key, record]));

  for (const [position, record] of before.entries()) {
    const match = afterByKey.get(record.key);

    if (match === undefined) {
      divergences.push({
        kind: "missing",
        label: record.label,
        message:
          `${record.label} is in the first export (line ${record.line}) ` +
          `and not in the second. The round trip lost this record.`,
      });
      continue;
    }

    divergences.push(...diffRecord(record, match));

    const movedTo = after.indexOf(match);
    if (movedTo !== position) {
      divergences.push({
        kind: "moved",
        label: record.label,
        message:
          `${record.label} is record ${position + 1} of the first export ` +
          `and record ${movedTo + 1} of the second. The export order is not ` +
          `stable across the trip.`,
      });
    }
  }

  for (const record of after) {
    if (beforeByKey.has(record.key)) continue;

    divergences.push({
      kind: "added",
      label: record.label,
      message:
        `${record.label} is in the second export (line ${record.line}) ` +
        `and not in the first. The round trip invented this record.`,
    });
  }

  if (divergences.length === 0) {
    divergences.push({
      kind: "unlocated",
      label: null,
      message:
        `The two exports differ but no record differs, which means this ` +
        `diff has a blind spot. They are ${first.length} and ` +
        `${second.length} characters long, and first differ at character ` +
        `${firstDifference(first, second)}.`,
    });
  }

  return divergences;
}

/** The lines of one record that changed, named by the record they are in. */
function diffRecord(
  before: GedcomRecord,
  after: GedcomRecord,
): GedcomDivergence[] {
  const divergences: GedcomDivergence[] = [];
  const length = Math.max(before.lines.length, after.lines.length);

  for (let index = 0; index < length; index++) {
    const left = before.lines[index];
    const right = after.lines[index];
    if (left === right) continue;

    const where =
      `${before.label}, line ${index + 1} of the record ` +
      `(first export line ${before.line + index}, ` +
      `second export line ${after.line + index})`;

    divergences.push({
      kind: "changed",
      label: before.label,
      message:
        left === undefined
          ? `${where}: the second export has ${JSON.stringify(right)} where the first export ended the record.`
          : right === undefined
            ? `${where}: the first export has ${JSON.stringify(left)} where the second export ended the record.`
            : `${where}: ${JSON.stringify(left)} became ${JSON.stringify(right)}.`,
    });
  }

  return divergences;
}

/** 1-based index of the first character at which two strings differ. */
function firstDifference(first: string, second: string): number {
  const length = Math.min(first.length, second.length);
  for (let index = 0; index < length; index++) {
    if (first[index] !== second[index]) return index + 1;
  }
  return length + 1;
}

/** What one trip through the pipeline produced. */
export type RoundTrip = {
  /** The export the trip started from. */
  first: string;
  /** The export written from the rows the first one was read back as. */
  second: string;
  /** Those rows — what an `importGedcom` of `first` would have written. */
  rows: ImportRows;
  /** The mapping they came from, for its `issues`. */
  mapping: GedcomMapping;
  /**
   * Why the two exports are not the same file. Empty when they are, which is
   * the property this whole module exists to check.
   */
  divergences: GedcomDivergence[];
};

/**
 * Export a tree, import it, and export it again.
 *
 * @param tree rows as the three tables hold them, in any order
 */
export function roundTrip(tree: GedcomExportInput): RoundTrip {
  const first = writeGedcom(tree);
  const mapping = mapGedcom(parseGedcomText(first));
  const rows = rowsFromMapping(mapping);
  const second = writeGedcom(rows);

  return {
    first,
    second,
    rows,
    mapping,
    divergences: diffGedcom(first, second),
  };
}

/**
 * The same trip, starting from a file rather than from rows.
 *
 * The file is imported first, and `first` is the export of *that* — so the
 * narrowing a first export does has already happened by the time the two
 * compared texts exist, which is what makes a dirty third-party file a fair
 * subject for a byte comparison. See the module docblock.
 *
 * @param text a GEDCOM file, however dirty
 */
export function roundTripFile(text: string): RoundTrip & {
  /** The mapping of the original file, for the issues it reported. */
  imported: GedcomMapping;
} {
  const imported = mapGedcom(parseGedcomText(text));

  return { ...roundTrip(rowsFromMapping(imported)), imported };
}

/**
 * The same trip again, starting from the bytes rather than from decoded text.
 *
 * `roundTripFile` takes a string, which quietly assumes somebody already knew
 * the file's character set. For a file written here that assumption is free.
 * For a real third-party one it is the whole problem: `TGC55C.ged` is ANSEL,
 * and decoding ANSEL as UTF-8 does not fail — it succeeds, and produces
 * mojibake. A round trip run on the mojibake would be a perfectly stable
 * fixed point over the wrong text, which is the one way this test can pass
 * and mean nothing.
 *
 * So the fixture that most needs the round trip is the one `roundTripFile`
 * cannot be handed, and this entry point starts a step earlier — at
 * `parseGedcom`, which chooses the encoding from the byte order mark, the
 * `HEAD.CHAR` line and the bytes themselves, exactly as an upload does. The
 * parsed file comes back with the trip so a test can assert *which* encoding
 * was chosen rather than take the round trip's word that it was the right
 * one.
 *
 * @param bytes a GEDCOM file as it sits on disk, in whatever character set
 */
export function roundTripBytes(bytes: Uint8Array): RoundTrip & {
  /** The file as parsed, for its encoding, its issues and its unknown tags. */
  parsed: GedcomFile;
  /** The mapping of the original file, for the issues it reported. */
  imported: GedcomMapping;
} {
  const parsed = parseGedcom(bytes);
  const imported = mapGedcom(parsed);

  return { ...roundTrip(rowsFromMapping(imported)), parsed, imported };
}
