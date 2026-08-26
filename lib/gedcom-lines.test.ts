import { describe, expect, it } from "vitest";

import { readGedcomTree } from "@/lib/gedcom-lines";

/**
 * GEDCOM's grammar (E6-T1, `YEO-46`).
 *
 * Written against strings rather than fixture files on purpose: this layer
 * knows nothing about `INDI` or `BIRT`, so the cases that matter are shapes of
 * text — a level that skips, a continuation of an empty value, a line ending
 * from another decade — and each reads best as the four lines that produce it.
 * The fixture files earn their place a layer up, in `lib/gedcom.test.ts`,
 * where a whole file is the unit under test.
 */

/** The records of a file, with the issues asserted to be empty. */
function tree(text: string) {
  const result = readGedcomTree(text);
  expect(result.issues).toEqual([]);
  return result.records;
}

/** The one child line of a one-record file, for the node it becomes. */
function only(line: string) {
  const [record] = tree(["0 @X1@ REC", line].join("\n"));
  return record.children[0];
}

describe("levels build the tree", () => {
  it("nests each line under the most recent line one level above", () => {
    const [record] = tree(
      ["0 @I1@ INDI", "1 BIRT", "2 DATE 1890", "2 PLAC Whitby"].join("\n"),
    );

    expect(record.tag).toBe("INDI");
    expect(record.children).toHaveLength(1);

    const [birth] = record.children;
    expect(birth.tag).toBe("BIRT");
    expect(birth.value).toBeNull();
    expect(birth.children.map((child) => [child.tag, child.value])).toEqual([
      ["DATE", "1890"],
      ["PLAC", "Whitby"],
    ]);
  });

  it("returns to an outer level correctly", () => {
    const [record] = tree(
      ["0 @I1@ INDI", "1 BIRT", "2 DATE 1890", "1 SEX M"].join("\n"),
    );

    // SEX is a sibling of BIRT, not a child of it — the whole of what the
    // level numbers mean.
    expect(record.children.map((child) => child.tag)).toEqual(["BIRT", "SEX"]);
  });

  it("starts a new record at level 0", () => {
    const records = tree(["0 @I1@ INDI", "0 @I2@ INDI", "0 TRLR"].join("\n"));

    expect(records.map((record) => record.tag)).toEqual([
      "INDI",
      "INDI",
      "TRLR",
    ]);
  });
});

describe("cross-references", () => {
  it("strips the @ delimiters from a record identifier", () => {
    const [record] = tree("0 @I1@ INDI");
    expect(record.xref).toBe("I1");
  });

  it("leaves a record with no identifier as null", () => {
    const [record] = tree("0 HEAD");
    expect(record.xref).toBeNull();
  });

  it("reads a pointer value back the same way", () => {
    expect(only("1 HUSB @F1@").pointer).toBe("F1");
    expect(only("1 HUSB  @F1@ ").pointer).toBe("F1");
  });

  it("refuses a value that is not a pointer", () => {
    // The caller turns this into an issue naming the tag that expected one.
    expect(only("1 HUSB F1").pointer).toBeNull();
    expect(only("1 HUSB @F1").pointer).toBeNull();
    expect(only("1 HUSB Mary Byrne").pointer).toBeNull();
    expect(only("1 HUSB").pointer).toBeNull();
  });

  it("leaves the pointer null on a line that is not one", () => {
    // Every node carries the field, and on the overwhelming majority of them
    // — a `SURN`, a `DATE`, a record's own `0` line — the answer is no.
    const [record] = tree("0 @I1@ INDI\n1 SURN Byrne");

    expect(record.pointer).toBeNull();
    expect(record.children[0].pointer).toBeNull();
  });
});

describe("line endings", () => {
  const lines = ["0 @I1@ INDI", "1 SEX M"];

  it.each([
    ["\n", "Unix"],
    ["\r\n", "Windows"],
    ["\r", "classic Mac"],
  ])("splits on %j (%s)", (ending) => {
    const [record] = tree(lines.join(ending));

    expect(record.tag).toBe("INDI");
    // The value must not keep a stray carriage return, which is the failure
    // that survives every other assertion: "M\r" is still truthy, still a
    // string, and matches nothing.
    expect(record.children[0].value).toBe("M");
  });

  it("ignores a trailing newline", () => {
    expect(tree("0 @I1@ INDI\n")).toHaveLength(1);
  });

  it("ignores blank lines in the middle of a file", () => {
    const [record] = tree("0 @I1@ INDI\n\n1 SEX M\n\n");
    expect(record.children).toHaveLength(1);
  });
});

