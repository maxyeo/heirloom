/**
 * What the GEDCOM parser could not use, in the shape a person can read
 * (E6-T1, `YEO-46`).
 *
 * ## The rule this exists to enforce
 *
 * **Nothing a real file contains is dropped in silence.** Real GEDCOM files
 * are dirty — thirty years of desktop programs each inventing their own tags,
 * dates typed by hand into a field that was never validated, files that
 * declare one character set and are written in another. A parser that quietly
 * keeps the parts it recognises and discards the rest looks like it worked.
 * The tree comes out smaller than the one that went in and nobody can say
 * which branch went missing.
 *
 * So every module in the GEDCOM pipeline answers with two things: what it
 * understood, and what it did not. This file is the vocabulary for the second
 * half, and it is deliberately written before its consumer exists — E6-T5
 * (`YEO-50`) is the import report, and it should be assembling a screen out of
 * these values rather than asking the parser to be rewritten to produce them.
 *
 * ## Why unknown tags and issues are two different lists
 *
 * They mean different things to whoever reads the report.
 *
 * An **unknown tag** is not an error. `SOUR`, `NOTE`, `OBJE`, `_UID` and a
 * hundred vendor extensions are perfectly valid GEDCOM that this application
 * has nowhere to put — the answer is "we imported the people and left the
 * source citations behind", which is a scope statement, not a fault. Counting
 * them tells an author how much of their file this application is ignoring.
 *
 * An **issue** is something that was meant to be understood and could not be:
 * a date nobody can read, a pointer to a family that is not in the file, a
 * line that is not a GEDCOM line at all. Each one is a specific place where
 * the imported tree will differ from the file, and each one has a line number
 * so the author can go and look.
 *
 * Collapsing the two into one list would bury the second in the first. A file
 * with 4,000 `SOUR` tags and one unreadable birth date would report 4,001
 * problems, and the one that mattered would be on page forty.
 */

/**
 * A tag this parser has no meaning for, and how often it appeared.
 *
 * Aggregated rather than listed per occurrence, because the per-occurrence
 * list is unbounded in exactly the cases where it is least useful: a 50,000
 * line file from a program that stamps `_UID` on every record produces 20,000
 * identical entries, and no report renders that. A count plus the first line
 * number is what a person actually acts on — "1,842 `SOUR` tags, first at line
 * 91" tells them both how much they are leaving behind and where to go and
 * look at an example.
 */
export type GedcomUnknownTag = {
  /**
   * Where the tag sits, as a dotted path from its record: `INDI.SOUR`,
   * `FAM.MARR.SOUR`, `HEAD.GEDC`.
   *
   * The path rather than the bare tag, because the same four letters mean
   * different things in different places and a report that merges them is
   * lying about both. `NOTE` under `INDI` is a note about a person; `NOTE`
   * under `FAM.MARR` is a note about a wedding. An author deciding whether
   * this import loses anything they care about needs to see which.
   */
  path: string;
  /** The tag itself — the last segment of `path`, for grouping and display. */
  tag: string;
  /** How many times it appeared in the file. */
  count: number;
  /** The line number of the first occurrence, so a person can go and look. */
  firstLine: number;
};

/**
 * The kinds of thing that can go wrong, as a closed set.
 *
 * A closed set rather than free text, so the report can group and count and a
 * future importer can decide which kinds are fatal without matching on
 * sentences. The `message` beside it stays the human half.
 *
 * - `line` — text that is not a GEDCOM line, or a level number that skips.
 * - `date` — a `DATE` value this application's date grammar cannot read at
 *   all, so the field is left **blank**.
 * - `narrowed` — a `DATE` value this application *could* read, but only by
 *   dropping something: a range's upper bound, an `INT` phrase (`YEO-88`).
 *   The field is left **populated**, with something true but weaker than the
 *   file said. Kept apart from `date` on purpose — the two are opposite
 *   outcomes for the person reading the report, one says "go and fix this
 *   file" and the other says "nothing to fix", and a report cannot answer
 *   "how many dates did this import fail to read" if they share a kind.
 *   `narrowed` is never fatal, by construction; there is no separate
 *   severity field because the kind already carries that distinction.
 * - `pointer` — an `@Xref@` naming a record that is not in the file.
 * - `value` — a value in a place that has a fixed vocabulary (`SEX`) that is
 *   not one of the words.
 * - `encoding` — the file's declared character set is absent, unsupported, or
 *   contradicted by its own bytes.
 */
export type GedcomIssueKind =
  "line" | "date" | "narrowed" | "pointer" | "value" | "encoding";

/** One specific place where the imported tree will differ from the file. */
export type GedcomIssue = {
  kind: GedcomIssueKind;
  /**
   * The line it happened on, 1-based, or `0` for something that is true of the
   * file as a whole rather than of any one line — an encoding decision, which
   * is made before there are lines to number.
   */
  line: number;
  /**
   * A sentence a person can act on, naming the value that caused it.
   *
   * Written for the author of the file, not for us: "12/03/1890 could mean
   * March or December" rather than "parse error at DATE". The parser has the
   * offending text in hand at the moment it fails and the report does not, so
   * quoting it here is the only chance to.
   */
  message: string;
};

/**
 * Roll a list of unknown-tag sightings up into one row per path.
 *
 * Separate from the walk that produces the sightings so that the walk can stay
 * a straight recursion that appends, rather than carrying a map and a
 * first-seen rule through every branch.
 *
 * Ordered by count descending, then by path, so the report's first rows are
 * the ones that describe most of what is being left behind. Ties break on the
 * path rather than on encounter order, because a stable order is what lets a
 * test assert the whole array and what stops a report reshuffling between two
 * runs over the same file.
 */
export function summariseUnknownTags(
  sightings: ReadonlyArray<{ path: string; line: number }>,
): GedcomUnknownTag[] {
  const byPath = new Map<string, GedcomUnknownTag>();

  for (const { path, line } of sightings) {
    const seen = byPath.get(path);
    if (seen === undefined) {
      const segments = path.split(".");
      byPath.set(path, {
        path,
        tag: segments[segments.length - 1],
        count: 1,
        firstLine: line,
      });
      continue;
    }

    seen.count += 1;
    // Not `Math.min`: the walk is in file order, so the first sighting is
    // already the earliest. Keeping it explicit rather than recomputing says
    // that the order is the guarantee being relied on.
    if (line < seen.firstLine) seen.firstLine = line;
  }

  return [...byPath.values()].sort(
    (a, b) => b.count - a.count || a.path.localeCompare(b.path),
  );
}
