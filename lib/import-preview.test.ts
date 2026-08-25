import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseGedcomText } from "@/lib/gedcom";
import { mapGedcom } from "@/lib/gedcom-map";
import {
  checkGedcomUpload,
  EXAMPLES_SHOWN,
  gedcomDigest,
  type ImportPreview,
  type ImportWarningKind,
  MAX_GEDCOM_BYTES,
  readGedcom,
  SAMPLE_SIZE,
  summariseImport,
  UNKNOWN_TAGS_SHOWN,
} from "@/lib/import-preview";

/**
 * The import preview (E6-T3, `YEO-48`).
 *
 * Every acceptance criterion of the ticket except the two that are about a
 * screen is decided in `lib/import-preview.ts`, and this drives it directly —
 * no route, no DOM, no mocking, because the module is a function from a file
 * to a value. `docs/testing.md` states the preference and this is the easy
 * case for it.
 *
 * Two habits worth naming, because both are load-bearing rather than
 * stylistic:
 *
 * - **The fixture is the real one.** `test/fixtures/gedcom/family.ged` is the
 *   file the parser and the mapper are already tested against, so a preview
 *   assertion here and a mapping assertion there are talking about the same
 *   five people. A private fixture would let this drift into agreeing with
 *   itself.
 * - **The sentences are not asserted verbatim** unless the point *is* the
 *   sentence. They belong to `lib/gedcom.ts` and `lib/gedcom-map.ts`, which
 *   should stay free to reword them; what this file pins is which group they
 *   land in, how many there are, and that they arrive with their line number.
 */

const FIXTURE = "test/fixtures/gedcom/family.ged";

/** The preview of some GEDCOM text, which is most of what is asserted below. */
function preview(text: string): ImportPreview {
  const file = parseGedcomText(text);
  return summariseImport(file, mapGedcom(file));
}

/** The one warning group of a kind, or `undefined` when the file raised none. */
function group(result: ImportPreview, kind: ImportWarningKind) {
  return result.warnings.find((warning) => warning.kind === kind);
}

/** A minimal well-formed file wrapping whatever records a test needs. */
function file(...records: string[]): string {
  return ["0 HEAD", "1 CHAR UTF-8", ...records, "0 TRLR", ""].join("\n");
}

describe("counts, which is what a preview is for", () => {
  const result = readGedcom(new Uint8Array(readFileSync(FIXTURE))).preview;

  it("counts the rows each of the three tables would gain", () => {
    // The same five people, two unions and two child links `lib/gedcom-map.
    // test.ts` asserts the mapping produces. Stated as one object so a count
    // that moves cannot be lost among three passing assertions.
    expect(result.counts).toEqual({ people: 5, unions: 2, children: 2 });
  });

  it("counts what the file holds beside what would be written", () => {
    expect(result.found).toEqual({ people: 5, unions: 2 });
    expect(result.refused).toEqual({ people: 0, unions: 0 });
  });

  it("samples the names, in the order the file lists them", () => {
    // File order rather than sorted: the question a sample answers is "is
    // this my tree", and the first names in the file are the ones whoever
    // exported it will recognise.
    expect(result.sample).toEqual([
      "John Henry Smith",
      "Mary Ann Byrne",
      "Edward Smith",
      "Ada Smith",
      "Thomas Byrne",
    ]);
  });

  it("stops the sample at a dozen, however large the file", () => {
    const many = preview(
      file(
        ...Array.from(
          { length: SAMPLE_SIZE + 8 },
          (_, index) => `0 @I${index}@ INDI\n1 NAME Person${index} /Smith/`,
        ),
      ),
    );

    expect(many.counts.people).toBe(SAMPLE_SIZE + 8);
    expect(many.sample).toHaveLength(SAMPLE_SIZE);
    expect(many.sample[0]).toBe("Person0 Smith");
  });
});

describe("a file that is not a GEDCOM file", () => {
  // The case the whole ticket exists for: somebody picked the wrong file. The
  // parser's own docblock promises this shape — "no records and an issue per
  // line, which is what the import preview needs in order to say so" — and
  // the preview's job is to make it legible rather than to refuse it.
  const result = preview("this is not gedcom\nnor is this\n");

  it("previews rather than refusing", () => {
    expect(result.counts).toEqual({ people: 0, unions: 0, children: 0 });
    expect(result.sample).toEqual([]);
  });

  it("says what it found instead, line by line", () => {
    const lines = group(result, "line");
    expect(lines?.count).toBe(2);
    expect(lines?.examples.map((example) => example.line)).toEqual([1, 2]);
  });
});

