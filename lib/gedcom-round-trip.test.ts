import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { seedFamily } from "@/db/seed-family";
import { CHILD_RELATIONS } from "@/lib/child-input";
import { DATE_PRECISIONS, DATE_QUALIFIERS } from "@/lib/field-input";
import { parseGedcom, parseGedcomText } from "@/lib/gedcom";
import { decodeGedcom } from "@/lib/gedcom-encoding";
import {
  type ExportChild,
  type ExportIndividual,
  type ExportUnion,
  type GedcomExportInput,
  writeGedcom,
} from "@/lib/gedcom-export";
import { type GedcomNode, readGedcomTree } from "@/lib/gedcom-lines";
import { mapGedcom } from "@/lib/gedcom-map";
import { SEXES, validateIndividual } from "@/lib/individual-input";
import { rowsFromMapping } from "@/lib/import-rows";
import {
  UNION_END_REASONS,
  UNION_TYPES,
  validateUnion,
} from "@/lib/union-input";
import {
  diffGedcom,
  roundTrip,
  roundTripBytes,
  roundTripFile,
  splitRecords,
} from "@/test/gedcom-round-trip";

/**
 * Export -> import -> export, byte for byte (E7-T2, `YEO-52`).
 *
 * ## What is actually being claimed
 *
 * That the export is *real* rather than nearly real. E7-T1 shipped a
 * serialiser whose own tests could not see that it wrote places the parser
 * would read back differently; the defect was found by writing the file
 * twice and comparing, and this file is the systematic version of that one
 * probe. It found a second defect of the same family — see "a divorce with
 * no marriage" in `lib/gedcom-export.test.ts` — which is the evidence that
 * the class is real and that spot checks do not exhaust it.
 *
 * The property is a **fixed point**: the second export equals the first,
 * byte for byte. It is not "the export equals the file you imported", and
 * `test/gedcom-round-trip.ts` explains at length why it cannot be — a first
 * export narrows in the three places `docs/gedcom.md` lists, and `FROM x TO
 * y` is stored as a range and written back as `BET x AND y`. The fixed point
 * is the statement that the loss happens *once*: whatever the first export
 * fails to say, it fails to say the same way forever, and a family that
 * exports, re-imports and exports again gets their file back rather than a
 * slightly smaller one each time.
 *
 * ## Four subjects, and why each is here
 *
 * - **The seeded family**, because it is the graph the data model was
 *   designed around and the only one in the repository with a remarriage
 *   chain in it. A round trip that dropped a union would leave that chain
 *   half-connected, which is the "loses a generation" failure the ticket is
 *   about.
 * - **A dirty synthetic file**, because clean input is not the case that
 *   breaks. Real GEDCOM is dirty and E6 exists because of it. Every piece of
 *   dirt in it is dirt this pipeline has actually met.
 * - **A real third-party file** — the published GEDCOM 5.5 torture test,
 *   added by `YEO-92` — because the fixture above it is dirty in the ways
 *   somebody here thought to imagine, and that is a smaller set than it
 *   looks. It found three ANSEL letters this repository had never decoded.
 * - **Generated trees**, because the fixtures between them still contain only
 *   a few dozen records and the defect E7-T2 found needed a union with an end
 *   reason of `divorce`, a type that was not `marriage`, and no start date —
 *   a combination no fixture had. The generator is seeded, so it is a fixed
 *   set of trees rather than a different suite on every run.
 *
 * ## Why none of it needs a database
 *
 * Because `lib/import-rows.ts` exists. The import's transaction cannot change
 * what the rows say, so the part that decides them was split out and the trip
 * runs through it — the same function `lib/gedcom-import.ts` inserts from,
 * asserted below rather than assumed. `docs/testing.md` requires `npm test`
 * to run with no `DATABASE_URL`, and this is the ticket that would most have
 * liked an exception.
 */

const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures", "gedcom");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * The same file undecoded, for the one fixture whose encoding is not ours to
 * assume. See `roundTripBytes` in the harness.
 */
function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** The messages, which is what a failure should read as. */
function messages(divergences: { message: string }[]): string[] {
  return divergences.map((divergence) => divergence.message);
}

/**
 * Every value in a parsed file, however deep, as one searchable string.
 *
 * For the `@` escape, which the mapping cannot be asked about: the tags the
 * torture test escapes an `@` under are `ADDR` and `NOTE`, and this
 * application keeps neither. The grammar layer is where the file's own
 * escaping is visible, so that is the layer this reads.
 */
function everyValue(nodes: readonly GedcomNode[]): string {
  return nodes
    .flatMap((node) => [node.value ?? "", everyValue(node.children)])
    .join("\n");
}

/**
 * The whole property, asserted so that a failure reads as a sentence.
 *
 * Both assertions are load-bearing. The first names the record and is what
 * anybody debugging this will actually read; the second is the byte
 * comparison the acceptance criterion asks for, and it is kept because a
 * reporter that had a blind spot could otherwise pass an unequal pair. (It
 * would have to get past `diffGedcom`'s own last resort to do it, which is
 * belt and braces on purpose: this is the test that says a family can leave.)
 */
function expectRoundTrip(trip: {
  first: string;
  second: string;
  divergences: { message: string }[];
}): void {
  expect(messages(trip.divergences)).toEqual([]);
  expect(trip.second).toBe(trip.first);
}