describe("CONC joins with no separator", () => {
  it("continues a value mid-word", () => {
    // Writers break at a fixed column, so a space inserted here lands inside
    // somebody's surname.
    const [record] = tree(
      ["0 @I1@ INDI", "1 NAME Feather", "2 CONC stonehaugh"].join("\n"),
    );

    expect(record.children[0].value).toBe("Featherstonehaugh");
  });

  it("keeps a leading space that belongs to the continuation", () => {
    const [record] = tree(
      ["0 @I1@ INDI", "1 NOTE the coast,", "2 CONC  and the moors"].join("\n"),
    );

    expect(record.children[0].value).toBe("the coast, and the moors");
  });

  it("chains several", () => {
    const [record] = tree(
      ["0 @I1@ INDI", "1 NAME a", "2 CONC b", "2 CONC c"].join("\n"),
    );

    expect(record.children[0].value).toBe("abc");
  });
});

describe("CONT joins with a newline", () => {
  it("restores a line break that was in the original text", () => {
    const [record] = tree(
      ["0 @I1@ INDI", "1 NOTE first line", "2 CONT second line"].join("\n"),
    );

    expect(record.children[0].value).toBe("first line\nsecond line");
  });

  it("is not the same as CONC", () => {
    const conc = tree(["0 X", "1 A one", "2 CONC two"].join("\n"));
    const cont = tree(["0 X", "1 A one", "2 CONT two"].join("\n"));

    // The classic GEDCOM bug is these two being treated alike.
    expect(conc[0].children[0].value).toBe("onetwo");
    expect(cont[0].children[0].value).toBe("one\ntwo");
  });

  it("continues a value that started empty", () => {
    const [record] = tree(["0 @I1@ INDI", "1 NOTE", "2 CONT text"].join("\n"));

    // `1 NOTE` with nothing after it is an empty first line, so the value is a
    // newline and then the continuation — not just "text".
    expect(record.children[0].value).toBe("\ntext");
  });

  it("adds an empty line for a CONT with no value", () => {
    const [record] = tree(
      ["0 X", "1 A one", "2 CONT", "2 CONT two"].join("\n"),
    );

    expect(record.children[0].value).toBe("one\n\ntwo");
  });

  it("mixes with CONC in one value", () => {
    const [record] = tree(
      ["0 X", "1 A one", "2 CONT two", "2 CONC three"].join("\n"),
    );

    expect(record.children[0].value).toBe("one\ntwothree");
  });

  it("does not appear as a child of its own", () => {
    const [record] = tree(["0 X", "1 A one", "2 CONT two"].join("\n"));

    // Folded into the value, so nothing above this layer can encounter a CONT
    // and have to decide what it means a second time.
    expect(record.children[0].children).toEqual([]);
  });
});

describe("values", () => {
  it("keeps everything after the first space", () => {
    const [record] = tree("0 X\n1 PLAC Whitby, Yorkshire, England");
    expect(record.children[0].value).toBe("Whitby, Yorkshire, England");
  });

  it("keeps a second space rather than eating it", () => {
    const [record] = tree("0 X\n1 A  indented");
    expect(record.children[0].value).toBe(" indented");
  });

  it("distinguishes no value from an empty one", () => {
    const [record] = tree("0 X\n1 A\n1 B ");

    // `1 A` records that A is present and says nothing; `1 B ` says B is
    // blank. Collapsing the two would lose a real distinction.
    expect(record.children[0].value).toBeNull();
    expect(record.children[1].value).toBe("");
  });
});

/**
 * The `@` escape (`YEO-105`).
 *
 * `@` is the format's only metacharacter and a literal one inside a value is
 * written doubled, so `O@@Brien` is the name `O@Brien`. This layer had never
 * undone it, which meant the doubled spelling went into the database and onto
 * the screen — and the round trip could not see it, because the export had
 * never put the doubling back either and two absences cancel.
 *
 * Most of these cases are about *order*, which is the only hard thing here:
 * the escape applies to a value, after the line's structure has been taken off
 * and after the continuations have been folded in. Either one done the other
 * way round is a different bug rather than a missing feature.
 */
