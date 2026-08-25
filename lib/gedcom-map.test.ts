import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGedcom, parseGedcomText } from "@/lib/gedcom";
import {
  type GedcomMapping,
  type MappedIndividual,
  type MappedUnion,
  mapGedcom,
} from "@/lib/gedcom-map";
import type { GedcomIssue, GedcomSkip } from "@/lib/gedcom-report";

/**
 * The GEDCOM → schema mapping (E6-T2, `YEO-47`).
 *
 * The ticket's acceptance criteria as assertions, and — like the parser's own
 * suite beside it — with no database anywhere in the file. That is not a
 * convenience: E6-T3's preview has to be able to say what an import would do
 * before it does any of it, which is only true if this module never writes.
 *
 * Inline `.ged` text for nearly everything, because each case here is three
 * or four lines that have to be read next to the assertion about them. The
 * one fixture-file test is the case where the whole file is the unit: five
 * people, two families, and every date form the schema has a column for.
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

/** A whole `.ged` from a body, so a test writes only the lines it cares about. */
function map(body: string): GedcomMapping {
  return mapGedcom(
    parseGedcomText(
      ["0 HEAD", "1 CHAR UTF-8", body.trim(), "0 TRLR"].join("\n"),
    ),
  );
}

function person(mapping: GedcomMapping, xref: string): MappedIndividual {
  const found = mapping.individuals.find((row) => row.xref === xref);
  if (found === undefined) throw new Error(`no individual ${xref}`);
  return found;
}

function union(mapping: GedcomMapping, xref: string): MappedUnion {
  const found = mapping.unions.find((row) => row.xref === xref);
  if (found === undefined) throw new Error(`no union ${xref}`);
  return found;
}

function messages(issues: readonly GedcomIssue[], kind: string): string[] {
  return issues.filter((issue) => issue.kind === kind).map((i) => i.message);
}

/** The skips, narrowed so their `record` is reachable. */
function skips(issues: readonly GedcomIssue[]): GedcomSkip[] {
  return issues.filter(
    (issue): issue is GedcomSkip => issue.kind === "skipped",
  );
}

/** One `INDI` with a birth date, which is most of what a date test needs. */
function born(date: string): GedcomMapping {
  return map(`0 @I1@ INDI
1 NAME Test /Person/
1 BIRT
2 DATE ${date}`);
}

function birthOf(date: string) {
  const values = person(born(date), "I1").values;
  return {
    date: values.birthDate,
    qualifier: values.birthDateQualifier,
    precision: values.birthDatePrecision,
    upper: values.birthDateUpper,
    upperPrecision: values.birthDateUpperPrecision,
  };
}

describe("the three tables", () => {
  const mapping = map(`0 @I1@ INDI
1 NAME John /Smith/
1 SEX M
0 @I2@ INDI
1 NAME Mary /Byrne/
1 SEX F
0 @I3@ INDI
1 NAME Edward /Smith/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1912`);

  it("turns INDI into individuals", () => {
    expect(mapping.individuals).toHaveLength(3);
    expect(person(mapping, "I1").values).toMatchObject({
      givenName: "John",
      surname: "Smith",
      sex: "male",
    });
  });

  it("turns FAM into unions, with HUSB and WIFE as the two partners", () => {
    expect(mapping.unions).toHaveLength(1);
    expect(union(mapping, "F1").values).toMatchObject({
      partnerAId: person(mapping, "I1").id,
      partnerBId: person(mapping, "I2").id,
      type: "marriage",
      startDate: "1912-01-01",
      startDatePrecision: "year",
    });
  });

  it("turns CHIL into union_children", () => {
    expect(mapping.unionChildren).toEqual([
      {
        unionId: union(mapping, "F1").id,
        childId: person(mapping, "I3").id,
        relation: "biological",
      },
    ]);
  });

  it("mints ids that are shaped like this schema's primary keys", () => {
    // The property `validateUnion` and `validateChildLink` actually check, and
    // the reason the mapping can assemble foreign keys without a database.
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of [...mapping.individuals, ...mapping.unions]) {
      expect(row.id).toMatch(uuid);
    }
    expect(new Set(mapping.individuals.map((row) => row.id)).size).toBe(3);
  });

  it("says nothing it did not have to", () => {
    expect(mapping.issues).toEqual([]);
  });
});