describe("the diff names the record that diverged", () => {
  // "Failures name the specific record that diverged" is an acceptance
  // criterion, so the reporter is tested against divergences that are
  // constructed rather than waited for. Every case below is a real export
  // with one line edited, which is the shape a regression would arrive in.

  const tree: GedcomExportInput = {
    individuals: [
      person(1, {
        givenName: "John",
        surname: "Smith",
        birthDate: "1890-03-12",
      }),
      person(2, { givenName: "Mary", surname: "Byrne" }),
      person(3, { givenName: "Edward", surname: "Smith" }),
    ],
    unions: [
      union(10, { partnerAId: id(1), partnerBId: id(2), type: "marriage" }),
    ],
    unionChildren: [
      { unionId: id(10), childId: id(3), relation: "biological" },
    ],
  };

  const text = writeGedcom(tree);

  it("cuts a file into its level-0 records, losing no line", () => {
    const records = splitRecords(text);

    expect(records.map((record) => record.label)).toEqual([
      "HEAD",
      "@U1@ SUBM",
      "@I1@ INDI",
      "@I2@ INDI",
      "@I3@ INDI",
      "@F1@ FAM",
      "TRLR",
    ]);

    // Every line is in exactly one record, which is what makes "no record
    // differs" mean "no line differs".
    const lines = records.flatMap((record) => record.lines);
    expect(lines.join("\r\n") + "\r\n").toBe(text);
  });

  it("finds nothing when the two files are the same", () => {
    expect(diffGedcom(text, text)).toEqual([]);
  });

  it("names the record and the line when a value changes", () => {
    const changed = text.replace("2 DATE 12 MAR 1890", "2 DATE MAR 1890");
    const [divergence, ...rest] = diffGedcom(text, changed);

    expect(rest).toEqual([]);
    expect(divergence.kind).toBe("changed");
    expect(divergence.label).toBe("@I3@ INDI");
    expect(divergence.message).toContain("@I3@ INDI");
    expect(divergence.message).toContain('"2 DATE 12 MAR 1890" became');
    expect(divergence.message).toContain('"2 DATE MAR 1890"');
  });

  it("names a record the second export lost", () => {
    const dropped = text.replace(/0 @I3@ INDI\r\n(?:[^0].*\r\n)*/, "");
    const kinds = diffGedcom(text, dropped);

    expect(kinds.some((one) => one.kind === "missing")).toBe(true);
    expect(messages(kinds)[0]).toContain("@I3@ INDI");
    expect(messages(kinds)[0]).toContain("lost this record");
  });

  it("names a record the second export invented", () => {
    const added = text.replace(
      "0 TRLR",
      "0 @I9@ INDI\r\n1 NAME Nobody\r\n0 TRLR",
    );
    const divergences = diffGedcom(text, added);
    const invented = divergences.filter((one) => one.kind === "added");

    expect(messages(invented)).toHaveLength(1);
    expect(messages(invented)[0]).toContain("@I9@ INDI");
    expect(messages(invented)[0]).toContain("invented this record");

    // The trailer moved down to make room, and the report says so — a record
    // appearing is also every later record changing position.
    expect(
      divergences.filter((one) => one.kind === "moved").map((one) => one.label),
    ).toEqual(["TRLR"]);
  });

  it("says so when the records are the same but the order is not", () => {
    const records = splitRecords(text);
    const swapped = [records[0], records[1], records[3], records[2]]
      .concat(records.slice(4))
      .flatMap((record) => record.lines);
    const divergences = diffGedcom(text, swapped.join("\r\n") + "\r\n");

    expect(divergences.every((one) => one.kind === "moved")).toBe(true);
    expect(messages(divergences).join(" ")).toContain("@I2@ INDI");
    expect(messages(divergences).join(" ")).toContain("order is not");
  });

  it("reports a difference it cannot place rather than reporting none", () => {
    // The last resort, and it has a real case: a file whose final line is
    // unterminated cuts into exactly the same records as one whose final line
    // is terminated, so every record matches and the two files are still not
    // the same file. `writeGedcom` always terminates, which is why this is a
    // net rather than a scenario — but a net that could not be reached would
    // be a comment rather than a safeguard.
    const unterminated = text.slice(0, -"\r\n".length);
    const divergences = diffGedcom(text, unterminated);

    expect(splitRecords(unterminated).map((one) => one.lines)).toEqual(
      splitRecords(text).map((one) => one.lines),
    );
    expect(divergences.map((one) => one.kind)).toEqual(["unlocated"]);
    expect(messages(divergences)[0]).toContain("blind spot");
    expect(messages(divergences)[0]).toContain("first differ at character");
  });
});

