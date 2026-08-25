import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseGedcomText } from "@/lib/gedcom";
import { mapGedcom } from "@/lib/gedcom-map";
import type { GedcomSkip } from "@/lib/gedcom-report";
import {
  type GedcomRead,
  type ImportCounts,
  summariseImport,
} from "@/lib/import-preview";
import {
  buildImportReport,
  formatImportReport,
  type ImportReport,
  importReportFilename,
  REPORT_ROWS_SHOWN,
} from "@/lib/import-report";

/**
 * The import report (E6-T5, `YEO-50`).
 *
 * Driven directly, with no route and no DOM, because the module is a function
 * from a read file and a count to a value — the same shape
 * `lib/import-preview.test.ts` gets to use and for the same reason
 * (docs/testing.md).
 *
 * The report is the one place in this pipeline that answers a question about
 * *the past* rather than about a file, so the habit worth naming is the
 * opposite of the preview's: `created` is asserted against a number this test
 * makes up, never against the mapping, because a report that derived what was
 * written from what was read could not report a disagreement between them.
 */

const FIXTURE = "test/fixtures/gedcom/family.ged";

/** A read file, as `readGedcom` would have produced it. */
function read(text: string): GedcomRead {
  const file = parseGedcomText(text);
  const mapping = mapGedcom(file);
  return { file, mapping, preview: summariseImport(file, mapping) };
}

/** A minimal well-formed file wrapping whatever records a test needs. */
function file(...records: string[]): string {
  return ["0 HEAD", "1 CHAR UTF-8", ...records, "0 TRLR", ""].join("\n");
}

/** The report of some GEDCOM text, with the write's counts supplied. */
function report(
  text: string,
  created: ImportCounts = { people: 0, unions: 0, children: 0 },
): ImportReport {
  return buildImportReport(read(text), created);
}

/** The report of the shared fixture, which is what a good file looks like. */
function fixtureReport(): ImportReport {
  const text = readFileSync(new URL(`../${FIXTURE}`, import.meta.url), "utf8");
  return buildImportReport(read(text), {
    people: 5,
    unions: 2,
    children: 2,
  });
}

/** A file with one person the validator refuses: a death before a birth. */
const REFUSED = file(
  "0 @I1@ INDI",
  "1 NAME Ann /Reed/",
  "1 BIRT",
  "2 DATE 1900",
  "1 DEAT",
  "2 DATE 1890",
);

describe("what was created", () => {
  it("counts what the write inserted, not what the reading predicted", () => {
    // The whole reason the counts are a parameter. If a transaction ever
    // lands fewer rows than the mapping held, the report is the only thing
    // that can say so — and it cannot say so if it recomputes them.
    const result = report(file("0 @I1@ INDI", "1 NAME Ann /Reed/"), {
      people: 0,
      unions: 0,
      children: 0,
    });

    expect(result.created.people).toBe(0);
    expect(result.found.people).toBe(1);
  });

  it("carries the file's own totals beside them", () => {
    const result = fixtureReport();

    expect(result.created).toEqual({ people: 5, unions: 2, children: 2 });
    expect(result.found).toEqual({ people: 5, unions: 2 });
  });
});