describe("a FAM with only one partner", () => {
  const mapping = map(`0 @I1@ INDI
1 NAME Mary /Byrne/
0 @I2@ INDI
1 NAME Edward /Byrne/
0 @F1@ FAM
1 WIFE @I1@
1 CHIL @I2@`);

  it("maps cleanly with the other partner left null", () => {
    // The case `docs/architecture.md` calls out as the reason both partner
    // columns are nullable: a child whose father nobody can name needs no
    // placeholder person invented for him.
    expect(union(mapping, "F1").values).toMatchObject({
      partnerAId: null,
      partnerBId: person(mapping, "I1").id,
    });
    expect(mapping.unionChildren).toHaveLength(1);
  });

  it("raises no issue about it, because nothing was lost", () => {
    expect(mapping.issues).toEqual([]);
  });

  it("records no marriage, because no tag claimed one", () => {
    expect(union(mapping, "F1").values.type).toBe("unknown");
  });
});

describe("how a union ended", () => {
  it("reads DIV as a divorce, with its date", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 1885
1 DIV
2 DATE 1889`);

    expect(union(mapping, "F1").values).toMatchObject({
      endReason: "divorce",
      endDate: "1889-01-01",
      endDatePrecision: "year",
    });
  });

  it("reads a DIV with no date as a divorce all the same", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I1@
1 DIV`);

    expect(union(mapping, "F1").values).toMatchObject({
      endReason: "divorce",
      endDate: null,
      // Nothing divorces that was not married.
      type: "marriage",
    });
  });

  it("takes a partner's death date to mean the union ended in death", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 DEAT
2 DATE 1962
0 @I2@ INDI
1 NAME B /Two/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 1912`);

    expect(union(mapping, "F1").values.endReason).toBe("death");
  });

  it("stores no end date for an inferred death", () => {
    // The date is recorded once, on the person who died. Copying it here
    // would make two rows that have to be corrected together forever.
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 DEAT
2 DATE 1962
0 @F1@ FAM
1 HUSB @I1@`);

    expect(union(mapping, "F1").values.endDate).toBeNull();
  });

  it("lets a divorce win over a later death", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 DEAT
2 DATE 1962
0 @I2@ INDI
1 NAME B /Two/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 DIV
2 DATE 1930`);

    expect(union(mapping, "F1").values.endReason).toBe("divorce");
  });

  it("leaves a union with neither as ongoing", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I1@`);

    expect(union(mapping, "F1").values.endReason).toBe("ongoing");
  });
});

