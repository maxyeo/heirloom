import type { GedcomIssue } from "./gedcom-report";

/**
 * GEDCOM's grammar: text in, a tree of tagged nodes out (E6-T1, `YEO-46`).
 *
 * ## The whole of the format, in four lines
 *
 * GEDCOM has almost no syntax. Every line is a level number, an optional
 * cross-reference identifier, a tag, and an optional value:
 *
 * ```
 * 0 @I1@ INDI
 * 1 NAME John /Smith/
 * 1 BIRT
 * 2 DATE 12 MAR 1890
 * ```
 *
 * The level number is the entire structure: a line at level *n* is a child of
 * the most recent line at level *n − 1*. That is it. Everything else — what
 * `INDI` means, which tags may appear inside it — is vocabulary layered on
 * top, and this module deliberately knows none of it. It turns text into a
 * tree and stops, which is what lets `lib/gedcom.ts` above it be a set of
 * statements about tags rather than a state machine that is also doing string
 * handling.
 *
 * ## CONT and CONC, the two tags this layer does know
 *
 * They are the exception, because they are grammar rather than vocabulary: a
 * value too long for one line, or one containing a newline, is split across
 * several. They are not two spellings of the same thing.
 *
 * - **`CONC`** — concatenate. The value continues with **no separator**.
 *   Writers break at a fixed column, often mid-word, so inserting a space
 *   here puts one inside somebody's surname.
 * - **`CONT`** — continue. The value continues **on a new line**, so joining
 *   restores a newline that was in the original text.
 *
 * Getting these the wrong way round is the classic GEDCOM bug and it is
 * invisible in the common case, because most continued values are prose where
 * a stray space reads as a typo rather than as corruption. They are folded
 * here, into the value of the line they continue, so nothing downstream can
 * encounter one and have to decide again.
 *
 * ## Line endings
 *
 * `\r\n`, `\n` and a bare `\r` all split. The first two because GEDCOM files
 * come from Windows programs at least as often as not, and the third for free
 * — it costs one alternative in the pattern and covers files exported by
 * classic Mac OS software, which is the same vintage as the ANSEL files this
 * import exists for.
 */

/** One node of the tree: a tag, what it said, and what was nested inside it. */
export type GedcomNode = {
  /**
   * The cross-reference this record defines, with the `@` delimiters removed
   * — `I1`, not `@I1@`. Only level-0 records have one.
   *
   * Stripped because the delimiters are punctuation, not part of the name: two
   * files that disagree about them describe the same person, and a consumer
   * comparing a `HUSB` pointer against a record identifier should not have to
   * remember which side kept the `@`. Writing them back is one template
   * literal on the export side (E7-T1, `YEO-51`).
   */
  xref: string | null;
  tag: string;
  /**
   * Everything after the tag, with `CONT`/`CONC` continuations already folded
   * in, or `null` when the line had no value at all.
   *
   * `null` rather than `""` because the difference is real: `1 BIRT` says a
   * birth is recorded and nothing about it is, whereas `1 NOTE` followed by an
   * empty value says somebody left the note blank. Untrimmed, because at this
   * level there is no way to know whether a trailing space is noise or part of
   * a continued value — trimming belongs where the tag's meaning is known.
   */
  value: string | null;
  /** 1-based line number in the file, for the import report. */
  line: number;
  children: GedcomNode[];
};

export type GedcomTree = {
  /** The level-0 records, in file order. */
  records: GedcomNode[];
  issues: GedcomIssue[];
};

/**
 * `0 @I1@ INDI Some value`.
 *
 * Leading whitespace is tolerated even though the specification forbids it,
 * because hand-edited files have it and refusing the whole line over an indent
 * would lose a record for a reason no author would consider a reason.
 *
 * The value is captured after exactly **one** space, so a second space is part
 * of the value rather than something the pattern eats.
 */
const LINE = /^\s*(\d+)\s+(?:@([^@\s]+)@\s+)?([A-Za-z0-9_]+)(?: (.*))?$/;

