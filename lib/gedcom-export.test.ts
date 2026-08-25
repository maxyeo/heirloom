import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CHILD_RELATIONS, type ChildRelation } from "@/lib/child-input";
import {
  DATE_PRECISIONS,
  DATE_QUALIFIERS,
  type DatePrecision,
  type DateQualifier,
} from "@/lib/field-input";
import { parseGedcomText } from "@/lib/gedcom";
import {
  type ExportChild,
  type ExportIndividual,
  type ExportUnion,
  type GedcomExportInput,
  writeGedcom,
} from "@/lib/gedcom-export";
import { mapGedcom } from "@/lib/gedcom-map";
import { SEXES, type Sex } from "@/lib/individual-input";

/**
 * The export half of the GEDCOM pipeline (E7-T1, `YEO-51`).
 *
 * Most of what is asserted here is asserted by *going back through the import
 * half* rather than by matching strings. `writeGedcom` then `parseGedcomText`
 * then `mapGedcom` is the whole pipeline in a line, and a test written that
 * way fails when the two halves disagree — which is the actual risk, and one
 * that a test comparing the output against a literal cannot see. A literal
 * says "this is the text we wrote yesterday"; the round trip says "the
 * importer reads this as the rows it came from".
 *
 * The literals that remain are for the things the round trip cannot check
 * because the importer does not read them: the header, the trailer, and the
 * line endings.
 */

/** A person with everything unrecorded, to be spread over. */
function person(overrides: Partial<ExportIndividual> = {}): ExportIndividual {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    givenName: "Ada",
    surname: "Smith",
    sex: "unknown",
    birthDate: null,
    birthDateQualifier: "exact",
    birthDatePrecision: "day",
    birthDateUpper: null,
    birthDateUpperPrecision: "day",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
    deathDateUpper: null,
    deathDateUpperPrecision: "day",
    deathPlace: null,
    notes: null,
    ...overrides,
  };
}

/** A union with everything unrecorded, to be spread over. */
function union(overrides: Partial<ExportUnion> = {}): ExportUnion {
  return {
    id: overrides.id ?? "22222222-2222-4222-8222-222222222222",
    partnerAId: null,
    partnerBId: null,
    type: "unknown",
    startDate: null,
    startDateQualifier: "exact",
    startDatePrecision: "day",
    startDateUpper: null,
    startDateUpperPrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    endDateUpper: null,
    endDateUpperPrecision: "day",
    endReason: "ongoing",
    sequence: 0,
    notes: null,
    ...overrides,
  };
}

/** A uuid-shaped id, since `validateUnion` refuses anything else. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Export, import, and map back — the pipeline, both directions. */
function roundTrip(tree: GedcomExportInput) {
  const text = writeGedcom(tree);
  const mapped = mapGedcom(parseGedcomText(text));

  return {
    text,
    mapped,
    /** The mapped rows, flattened back into the shape the exporter takes. */
    input: {
      individuals: mapped.individuals.map((individual) => ({
        id: individual.id,
        ...individual.values,
      })),
      unions: mapped.unions.map((mappedUnion) => ({
        id: mappedUnion.id,
        ...mappedUnion.values,
      })),
      unionChildren: mapped.unionChildren,
    } satisfies GedcomExportInput,
  };
}