describe("the seeded family", () => {
  // `db/seed-family.ts` rather than a literal, for the reason
  // `lib/tree-layout.seed.test.ts` gives: a copy agrees with the seed today
  // and drifts silently afterwards. It reaches no database, so importing it
  // costs this suite nothing.
  const tree: GedcomExportInput = {
    individuals: seedFamily.people,
    unions: seedFamily.unions,
    unionChildren: seedFamily.childLinks,
  };

  const trip = roundTrip(tree);

  it("exports, imports and exports again byte for byte", () => {
    expectRoundTrip(trip);
  });

  it("is read back with no complaint at all", () => {
    // A file this application wrote should be one it can read perfectly. Any
    // issue here is the export telling on itself.
    expect(trip.mapping.issues).toEqual([]);
  });

  it("brings every person back, once each, with every field intact", () => {
    expect(trip.rows.individuals).toHaveLength(seedFamily.people.length);

    for (const original of seedFamily.people) {
      const matches = trip.rows.individuals.filter(
        (row) =>
          row.givenName === original.givenName &&
          row.surname === original.surname,
      );

      expect(matches, `${original.givenName} ${original.surname}`).toHaveLength(
        1,
      );

      // Field by field rather than a whole-object compare, because `id` is
      // re-minted by design and `pageId` is not a column the exporter carries
      // — GEDCOM has nowhere to put a wiki entry, which is E7-T4's problem.
      const back = matches[0];
      for (const field of individualFields()) {
        expect(back[field], `${original.givenName}.${field}`).toEqual(
          original[field],
        );
      }
    }
  });

  it("brings every child link back, with the right relation", () => {
    expect(trip.rows.unionChildren).toHaveLength(seedFamily.childLinks.length);

    // Clara is the adopted one, and the only reason children belong to a
    // union rather than to a parent. A trip that flattened her to biological
    // would still count twelve links.
    const clara = trip.rows.individuals.find(
      (row) => row.givenName === "Clara",
    );
    const link = trip.rows.unionChildren.find(
      (row) => row.childId === clara?.id,
    );

    expect(link?.relation).toBe("adopted");
  });

  it("keeps the remarriage chain connected, and nobody doubled", () => {
    // The whole reason this family is the fixture. Thomas is widowed and
    // remarries, Rose is widowed and remarries, and the Hale and Shaw
    // children are connected only through that chain — so a union dropped in
    // the middle severs a branch while leaving a file that still looks like a
    // family tree.
    const partners = (givenName: string) => {
      const person = trip.rows.individuals.find(
        (row) => row.givenName === givenName,
      );
      return trip.rows.unions.filter(
        (row) => row.partnerAId === person?.id || row.partnerBId === person?.id,
      );
    };

    expect(partners("Thomas")).toHaveLength(2);
    expect(partners("Rose")).toHaveLength(2);
    expect(partners("Mary")).toHaveLength(1);
    expect(partners("Walter")).toHaveLength(1);

    // Mary -- Thomas -- Rose -- Walter: four unions over five adults, with
    // the two middles shared. That is the chain, and it is what the seeded
    // graph exists to hold.
    expect(trip.rows.unions).toHaveLength(seedFamily.unions.length);

    const marysUnion = partners("Mary")[0];
    const waltersUnion = partners("Walter")[0];
    expect(marysUnion.id).not.toBe(waltersUnion.id);
    expect(partners("Thomas").some((row) => row.id === marysUnion.id)).toBe(
      true,
    );
    expect(partners("Rose").some((row) => row.id === waltersUnion.id)).toBe(
      true,
    );
  });

  it("loses on a union only what docs/gedcom.md says it loses", () => {
    /**
     * The narrowings are documented, so they are asserted rather than
     * tolerated: this test fails both when a *new* loss appears and when a
     * listed one is fixed and the documentation is not.
     *
     * - `sequence` has no GEDCOM equivalent at all and is re-derived on
     *   import from family order. The seed numbers its unions from 1 and the
     *   derivation counts from 0, so every seeded union shifts by one.
     * - `end_reason` `unknown` has no family event, so Agnes's union comes
     *   back as `ongoing` — nobody said it ended, which is what the file now
     *   says.
     * - `death` is deliberately never written, and the mapper infers it from
     *   the partners' own death dates. So the two unions that ended in a
     *   death keep the reason and lose the `end_date` that duplicated it —
     *   and Rose's marriage to Walter, recorded as `ongoing` although Walter
     *   died in 1978, is inferred to have ended in his death. The seed row is
     *   the imprecise one there; the file is right.
     */
    const changes = new Set<string>();

    for (const original of seedFamily.unions) {
      const back = trip.rows.unions.find(
        (row) =>
          samePerson(row.partnerAId, original.partnerAId, trip) &&
          samePerson(row.partnerBId, original.partnerBId, trip),
      );

      expect(back, `union ${original.id}`).toBeDefined();

      for (const field of unionFields()) {
        if (back?.[field] !== original[field]) changes.add(field);
      }
    }

    expect([...changes].sort()).toEqual(["endDate", "endReason", "sequence"]);
  });
});