/** `@I1@` used as a value — a pointer to a record defined elsewhere. */
const POINTER = /^@([^@\s]+)@$/;

/**
 * Read a whole file into a tree of records.
 *
 * Total: any text produces a tree, and nothing throws. Text that is not GEDCOM
 * at all yields no records and one issue per line, which is precisely what an
 * import preview needs in order to say "this does not look like a GEDCOM file"
 * rather than crashing on somebody's holiday photo.
 *
 * @param text the decoded file — see `lib/gedcom-encoding.ts` for how bytes
 *   become this
 */
export function readGedcomTree(text: string): GedcomTree {
  const records: GedcomNode[] = [];
  const issues: GedcomIssue[] = [];

  // A byte order mark survives decoding as a zero-width character, and it sits
  // exactly where the first level number has to be. Stripping it here as well
  // as in the decoder covers `parseGedcomText`, which is handed a string that
  // never went through the decoder at all.
  const body = text.replace(/^﻿/, "");

  // `stack[level]` is the most recent node at that level, which is the parent
  // for the next line one deeper. This is the entire structural algorithm.
  const stack: GedcomNode[] = [];

  const lines = body.split(/\r\n|\r|\n/);

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;

    // Blank lines are not legal GEDCOM and are in almost every file — a
    // trailing newline produces one on its own. Reporting them would fill the
    // import report with a problem nobody has.
    if (raw.trim() === "") continue;

    const match = LINE.exec(raw);
    if (match === null) {
      issues.push({
        kind: "line",
        line,
        message: `This is not a GEDCOM line and was skipped: ${quote(raw)}`,
      });
      continue;
    }

    const [, levelText, xref, tag, value] = match;
    const level = Number(levelText);

    if (level === 0) {
      const record: GedcomNode = {
        xref: xref ?? null,
        tag,
        value: value ?? null,
        line,
        children: [],
      };
      records.push(record);
      stack.length = 0;
      stack[0] = record;
      continue;
    }

    const parent = stack[level - 1] as GedcomNode | undefined;
    if (parent === undefined) {
      // A level that skips one — `0 INDI` followed by `2 DATE` — has no parent
      // to attach to, and guessing one would silently reparent the line onto
      // whatever came before. Skipping and saying so is the honest answer.
      issues.push({
        kind: "line",
        line,
        message: `Level ${level} has no level ${level - 1} above it, so this line was skipped: ${quote(raw)}`,
      });
      continue;
    }

    if (tag === "CONT" || tag === "CONC") {
      parent.value = continueValue(parent.value, tag, value ?? "");
      // Truncating rather than leaving a stale entry: a continuation has no
      // children, so anything nested under one is malformed and should be
      // reported as such rather than quietly attached to the line above.
      stack.length = level;
      continue;
    }

    const node: GedcomNode = {
      xref: xref ?? null,
      tag,
      value: value ?? null,
      line,
      children: [],
    };
    parent.children.push(node);
    stack.length = level;
    stack[level] = node;
  }

  return { records, issues };
}

/**
 * Read a value that is a pointer to another record.
 *
 * Returns the bare identifier, or `null` when the value is not a pointer at
 * all — which is a real case rather than a defensive one: `1 HUSB` with no
 * value, or a file that writes a name where a pointer belongs. The caller
 * turns `null` into an issue against the tag it was expecting.
 */
export function readPointer(value: string | null): string | null {
  if (value === null) return null;

  const match = POINTER.exec(value.trim());
  return match === null ? null : match[1];
}

/** Fold one continuation line into the value it continues. */
function continueValue(
  current: string | null,
  tag: "CONT" | "CONC",
  addition: string,
): string {
  // A continuation of nothing still produces a value: `1 NOTE` with a `2 CONT`
  // under it means an empty first line followed by a second one.
  const base = current ?? "";
  return tag === "CONT" ? `${base}\n${addition}` : base + addition;
}

/** A line, shortened and quoted, for a message a person has to read. */
function quote(raw: string): string {
  const trimmed = raw.trim();
  const shortened = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
  return `"${shortened}"`;
}
