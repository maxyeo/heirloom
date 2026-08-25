import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseGedcom,
  parseGedcomText,
  type GedcomFile,
  type GedcomIndividual,
} from "@/lib/gedcom";

/**
 * The GEDCOM parser (E6-T1, `YEO-46`).
 *
 * This file is the ticket's acceptance criteria written as assertions, and it
 * needs no database to make them — which is the property the ticket is
 * actually about. `lib/gedcom.purity.test.ts` beside it proves that separately
 * and statically; this one exercises the behaviour.
 *
 * Fixture files rather than inline strings for the cases where **the file is
 * the unit under test**: a real `.ged` with a header, a trailer, records that
 * point at each other and tags we do not support. Inline strings for the
 * malformed cases, where four lines say more than a file would and where
 * keeping the broken input next to the assertion is the whole point.
 */

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(
      fileURLToPath(
        new URL(`../test/fixtures/gedcom/${name}`, import.meta.url),
      ),
    ),
  );
}

/** Parsed, with the issue list asserted empty so a regression cannot hide. */
function clean(file: GedcomFile): GedcomFile {
  expect(file.issues).toEqual([]);
  return file;
}

/** Unknown tags as a plain path-to-count map, which is what they mean. */
function unknownCounts(file: GedcomFile): Record<string, number> {
  return Object.fromEntries(
    file.unknownTags.map((entry) => [entry.path, entry.count]),
  );
}

function byXref(file: GedcomFile, xref: string): GedcomIndividual {
  const found = file.individuals.find((individual) => individual.xref === xref);
  if (found === undefined) throw new Error(`no individual ${xref}`);
  return found;
}

describe("a whole family, from a fixture file", () => {
  const file = clean(parseGedcom(fixture("family.ged")));

  it("reads every record", () => {
    expect(file.individuals).toHaveLength(5);
    expect(file.families).toHaveLength(2);
    expect(file.encoding).toBe("utf-8");
    expect(file.declaredEncoding).toBe("UTF-8");
  });

  it("splits a name on GEDCOM's surname slashes", () => {
    expect(byXref(file, "I1").names).toEqual([
      { full: "John Henry Smith", given: "John Henry", surname: "Smith" },
    ]);
  });

  it("reads the sexes, including one that is not recorded", () => {
    expect(byXref(file, "I1").sex).toBe("male");
    expect(byXref(file, "I2").sex).toBe("female");
    expect(byXref(file, "I5").sex).toBe("unknown");
  });

  it("reads a full date as a day", () => {
    expect(byXref(file, "I1").birth).toEqual({
      date: { date: "1890-03-12", qualifier: "exact", precision: "day" },
      dateText: "12 MAR 1890",
      place: "Whitby, Yorkshire, England",
    });
  });

  it("keeps a union's partners and children as pointers", () => {
    const [first] = file.families;

    expect(first).toMatchObject({
      xref: "F1",
      husband: "I1",
      wife: "I2",
      children: ["I3", "I4"],
    });
  });

  it("reads a marriage and a divorce", () => {
    const [, second] = file.families;

    expect(second.marriage?.date).toEqual({
      date: "1885-01-01",
      qualifier: "exact",
      precision: "year",
    });
    expect(second.divorce?.date).toEqual({
      date: "1889-01-01",
      qualifier: "exact",
      precision: "year",
    });
  });

  it("carries FAMS and FAMC rather than reporting them as ignored", () => {
    // Redundant with the FAM side, and kept anyway: reporting 240 of these as
    // unknown tags would put "we ignored 240 things" into a report where
    // nothing was lost, which is how a report loses its credibility.
    expect(byXref(file, "I2").familiesAsSpouse).toEqual(["F1", "F2"]);
    expect(byXref(file, "I3").familiesAsChild).toEqual(["F1"]);
    expect(unknownCounts(file)).not.toHaveProperty("INDI.FAMS");
  });

  it("collects the header tags it has nowhere to put", () => {
    expect(unknownCounts(file)).toEqual({ "HEAD.GEDC": 1, "HEAD.SOUR": 1 });
  });
});