describe("a dirty third-party file", () => {
  /**
   * `test/fixtures/gedcom/dirty-third-party.ged` is **synthetic**: it is
   * written to look like the output of a mid-2000s Windows genealogy program
   * rather than taken from one, because a real family's file is not ours to
   * commit.
   *
   * What makes it a fair subject is that every piece of dirt in it is dirt
   * this pipeline has actually met, and each is asserted below by the issue
   * it provokes — so the fixture cannot quietly stop being dirty.
   *
   * `YEO-92` put a genuinely third-party file beside it and **kept this one**,
   * because the two fail differently and neither covers the other. This
   * fixture is a catalogue of things that go wrong — a `31 FEB`, a range
   * running backwards, a `CHIL` pointing at nothing — and the real file has
   * none of them, being a valid file whose author was testing tag coverage
   * rather than dirt. Every assertion below is about a message this pipeline
   * produces, and losing them to replace a synthetic file with a real one
   * would trade a suite that says what went wrong for one that says a
   * stranger's file survived.
   */
  const text = fixture("dirty-third-party.ged");
  const trip = roundTripFile(text);

  it("is as dirty as it claims to be", () => {
    const said = trip.imported.issues.map((issue) => issue.message).join("\n");

    expect(said).toContain('"31 FEB 1943" could not be read'); // a date that is not a day
    expect(said).toContain('"UNKNOWN" could not be read'); // a date that is not a date
    expect(said).toContain('"?" is not a sex'); // a value out of vocabulary
    expect(said).toContain("first name is not recorded"); // `1 NAME //`
    expect(said).toContain("has 2 names in the file"); // two NAME records
    expect(said).toContain("upper bound of the birth date is before"); // BET 1902 AND 1899
    expect(said).toContain("names I04 more than once"); // a repeated CHIL
    expect(said).toContain("names I99, which is not a record"); // a dangling pointer
    expect(said).toContain("names F09, which is not a record"); // a dangling FAMC
    expect(said).toContain("who is also a partner in this family"); // a self-contradictory CHIL
    expect(said).toContain("A union needs at least one partner"); // a FAM about nobody
    expect(said).toContain('"sealing" is a religious ordinance'); // a PEDI out of vocabulary
    expect(said).toContain("nowhere to keep a place"); // MARR.PLAC, a documented loss
  });

  it("is read as UTF-8 in spite of saying ANSI, and in spite of the BOM", () => {
    // `1 CHAR ANSI` is not accepted as a synonym for anything (see
    // docs/gedcom.md), and the byte order mark decides ahead of the
    // declaration. Both matter to the round trip: a file decoded as ANSEL
    // would round-trip perfectly and be the wrong text.
    const parsed = parseGedcom(
      new Uint8Array(readFileSync(join(FIXTURES, "dirty-third-party.ged"))),
    );

    expect(parsed.encoding).toBe("utf-8");
    expect(text.startsWith("﻿")).toBe(true);
  });

  it("has mixed line endings, which the round trip must not inherit", () => {
    expect(text).toContain("\r\n");
    expect(/[^\r]\n/.test(text)).toBe(true);
    // Whatever came in, what goes out is CRLF and nothing else.
    expect(/[^\r]\n/.test(trip.first)).toBe(false);
  });

  it("still has everybody it could keep after the trip", () => {
    // Six of the seven INDI records: Cornelius is refused, with a sentence
    // saying why. Losing a seventh silently is the failure this counts.
    expect(trip.rows.individuals).toHaveLength(6);
    expect(trip.rows.unions).toHaveLength(2);
    expect(trip.rows.unionChildren).toHaveLength(2);
  });

  it("exports, imports and exports again byte for byte", () => {
    expectRoundTrip(trip);
  });

  it("is a fixed point rather than merely settling on the second pass", () => {
    // A third pass, because "stable" and "stable so far" are different
    // claims. If the second export were a different file that happened to
    // export to itself, this is what would catch it.
    const third = roundTrip(trip.rows);

    expectRoundTrip(third);
    expect(third.first).toBe(trip.first);
  });

  it("keeps the two people it cannot tell apart apart", () => {
    // @I01@ and @I07@ are both "Ernest Albert Tremaine, ABT 1871", identical
    // in every field the export sorts on. They fall through to the caller's
    // order, which is the one tie-break that is not derived from the file —
    // so this is the case where two records could collapse into one, or swap
    // on every pass, and nobody would notice from the counts.
    const ernests = trip.rows.individuals.filter(
      (row) => row.givenName === "Ernest Albert",
    );

    expect(ernests).toHaveLength(2);
    expect(ernests.filter((row) => row.birthPlace !== null)).toHaveLength(1);
  });

  it("writes the period as a range, and is byte-identical from then on", () => {
    // `2 DATE FROM 1874 TO 1876` in the file. The schema stores a period and
    // a range identically, and an export writes `BET x AND y` — so this
    // record is *not* byte-identical to its own first export, by design, and
    // is byte-identical from the first export onward. That distinction is the
    // reason the property is a fixed point rather than a comparison with the
    // input.
    expect(text).toContain("2 DATE FROM 1874 TO 1876");
    expect(trip.first).not.toContain("FROM 1874 TO 1876");
    expect(trip.first).toContain("2 DATE BET 1874 AND 1876\r\n");
  });
});