describe("the @ escape", () => {
  it("reads a doubled @ as the single one it spells", () => {
    expect(only("1 SURN O@@Brien").value).toBe("O@Brien");
  });

  it("undoes every occurrence rather than the first", () => {
    expect(only("1 NAME @@a@@b@@").value).toBe("@a@b@");
  });

  it("reads @@@@ as the two characters it escapes", () => {
    // Left to right and non-overlapping: an escaped `@@` is four characters
    // in the file and two in the value, not one.
    expect(only("1 NAME a@@@@b").value).toBe("a@@b");
  });

  it("leaves a lone @ as it found it", () => {
    // No conforming writer emits one, and real files are full of them —
    // unescaped email addresses most of all. This layer reports lines it
    // cannot parse, and this is not one of them.
    expect(only("1 NAME nobody@example.com").value).toBe("nobody@example.com");
  });

  it("leaves the delimiters around a record identifier alone", () => {
    // The unescaping runs on the value, and a record's identifier is not one:
    // `0 @I1@ INDI` still names `I1`, and the `@`s are gone as punctuation
    // rather than reduced as an escape.
    const [record] = tree("0 @I1@ INDI");

    expect(record.xref).toBe("I1");
    expect(record.value).toBeNull();
  });

  it("does not let an escaped @ invent a cross-reference", () => {
    // The hazard the ordering exists for. `@@I1@@` is the *text* `@I1@`, and
    // a reader that unescaped before asking would find in it a pointer to a
    // record the file never mentioned.
    const husband = only("1 HUSB @@I1@@");

    expect(husband.pointer).toBeNull();
    expect(husband.value).toBe("@I1@");
  });

  it("does not let a padded escaped @ invent one either", () => {
    // The same hazard through the one other thing `readPointer` does. It
    // trims, because `1 HUSB  @F1@ ` is a real pointer somebody's writer
    // padded — so padding on its own is never what makes a value not a
    // pointer, and this combination rests entirely on the question being
    // asked before the unescaping rather than after it.
    //
    // The value keeps its spaces while the pointer ignores them, which is the
    // asymmetry worth pinning: trimming a value belongs a layer up, where the
    // tag's meaning is known and a trailing space might be somebody's data.
    const husband = only("1 HUSB  @@F1@@ ");

    expect(husband.pointer).toBeNull();
    expect(husband.value).toBe(" @F1@ ");
  });

  it("still reads a real pointer, whose @s are delimiters", () => {
    const husband = only("1 HUSB @I1@");

    expect(husband.pointer).toBe("I1");
    expect(husband.value).toBe("@I1@");
  });

  it("undoes a @@ that CONC split down the middle", () => {
    // The second hazard: two characters that are one escape, and a writer
    // breaking at a fixed column may break between them. A replacement
    // applied per physical line sees two lone `@`s and undoes neither.
    const [record] = tree(
      ["0 @I1@ INDI", "1 SURN O@", "2 CONC @Brien"].join("\n"),
    );

    expect(record.children[0].value).toBe("O@Brien");
  });

  it("does not join two @s that CONT put on separate lines", () => {
    // The same two characters with a line break between them are not an
    // escape at all, and the difference is the whole reason `CONT` and `CONC`
    // are folded before this runs rather than after.
    const [record] = tree(
      ["0 @I1@ INDI", "1 NAME O@", "2 CONT @Brien"].join("\n"),
    );

    expect(record.children[0].value).toBe("O@\n@Brien");
  });
});

describe("what it reports rather than guesses", () => {
  it("skips a line that is not a GEDCOM line, and says which", () => {
    const { records, issues } = readGedcomTree(
      ["0 @I1@ INDI", "this is not GEDCOM", "1 SEX M"].join("\n"),
    );

    expect(records[0].children.map((child) => child.tag)).toEqual(["SEX"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "line", line: 2 });
    expect(issues[0].message).toContain("this is not GEDCOM");
  });

  it("skips a level that has no parent", () => {
    const { records, issues } = readGedcomTree(
      ["0 @I1@ INDI", "2 DATE 1890"].join("\n"),
    );

    // Attaching it to INDI anyway would silently reparent the line and change
    // what the file says.
    expect(records[0].children).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "line", line: 2 });
  });

  it("reports a line nested under a continuation", () => {
    const { issues } = readGedcomTree(
      ["0 X", "1 A one", "2 CONT two", "3 B three"].join("\n"),
    );

    // A continuation has no children, so this is malformed rather than
    // something to quietly attach to the line above.
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(4);
  });

  it("shortens a very long line in the message it quotes", () => {
    const { issues } = readGedcomTree("x".repeat(500));
    expect(issues[0].message.length).toBeLessThan(120);
  });

  it("produces nothing but issues for text that is not GEDCOM at all", () => {
    const { records, issues } = readGedcomTree("hello\nworld");

    expect(records).toEqual([]);
    expect(issues).toHaveLength(2);
  });
});

describe("tolerances", () => {
  it("accepts leading whitespace the specification forbids", () => {
    // Hand-edited files have it, and losing a record over an indent is a
    // trade no author would make.
    const [record] = tree("0 @I1@ INDI\n  1 SEX M");
    expect(record.children[0].tag).toBe("SEX");
  });

  it("accepts a vendor tag with an underscore", () => {
    const [record] = tree("0 @I1@ INDI\n1 _UID 8F3C");
    expect(record.children[0].tag).toBe("_UID");
  });

  it("strips a byte order mark left in the text", () => {
    const [record] = tree("﻿0 @I1@ INDI");
    expect(record.tag).toBe("INDI");
  });
});

describe("line numbers", () => {
  it("counts from one, including lines it skipped", () => {
    const [record] = tree(["0 @I1@ INDI", "", "1 SEX M"].join("\n"));

    // The number has to be the number in the file, or the report sends people
    // to the wrong line.
    expect(record.line).toBe(1);
    expect(record.children[0].line).toBe(3);
  });
});