describe("dates, which is what the schema was widened for", () => {
  it("carries ABT onto the qualifier", () => {
    expect(birthOf("ABT 1890")).toEqual({
      date: "1890-01-01",
      qualifier: "about",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("carries BEF onto the qualifier", () => {
    expect(birthOf("BEF 1920")).toEqual({
      date: "1920-01-01",
      qualifier: "before",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("carries AFT onto the qualifier", () => {
    expect(birthOf("AFT 1913")).toEqual({
      date: "1913-01-01",
      qualifier: "after",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("keeps a full date at day precision", () => {
    expect(birthOf("12 MAR 1890")).toEqual({
      date: "1890-03-12",
      qualifier: "exact",
      precision: "day",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("keeps a month and year at month precision", () => {
    expect(birthOf("MAR 1893")).toEqual({
      date: "1893-03-01",
      qualifier: "exact",
      precision: "month",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("keeps a bare year at year precision", () => {
    expect(birthOf("1915")).toEqual({
      date: "1915-01-01",
      qualifier: "exact",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
  });

  it("stores BET x AND y as both bounds", () => {
    expect(birthOf("BET 1880 AND 1885")).toEqual({
      date: "1880-01-01",
      qualifier: "exact",
      precision: "year",
      upper: "1885-01-01",
      upperPrecision: "year",
    });
  });

  it("gives each end of a range its own precision", () => {
    // The criterion the second precision column exists for: without it this
    // would have to choose between throwing March away and inventing one.
    expect(birthOf("BET MAR 1890 AND 1900")).toEqual({
      date: "1890-03-01",
      qualifier: "exact",
      precision: "month",
      upper: "1900-01-01",
      upperPrecision: "year",
    });
  });

  it("stores FROM x TO y exactly as it stores BET x AND y", () => {
    // A deliberate equivalence rather than a loss: a period and a range are a
    // distinction with no column, and for a birth the period reading is a
    // data-entry habit rather than a claim. An export writes both as BET.
    expect(birthOf("FROM 1912 TO 1918")).toEqual(birthOf("BET 1912 AND 1918"));
  });

  it("raises no issue for either range form", () => {
    expect(born("BET 1890 AND 1900").issues).toEqual([]);
    expect(born("FROM 1912 TO 1918").issues).toEqual([]);
  });

  it("stores FROM x on its own as an after date", () => {
    expect(birthOf("FROM 1912")).toEqual({
      date: "1912-01-01",
      qualifier: "after",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
    expect(born("FROM 1912").issues).toEqual([]);
  });

  it("stores TO y on its own as a before date", () => {
    expect(birthOf("TO 1918")).toEqual({
      date: "1918-01-01",
      qualifier: "before",
      precision: "year",
      upper: null,
      upperPrecision: "day",
    });
    expect(born("TO 1918").issues).toEqual([]);
  });

  it("puts a union's dates in the union's own columns", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 DATE BET 1910 AND MAR 1912
1 DIV
2 DATE ABT 1930`);

    expect(union(mapping, "F1").values).toMatchObject({
      startDate: "1910-01-01",
      startDateQualifier: "exact",
      startDatePrecision: "year",
      startDateUpper: "1912-03-01",
      startDateUpperPrecision: "month",
      endDate: "1930-01-01",
      endDateQualifier: "about",
      endDatePrecision: "year",
      endDateUpper: null,
    });
  });
});

describe("the four residual losses, each reported as narrowed", () => {
  /** The `narrowed` messages a date raises, in order. */
  function narrowings(date: string): string[] {
    return messages(born(date).issues, "narrowed");
  }

  it("reports an INT interpretation phrase, which is not stored", () => {
    const [message, ...rest] = narrowings("INT 1890 (from baptism record)");
    expect(rest).toEqual([]);
    expect(message).toContain("INT 1890 (from baptism record)");
    expect(message).toContain("from baptism record");
    expect(message).toContain("not stored");
    expect(birthOf("INT 1890 (from baptism record)").qualifier).toBe("about");
  });

  it("reports a modifier on a range endpoint, which is not stored", () => {
    const [message, ...rest] = narrowings("BET ABT 1890 AND 1900");
    expect(rest).toEqual([]);
    expect(message).toContain("BET ABT 1890 AND 1900");
    expect(message).toContain("about");
    expect(message).toContain("not stored");
    // The bounds themselves survive whole; only the fuzz on one edge goes.
    expect(birthOf("BET ABT 1890 AND 1900")).toMatchObject({
      date: "1890-01-01",
      qualifier: "exact",
      upper: "1900-01-01",
    });
  });

  it("reports a range whose upper bound could not be read", () => {
    const [message, ...rest] = narrowings("BET 1890 AND (some Tuesday)");
    expect(rest).toEqual([]);
    expect(message).toContain("(some Tuesday)");
    expect(message).toContain("after");
    // The lower bound is a date the file genuinely gave, so it is kept.
    expect(birthOf("BET 1890 AND (some Tuesday)")).toMatchObject({
      date: "1890-01-01",
      qualifier: "after",
      upper: null,
    });
  });

  it("reports EST, which has always been stored as about", () => {
    // The oldest of the four and the one that used to go through in silence,
    // which made "how much did this import narrow" unanswerable.
    const [message, ...rest] = narrowings("EST 1918");
    expect(rest).toEqual([]);
    expect(message).toContain("EST 1918");
    expect(message).toContain("about");
    expect(birthOf("EST 1918")).toMatchObject({
      date: "1918-01-01",
      qualifier: "about",
      precision: "year",
    });
  });

  it("counts an EST inside a range once, not twice", () => {
    // `BET EST 1890 AND 1900` is one loss — the endpoint's modifier — and the
    // endpoint rule already reports it. Two sentences would make one loss
    // look like two on the report.
    expect(narrowings("BET EST 1890 AND 1900")).toHaveLength(1);
  });

  it("names the original text, the value written and the line, every time", () => {
    for (const date of [
      "INT 1890 (from baptism record)",
      "BET ABT 1890 AND 1900",
      "BET 1890 AND (some Tuesday)",
      "EST 1918",
    ]) {
      const [issue] = born(date).issues.filter((i) => i.kind === "narrowed");
      expect(issue.message).toContain(date);
      expect(issue.line).toBeGreaterThan(0);
    }
  });

  it("carries every narrowed issue through unchanged", () => {
    // The criterion in full: the mapping invents no second representation for
    // a loss the parser has already worded. Object identity is the strongest
    // way to say "unchanged" and the cheapest to check.
    const file = parseGedcomText(
      [
        "0 HEAD",
        "1 CHAR UTF-8",
        "0 @I1@ INDI",
        "1 NAME A /One/",
        "1 BIRT",
        "2 DATE EST 1918",
        "1 DEAT",
        "2 DATE INT 1990 (from a letter)",
        "0 TRLR",
      ].join("\n"),
    );

    const narrowed = file.issues.filter((issue) => issue.kind === "narrowed");
    expect(narrowed).toHaveLength(2);

    const mapping = mapGedcom(file);
    for (const issue of narrowed) {
      expect(mapping.issues).toContain(issue);
    }
    // And the file's issues come first, in the order the parser found them.
    expect(mapping.issues.slice(0, file.issues.length)).toEqual(file.issues);
  });
});

describe("unions.sequence", () => {
  it("counts a person's unions in date order, not file order", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME Mary /Byrne/
0 @F1@ FAM
1 WIFE @I1@
1 MARR
2 DATE 1913
0 @F2@ FAM
1 WIFE @I1@
1 MARR
2 DATE 1885`);

    expect(union(mapping, "F2").values.sequence).toBe(0);
    expect(union(mapping, "F1").values.sequence).toBe(1);
  });

  it("falls back to file order when there are no dates to sort by", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME Mary /Byrne/
0 @F1@ FAM
1 WIFE @I1@
0 @F2@ FAM
1 WIFE @I1@`);

    expect(union(mapping, "F1").values.sequence).toBe(0);
    expect(union(mapping, "F2").values.sequence).toBe(1);
  });

  it("puts an undated union after the dated ones, as addSpouse would", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME Mary /Byrne/
0 @F1@ FAM
1 WIFE @I1@
0 @F2@ FAM
1 WIFE @I1@
1 MARR
2 DATE 1885`);

    expect(union(mapping, "F2").values.sequence).toBe(0);
    expect(union(mapping, "F1").values.sequence).toBe(1);
  });

  it("counts down each partner's own list, not the whole file", () => {
    // Two couples with one person in common. The shared partner's second
    // union takes 1; the union between two people new to the file takes 0.
    const mapping = map(`0 @I1@ INDI
1 NAME Mary /Byrne/
0 @I2@ INDI
1 NAME John /Smith/
0 @I3@ INDI
1 NAME Ann /Hall/
0 @I4@ INDI
1 NAME Tom /Hall/
0 @F1@ FAM
1 WIFE @I1@
1 HUSB @I2@
1 MARR
2 DATE 1900
0 @F2@ FAM
1 WIFE @I3@
1 HUSB @I4@
1 MARR
2 DATE 1905
0 @F3@ FAM
1 WIFE @I1@
1 MARR
2 DATE 1910`);

    expect(union(mapping, "F1").values.sequence).toBe(0);
    expect(union(mapping, "F2").values.sequence).toBe(0);
    expect(union(mapping, "F3").values.sequence).toBe(1);
  });
});

describe("PEDI", () => {
  function relationOf(pedi: string): string {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
2 PEDI ${pedi}
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`);
    return mapping.unionChildren[0].relation;
  }

  it("reads adopted", () => {
    expect(relationOf("adopted")).toBe("adopted");
  });

  it("reads foster", () => {
    expect(relationOf("foster")).toBe("foster");
  });

  it("reads birth as biological, which is what this schema calls it", () => {
    expect(relationOf("birth")).toBe("biological");
  });

  it("reads step, which is not in 5.5.1 but is a member of our enum", () => {
    expect(relationOf("step")).toBe("step");
  });

  it("is case-insensitive, because files are", () => {
    expect(relationOf("Adopted")).toBe("adopted");
  });

  it("defaults to biological when the file gives no PEDI", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`);

    expect(mapping.unionChildren[0].relation).toBe("biological");
    expect(mapping.issues).toEqual([]);
  });

  it("reports a sealing as the ordinance it is, and records biological", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
2 PEDI sealing
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`);

    expect(mapping.unionChildren[0].relation).toBe("biological");
    expect(messages(mapping.issues, "value")).toEqual([
      expect.stringContaining("sealing"),
    ]);
  });

  it("reports a pedigree it does not understand", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
2 PEDI godparent
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`);

    expect(mapping.unionChildren[0].relation).toBe("biological");
    expect(messages(mapping.issues, "value")).toEqual([
      expect.stringContaining("godparent"),
    ]);
  });
});

describe("what the schema has no room for", () => {
  it("reports a marriage place, which unions have no column for", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I1@
1 MARR
2 DATE 1912
2 PLAC St Anne's, Whitby`);

    expect(messages(mapping.issues, "value")).toEqual([
      expect.stringContaining("St Anne's, Whitby"),
    ]);
    // A birth place has a column, so it goes in it and says nothing.
    expect(union(mapping, "F1").values.startDate).toBe("1912-01-01");
  });

  it("keeps birth and death places, which individuals do have columns for", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 BIRT
2 PLAC Whitby
1 DEAT
2 PLAC Leeds`);

    expect(person(mapping, "I1").values).toMatchObject({
      birthPlace: "Whitby",
      deathPlace: "Leeds",
    });
    expect(mapping.issues).toEqual([]);
  });

  it("records a placeholder first name, and says that it did", () => {
    // `1 NAME /Smith/` is an ordinary way to record a woman known only by a
    // married surname. Skipping her would delete the edge that is the only
    // reason the file mentions her.
    const mapping = map(`0 @I1@ INDI
1 NAME /Smith/`);

    expect(person(mapping, "I1").values).toMatchObject({
      givenName: "Unknown",
      surname: "Smith",
    });
    expect(messages(mapping.issues, "value")).toEqual([
      expect.stringContaining("first name"),
    ]);
  });

  it("records a person with no NAME at all", () => {
    const mapping = map(`0 @I1@ INDI
1 SEX M`);

    expect(person(mapping, "I1").values).toMatchObject({
      givenName: "Unknown",
      surname: null,
    });
  });

  it("keeps the first of several names and reports the rest", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME Mary /Byrne/
1 NAME Mary /Smith/`);

    expect(person(mapping, "I1").values).toMatchObject({
      givenName: "Mary",
      surname: "Byrne",
    });
    expect(messages(mapping.issues, "value")).toEqual([
      expect.stringContaining("Mary Smith"),
    ]);
  });
});

describe("records the validation layer refuses", () => {
  it("leaves out a person whose dates are impossible, and says why", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 BIRT
2 DATE 1950
1 DEAT
2 DATE 1900`);

    expect(mapping.individuals).toEqual([]);
    expect(messages(mapping.issues, "skipped")).toEqual([
      expect.stringContaining("before the birth date"),
    ]);
    // "Each skip names the GEDCOM record and the reason" (E6-T5, `YEO-50`),
    // and the record is a value rather than a phrase inside the sentence, so
    // a report can group and count without reading English.
    expect(skips(mapping.issues)[0].record).toEqual({
      tag: "INDI",
      xref: "I1",
      label: "A One",
    });
  });

  it("leaves out a person whose range is written backwards", () => {
    // The parser deliberately stores `BET 1900 AND 1890` as written and
    // leaves the judgement to the validator. This is the validator.
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 BIRT
2 DATE BET 1900 AND 1890`);

    expect(mapping.individuals).toEqual([]);
    expect(messages(mapping.issues, "skipped")).toEqual([
      expect.stringContaining("before the lower bound"),
    ]);
  });

  it("takes every link to a refused person with them", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 BIRT
2 DATE 1950
1 DEAT
2 DATE 1900
0 @I2@ INDI
1 NAME B /Two/
0 @I3@ INDI
1 NAME C /Three/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@`);

    // The family survives with one partner; the refused one is a null.
    expect(union(mapping, "F1").values).toMatchObject({
      partnerAId: null,
      partnerBId: person(mapping, "I2").id,
    });
    expect(mapping.unionChildren).toHaveLength(1);
    expect(messages(mapping.issues, "skipped")).toContainEqual(
      expect.stringContaining("could not be recorded, so this family has no"),
    );
    // The link is skipped as its own record, naming the partner who is not
    // there rather than the family that survived without them.
    expect(skips(mapping.issues)).toContainEqual(
      expect.objectContaining({
        record: { tag: "FAM.HUSB", xref: "I1", label: "A One" },
      }),
    );
  });

  it("leaves out a family with nobody in it", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 CHIL @I1@`);

    expect(mapping.unions).toEqual([]);
    expect(mapping.unionChildren).toEqual([]);
    expect(messages(mapping.issues, "skipped")).toEqual([
      expect.stringContaining("at least one partner"),
    ]);
    // A family has no name for the label to carry, and the xref is what
    // names it. `null` rather than an invented description.
    expect(skips(mapping.issues)[0].record).toEqual({
      tag: "FAM",
      xref: "F1",
      label: null,
    });
  });

  it("leaves out a family whose two partners are the same person", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I1@`);

    expect(mapping.unions).toEqual([]);
    expect(messages(mapping.issues, "skipped")).toEqual([
      expect.stringContaining("union with themselves"),
    ]);
  });

  it("leaves out a child who is also a partner in the same family", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I1@`);

    expect(mapping.unions).toHaveLength(1);
    expect(mapping.unionChildren).toEqual([]);
    expect(messages(mapping.issues, "skipped")).toEqual([
      expect.stringContaining("also a partner"),
    ]);
  });

  it("writes one union_children row for a child named twice", () => {
    // The table is keyed on the pair, so the second row could not be written.
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
1 CHIL @I2@`);

    expect(mapping.unionChildren).toHaveLength(1);
    expect(messages(mapping.issues, "skipped")).toEqual([
      expect.stringContaining("more than once"),
    ]);
    expect(skips(mapping.issues)[0].record).toEqual({
      tag: "FAM.CHIL",
      xref: "I2",
      label: "B Two",
    });
  });
});

describe("pointers the file cannot honour", () => {
  it("reports a HUSB naming a record that is not in the file", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I9@
1 WIFE @I1@`);

    expect(union(mapping, "F1").values.partnerAId).toBeNull();
    expect(messages(mapping.issues, "pointer")).toEqual([
      expect.stringContaining("I9"),
    ]);
  });

  it("reports a CHIL naming a record that is not in the file", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I9@`);

    expect(mapping.unionChildren).toEqual([]);
    expect(messages(mapping.issues, "pointer")).toEqual([
      expect.stringContaining("I9"),
    ]);
  });

  it("reports a FAMS the family side does not agree with", () => {
    // The cross-check the parser's own docblock says is the only reason to
    // carry FAMS and FAMC at all.
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 FAMS @F1@
0 @I2@ INDI
1 NAME B /Two/
0 @F1@ FAM
1 HUSB @I2@`);

    expect(messages(mapping.issues, "pointer")).toEqual([
      expect.stringContaining("names somebody else"),
    ]);
  });

  it("reports a FAMC the family side does not list", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@`);

    expect(mapping.unionChildren).toEqual([]);
    expect(messages(mapping.issues, "pointer")).toEqual([
      expect.stringContaining("does not list them"),
    ]);
  });

  it("says nothing when the two halves agree, which is every good file", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
1 FAMS @F1@
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`);

    expect(mapping.issues).toEqual([]);
  });
});

describe("duplicate identifiers", () => {
  // The parser reports a duplicated xref and deliberately does not resolve
  // it; the mapping has to pick one, and every reference in the file is
  // ambiguous either way. What matters is that it picks the *same* record
  // everywhere — the row a pointer resolves to and the record `PEDI` is read
  // off have to be the same person, or an adopted child comes out biological
  // with nothing on the report to explain it.

  it("resolves a duplicated xref to the first record that validated", () => {
    const mapping = map(`0 @I1@ INDI
1 NAME Alice /One/
0 @I1@ INDI
1 NAME Beth /Two/
0 @F1@ FAM
1 WIFE @I1@`);

    expect(mapping.individuals).toHaveLength(2);
    expect(union(mapping, "F1").values.partnerBId).toBe(
      mapping.individuals[0].id,
    );
  });

  it("skips a refused duplicate and resolves to the one that survived", () => {
    // The regression this pins: the first `@I2@` is refused for impossible
    // dates, so the pointer resolves to the second — and `PEDI` has to be
    // read off that same second record, not off the discarded first.
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME Refused /Two/
1 BIRT
2 DATE 1950
1 DEAT
2 DATE 1900
0 @I2@ INDI
1 NAME Kept /Two/
1 FAMC @F1@
2 PEDI adopted
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`);

    const kept = person(mapping, "I2");
    expect(kept.values.givenName).toBe("Kept");
    expect(mapping.unionChildren).toEqual([
      {
        unionId: union(mapping, "F1").id,
        childId: kept.id,
        relation: "adopted",
      },
    ]);
  });

  it("does not invent a disagreement between two families sharing an xref", () => {
    // The cross-check reads "does any record bearing this identifier agree",
    // so a duplicated `FAM` must not have one copy's children overwrite the
    // other's and report a mismatch that the file does not have.
    const mapping = map(`0 @I1@ INDI
1 NAME A /One/
0 @I2@ INDI
1 NAME B /Two/
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 @F1@ FAM
1 HUSB @I1@`);

    // The parser's own "this identifier is used twice" issue is expected and
    // stays. What must not appear is a *cross-check* complaint: the second
    // `F1` lists no children, and overwriting would have made the first one's
    // `CHIL` vanish and Beth's `FAMC` look one-sided.
    expect(
      messages(mapping.issues, "pointer").filter((message) =>
        message.includes("does not list them"),
      ),
    ).toEqual([]);
    expect(mapping.unionChildren).toHaveLength(1);
  });
});

describe("a file with nothing usable in it", () => {
  it("maps to three empty lists and a report saying why", () => {
    // The "pure and total" guarantee E6-T3's preview rests on: this never
    // throws, so a preview can render a verdict on any file at all.
    const mapping = mapGedcom(parseGedcomText("this is not a GEDCOM file"));

    expect(mapping.individuals).toEqual([]);
    expect(mapping.unions).toEqual([]);
    expect(mapping.unionChildren).toEqual([]);
    expect(mapping.issues.length).toBeGreaterThan(0);
  });

  it("maps an empty file to nothing at all, without complaint", () => {
    const mapping = mapGedcom(parseGedcomText(""));

    expect(mapping.individuals).toEqual([]);
    expect(mapping.unions).toEqual([]);
    expect(mapping.unionChildren).toEqual([]);
    expect(mapping.issues).toEqual([]);
  });
});

describe("a whole family, from a fixture file", () => {
  const mapping = mapGedcom(parseGedcom(fixture("family.ged")));

  it("maps every record", () => {
    expect(mapping.individuals).toHaveLength(5);
    expect(mapping.unions).toHaveLength(2);
    expect(mapping.unionChildren).toHaveLength(2);
  });

  it("puts both of a remarried person's unions in date order", () => {
    // Mary Ann Byrne is in F1 (married after 1913) and F2 (married 1885).
    // File order is F1 then F2; date order is the other way round.
    expect(union(mapping, "F2").values.sequence).toBe(0);
    expect(union(mapping, "F1").values.sequence).toBe(1);
  });

  it("ends F1 in death and F2 in divorce", () => {
    expect(union(mapping, "F1").values).toMatchObject({
      endReason: "death",
      endDate: null,
    });
    expect(union(mapping, "F2").values).toMatchObject({
      endReason: "divorce",
      endDate: "1889-01-01",
    });
  });

  it("carries a range, a qualifier and three precisions into the columns", () => {
    expect(person(mapping, "I5").values).toMatchObject({
      birthDate: "1880-01-01",
      birthDatePrecision: "year",
      birthDateUpper: "1885-01-01",
      birthDateUpperPrecision: "year",
    });
    expect(person(mapping, "I1").values).toMatchObject({
      birthDate: "1890-03-12",
      birthDatePrecision: "day",
      deathDate: "1962-01-01",
      deathDateQualifier: "about",
    });
    expect(person(mapping, "I2").values).toMatchObject({
      birthDate: "1893-03-01",
      birthDatePrecision: "month",
      deathDateQualifier: "before",
    });
  });

  it("reports exactly the losses this file actually has", () => {
    // Two, and only two: Ada's `EST 1918` birth, and F1's marriage place,
    // which has no column. The birth and death places in the same file have
    // columns and go into them without a word.
    expect(messages(mapping.issues, "narrowed")).toEqual([
      expect.stringContaining("EST 1918"),
    ]);
    expect(messages(mapping.issues, "value")).toEqual([
      expect.stringContaining("St Anne's, Whitby, England"),
    ]);
    expect(messages(mapping.issues, "pointer")).toEqual([]);
  });
});