describe("a real third-party file", () => {
  /**
   * `test/fixtures/gedcom/TGC55C.ged` is the **GEDCOM 5.5 Torture Test**:
   * H. Eichmann's 1997 file as extended by J. A. Nairn, published since 2003
   * and committed here unmodified. `test/fixtures/gedcom/README.md` records
   * where it came from, when, and on what terms.
   *
   * It is here because the fixture beside it is synthetic (`YEO-92`). A
   * synthetic file is dirty in the ways somebody thought to imagine, and
   * `YEO-52` made the limit of that concrete: the `DIV`-without-`MARR` defect
   * was found by 500 generated trees rather than by either fixture, because it
   * needed a combination no hand-written file happened to contain. Generated
   * trees cover the shapes this schema can hold. A file written by somebody
   * who had never seen this application covers the shapes it cannot.
   *
   * It earned its place immediately. The file spells out the whole upper half
   * of ANSEL a byte at a time, with a label on each — and three of the bytes
   * came back as replacement characters that the standard does assign, which
   * is the defect `lib/ansel.ts` was fixed for. Nothing invented the case
   * because nobody here would have thought to write a fixture that recites a
   * character set.
   */
  const bytes = fixtureBytes("TGC55C.ged");
  const trip = roundTripBytes(bytes);

  it("is read as ANSEL on the strength of its own declaration", () => {
    // No byte order mark and no UTF-8 to fall back on: `HEAD.CHAR` is the
    // only evidence, which is the branch `accents-ansel.ged` cannot test
    // honestly because we encoded that one ourselves knowing the answer.
    expect(trip.parsed.declaredEncoding).toBe("ANSEL");
    expect(trip.parsed.encoding).toBe("ansel");
    expect(bytes[0]).toBe("0".charCodeAt(0));
  });

  it("is terminated with carriage returns and nothing else", () => {
    // Legal in 5.5, emitted by Mac-era software, and a form no other fixture
    // here has. What comes out is CRLF regardless, as 5.5.1 requires.
    expect(bytes.includes(0x0d)).toBe(true);
    expect(bytes.includes(0x0a)).toBe(false);
    expect(/[^\r]\n/.test(trip.first)).toBe(false);
  });

  it("decodes to real letters, with four refusals it names itself", () => {
    // The file recites ANSEL byte by byte with a description of each, so what
    // this application does with the character set is legible in the fixture
    // rather than only in `lib/ansel.test.ts`. Every remaining replacement
    // character sits on a line the file has already labelled "LDS extension"
    // — an addition to ANSEL rather than part of it, with no Unicode
    // character that means the same thing. That is the narrowing, and the
    // count is exact so that a fifth one cannot appear unremarked.
    const text = decodeGedcom(bytes).text;
    const refused = text.split("\r").filter((line) => line.includes("�"));

    expect(refused).toHaveLength(4);
    for (const line of refused) expect(line).toContain("LDS extension");

    // And the three that were refused before `YEO-92` and are not any more.
    expect(text).toContain("ơ");
    expect(text).toContain("ư");
    expect(text).toContain("ß");
    expect(text).toContain("1 COPR © 1997 by H. Eichmann");
  });

  it("uses 124 tag paths with nowhere to go, and reports every one", () => {
    // "Nothing is dropped in silence" is a contract every other fixture tests
    // against a handful of tags somebody chose. This file uses most of 5.5,
    // including six whole record types with no table behind them and a vendor
    // extension — and the exact count is asserted because the interesting
    // regression is the list getting *shorter* without the parser learning
    // anything.
    const paths = trip.parsed.unknownTags.map((entry) => entry.path);

    expect(paths).toHaveLength(124);
    expect(paths).toEqual(expect.arrayContaining(["SUBM", "SUBN", "REPO"]));
    expect(paths).toContain("HEAD._HME"); // a vendor tag from 1998
    // The name pieces the mapping cannot keep. `@PERSON1@` is "Prof. Joseph
    // 'Joe' Le Torture Jr." in the file and "Joseph Torture" in this tree, and
    // these four entries are the difference being stated rather than lost.
    expect(paths).toEqual(
      expect.arrayContaining([
        "INDI.NAME.NPFX",
        "INDI.NAME.NICK",
        "INDI.NAME.SPFX",
        "INDI.NAME.NSFX",
      ]),
    );
  });

  it("provokes four narrowings and no complaint of any other kind", () => {
    // The acceptance criterion is that whatever a real file exposes is either
    // fixed or written down. These four are written down in `docs/gedcom.md`;
    // the ANSEL gaps were the fixed ones. Asserting the length is what makes
    // this an inventory rather than a sample: a fifth issue is a fifth thing
    // this application does to somebody's file, and it should have to be
    // added here on purpose.
    const said = trip.imported.issues.map((issue) => issue.message);
    const places = said.filter((message) =>
      message.includes("nowhere to keep a place"),
    );

    expect(said).toHaveLength(4);
    expect(said.join("\n")).toContain(
      '"INT 1995 (from estimated age)" was interpreted from a phrase',
    );
    expect(said.join("\n")).toContain('"William John Smith" left out'); // 2 NAMEs
    expect(places).toHaveLength(2); // the PLAC on MARR and the one on DIV
  });

  it("has its doubled at-signs read as the single ones they spell", () => {
    /**
     * The fixture that found `YEO-105`, tested against the thing it was
     * written to catch. It escapes an `@` the way 5.5.1 says to in four
     * places, and then — being a torture test — explains in prose what it
     * expects a reader to do about it:
     *
     * > If all "at" signs above appear above as 2 or 4 at signs, that GEDCOM
     * > software is not converting double at signs to single at signs.
     *
     * This repository was that software until now. The last assertion is the
     * pleasing one: the file escapes a literal `@@` as `@@@@`, so a reader
     * that halved everything blindly would fail it in the other direction.
     */
    const values = everyValue(readGedcomTree(decodeGedcom(bytes).text).records);

    expect(values).toContain("email: h.eichmann@mbox.iqo.uni-hannover.de");
    expect(values).toContain("or: heiner_eichmann@h.maus.de");
    expect(values).toContain("A single @ sign in some notes");
    expect(values).toContain('the "@" sign should appear in any text');
    expect(values).toContain('as double "@@" signs');
  });

  it("refuses nobody: every record it holds survives to the rows", () => {
    // Unlike the synthetic fixture, which is written with a person the
    // validators must decline. Nothing in a file this awkward happens to be
    // a shape this schema refuses, which is worth knowing.
    expect(trip.parsed.individuals).toHaveLength(15);
    expect(trip.parsed.families).toHaveLength(7);
    expect(trip.rows.individuals).toHaveLength(15);
    expect(trip.rows.unions).toHaveLength(7);
    expect(trip.rows.unionChildren).toHaveLength(10);
  });

  it("exports, imports and exports again byte for byte", () => {
    expectRoundTrip(trip);
  });

  it("is a fixed point rather than merely settling on the second pass", () => {
    const third = roundTrip(trip.rows);

    expectRoundTrip(third);
    expect(third.first).toBe(trip.first);
  });
});