describe("what was skipped", () => {
  it("names the record and the reason for every one", () => {
    // The acceptance criterion, and the reason `skipped` is a kind of its own
    // rather than a sentence inside `value`: the record is a value, so this
    // assertion needs no substring matching at all.
    const result = report(REFUSED);

    expect(result.skipped.total).toBe(1);
    expect(result.skipped.rows[0].record).toEqual({
      tag: "INDI",
      xref: "I1",
      label: "Ann Reed",
    });
    expect(result.skipped.rows[0].message).toContain("before the birth date");
    expect(result.skipped.rows[0].line).toBeGreaterThan(0);
  });

  it("names a link that went with a refused person", () => {
    const result = report(
      file(
        "0 @I1@ INDI",
        "1 NAME Ann /Reed/",
        "1 BIRT",
        "2 DATE 1900",
        "1 DEAT",
        "2 DATE 1890",
        "0 @I2@ INDI",
        "1 NAME Bob /Reed/",
        "0 @F1@ FAM",
        "1 HUSB @I1@",
        "1 WIFE @I2@",
      ),
    );

    // The person, and the partner link that could not be filled because of
    // them. The second names Ann too — she is who is missing from the family,
    // not the family that survived without her.
    expect(result.skipped.rows.map((skip) => skip.record.tag)).toEqual([
      "INDI",
      "FAM.HUSB",
    ]);
    expect(result.skipped.rows[1].record.label).toBe("Ann Reed");
  });

  it("leaves a pointer at nothing out of the skips", () => {
    // A `CHIL` naming a record the file does not contain is the file
    // disagreeing with itself, which is what `pointer` means. Counting it as
    // a skip would be two kinds truthfully describing one issue — the failure
    // `lib/gedcom-report.ts` keeps two lists to avoid.
    const result = report(
      file(
        "0 @I1@ INDI",
        "1 NAME Ann /Reed/",
        "0 @F1@ FAM",
        "1 HUSB @I1@",
        "1 CHIL @I9@",
      ),
    );

    expect(result.skipped.total).toBe(0);
    expect(
      result.warnings.find((warning) => warning.kind === "pointer")?.count,
    ).toBe(1);
  });

  it("says so plainly when a file skipped nothing", () => {
    expect(fixtureReport().skipped).toEqual({ total: 0, rows: [] });
  });
});

describe("what was approximated", () => {
  it("carries the mapper's narrowed issues through unchanged", () => {
    // Byte for byte, which `docs/gedcom.md` has asked for since E6-T2: those
    // losses are decisions with reasons, already worded for the person who
    // has to act on them, and a second wording would be one loss with two
    // spellings in one report.
    const result = fixtureReport();
    const narrowed = mapGedcom(
      parseGedcomText(
        readFileSync(new URL(`../${FIXTURE}`, import.meta.url), "utf8"),
      ),
    ).issues.filter((issue) => issue.kind === "narrowed");

    expect(result.approximated.total).toBe(narrowed.length);
    expect(result.approximated.rows.map((row) => row.message)).toEqual(
      narrowed.map((issue) => issue.message),
    );
    expect(result.approximated.rows[0].message).toContain("EST 1918");
  });

  it("keeps them out of the grouped warnings, so one loss is listed once", () => {
    const result = fixtureReport();

    expect(result.approximated.total).toBeGreaterThan(0);
    expect(result.warnings.map((warning) => warning.kind)).not.toContain(
      "narrowed",
    );
    expect(result.warnings.map((warning) => warning.kind)).not.toContain(
      "skipped",
    );
  });
});

describe("tags this application does not read", () => {
  it("lists them so the gap is visible rather than assumed absent", () => {
    const result = fixtureReport();

    // `HEAD.SOUR` and friends: valid GEDCOM with nowhere to go. The point of
    // the section is that somebody who deletes their original file has been
    // told what this does not hold.
    expect(result.unsupportedTags.total).toBeGreaterThan(0);
    expect(result.unsupportedTagOccurrences).toBeGreaterThanOrEqual(
      result.unsupportedTags.total,
    );
    expect(result.unsupportedTags.rows[0]).toMatchObject({
      path: expect.any(String),
      count: expect.any(Number),
      firstLine: expect.any(Number),
    });
  });
});

describe("the character set", () => {
  it("repeats the preview's reading rather than deciding again", () => {
    const source = read(file("0 @I1@ INDI", "1 NAME Ann /Reed/"));
    const result = buildImportReport(source, {
      people: 1,
      unions: 0,
      children: 0,
    });

    expect(result.encoding).toBe(source.preview.encoding);
    expect(result.misdeclaredEncoding).toBe(source.preview.misdeclaredEncoding);
  });
});