describe("the three warnings the ticket names", () => {
  it("surfaces dates it could not read, with the line to go and look at", () => {
    const result = preview(
      file("0 @I1@ INDI", "1 NAME Ann /Reed/", "1 BIRT", "2 DATE 12/03/1890"),
    );

    const dates = group(result, "date");
    expect(dates?.count).toBe(1);
    // The sixth line of the file `file()` wraps it in, which is the number a
    // reader would use to go and look.
    expect(dates?.examples[0].line).toBe(6);
    // The one place a sentence is asserted, because the whole value of a
    // `date` warning is that it quotes what it could not read.
    expect(dates?.examples[0].message).toContain("12/03/1890");
  });

  it("surfaces unknown tags separately from warnings, aggregated by path", () => {
    const result = preview(
      file(
        "0 @I1@ INDI",
        "1 NAME Ann /Reed/",
        "1 SOUR A parish register",
        "1 NOTE Something",
        "0 @I2@ INDI",
        "1 NAME Bob /Reed/",
        "1 SOUR The same register",
      ),
    );

    expect(result.unknownTags.map((tag) => [tag.path, tag.count])).toEqual([
      ["INDI.SOUR", 2],
      ["INDI.NOTE", 1],
    ]);
    expect(result.unknownTagOccurrences).toBe(3);
    // Not warnings. `lib/gedcom-report.ts` argues this at length: a file with
    // 4,000 `SOUR` tags and one unreadable date must not report 4,001
    // problems with the one that matters on page forty.
    expect(result.warnings.map((warning) => warning.kind)).not.toContain(
      "value",
    );
  });

  it("truncates the unknown tags and says how many kinds there were", () => {
    const result = preview(
      file(
        "0 @I1@ INDI",
        "1 NAME Ann /Reed/",
        ...Array.from(
          { length: UNKNOWN_TAGS_SHOWN + 3 },
          (_, index) => `1 _X${index} whatever`,
        ),
      ),
    );

    expect(result.unknownTags).toHaveLength(UNKNOWN_TAGS_SHOWN);
    expect(result.unknownTagTotal).toBe(UNKNOWN_TAGS_SHOWN + 3);
  });

  it("surfaces people the file does not name, and what they will be called", () => {
    // `1 NAME /Smith/` is an ordinary way to record a woman known only by her
    // married surname; an `INDI` with no `NAME` at all is how a program
    // records somebody known only to have existed.
    const result = preview(
      file("0 @I1@ INDI", "1 NAME /Smith/", "0 @I2@ INDI"),
    );

    const unnamed = group(result, "unnamed");
    expect(unnamed?.count).toBe(2);
    expect(unnamed?.examples.map((example) => example.line)).toEqual([3, 5]);
    expect(unnamed?.examples[0].message).toContain("Unknown Smith");
    expect(unnamed?.examples[1].message).toContain('"Unknown"');
    // They are imported, not skipped — those are precisely the people who are
    // in the file because they are somebody's parent.
    expect(result.sample).toEqual(["Unknown Smith", "Unknown"]);
  });

  it("does not also report the unnamed people as facts with nowhere to go", () => {
    // The mapper reports them as `value`, correctly for its own report and
    // twice for this screen. One loss, one spelling.
    const result = preview(file("0 @I1@ INDI", "1 NAME /Smith/"));

    expect(group(result, "unnamed")?.count).toBe(1);
    expect(group(result, "value")).toBeUndefined();
  });

  it("leaves a second finding about the same person in its own group", () => {
    // A person with no first name *and* more names than this tree can hold
    // raises two `value` issues on one line. Only the first is claimed by the
    // unnamed group; the other is a different loss and stays visible.
    const result = preview(
      file("0 @I1@ INDI", "1 NAME /Smith/", "1 NAME /Jones/"),
    );

    expect(group(result, "unnamed")?.count).toBe(1);
    expect(group(result, "value")?.count).toBe(1);
    expect(group(result, "value")?.examples[0].message).toContain("Jones");
  });
});

describe("the order the warnings are read in", () => {
  it("leads with the character set and ends with what needs no fixing", () => {
    // A file with no `HEAD.CHAR` (an `encoding` issue), a line that is not
    // GEDCOM, an unreadable date and an `EST` date, which is `narrowed`.
    //
    // Read from bytes rather than from text, because the character set is
    // decided while there are still bytes to decide it from — `parseGedcomText`
    // is handed a string that has already been decoded and has nothing to say
    // about how.
    const result = readGedcom(
      new TextEncoder().encode(
        [
          "0 HEAD",
          "0 @I1@ INDI",
          "1 NAME Ann /Reed/",
          "1 BIRT",
          "2 DATE 12/03/1890",
          "1 DEAT",
          "2 DATE EST 1962",
          "not a gedcom line",
          "0 TRLR",
          "",
        ].join("\n"),
      ),
    ).preview;

    const kinds = result.warnings.map((warning) => warning.kind);
    expect(kinds[0]).toBe("encoding");
    expect(kinds.at(-1)).toBe("narrowed");
    // `narrowed` means the field was populated with something true and
    // slightly poorer — the opposite outcome to `date`, and the reason
    // `lib/gedcom-report.ts` keeps the two kinds apart.
    expect(kinds.indexOf("date")).toBeLessThan(kinds.indexOf("narrowed"));
  });

  it("shows a handful of examples and says how many it did not show", () => {
    const result = preview(
      file(
        ...Array.from(
          { length: EXAMPLES_SHOWN + 4 },
          (_, index) =>
            `0 @I${index}@ INDI\n1 NAME Ann /Reed/\n1 BIRT\n2 DATE 12/03/189${index % 10}`,
        ),
      ),
    );

    const dates = group(result, "date");
    expect(dates?.count).toBe(EXAMPLES_SHOWN + 4);
    expect(dates?.examples).toHaveLength(EXAMPLES_SHOWN);
  });

  it("raises no warnings at all for a file with nothing wrong with it", () => {
    const result = preview(file("0 @I1@ INDI", "1 NAME Ann /Reed/"));
    expect(result.warnings).toEqual([]);
  });
});