/**
 * A value with an `@` in it (`YEO-105`).
 *
 * The one thing asserted in this file that is not about bytes, and it is here
 * because of a defect the fixed point structurally could not see.
 *
 * `lib/gedcom-lines.ts` never undid GEDCOM's `@@` escape and
 * `lib/gedcom-export.ts` never put it back, so a surname of `O@@Brien` parsed
 * to `O@@Brien` and exported as `O@@Brien`. The two errors cancelled exactly:
 * the file was a perfect fixed point, every assertion above passed, and the
 * database held a name nobody has for as long as it took somebody to read the
 * torture test by hand.
 *
 * The generated trees below could not see it either, and for a sharper reason
 * worth writing down: their values reach the file through the same encoder,
 * so whatever the encoder leaves out the generator leaves out too, and the
 * trip agrees with itself about the omission. A round trip proves that a
 * pipeline is *self-consistent*. It cannot prove the value in the middle is
 * the value that went in — only an assertion on that value can, which is what
 * this describe is.
 */
describe("a value with an @ in it", () => {
  const givenName = "@home";
  const surname = "O@Brien";
  const birthPlace = "St @ Mary, Ceredigion";

  const trip = roundTrip({
    individuals: [
      person(1, { givenName, surname, birthPlace }),
      person(2, { givenName: "Mary", surname: "Byrne" }),
    ],
    unions: [union(100, { partnerAId: id(1), partnerBId: id(2) })],
    unionChildren: [],
  });

  it("exports, imports and exports again byte for byte", () => {
    // The property the old code also had, and which is why it was not enough.
    expectRoundTrip(trip);
  });

  it("writes the @ doubled, and the pointers' @s single", () => {
    expect(trip.first).toContain("2 GIVN @@home\r\n");
    expect(trip.first).toContain("2 SURN O@@Brien\r\n");
    expect(trip.first).toContain("2 PLAC St @@ Mary, Ceredigion\r\n");
    expect(trip.first).toMatch(/1 HUSB @I\d+@\r\n/);
  });

  it("comes back as the same value and not merely as the same bytes", () => {
    const back = trip.rows.individuals.find((row) => row.surname === surname);

    expect(back).toBeDefined();
    expect(back?.givenName).toBe(givenName);
    expect(back?.birthPlace).toBe(birthPlace);
  });

  it("puts the doubled spelling nowhere in the rows", () => {
    // The inverse of the assertion above, and the one that fails loudest on
    // the code this replaced: `@@` is a thing files contain and columns do
    // not.
    const stored = trip.rows.individuals.flatMap((row) => [
      row.givenName,
      row.surname,
      row.birthPlace,
    ]);

    expect(stored.join("\n")).not.toContain("@@");
  });

  it("keeps the family connected, so nothing read an escape as a delimiter", () => {
    // The other half of the ordering: an `@` that reached the xref parse
    // would have made `@I1@` unreadable and left this union with no partners.
    expect(trip.rows.unions).toHaveLength(1);
    expect(trip.rows.unions[0].partnerAId).not.toBeNull();
    expect(trip.rows.unions[0].partnerBId).not.toBeNull();
  });
});

describe("the fixtures the rest of the suite already uses", () => {
  // Cheap, and they cover ground the dirty fixture does not: `family.ged` has
  // every qualifier, and the continuation file has `CONC` and unknown tags.
  it.each(["family.ged", "continuations-crlf.ged", "accents-utf8.ged"])(
    "%s survives the trip byte for byte",
    (name) => {
      expectRoundTrip(roundTripFile(fixture(name)));
    },
  );
});

describe("trees the application can hold", () => {
  /**
   * Generated trees, run through the validators first.
   *
   * The domain of the property is every tree this application can *hold* —
   * which is every tree that got past `validateIndividual` and `validateUnion`,
   * because that is the only way a row reaches the database. So the generator
   * makes trees freely and then canonicalises them through those two
   * functions, dropping what they refuse. A row written around them is a
   * different question, deliberately answered elsewhere: `lib/gedcom-export.
   * test.ts` covers what the exporter does with one, and the answer is that
   * it writes it faithfully and the import declines it.
   *
   * Seeded, so this is a fixed set of 500 trees and a failure reproduces. The
   * pool is small and deliberately nasty — names and places that collide on
   * the sort key, that the parser normalises, that look like GEDCOM syntax —
   * because the interesting failures are collisions and normalisations rather
   * than exotic values.
   */
  const trees = generateTrees(500);

  it("generates trees with something in them", () => {
    // A generator that quietly produced 500 empty trees would pass every
    // assertion below, so it is checked rather than assumed.
    const people = trees.reduce((sum, one) => sum + one.individuals.length, 0);
    const unions = trees.reduce((sum, one) => sum + one.unions.length, 0);
    const links = trees.reduce((sum, one) => sum + one.unionChildren.length, 0);

    expect(people).toBeGreaterThan(500);
    expect(unions).toBeGreaterThan(100);
    expect(links).toBeGreaterThan(50);
  });

  it("round-trips every one of them byte for byte", () => {
    const broken: string[] = [];

    for (const [index, tree] of trees.entries()) {
      const trip = roundTrip(tree);
      if (trip.divergences.length === 0) continue;

      broken.push(`tree ${index}: ${trip.divergences[0].message}`);
    }

    expect(broken).toEqual([]);
  });
});

