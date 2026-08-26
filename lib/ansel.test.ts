import { describe, expect, it } from "vitest";

import { decodeAnsel } from "@/lib/ansel";

/**
 * ANSEL decoding (E6-T1, `YEO-46`).
 *
 * The interesting property is the one in the module's own docblock: **ANSEL
 * puts the diacritic before the letter and Unicode puts it after.** Almost
 * everything below is an assertion about that reversal, because it is the part
 * that fails silently — a wrong table entry produces a visibly wrong
 * character, whereas a wrong *order* produces text that renders correctly in
 * some fonts and compares unequal to everything.
 *
 * Every non-ASCII expectation is written as `\u` escapes rather than as a
 * literal. A literal `é` in this file could itself be either one code point or
 * two, depending on what the editor that last saved it did, which would make
 * the assertions here quietly meaningless — an NFD literal would match an
 * un-normalised decoder and the test would pass for the wrong reason.
 */

/** ANSEL bytes, written as a byte list because that is what a file holds. */
function ansel(...bytes: number[]): string {
  return decodeAnsel(Uint8Array.from(bytes));
}

/** ASCII spelled as text, for the parts of a fixture that are just letters. */
function bytesOf(ascii: string): number[] {
  return [...ascii].map((character) => character.charCodeAt(0));
}

describe("ASCII", () => {
  it("passes the whole lower half through unchanged", () => {
    const ascii = Array.from({ length: 0x80 }, (_, byte) => byte);
    expect(ansel(...ascii)).toBe(
      ascii.map((byte) => String.fromCharCode(byte)).join(""),
    );
  });

  it("leaves a plain GEDCOM line alone", () => {
    expect(ansel(...bytesOf("1 NAME John /Smith/"))).toBe(
      "1 NAME John /Smith/",
    );
  });
});

describe("the mark comes before the letter", () => {
  it("reads acute-then-e as e-acute", () => {
    // U+00E9, the precomposed letter: the mark applied to the letter after it.
    expect(ansel(0xe2, 0x65)).toBe("é");
  });

  it("puts the mark after the base once decoded", () => {
    // The rule stated directly, with composition undone so the order is
    // visible: `e` first, then the combining acute.
    expect(ansel(0xe2, 0x65).normalize("NFD")).toBe("e\u0301");
  });

  it("composes to a single code point", () => {
    // The reason NFC is worth doing at all. Without it this is length 2, it
    // renders identically, and it never matches the "é" somebody types into
    // the search box.
    expect(ansel(0xe2, 0x65)).toHaveLength(1);
  });

  it("reads a cedilla the same way", () => {
    expect(ansel(...bytesOf("Fran"), 0xf0, 0x63, ...bytesOf("ois"))).toBe(
      "François",
    );
  });

  it("applies a mark only to the letter that follows it", () => {
    // "Besçon", not "Beçson": the cedilla belongs to the `c` after it and to
    // nothing before it.
    expect(ansel(...bytesOf("Bes"), 0xf0, 0x63, ...bytesOf("on"))).toBe(
      "Besçon",
    );
  });
});

describe("stacked marks", () => {
  it("keeps several marks in the order the file wrote them", () => {
    // Asserted through NFD so the test states the ordering rule itself rather
    // than depending on which combinations Unicode has a single character for.
    expect(ansel(0xe8, 0xe5, 0x6f).normalize("NFD")).toBe("o\u0308\u0304");
  });

  it("still composes what can be composed", () => {
    expect(ansel(0xe8, 0x6f)).toBe("ö");
  });
});

describe("characters that stand alone", () => {
  it("reads the letters ANSEL gives a byte of their own", () => {
    expect(ansel(0xa4)).toBe("Þ"); // Þ
    expect(ansel(0xba)).toBe("ð"); // ð
    expect(ansel(0xa5)).toBe("Æ"); // Æ
    expect(ansel(0xb2)).toBe("ø"); // ø
    expect(ansel(0xb9)).toBe("£"); // £
  });

  it("reads a word mixing both kinds", () => {
    // Sigríður: a table lookup for ð and a preceding acute for í.
    expect(ansel(...bytesOf("Sigr"), 0xe2, 0x69, 0xba, ...bytesOf("ur"))).toBe(
      "Sigríður",
    );
  });

  it("reads the three the table was missing until a real file said so", () => {
    // `YEO-92`. The torture test at `test/fixtures/gedcom/TGC55C.ged` lists
    // the upper half a byte at a time, which is how three assignments the
    // standard makes turned out never to have been written down here.
    expect(ansel(0xbc)).toBe("ơ");
    expect(ansel(0xbd)).toBe("ư");
    expect(ansel(0xcf)).toBe("ß");
  });

  it("reads both cases of the hooked vowels, which is the point", () => {
    // The gap was an asymmetry, not a decision: the capitals were in the
    // table and their lowercase pairs were not, so half of a Vietnamese name
    // survived and half came back as replacement characters.
    expect(ansel(0xac, 0xad, 0xbc, 0xbd)).toBe("ƠƯơư");
    expect(ansel(...bytesOf("H"), 0xbd, 0xbc, ...bytesOf("ng"))).toBe("Hương");
  });
});

describe("what it refuses to guess", () => {
  it("marks an unassigned byte visibly rather than dropping it", () => {
    // A dropped byte reads as a typo in the source file; a guessed Latin-1
    // letter reads as correct. Only the replacement character is actionable.
    expect(ansel(0xff)).toBe("\ufffd");
  });

  it("does not shorten the text when it cannot read a byte", () => {
    expect(ansel(...bytesOf("ab"), 0xd0, ...bytesOf("cd"))).toHaveLength(5);
  });

  it("leaves the four LDS extensions unread, on purpose", () => {
    // Empty box, black box, midline e, midline o: additions to ANSEL made by
    // the LDS church rather than assignments the standard makes, and none has
    // a Unicode character that means the same thing. Picking a lookalike is
    // exactly the guess this module refuses. `docs/gedcom.md` records them as
    // a narrowing, and `YEO-92` is where a real file made them visible.
    for (const byte of [0xbe, 0xbf, 0xcd, 0xce]) {
      expect(ansel(byte)).toBe("\ufffd");
    }
  });
});

describe("truncation", () => {
  it("keeps a mark that has no letter after it", () => {
    // A file that ends mid-sequence must not lose the mark: what came out has
    // to be comparable against what went in. `b` has no precomposed form with
    // an acute, so the mark survives as its own code point.
    expect(ansel(...bytesOf("ab"), 0xe2)).toBe("ab\u0301");
  });
});

describe("empty input", () => {
  it("decodes to an empty string", () => {
    expect(decodeAnsel(new Uint8Array())).toBe("");
  });
});