describe("the date forms the ticket names", () => {
  const file = clean(parseGedcom(fixture("family.ged")));

  it("reads ABT as about", () => {
    expect(byXref(file, "I1").death?.date).toEqual({
      date: "1962-01-01",
      qualifier: "about",
      precision: "year",
    });
  });

  it("reads BEF as before", () => {
    expect(byXref(file, "I2").death?.date).toEqual({
      date: "1970-01-01",
      qualifier: "before",
      precision: "year",
    });
  });

  it("reads AFT as after", () => {
    expect(file.families[0].marriage?.date).toEqual({
      date: "1913-01-01",
      qualifier: "after",
      precision: "year",
    });
  });

  it("reads EST as about, which is the nearest the schema has", () => {
    // The `date_qualifier` enum has four members and GEDCOM's EST has no home
    // among them. "Estimated" and "about" both mean roughly, so the
    // distinction is worth less than the date.
    expect(byXref(file, "I4").birth?.date).toEqual({
      date: "1918-01-01",
      qualifier: "about",
      precision: "year",
    });
  });

  it("reads a month and year as a month", () => {
    expect(byXref(file, "I2").birth?.date).toEqual({
      date: "1893-03-01",
      qualifier: "exact",
      precision: "month",
    });
  });

  it("reads a bare year as a year", () => {
    // The anchor is 1 January and `precision` is what stops anything
    // downstream reading it as a birthday.
    expect(byXref(file, "I3").birth?.date).toEqual({
      date: "1915-01-01",
      qualifier: "exact",
      precision: "year",
    });
  });

  it("keeps the text it read every date from", () => {
    expect(byXref(file, "I4").birth?.dateText).toBe("EST 1918");
  });
});

describe("CRLF line endings and continuations, from a fixture file", () => {
  const file = parseGedcom(fixture("continuations-crlf.ged"));

  it("reads a file written with \\r\\n", () => {
    expect(file.individuals).toHaveLength(1);
    expect(file.individuals[0].sex).toBe("male");
  });

  it("prefers explicit GIVN and SURN over slash-splitting", () => {
    expect(file.individuals[0].names[0]).toEqual({
      full: "Bartholomew Featherstonehaugh",
      given: "Bartholomew",
      surname: "Featherstonehaugh",
    });
  });

  it("joins a CONC continuation with no separator", () => {
    // Split mid-word at "York|shire" by whichever program wrote the file. A
    // space inserted here would be inside the place name for good.
    expect(file.individuals[0].birth?.place).toBe(
      "Robin Hood's Bay, Whitby, North Riding of Yorkshire, England",
    );
  });

  it("collects the tags outside the subset", () => {
    expect(unknownCounts(file)).toEqual({
      "BIRT.SOUR": 1,
      "INDI.NOTE": 1,
      "INDI.OBJE": 1,
      "INDI._UID": 1,
      SOUR: 1,
    });
  });

  it("reports an unknown tag once, not once per line beneath it", () => {
    // OBJE has FILE and FORM inside it. They are part of the same unread
    // structure, and listing them separately would turn one honest row into
    // three that say the same thing.
    for (const entry of file.unknownTags) {
      expect(entry.path).not.toContain("OBJE.");
    }
  });

  it("says where to look for each one", () => {
    const uid = file.unknownTags.find((entry) => entry.tag === "_UID");
    expect(uid?.firstLine).toBe(16);
  });
});

describe("ANSEL and UTF-8, from a matched pair of fixture files", () => {
  const ansel = parseGedcom(fixture("accents-ansel.ged"));
  const utf8 = parseGedcom(fixture("accents-utf8.ged"));

  it("recognises each file's encoding", () => {
    expect(ansel.encoding).toBe("ansel");
    expect(ansel.declaredEncoding).toBe("ANSEL");
    expect(utf8.encoding).toBe("utf-8");
  });

  it("reads the same people out of both", () => {
    // The two fixtures hold identical content in two encodings, so this is
    // the assertion that makes the binary one reviewable: whatever it
    // contains, it has to mean what its readable twin means.
    expect(ansel.individuals).toEqual(utf8.individuals);
  });

  it("reads a mark that precedes its letter in ANSEL", () => {
    expect(ansel.individuals[0].names[0]).toEqual({
      full: "François Béranger",
      given: "François",
      surname: "Béranger",
    });
  });

  it("reads characters ANSEL gives a byte of their own", () => {
    expect(ansel.individuals[1].names[0].surname).toBe("Þórðardóttir");
  });

  it("reads accented places too", () => {
    expect(ansel.individuals[0].birth?.place).toBe("Besançon, France");
    expect(ansel.individuals[1].birth?.place).toBe("Reykjavík, Ísland");
  });
});