describe("the pipeline this tests is the pipeline that runs", () => {
  it("imports the rows through the same function the database import does", () => {
    /**
     * Structural rather than behavioural, in the manner of
     * `lib/gedcom.purity.test.ts`. Everything above proves a property of
     * `roundTrip`, and `roundTrip` is only worth anything if its middle step
     * is the real import's middle step. Nothing about the assertions above
     * would change if somebody inlined the flattening back into
     * `lib/gedcom-import.ts` and left this test round-tripping through a
     * copy that had stopped agreeing with it.
     */
    const source = readFileSync(
      join(import.meta.dirname, "gedcom-import.ts"),
      "utf8",
    );

    expect(source).toContain('from "@/lib/import-rows"');
    expect(source).toContain("rowsFromMapping(mapping)");

    // And the flattening itself is not repeated there: three `.map` calls
    // over the mapping is what this replaced.
    expect(source).not.toContain("mapping.individuals.map");
    expect(source).not.toContain("mapping.unions.map");
  });

  it("exports with the same serialiser at both ends of the trip", () => {
    // `roundTrip` calls `writeGedcom` twice, and a trip whose second leg used
    // anything else would be comparing two things rather than testing one.
    const source = readFileSync(
      join(import.meta.dirname, "..", "test", "gedcom-round-trip.ts"),
      "utf8",
    );

    expect(source.match(/writeGedcom\(/g)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------
 * Fixture builders
 * ---------------------------------------------------------------------- */

/** A uuid-shaped id, since `validateUnion` refuses anything else. */
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function person(
  n: number,
  overrides: Partial<ExportIndividual> = {},
): ExportIndividual {
  return {
    id: id(n),
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
    portraitKey: null,
    portraitThumbKey: null,
    ...overrides,
  };
}

function union(n: number, overrides: Partial<ExportUnion> = {}): ExportUnion {
  return {
    id: id(n),
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

/** The columns an export carries, which is every one but `id` and `notes`. */
function individualFields(): (keyof ExportIndividual)[] {
  return (Object.keys(person(0)) as (keyof ExportIndividual)[]).filter(
    (field) => field !== "id" && field !== "notes",
  );
}

/** As above, and without the partner ids, which are compared by person. */
function unionFields(): (keyof ExportUnion)[] {
  return (Object.keys(union(0)) as (keyof ExportUnion)[]).filter(
    (field) =>
      field !== "id" &&
      field !== "notes" &&
      field !== "partnerAId" &&
      field !== "partnerBId",
  );
}

/** Whether two partner slots hold the same person across the trip. */
function samePerson(
  after: string | null,
  before: string | null,
  trip: { rows: { individuals: readonly ExportIndividual[] } },
): boolean {
  if (after === null || before === null) return after === before;

  const back = trip.rows.individuals.find((row) => row.id === after);
  const original = seedFamily.people.find((row) => row.id === before);

  return (
    back !== undefined &&
    original !== undefined &&
    back.givenName === original.givenName &&
    back.surname === original.surname
  );
}

/* -------------------------------------------------------------------------
 * The generator
 * ---------------------------------------------------------------------- */

/**
 * Values chosen to collide and to provoke normalisation.
 *
 * Every one of these is something the parser, the validators or the sort
 * order has an opinion about: repeated whitespace (which `PLAC` collapses and
 * `GIVN` does not), leading and trailing space (which every column trims),
 * text that looks like a GEDCOM line, text that looks like a pointer, a
 * slash (which is `NAME`'s own delimiter), and two spellings of the same
 * accented letter (composed and decomposed).
 *
 * The three containing an `@` were here before `YEO-105` and passed anyway,
 * which is the limit of the property rather than of the pool: the generator
 * writes its values through the same encoder the trip reads them back with,
 * so an escape neither side performed was invisible to both. They exercise
 * the escaping now. The assertion that the value is *unchanged* is above, in
 * "a value with an `@` in it", and had to be written by hand.
 */
const NASTY = [
  "John",
  "Ada",
  "Mary",
  "Smith",
  "Hale",
  "O'Meara",
  "van der Berg",
  "  John  Henry  ",
  "double  space",
  "trailing ",
  " leading",
  "Tab\there",
  "Line1\nLine2",
  "A/B",
  "Mc/Donald",
  "@home",
  "@@x",
  "O@Brien",
  "0 HEAD",
  "1 NAME fake",
  "José",
  "José",
  "Zürich",
  "Zürich",
  "日本語",
  "\u{1d49c}lice",
  "Whitby, Yorkshire",
  "Whitby,  Yorkshire",
  "Whitby\tYorkshire",
  "Whitby\nYorkshire",
];

/**
 * Build a fixed set of trees.
 *
 * The linear congruential generator is spelled out rather than imported so
 * the sequence is a property of this file: a suite whose subjects changed
 * with a dependency's version would be a different suite on a different day,
 * which is the thing a seeded generator exists to avoid.
 */
function generateTrees(count: number): GedcomExportInput[] {
  let seed = 1_234_567;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return seed / 0x7fff_ffff;
  };
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)];

  /** An ISO date at or after a year, so a generated row is self-consistent. */
  const dateAfter = (from: number) => {
    const year = from + Math.floor(next() * 25);
    const month = 1 + Math.floor(next() * 12);
    const day = 1 + Math.floor(next() * 28);
    return {
      year,
      date:
        `${String(year).padStart(4, "0")}-` +
        `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    };
  };

  const trees: GedcomExportInput[] = [];

  for (let n = 0; n < count; n++) {
    const people: ExportIndividual[] = [];

    for (let p = 0; p < 1 + Math.floor(next() * 8); p++) {
      const birth = next() < 0.2 ? null : dateAfter(1850);
      const death =
        next() < 0.3 ? null : dateAfter(birth ? birth.year + 1 : 1880);

      const candidate = person(p + 1, {
        givenName: pick(NASTY),
        surname: next() < 0.15 ? null : pick(NASTY),
        sex: pick(SEXES),
        birthDate: birth?.date ?? null,
        birthDateQualifier: pick(DATE_QUALIFIERS),
        birthDatePrecision: pick(DATE_PRECISIONS),
        birthDateUpper:
          birth && next() < 0.5 ? dateAfter(birth.year).date : null,
        birthDateUpperPrecision: pick(DATE_PRECISIONS),
        birthPlace: next() < 0.3 ? null : pick(NASTY),
        deathDate: death?.date ?? null,
        deathDateQualifier: pick(DATE_QUALIFIERS),
        deathDatePrecision: pick(DATE_PRECISIONS),
        deathDateUpper:
          death && next() < 0.5 ? dateAfter(death.year).date : null,
        deathDateUpperPrecision: pick(DATE_PRECISIONS),
        deathPlace: next() < 0.3 ? null : pick(NASTY),
      });

      const checked = validateIndividual(candidate);
      if (checked.ok) people.push({ id: candidate.id, ...checked.value });
    }

    const held = people.map((one) => one.id);
    const unions: ExportUnion[] = [];

    for (let u = 0; u < Math.floor(next() * 6) && held.length > 0; u++) {
      const start = next() < 0.2 ? null : dateAfter(1870);
      const endReason = pick(UNION_END_REASONS);
      const end =
        endReason === "ongoing" || next() < 0.3
          ? null
          : dateAfter(start ? start.year + 1 : 1900);

      // Biased towards the first two people, so that remarriage chains form
      // rather than every union being a fresh pair.
      const partner = () =>
        next() < 0.6
          ? held[Math.floor(next() * Math.min(2, held.length))]
          : pick(held);

      const candidate = union(100 + u, {
        partnerAId: next() < 0.1 ? null : partner(),
        partnerBId: next() < 0.2 ? null : partner(),
        type: pick(UNION_TYPES),
        startDate: start?.date ?? null,
        startDateQualifier: pick(DATE_QUALIFIERS),
        startDatePrecision: pick(DATE_PRECISIONS),
        startDateUpper:
          start && next() < 0.5 ? dateAfter(start.year).date : null,
        startDateUpperPrecision: pick(DATE_PRECISIONS),
        endDate: end?.date ?? null,
        endDateQualifier: pick(DATE_QUALIFIERS),
        endDatePrecision: pick(DATE_PRECISIONS),
        endDateUpper: end && next() < 0.5 ? dateAfter(end.year).date : null,
        endDateUpperPrecision: pick(DATE_PRECISIONS),
        endReason,
        sequence: Math.floor(next() * 3),
      });

      const checked = validateUnion(candidate);
      if (checked.ok) unions.push({ id: candidate.id, ...checked.value });
    }

    const unionChildren: ExportChild[] = [];
    for (let c = 0; c < Math.floor(next() * 9) && unions.length > 0; c++) {
      unionChildren.push({
        unionId: pick(unions).id,
        childId: pick(held),
        relation: pick(CHILD_RELATIONS),
      });
    }

    trees.push({ individuals: people, unions, unionChildren });
  }

  return trees;
}

/** Kept honest: the two vocabularies the generator draws from are complete. */
describe("the generator draws from the real vocabularies", () => {
  it("uses every member of every enum the export distinguishes", () => {
    // If somebody adds a `union_end_reason` member, these arrays grow and the
    // generator covers it without anybody remembering to. Asserted so that a
    // future hand-written list here would be caught.
    expect(SEXES.length).toBeGreaterThan(1);
    expect(UNION_TYPES.length).toBeGreaterThan(1);
    expect(UNION_END_REASONS.length).toBeGreaterThan(1);
    expect(CHILD_RELATIONS.length).toBeGreaterThan(1);
    expect(DATE_QUALIFIERS.length).toBeGreaterThan(1);
    expect(DATE_PRECISIONS.length).toBeGreaterThan(1);
  });

  it("does not round-trip a mapping it never parsed", () => {
    // A sanity check on the harness itself: `roundTrip` must actually go
    // through the parser, so a tree whose file the parser could not read
    // would come back empty rather than passing by identity.
    expect(
      mapGedcom(parseGedcomText("0 HEAD\r\n0 TRLR\r\n")).individuals,
    ).toHaveLength(0);
    expect(
      rowsFromMapping(mapGedcom(parseGedcomText(""))).individuals,
    ).toHaveLength(0);
  });
});