describe("records the import would leave out", () => {
  it("counts them, so the reader is told rather than left to subtract", () => {
    // A death before a birth is refused by `validateIndividual`, and every
    // family link to that person goes with them (`lib/gedcom-map.ts`).
    const result = preview(
      file(
        "0 @I1@ INDI",
        "1 NAME Ann /Reed/",
        "1 BIRT",
        "2 DATE 1900",
        "1 DEAT",
        "2 DATE 1890",
        "0 @I2@ INDI",
        "1 NAME Bob /Reed/",
      ),
    );

    expect(result.found.people).toBe(2);
    expect(result.counts.people).toBe(1);
    expect(result.refused.people).toBe(1);
    expect(result.sample).toEqual(["Bob Reed"]);
  });
});

describe("the character set", () => {
  it("says nothing when the file agrees with itself", () => {
    const result = preview(file("0 @I1@ INDI", "1 NAME Ann /Reed/"));
    expect(result.encoding).toBe("utf-8");
    expect(result.misdeclaredEncoding).toBeNull();
  });

  it("reports a file whose own bytes contradict its declaration", () => {
    // ANSEL puts the diacritic before the letter, so `0xE2 0x65` is é and is
    // not valid UTF-8 — which is proof the declaration is wrong, whatever it
    // says. `lib/gedcom-encoding.ts` owns that decision; this asserts the
    // preview surfaces it, because a file read as the wrong character set has
    // every accented name in it wrong.
    const text = file("0 @I1@ INDI", "1 NAME Rene /Reed/");
    const bytes = Array.from(new TextEncoder().encode(text));
    // Everything before it is ASCII, so a character index is a byte index.
    bytes.splice(text.indexOf("Rene") + 3, 1, 0xe2, 0x65);

    const result = readGedcom(new Uint8Array(bytes)).preview;
    expect(result.encoding).toBe("ansel");
    expect(result.misdeclaredEncoding).toBe("UTF-8");
  });
});

describe("what the endpoint refuses before reading anything", () => {
  it("accepts an ordinary file", () => {
    expect(checkGedcomUpload(1024)).toEqual({ ok: true });
  });

  it("refuses an empty one", () => {
    expect(checkGedcomUpload(0)).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses one over the cap, and says what the cap is", () => {
    const refusal = checkGedcomUpload(MAX_GEDCOM_BYTES + 1);
    expect(refusal).toMatchObject({ ok: false, status: 413 });
    expect(refusal.ok === false && refusal.message).toContain("4 MB");
  });

  it("accepts a file exactly at the cap", () => {
    // The boundary in the direction that matters: a cap that refused the file
    // it names would be a cap nobody could satisfy.
    expect(checkGedcomUpload(MAX_GEDCOM_BYTES)).toEqual({ ok: true });
  });

  it("does not sniff the format", () => {
    // Deliberate, and the reason is the first `describe` above: a file that
    // is not GEDCOM has a *preview* saying so, which tells the reader far
    // more than a rejection would.
    expect(checkGedcomUpload(12)).toEqual({ ok: true });
  });
});

describe("the digest that pins a confirmation to a file", () => {
  const bytes = new TextEncoder().encode(file("0 @I1@ INDI"));

  it("is the same for the same bytes", async () => {
    expect(await gedcomDigest(bytes)).toBe(await gedcomDigest(bytes.slice()));
  });

  it("is different for different bytes", async () => {
    const other = new TextEncoder().encode(file("0 @I2@ INDI"));
    expect(await gedcomDigest(bytes)).not.toBe(await gedcomDigest(other));
  });

  it("digests the file rather than the buffer it happens to sit in", async () => {
    // `formData()` returns views into one buffer holding the whole multipart
    // body, so a digest taken over the underlying `ArrayBuffer` would be the
    // digest of the request rather than of the file — the same file would
    // hash differently under a different field name, and no confirmation
    // would ever match.
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    const view = padded.subarray(4, 4 + bytes.length);

    expect(await gedcomDigest(view)).toBe(await gedcomDigest(bytes));
  });

  it("is lowercase hex of a SHA-256", async () => {
    expect(await gedcomDigest(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});