describe("the file it writes", () => {
  const text = writeGedcom({
    individuals: [person()],
    unions: [],
    unionChildren: [],
  });

  it("is a GEDCOM 5.5.1 lineage-linked file", () => {
    expect(text).toContain("0 HEAD\r\n");
    expect(text).toContain(
      "1 GEDC\r\n2 VERS 5.5.1\r\n2 FORM LINEAGE-LINKED\r\n",
    );
    expect(text).toContain("1 CHAR UTF-8\r\n");
  });

  it("points its header at a submitter record that exists", () => {
    // `SUBM` is mandatory in 5.5.1 and is a pointer, so a header alone is not
    // a valid file. Strict readers check that the record it names is there.
    expect(text).toContain("1 SUBM @U1@\r\n");
    expect(text).toContain("0 @U1@ SUBM\r\n");
  });

  it("ends with the trailer, on its own terminated line", () => {
    expect(text.endsWith("0 TRLR\r\n")).toBe(true);
  });

  it("writes CRLF everywhere and never a bare newline", () => {
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("writes no timestamp, so an unchanged tree exports byte for byte the same", () => {
    // The header's `DATE` is optional in 5.5.1 and deliberately absent: E7-T2
    // compares bytes, and so does anybody diffing two backups.
    expect(text).not.toContain("1 DATE");
    expect(
      writeGedcom({ individuals: [person()], unions: [], unionChildren: [] }),
    ).toBe(text);
  });
});

describe("individuals", () => {
  it("writes the name in slash notation and in parts", () => {
    const text = writeGedcom({
      individuals: [person({ givenName: "John Henry", surname: "Smith" })],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("1 NAME John Henry /Smith/\r\n");
    expect(text).toContain("2 GIVN John Henry\r\n");
    expect(text).toContain("2 SURN Smith\r\n");
  });

  it("writes a person with no surname as a bare given name", () => {
    const text = writeGedcom({
      individuals: [person({ givenName: "Wilhelmina", surname: null })],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("1 NAME Wilhelmina\r\n");
    expect(text).not.toContain("2 SURN");
  });

  it("writes no BIRT at all when nothing about a birth is recorded", () => {
    // `1 BIRT` alone asserts that a birth is *recorded*. Everybody was born,
    // so the tag would be true of every person and informative about none.
    const text = writeGedcom({
      individuals: [person()],
      unions: [],
      unionChildren: [],
    });

    expect(text).not.toContain("1 BIRT");
    expect(text).not.toContain("1 DEAT");
  });

  it.each(SEXES)("round-trips sex %s", (sex: Sex) => {
    const { input } = roundTrip({
      individuals: [person({ id: id(1), sex })],
      unions: [],
      unionChildren: [],
    });

    // Every member of the enum has a GEDCOM spelling, and it is this table
    // read backwards rather than a second one — see `invert` in the module.
    expect(input.individuals[0].sex).toBe(sex);
  });

  it("round-trips both places", () => {
    const { input } = roundTrip({
      individuals: [
        person({
          id: id(1),
          birthDate: "1890-03-12",
          birthPlace: "Whitby, Yorkshire, England",
          deathDate: "1962-01-01",
          deathDatePrecision: "year",
          deathPlace: "Scarborough, England",
        }),
      ],
      unions: [],
      unionChildren: [],
    });

    expect(input.individuals[0].birthPlace).toBe("Whitby, Yorkshire, England");
    expect(input.individuals[0].deathPlace).toBe("Scarborough, England");
  });
});

describe("dates", () => {
  it("writes each precision at the precision it was recorded to", () => {
    // The stored anchor is 1 January, and writing it as a day would put an
    // invented birthday into every program that read the file.
    const cases: ReadonlyArray<[DatePrecision, string]> = [
      ["year", "2 DATE 1890\r\n"],
      ["month", "2 DATE JAN 1890\r\n"],
      ["day", "2 DATE 1 JAN 1890\r\n"],
    ];

    for (const [precision, expected] of cases) {
      const text = writeGedcom({
        individuals: [
          person({ birthDate: "1890-01-01", birthDatePrecision: precision }),
        ],
        unions: [],
        unionChildren: [],
      });

      expect(text).toContain(expected);
    }
  });

  it("writes the qualifiers as ABT, BEF and AFT", () => {
    const cases: ReadonlyArray<[DateQualifier, string]> = [
      ["exact", "2 DATE 1890\r\n"],
      ["about", "2 DATE ABT 1890\r\n"],
      ["before", "2 DATE BEF 1890\r\n"],
      ["after", "2 DATE AFT 1890\r\n"],
    ];

    for (const [qualifier, expected] of cases) {
      const text = writeGedcom({
        individuals: [
          person({
            birthDate: "1890-01-01",
            birthDatePrecision: "year",
            birthDateQualifier: qualifier,
          }),
        ],
        unions: [],
        unionChildren: [],
      });

      expect(text).toContain(expected);
    }
  });

  it.each(DATE_QUALIFIERS)(
    "round-trips the %s qualifier",
    (qualifier: DateQualifier) => {
      const { input } = roundTrip({
        individuals: [
          person({
            id: id(1),
            birthDate: "1890-01-01",
            birthDatePrecision: "year",
            birthDateQualifier: qualifier,
          }),
        ],
        unions: [],
        unionChildren: [],
      });

      expect(input.individuals[0].birthDateQualifier).toBe(qualifier);
      expect(input.individuals[0].birthDate).toBe("1890-01-01");
    },
  );

  it.each(DATE_PRECISIONS)(
    "round-trips the %s precision",
    (precision: DatePrecision) => {
      const { input } = roundTrip({
        individuals: [
          person({
            id: id(1),
            birthDate: "1890-03-12",
            birthDatePrecision: precision,
          }),
        ],
        unions: [],
        unionChildren: [],
      });

      expect(input.individuals[0].birthDatePrecision).toBe(precision);
    },
  );

  it("round-trips every month, so the abbreviations are the ones the grammar reads", () => {
    for (let month = 1; month <= 12; month += 1) {
      const date = `1890-${String(month).padStart(2, "0")}-01`;

      const { input } = roundTrip({
        individuals: [
          person({ id: id(1), birthDate: date, birthDatePrecision: "month" }),
        ],
        unions: [],
        unionChildren: [],
      });

      expect(input.individuals[0].birthDate).toBe(date);
      expect(input.individuals[0].birthDatePrecision).toBe("month");
    }
  });

  it("writes a range as BET x AND y, each bound at its own precision", () => {
    const text = writeGedcom({
      individuals: [
        person({
          birthDate: "1890-03-01",
          birthDatePrecision: "month",
          birthDateUpper: "1900-01-01",
          birthDateUpperPrecision: "year",
        }),
      ],
      unions: [],
      unionChildren: [],
    });

    // Never `FROM x TO y`: the schema stores the two forms identically, so one
    // of them has to be the one written, and `BET` is what the columns mean.
    expect(text).toContain("2 DATE BET MAR 1890 AND 1900\r\n");
  });

  it("round-trips a range whole", () => {
    const { input } = roundTrip({
      individuals: [
        person({
          id: id(1),
          birthDate: "1890-03-01",
          birthDatePrecision: "month",
          birthDateUpper: "1900-01-01",
          birthDateUpperPrecision: "year",
        }),
      ],
      unions: [],
      unionChildren: [],
    });

    expect(input.individuals[0]).toMatchObject({
      birthDate: "1890-03-01",
      birthDatePrecision: "month",
      birthDateUpper: "1900-01-01",
      birthDateUpperPrecision: "year",
      birthDateQualifier: "exact",
    });
  });

  it("keeps a mediaeval year's four ISO digits, which is what the grammar reads", () => {
    const { text, input } = roundTrip({
      individuals: [
        person({
          id: id(1),
          birthDate: "0850-01-01",
          birthDatePrecision: "year",
        }),
      ],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("2 DATE 0850\r\n");
    expect(input.individuals[0].birthDate).toBe("0850-01-01");
  });
});

describe("families", () => {
  const husband = person({ id: id(1), givenName: "John", surname: "Smith" });
  const wife = person({ id: id(2), givenName: "Mary", surname: "Byrne" });
  const child = person({ id: id(3), givenName: "Edward", surname: "Smith" });

  const married = union({
    id: id(4),
    partnerAId: husband.id,
    partnerBId: wife.id,
    type: "marriage",
    startDate: "1913-01-01",
    startDatePrecision: "year",
  });

  const link: ExportChild = {
    unionId: married.id,
    childId: child.id,
    relation: "biological",
  };

  const tree: GedcomExportInput = {
    individuals: [husband, wife, child],
    unions: [married],
    unionChildren: [link],
  };

  it("writes the union as a FAM with both partners and the child", () => {
    const text = writeGedcom(tree);

    expect(text).toContain("0 @F1@ FAM\r\n");
    expect(text).toMatch(/1 HUSB @I\d+@\r\n/);
    expect(text).toMatch(/1 WIFE @I\d+@\r\n/);
    expect(text).toMatch(/1 CHIL @I\d+@\r\n/);
    expect(text).toContain("1 MARR\r\n2 DATE 1913\r\n");
  });

  it("writes both halves of every edge, so the cross-check on the way back in passes", () => {
    const { text, mapped } = roundTrip(tree);

    expect(text).toMatch(/1 FAMS @F\d+@\r\n/);
    expect(text).toMatch(/1 FAMC @F\d+@\r\n/);
    // `reportOneSidedLinks` compares `FAMS`/`FAMC` against `HUSB`/`WIFE`/`CHIL`
    // and speaks only when they disagree.
    expect(mapped.issues).toEqual([]);
  });

  it("round-trips the partners, the child, and the marriage date", () => {
    const { input } = roundTrip(tree);

    expect(input.individuals).toHaveLength(3);
    expect(input.unions).toHaveLength(1);
    expect(input.unionChildren).toHaveLength(1);

    const [reunion] = input.unions;
    expect(reunion.type).toBe("marriage");
    expect(reunion.startDate).toBe("1913-01-01");
    expect(reunion.startDatePrecision).toBe("year");

    const partners = input.individuals.filter(
      (individual) =>
        individual.id === reunion.partnerAId ||
        individual.id === reunion.partnerBId,
    );
    expect(partners.map((individual) => individual.givenName).sort()).toEqual([
      "John",
      "Mary",
    ]);
  });

  it("writes a divorce as DIV, with the end date", () => {
    const text = writeGedcom({
      ...tree,
      unions: [
        {
          ...married,
          endReason: "divorce",
          endDate: "1920-01-01",
          endDatePrecision: "year",
        },
      ],
    });

    expect(text).toContain("1 DIV\r\n2 DATE 1920\r\n");
  });

  it("writes no DIV for a union that ended in a death", () => {
    // The date is recorded once, on the person who died, and `lib/gedcom-map.ts`
    // infers the reason back from it.
    const text = writeGedcom({
      ...tree,
      unions: [{ ...married, endReason: "death" }],
    });

    expect(text).not.toContain("1 DIV");
  });

  it("writes a bare marriage as MARR Y, which is how 5.5.1 asserts an undated event", () => {
    const text = writeGedcom({
      ...tree,
      unions: [{ ...married, type: "marriage", startDate: null }],
    });

    expect(text).toContain("1 MARR Y\r\n");
  });

  it("writes no MARR for an undated union nobody called a marriage", () => {
    const text = writeGedcom({
      ...tree,
      unions: [{ ...married, type: "unknown", startDate: null }],
    });

    expect(text).not.toContain("1 MARR");
  });

  it("leaves the column null for a partner the file does not name", () => {
    const { input } = roundTrip({
      individuals: [wife, child],
      unions: [{ ...married, partnerAId: null }],
      unionChildren: [link],
    });

    expect(input.unions[0].partnerAId).toBeNull();
    expect(input.unions[0].partnerBId).not.toBeNull();
  });

  it.each(CHILD_RELATIONS)(
    "writes %s as a PEDI and reads it back",
    (relation: ChildRelation) => {
      const { text, input } = roundTrip({
        individuals: [husband, wife, child],
        unions: [married],
        unionChildren: [{ ...link, relation }],
      });

      expect(text).toMatch(/1 FAMC @F\d+@\r\n2 PEDI \w+\r\n/);
      expect(input.unionChildren[0].relation).toBe(relation);
    },
  );
});

describe("determinism", () => {
  const people = [
    person({
      id: id(1),
      givenName: "John",
      surname: "Smith",
      birthDate: "1890-03-12",
    }),
    person({
      id: id(2),
      givenName: "Mary",
      surname: "Byrne",
      birthDate: "1893-03-01",
    }),
    person({
      id: id(3),
      givenName: "Edward",
      surname: "Smith",
      birthDate: "1915-01-01",
    }),
    person({
      id: id(4),
      givenName: "Ada",
      surname: "Smith",
      birthDate: "1918-01-01",
    }),
  ];

  const unions = [
    union({
      id: id(5),
      partnerAId: id(1),
      partnerBId: id(2),
      type: "marriage",
      startDate: "1913-01-01",
    }),
    union({ id: id(6), partnerAId: id(3), partnerBId: null, type: "marriage" }),
  ];

  const unionChildren: ExportChild[] = [
    { unionId: id(5), childId: id(3), relation: "biological" },
    { unionId: id(5), childId: id(4), relation: "adopted" },
  ];

  const tree: GedcomExportInput = {
    individuals: people,
    unions,
    unionChildren,
  };

  it("does not depend on the order the rows arrive in", () => {
    // A query with no `ORDER BY` gives no order, and two exports of one
    // unchanged database must not differ.
    const reversed: GedcomExportInput = {
      individuals: [...people].reverse(),
      unions: [...unions].reverse(),
      unionChildren: [...unionChildren].reverse(),
    };

    expect(writeGedcom(reversed)).toBe(writeGedcom(tree));
  });

  it("does not depend on the row ids, which a round trip replaces", () => {
    const shifted: GedcomExportInput = {
      individuals: people.map((individual) => ({
        ...individual,
        id: id(100 + Number(individual.id.slice(-1))),
      })),
      unions: unions.map((mappedUnion) => ({
        ...mappedUnion,
        id: id(100 + Number(mappedUnion.id.slice(-1))),
        partnerAId:
          mappedUnion.partnerAId === null
            ? null
            : id(100 + Number(mappedUnion.partnerAId.slice(-1))),
        partnerBId:
          mappedUnion.partnerBId === null
            ? null
            : id(100 + Number(mappedUnion.partnerBId.slice(-1))),
      })),
      unionChildren: unionChildren.map((childLink) => ({
        ...childLink,
        unionId: id(100 + Number(childLink.unionId.slice(-1))),
        childId: id(100 + Number(childLink.childId.slice(-1))),
      })),
    };

    expect(writeGedcom(shifted)).toBe(writeGedcom(tree));
  });

  it("holds on a tree big enough that the lookups matter", () => {
    // Every record is found through a `Map` built once rather than by scanning
    // the link and union lists per record, so this walks the grouping paths
    // with enough rows that a mis-keyed group would show up as a missing or
    // misattached family rather than as a slow test.
    const families = 120;

    const people: ExportIndividual[] = [];
    const marriages: ExportUnion[] = [];
    const links: ExportChild[] = [];

    for (let n = 0; n < families; n += 1) {
      const father = id(n * 4 + 1);
      const mother = id(n * 4 + 2);
      const first = id(n * 4 + 3);
      const second = id(n * 4 + 4);
      const home = id(n * 4 + 1000);

      people.push(
        person({ id: father, givenName: `Father${n}`, surname: `House${n}` }),
        person({ id: mother, givenName: `Mother${n}`, surname: `House${n}` }),
        person({ id: first, givenName: `First${n}`, surname: `House${n}` }),
        person({ id: second, givenName: `Second${n}`, surname: `House${n}` }),
      );

      marriages.push(
        union({
          id: home,
          partnerAId: father,
          partnerBId: mother,
          type: "marriage",
          startDate: `19${String(n % 90).padStart(2, "0")}-01-01`,
          startDatePrecision: "year",
        }),
      );

      links.push(
        { unionId: home, childId: first, relation: "biological" },
        { unionId: home, childId: second, relation: "adopted" },
      );
    }

    const big: GedcomExportInput = {
      individuals: people,
      unions: marriages,
      unionChildren: links,
    };

    const { text, mapped, input } = roundTrip(big);

    expect(mapped.issues).toEqual([]);
    expect(input.individuals).toHaveLength(families * 4);
    expect(input.unions).toHaveLength(families);
    expect(input.unionChildren).toHaveLength(families * 2);
    expect(text.match(/1 CHIL /g)).toHaveLength(families * 2);
    expect(text.match(/1 FAMS /g)).toHaveLength(families * 2);
    expect(text.match(/1 FAMC /g)).toHaveLength(families * 2);
    expect(writeGedcom(input)).toBe(text);
  });

  it("survives export, import and export unchanged — the property E7-T2 tests", () => {
    const first = writeGedcom(tree);
    const { input } = roundTrip(tree);
    const second = writeGedcom(input);

    expect(second).toBe(first);
  });
});

describe("long and multi-line values", () => {
  it("folds a value too long for one line with CONC, and reads it back whole", () => {
    // Longer than `MAX_NAME_LENGTH`, so this is a row `validateIndividual`
    // would refuse — which is the point: the folding is what keeps a row
    // written around the validators from producing a line no reader accepts.
    // Asserted against the parser rather than the mapper for that reason.
    const surname = "R".repeat(260);

    const text = writeGedcom({
      individuals: [person({ id: id(1), surname })],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("2 CONC ");

    // 5.5.1 caps a line at 255 characters, and a reader that truncates rather
    // than folding is how a surname ends up cut in half.
    for (const line of text.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(255);
    }

    const [reread] = parseGedcomText(text).individuals;
    expect(reread.names[0].surname).toBe(surname);
  });

  it("folds a newline with CONT rather than CONC", () => {
    // Getting these the wrong way round is the classic GEDCOM bug: `CONC`
    // rejoins with nothing, `CONT` with a newline. A name rather than a place,
    // because the parser does not collapse a name — so this is a value that
    // genuinely reaches the `CONT` path and survives the trip.
    const text = writeGedcom({
      individuals: [person({ givenName: "John\nHenry", surname: null })],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("2 GIVN John\r\n3 CONT Henry\r\n");
  });

  it("recovers a folded value character for character", () => {
    const place = "Q".repeat(400);

    const text = writeGedcom({
      individuals: [person({ birthPlace: place })],
      unions: [],
      unionChildren: [],
    });

    expect(parseGedcomText(text).individuals[0].birth?.place).toBe(place);
  });

  it("does not split inside a surrogate pair", () => {
    // Walking UTF-16 units instead of code points would cut an astral
    // character in half and produce two replacement characters.
    const name = "\u{1F600}".repeat(150);

    const text = writeGedcom({
      individuals: [person({ givenName: name, surname: null })],
      unions: [],
      unionChildren: [],
    });

    expect(text).not.toContain("\uFFFD");
    expect(parseGedcomText(text).individuals[0].names[0].given).toBe(name);
  });
});

describe("values written as the parser will read them", () => {
  // The round trip is a byte comparison, so a value the parser normalises has
  // to be normalised on the way out or the second export disagrees with the
  // first. These are all rows written around the validators — `readText` trims
  // on the way into the column — but the file still has to say what a reader
  // will read out of it.

  it("collapses whitespace in a place, which is what the parser does to it", () => {
    const text = writeGedcom({
      individuals: [person({ birthPlace: "Whitby,  Yorkshire" })],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("2 PLAC Whitby, Yorkshire\r\n");
  });

  it.each([
    ["a double space", "Whitby,  Yorkshire"],
    ["a tab", "Whitby,\tYorkshire"],
    ["a newline", "Whitby\nYorkshire"],
  ])(
    "round-trips a place containing %s unchanged on the second pass",
    (_label, place) => {
      const tree: GedcomExportInput = {
        individuals: [person({ id: id(1), birthPlace: place })],
        unions: [],
        unionChildren: [],
      };

      const first = writeGedcom(tree);
      expect(writeGedcom(roundTrip(tree).input)).toBe(first);
    },
  );

  it("trims a name but does not collapse it", () => {
    // The parser trims `GIVN` and `SURN` and does not collapse them, so
    // `John  Henry` is a name that survives the trip exactly as stored.
    const text = writeGedcom({
      individuals: [
        person({ givenName: "  John  Henry  ", surname: " Smith " }),
      ],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("2 GIVN John  Henry\r\n");
    expect(text).toContain("2 SURN Smith\r\n");
  });
});

describe("rows that could only have been written around the validators", () => {
  const alive = person({ id: id(1), givenName: "John", surname: "Smith" });
  const kid = person({ id: id(2), givenName: "Edward", surname: "Smith" });

  it("writes no FAM for a union with no partner this tree contains", () => {
    // `validateUnion` refuses one — "A union needs at least one partner" — so
    // the record would say nothing about anybody and would not survive the
    // trip. Dropping it before the xrefs are handed out is what keeps it from
    // shifting the numbering of the families that are intact.
    const text = writeGedcom({
      individuals: [alive],
      unions: [union({ id: id(50), type: "marriage" })],
      unionChildren: [],
    });

    expect(text).not.toContain(" FAM");
    expect(text).not.toContain("1 MARR");
  });

  it("keeps the family numbering contiguous when a union is dropped", () => {
    const text = writeGedcom({
      individuals: [alive],
      unions: [
        union({ id: id(50), type: "marriage" }),
        union({ id: id(51), partnerAId: alive.id, type: "marriage" }),
      ],
      unionChildren: [],
    });

    expect(text).toContain("0 @F1@ FAM\r\n");
    expect(text).not.toContain("@F2@");
    expect(text).toContain("1 FAMS @F1@\r\n");
  });

  it("writes no CHIL for a person who is a partner in the same family", () => {
    // `1 WIFE @I2@` beside `1 CHIL @I2@` is a contradiction no reader can
    // resolve, and `lib/gedcom-map.ts` refuses it by name on the way back in.
    const text = writeGedcom({
      individuals: [alive, kid],
      unions: [
        union({
          id: id(50),
          partnerAId: alive.id,
          partnerBId: kid.id,
          type: "marriage",
        }),
      ],
      unionChildren: [
        { unionId: id(50), childId: kid.id, relation: "biological" },
      ],
    });

    expect(text).not.toContain("1 CHIL");
    expect(text).not.toContain("1 FAMC");
  });

  it("writes one CHIL for a child link repeated", () => {
    // `union_children` is keyed on the pair, so a repeat is not a row that can
    // exist in the first place.
    const text = writeGedcom({
      individuals: [alive, kid],
      unions: [union({ id: id(50), partnerAId: alive.id, type: "marriage" })],
      unionChildren: [
        { unionId: id(50), childId: kid.id, relation: "adopted" },
        { unionId: id(50), childId: kid.id, relation: "foster" },
      ],
    });

    expect(text.match(/1 CHIL /g)).toHaveLength(1);
    expect(text.match(/2 PEDI /g)).toHaveLength(1);
  });

  it("skips a link naming a record this tree does not contain", () => {
    const text = writeGedcom({
      individuals: [alive],
      unions: [union({ id: id(50), partnerAId: alive.id, type: "marriage" })],
      unionChildren: [
        { unionId: id(50), childId: id(99), relation: "biological" },
      ],
    });

    expect(text).not.toContain("1 CHIL");
  });

  it("writes a value the schema refuses rather than quietly repairing it", () => {
    // An inverted range. `validateIndividual` is what refuses it, and it does
    // so on the way back in with a sentence on the report — reversing the
    // bounds here would hide a broken row instead of surfacing it.
    const text = writeGedcom({
      individuals: [
        person({
          birthDate: "1900-01-01",
          birthDatePrecision: "year",
          birthDateUpper: "1890-01-01",
          birthDateUpperPrecision: "year",
        }),
      ],
      unions: [],
      unionChildren: [],
    });

    expect(text).toContain("2 DATE BET 1900 AND 1890\r\n");
  });

  it("writes one FAMS for a person named in both partner columns", () => {
    // `validateUnion` refuses a person in a union with themselves, so this is
    // a row written around it — and it is the case the grouping behind `FAMS`
    // has to collapse. Counting the union once per person rather than once per
    // partner column is what keeps the same line from being written twice.
    const text = writeGedcom({
      individuals: [person({ id: id(1) })],
      unions: [
        union({
          id: id(50),
          partnerAId: id(1),
          partnerBId: id(1),
          type: "marriage",
        }),
      ],
      unionChildren: [],
    });

    expect(text.match(/1 FAMS /g)).toHaveLength(1);
    // Both columns are still written, because both are what the row says.
    expect(text).toContain("1 HUSB @I1@\r\n");
    expect(text).toContain("1 WIFE @I1@\r\n");
  });

  it("never throws, whatever the row says", () => {
    expect(() =>
      writeGedcom({
        individuals: [person({ birthDate: "not-a-date", givenName: "" })],
        unions: [union({ id: id(50), partnerAId: id(99) })],
        unionChildren: [
          { unionId: id(98), childId: id(97), relation: "biological" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("a third-party file", () => {
  const fixture = readFileSync(
    join(import.meta.dirname, "..", "test", "fixtures", "gedcom", "family.ged"),
    "utf8",
  );

  const imported = mapGedcom(parseGedcomText(fixture));

  const tree: GedcomExportInput = {
    individuals: imported.individuals.map((individual) => ({
      id: individual.id,
      ...individual.values,
    })),
    unions: imported.unions.map((mappedUnion) => ({
      id: mappedUnion.id,
      ...mappedUnion.values,
    })),
    unionChildren: imported.unionChildren,
  };

  it("comes back out with everybody and every family still in it", () => {
    const reread = parseGedcomText(writeGedcom(tree));

    expect(reread.individuals).toHaveLength(5);
    expect(reread.families).toHaveLength(2);
    expect(reread.issues).toEqual([]);
  });

  it("is stable from the first export on", () => {
    const first = writeGedcom(tree);
    const { input } = roundTrip(tree);

    expect(writeGedcom(input)).toBe(first);
  });

  it("writes a period back as a range, which docs/gedcom.md said it would", () => {
    // `BET 1880 AND 1885` in the fixture; a `FROM x TO y` would come out the
    // same way, because the schema stores the two identically.
    expect(writeGedcom(tree)).toContain("2 DATE BET 1880 AND 1885\r\n");
  });
});
