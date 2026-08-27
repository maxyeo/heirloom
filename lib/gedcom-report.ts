import { compareIds } from "./compare-ids";

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
 * half, and it was deliberately written before its consumer existed — E6-T5
 * (`YEO-50`) is the import report, and it should be assembling a screen out of
 * these values rather than asking the parser to be rewritten to produce them.
 *
 * ## What E6-T5 changed here anyway, and why that is not a contradiction
 *
 * The report was assembled out of these values, and one thing it could not
 * assemble was *who is missing from the tree*. `value` had come to mean two
 * unrelated things — a fact with nowhere to put it, and a whole record left
 * out — so the only way to count the second was to match on the wording of a
 * sentence written for a human to read. That is precisely what the paragraph
 * below forbids: the set is closed "so the report can group and count …
 * without matching on sentences", and on this question it was not doing that
 * job.
 *
 * So `skipped` was split out of `value` for the same reason `narrowed` was
 * split out of `date`, by the same argument, and the change is to the
 * *mapper* rather than the parser — `lib/gedcom-map.ts` is where a record is
 * refused, and it was already reporting every one of them. What it was not
 * doing was saying so in a word the report could count, or naming the record
 * in anything but prose.
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
 * - `narrowed` — a `DATE` this application read, but not everything beside
 *   it: a modifier on a range endpoint, an upper bound it could not read, an
 *   `INT` phrase (`YEO-88`). The field is left **populated**, with something
 *   true and slightly poorer than the file said. Kept apart from `date` on
 *   purpose — the two are opposite outcomes for the person reading the
 *   report, one says "go and fix this file" and the other says "nothing to
 *   fix", and a report cannot answer "how many dates did this import fail to
 *   read" if they share a kind. Never fatal, by construction; there is no
 *   separate severity field because the kind already carries the
 *   distinction. Note that the ordinary range forms — `BET x AND y`, `FROM x
 *   TO y` — do **not** raise this, because both of their bounds are stored.
 * - `pointer` — an `@Xref@` naming a record that is not in the file, or two
 *   halves of one edge that disagree about whether it exists.
 * - `value` — a value in a place that has a fixed vocabulary (`SEX`) that is
 *   not one of the words, or a fact this schema has no column for at all.
 * - `skipped` — **this application refused a record or a link**, so it is not
 *   in the tree: a person `validateIndividual` would not have, a family with
 *   nobody in it, a `CHIL` naming somebody who was themselves refused. Raised
 *   only by `lib/gedcom-map.ts`, which is the module where what goes into the
 *   tree is decided; the parser never decides that, so it never raises one.
 *   It is the one kind that carries a {@link GedcomRecordRef}, and the type
 *   insists on it.
 * - `encoding` — the file's declared character set is absent, unsupported, or
 *   contradicted by its own bytes.
 */
export type GedcomIssueKind =
  "line" | "date" | "narrowed" | "pointer" | "value" | "skipped" | "encoding";

/**
 * The record a skip is about, in the file's own terms.
 *
 * "Each skip names the GEDCOM record and the reason" is an acceptance
 * criterion of E6-T5, and this is the half a sentence cannot carry. The
 * reason is prose written for a person; the record has to be a value, because
 * a report that grouped skips or a reader who wanted to find one in the file
 * would otherwise have to parse English.
 */
export type GedcomRecordRef = {
  /**
   * Where in the file's grammar it sits: `INDI` and `FAM` for whole records,
   * `FAM.HUSB`, `FAM.WIFE` and `FAM.CHIL` for a link off one.
   *
   * A link rather than a record is still worth a skip of its own. The family
   * survives losing a partner and the tree is quietly wrong about who was in
   * it, which is exactly the failure this ticket exists to make visible.
   */
  tag: GedcomRecordTag;
  /**
   * The `@I5@` identifier of the thing that was left out — the person, the
   * family, the child a `CHIL` named — or `null` when the file gave it none.
   *
   * Not the identifier of the record it was written *inside*: a `FAM.CHIL`
   * skip names the child, because the child is who is missing. Where the
   * containing record matters to the sentence, the sentence says so.
   */
  xref: string | null;
  /**
   * How the file names it — a person's `NAME` as written — so a reader
   * recognises it without going and looking. `null` when the file offers
   * nothing to call it by, which a family always does and an `INDI` with no
   * `NAME` does too.
   */
  label: string | null;
};

/** The places a {@link GedcomRecordRef} can point at. */
export type GedcomRecordTag =
  "INDI" | "FAM" | "FAM.HUSB" | "FAM.WIFE" | "FAM.CHIL";

/**
 * One specific place where the imported tree will differ from the file.
 *
 * A union rather than one object with an optional `record`, so that "every
 * skip names a record" is checked by the compiler rather than asserted in a
 * test and hoped for at the call sites. A `date` issue is about a line and
 * has no record to name; a `skipped` issue is about a record by definition,
 * and the day somebody adds a sixth place that skips something, leaving the
 * record off will not compile.
 */
export type GedcomIssue = GedcomLineIssue | GedcomSkip;

/** Everything except a skip: a place in the file, and what was wrong with it. */
export type GedcomLineIssue = {
  kind: Exclude<GedcomIssueKind, "skipped">;
  line: number;
  message: string;
};

/** A record or link the file asserted that is not in the imported tree. */
export type GedcomSkip = {
  kind: "skipped";
  line: number;
  message: string;
  /** What was left out. Required — see {@link GedcomIssue}. */
  record: GedcomRecordRef;
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
 * runs over the same file — and the path breaks that tie by code unit
 * (`YEO-116`), not by `localeCompare`. It is a GEDCOM tag path (`INDI.SOUR`,
 * `FAM.MARR.SOUR`), a machine identifier `components/GedcomImport.tsx` renders
 * inside `<code>`, not text read as an alphabet — the same distinction
 * `docs/gedcom.md` already draws for the exporter's own string comparisons,
 * and the same rule reaching a second GEDCOM-pipeline module.
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
    (a, b) => b.count - a.count || compareIds(a.path, b.path),
  );
}