describe("names", () => {
  function nameOf(value: string) {
    return parseGedcomText(`0 @I1@ INDI\n1 NAME ${value}`).individuals[0]
      .names[0];
  }

  it("reads a name with no slashes as all given name", () => {
    expect(nameOf("Mary Ann")).toEqual({
      full: "Mary Ann",
      given: "Mary Ann",
      surname: null,
    });
  });

  it("reads a surname with no given name", () => {
    expect(nameOf("/Smith/")).toEqual({
      full: "Smith",
      given: null,
      surname: "Smith",
    });
  });

  it("keeps a suffix in the full name", () => {
    // `full` is the only lossless field of the three: a suffix, a patronymic
    // or a title survives here and nowhere else.
    expect(nameOf("John /Smith/ Jr")).toEqual({
      full: "John Smith Jr",
      given: "John",
      surname: "Smith",
    });
  });

  it("keeps every name a person has, in file order", () => {
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 NAME Mary /Byrne/", "1 NAME Mary /Smith/"].join("\n"),
    );

    expect(file.individuals[0].names.map((name) => name.surname)).toEqual([
      "Byrne",
      "Smith",
    ]);
  });
});

describe("dates it will not guess at", () => {
  function dateIssue(value: string) {
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 BIRT", `2 DATE ${value}`].join("\n"),
    );
    return { file, birth: file.individuals[0].birth };
  }

  it("refuses a range rather than reading one end of it", () => {
    // `individuals` has one birth date. Taking 1890 here would turn "some
    // time in that decade" into a false certainty that reads as a fact.
    const { file, birth } = dateIssue("BET 1890 AND 1900");

    expect(birth?.date).toBeNull();
    expect(birth?.dateText).toBe("BET 1890 AND 1900");
    expect(file.issues).toHaveLength(1);
    expect(file.issues[0].kind).toBe("date");
  });

  it("refuses a FROM/TO span the same way", () => {
    const { birth } = dateIssue("FROM 1912 TO 1918");
    expect(birth?.date).toBeNull();
  });

  it("names the text it could not read", () => {
    const { file } = dateIssue("BET 1890 AND 1900");
    expect(file.issues[0].message).toContain("BET 1890 AND 1900");
  });

  it("says which date it was", () => {
    const { file } = dateIssue("nonsense");
    expect(file.issues[0].message).toContain("birth");
  });

  it("keeps the rest of the record", () => {
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 NAME John /Smith/", "1 BIRT", "2 DATE nonsense"].join(
        "\n",
      ),
    );

    // One unreadable date must not cost a person.
    expect(file.individuals[0].names[0].surname).toBe("Smith");
  });
});

describe("events", () => {
  it("reads an event with no date or place at all", () => {
    // `1 DEAT Y` is GEDCOM for "this person is dead and we do not know when".
    const file = parseGedcomText("0 @I1@ INDI\n1 DEAT Y");

    expect(file.individuals[0].death).toEqual({
      date: null,
      dateText: null,
      place: null,
    });
  });

  it("keeps the first of two births and reports the second", () => {
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 BIRT", "2 DATE 1890", "1 BIRT", "2 DATE 1900"].join(
        "\n",
      ),
    );

    // Letting the last one win would make the imported date depend on file
    // order, which nobody notices until two runs disagree.
    expect(file.individuals[0].birth?.dateText).toBe("1890");
    expect(file.issues).toHaveLength(1);
    expect(file.issues[0].kind).toBe("value");
  });

  it("collapses whitespace in a place name", () => {
    const file = parseGedcomText(
      "0 @I1@ INDI\n1 BIRT\n2 PLAC  Whitby,   York ",
    );
    expect(file.individuals[0].birth?.place).toBe("Whitby, York");
  });
});

describe("sex", () => {
  function sexOf(code: string) {
    return parseGedcomText(`0 @I1@ INDI\n1 SEX ${code}`);
  }

  it.each([
    ["M", "male"],
    ["F", "female"],
    ["U", "unknown"],
    ["X", "other"],
  ])("reads %s as %s", (code, expected) => {
    expect(clean(sexOf(code)).individuals[0].sex).toBe(expected);
  });

  it("records an unrecognised code as unknown and says so", () => {
    const file = sexOf("Q");

    expect(file.individuals[0].sex).toBe("unknown");
    expect(file.issues[0]).toMatchObject({ kind: "value" });
  });
});