describe("the cap that keeps a report sendable", () => {
  it("lists at most REPORT_ROWS_SHOWN and still counts them all", () => {
    // A file of pure noise is the case: `lib/gedcom-lines.ts` raises one
    // issue per unreadable line, and the platform caps a response body. The
    // count has to survive the cap, because the count is the finding.
    const noise = Array.from(
      { length: REPORT_ROWS_SHOWN + 20 },
      (_, index) => `not a gedcom line ${index}`,
    ).join("\n");

    const lines = report(noise).warnings.find(
      (warning) => warning.kind === "line",
    );

    expect(lines?.count).toBe(REPORT_ROWS_SHOWN + 20);
    expect(lines?.examples).toHaveLength(REPORT_ROWS_SHOWN);
  });

  it("caps the skips the same way", () => {
    const many = file(
      ...Array.from(
        { length: REPORT_ROWS_SHOWN + 3 },
        (_, index) =>
          `0 @I${index}@ INDI\n1 NAME Ann /Reed/\n1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1890`,
      ),
    );

    const result = report(many);

    expect(result.skipped.total).toBe(REPORT_ROWS_SHOWN + 3);
    expect(result.skipped.rows).toHaveLength(REPORT_ROWS_SHOWN);
  });
});

describe("the downloaded text", () => {
  const heading = {
    fileName: "grandad.ged",
    importedAt: new Date("2026-08-25T09:00:00Z"),
  };

  function text(result: ImportReport): string {
    return formatImportReport(result, heading);
  }

  it("has all four sections even when there is nothing in them", () => {
    // An empty heading says "nothing was skipped", which is a finding. An
    // absent one says nothing at all, and silence is what this replaces.
    const written = text(
      buildImportReport(read(file("0 @I1@ INDI", "1 NAME Ann /Reed/")), {
        people: 1,
        unions: 0,
        children: 0,
      }),
    );

    expect(written).toContain("WHAT WAS CREATED");
    expect(written).toContain("WHAT WAS SKIPPED (0)");
    expect(written).toContain("WHAT WAS APPROXIMATED (0)");
    expect(written).toContain("TAGS THIS APPLICATION DOES NOT READ (0)");
    expect(written).toContain(
      "Nothing. Every record in the file is in the tree.",
    );
  });

  it("names the file and when it was imported", () => {
    expect(text(fixtureReport())).toContain("File: grandad.ged");
    expect(text(fixtureReport())).toContain("2026-08-25T09:00:00.000Z");
  });

  it("writes each skip as its record and then its reason", () => {
    const written = text(report(REFUSED));

    // The record on its own line, so a reader with the `.ged` open can search
    // for `I1` and land on it, and the sentence underneath it.
    expect(written).toContain("INDI I1 (Ann Reed), line");
    expect(written).toContain("before the birth date");
  });

  it("says how much of a capped section it did not list", () => {
    const many = file(
      ...Array.from(
        { length: REPORT_ROWS_SHOWN + 3 },
        (_, index) =>
          `0 @I${index}@ INDI\n1 NAME Ann /Reed/\n1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1890`,
      ),
    );

    expect(text(report(many))).toContain("… and 3 skips not listed");
  });

  it("is longer than a screen for a real file, which is why it is a file", () => {
    expect(text(fixtureReport()).split("\n").length).toBeGreaterThan(24);
  });
});

describe("the name of the downloaded file", () => {
  it("keeps the .ged's own name so six imports are six reports", () => {
    expect(importReportFilename("grandad.ged")).toBe(
      "grandad-import-report.txt",
    );
    expect(importReportFilename("Smith Family.GEDCOM")).toBe(
      "Smith-Family-import-report.txt",
    );
  });

  it("still produces a filename for a name with nothing usable in it", () => {
    expect(importReportFilename(".ged")).toBe("gedcom-import-report.txt");
  });
});

describe("the type, rather than a test, is what makes a skip name a record", () => {
  it("does not compile a skip without one", () => {
    // Not an assertion so much as a place to say where the guarantee lives.
    // `GedcomIssue` is a union whose `skipped` member requires `record`, so
    // the sixth place that skips something cannot forget to name it — which
    // is a stronger promise than any sample of files this test could hold.
    const skip: GedcomSkip = {
      kind: "skipped",
      line: 1,
      message: "…",
      record: { tag: "INDI", xref: null, label: null },
    };

    expect(skip.record.tag).toBe("INDI");
  });
});