describe("references that do not hold up", () => {
  it("reports a HUSB that is not a pointer", () => {
    const file = parseGedcomText("0 @F1@ FAM\n1 HUSB John Smith");

    expect(file.families[0].husband).toBeNull();
    expect(file.issues[0]).toMatchObject({ kind: "pointer", line: 2 });
  });

  it("reports two records sharing an identifier", () => {
    const file = parseGedcomText("0 @I1@ INDI\n0 @I1@ INDI");

    // Every pointer to I1 is now ambiguous, and the ambiguity is silent:
    // whichever record a mapper indexes last wins.
    expect(file.individuals).toHaveLength(2);
    expect(file.issues[0]).toMatchObject({ kind: "pointer", line: 2 });
    expect(file.issues[0].message).toContain("ambiguous");
  });

  it("keeps a record with no identifier and says nothing can refer to it", () => {
    const file = parseGedcomText("0 INDI\n1 NAME John /Smith/");

    // An unreferenced person is still a person in the file. Dropping one
    // silently is the exact failure this parser is written to avoid.
    expect(file.individuals[0].names[0].surname).toBe("Smith");
    expect(file.issues[0].kind).toBe("pointer");
  });

  it("does not check that a pointer resolves", () => {
    // Deliberately out of scope: this module reports on the file, and
    // resolving references across records is the mapper's job (E6-T2).
    const file = clean(parseGedcomText("0 @F1@ FAM\n1 HUSB @I9@"));
    expect(file.families[0].husband).toBe("I9");
  });
});

describe("the unknown-tag report", () => {
  it("counts repeats rather than listing each one", () => {
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 SOUR @S1@", "1 SOUR @S2@", "1 NOTE x"].join("\n"),
    );

    expect(file.unknownTags).toEqual([
      { path: "INDI.SOUR", tag: "SOUR", count: 2, firstLine: 2 },
      { path: "INDI.NOTE", tag: "NOTE", count: 1, firstLine: 4 },
    ]);
  });

  it("puts the biggest losses first", () => {
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 NOTE x", "1 SOUR a", "1 SOUR b", "1 SOUR c"].join(
        "\n",
      ),
    );

    expect(file.unknownTags.map((entry) => entry.path)).toEqual([
      "INDI.SOUR",
      "INDI.NOTE",
    ]);
  });

  it("keeps the same tag under different parents apart", () => {
    // NOTE under INDI is a note about a person; NOTE under BIRT is a note
    // about a birth. Merging them would misdescribe both.
    const file = parseGedcomText(
      ["0 @I1@ INDI", "1 NOTE x", "1 BIRT", "2 NOTE y"].join("\n"),
    );

    expect(unknownCounts(file)).toEqual({ "INDI.NOTE": 1, "BIRT.NOTE": 1 });
  });

  it("counts a whole record type it does not know", () => {
    const file = parseGedcomText("0 @R1@ REPO\n1 NAME An archive");
    expect(unknownCounts(file)).toEqual({ REPO: 1 });
  });

  it("does not report the one header tag it actually used", () => {
    const file = parseGedcomText("0 HEAD\n1 CHAR UTF-8");
    expect(file.unknownTags).toEqual([]);
  });

  it("does not report the trailer", () => {
    expect(parseGedcomText("0 TRLR").unknownTags).toEqual([]);
  });
});

describe("files that are not what they claim", () => {
  it("produces no records and an issue per line for text that is not GEDCOM", () => {
    const file = parseGedcomText("hello\nworld");

    expect(file.individuals).toEqual([]);
    expect(file.issues).toHaveLength(2);
  });

  it("parses an empty file without throwing", () => {
    const file = parseGedcom(new Uint8Array());

    expect(file.individuals).toEqual([]);
    expect(file.families).toEqual([]);
  });
});

describe("parsing text that is already decoded", () => {
  it("is the entry point a round trip uses", () => {
    // E7-T2's exporter produces a string, not bytes. Making it encode to
    // bytes only for this to decode them again would put an encoding round
    // trip inside a test about the format.
    const file = parseGedcomText("0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI");

    expect(file.encoding).toBe("utf-8");
    // Still reported, because a round trip has to write back what it read.
    expect(file.declaredEncoding).toBe("ANSEL");
  });
});
