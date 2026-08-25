import { describe, expect, it } from "vitest";

import { decodeGedcom } from "@/lib/gedcom-encoding";

/**
 * Choosing a character set for a `.ged` file (E6-T1, `YEO-46`).
 *
 * The cases that matter are the ones where the file contradicts itself, so
 * most of this file builds byte sequences whose `CHAR` line is a lie. That is
 * not a contrived scenario: a file written by one program, edited by a second
 * and exported by a third carries whichever declaration survived, and the two
 * ways it can be wrong both corrupt names silently rather than failing.
 */

const utf8 = new TextEncoder();

/** A file built from text and raw bytes, which is what a mixed encoding is. */
function bytes(...parts: Array<string | number>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") out.push(part);
    else out.push(...utf8.encode(part));
  }
  return Uint8Array.from(out);
}

/** `0 HEAD` with the given CHAR line, or none, and a name to check. */
function file(charLine: string | null, ...name: Array<string | number>) {
  return bytes(
    "0 HEAD\n",
    ...(charLine === null ? [] : [`1 CHAR ${charLine}\n`]),
    "0 @I1@ INDI\n1 NAME ",
    ...name,
    "\n0 TRLR\n",
  );
}

/** `François` in ANSEL: cedilla (0xF0) before the `c` it belongs to. */
const ANSEL_NAME = ["Fran", 0xf0, "cois"] as const;

describe("a byte order mark outranks everything", () => {
  it("reads a UTF-8 BOM and strips it", () => {
    const result = decodeGedcom(bytes(0xef, 0xbb, 0xbf, "0 HEAD\n"));

    expect(result.encoding).toBe("utf-8");
    // The mark must not survive into the text: it sits exactly where the
    // first level number has to be.
    expect(result.text).toBe("0 HEAD\n");
  });

  it("reads a UTF-16 little-endian BOM", () => {
    const text = "0 HEAD\n1 CHAR UNICODE\n";
    const utf16 = [0xff, 0xfe];
    for (const character of text) {
      const code = character.charCodeAt(0);
      utf16.push(code & 0xff, code >> 8);
    }

    const result = decodeGedcom(Uint8Array.from(utf16));

    expect(result.encoding).toBe("utf-16le");
    expect(result.text).toBe(text);
  });

  it("reads a UTF-16 big-endian BOM", () => {
    const text = "0 HEAD\n";
    const utf16 = [0xfe, 0xff];
    for (const character of text) {
      const code = character.charCodeAt(0);
      utf16.push(code >> 8, code & 0xff);
    }

    const result = decodeGedcom(Uint8Array.from(utf16));

    expect(result.encoding).toBe("utf-16be");
    expect(result.text).toBe(text);
  });

  it("beats a CHAR line that disagrees with it", () => {
    // The mark is made in the encoding itself; the CHAR line is whatever the
    // last program to touch the file left behind.
    const result = decodeGedcom(
      bytes(0xef, 0xbb, 0xbf, "0 HEAD\n1 CHAR ANSEL\n"),
    );

    expect(result.encoding).toBe("utf-8");
    expect(result.declared).toBe("ANSEL");
  });
});

describe("a declaration that matches the bytes", () => {
  it("reads a declared ANSEL file as ANSEL", () => {
    const result = decodeGedcom(file("ANSEL", ...ANSEL_NAME));

    expect(result.encoding).toBe("ansel");
    expect(result.declared).toBe("ANSEL");
    expect(result.text).toContain("François");
    expect(result.issues).toEqual([]);
  });

  it("reads a declared UTF-8 file as UTF-8", () => {
    const result = decodeGedcom(file("UTF-8", "François"));

    expect(result.encoding).toBe("utf-8");
    expect(result.text).toContain("François");
    expect(result.issues).toEqual([]);
  });

  it("accepts UTF8 without the hyphen", () => {
    expect(decodeGedcom(file("UTF8", "Smith")).encoding).toBe("utf-8");
  });

  it("treats ASCII as UTF-8, which it is a subset of", () => {
    const result = decodeGedcom(file("ASCII", "Smith"));

    expect(result.encoding).toBe("utf-8");
    expect(result.issues).toEqual([]);
  });
});

describe("a declaration the bytes contradict", () => {
  it("overrides UTF-8 when the file is not valid UTF-8", () => {
    // The decisive case. UTF-8 is self-checking, so this is proof rather than
    // a guess — and believing the declaration would put a replacement
    // character through every accented name in the file.
    const result = decodeGedcom(file("UTF-8", ...ANSEL_NAME));

    expect(result.encoding).toBe("ansel");
    expect(result.text).toContain("François");
  });

  it("says so rather than overriding quietly", () => {
    const result = decodeGedcom(file("UTF-8", ...ANSEL_NAME));

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ kind: "encoding", line: 0 });
    expect(result.issues[0].message).toContain("UTF-8");
  });

  it("keeps the declaration even when it did not follow it", () => {
    // A round trip (E7-T2) has to be able to write back what it read.
    expect(decodeGedcom(file("UTF-8", ...ANSEL_NAME)).declared).toBe("UTF-8");
  });
});

describe("a declaration it cannot use", () => {
  it("refuses to treat ANSI as a character set it knows", () => {
    // ANSI is what Windows programs called Windows-1252. Mapping it to UTF-8
    // would mangle exactly the characters somebody chose it for.
    const result = decodeGedcom(file("ANSI", ...ANSEL_NAME));

    expect(result.encoding).toBe("ansel");
    expect(result.issues[0].message).toContain("ANSI");
  });

  it("reports UNICODE with no byte order mark", () => {
    const result = decodeGedcom(file("UNICODE", "Smith"));

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("byte order mark");
  });
});

describe("no declaration at all", () => {
  it("falls back to UTF-8 when the bytes are valid UTF-8", () => {
    const result = decodeGedcom(file(null, "François"));

    expect(result.encoding).toBe("utf-8");
    expect(result.declared).toBeNull();
    expect(result.text).toContain("François");
  });

  it("falls back to ANSEL when they are not", () => {
    const result = decodeGedcom(file(null, ...ANSEL_NAME));

    expect(result.encoding).toBe("ansel");
    expect(result.text).toContain("François");
  });

  it("always says that it had to guess", () => {
    expect(decodeGedcom(file(null, "Smith")).issues).toHaveLength(1);
    expect(decodeGedcom(file(null, "Smith")).issues[0].kind).toBe("encoding");
  });
});

describe("where it looks for the declaration", () => {
  it("does not read a CHAR line buried deep in the file as one", () => {
    // `1 CHAR ANSEL` inside a NOTE halfway down a large file is text, not a
    // declaration. Without a bound on the search it would be read as one.
    const padding = "1 NOTE ".concat("x".repeat(1200), "\n");
    const result = decodeGedcom(bytes("0 HEAD\n", padding, "1 CHAR ANSEL\n"));

    expect(result.declared).toBeNull();
  });

  it("is not thrown off by an accented byte above the CHAR line", () => {
    const result = decodeGedcom(
      bytes("0 HEAD\n1 SOUR ", 0xe9, "\n1 CHAR ANSEL\n"),
    );

    expect(result.declared).toBe("ANSEL");
  });

  it("reads the declaration case-insensitively and normalises it", () => {
    expect(decodeGedcom(file("ansel", ...ANSEL_NAME)).declared).toBe("ANSEL");
    expect(decodeGedcom(file("ansel", ...ANSEL_NAME)).encoding).toBe("ansel");
  });
});

describe("empty input", () => {
  it("decodes to empty text rather than throwing", () => {
    const result = decodeGedcom(new Uint8Array());

    expect(result.text).toBe("");
    expect(result.encoding).toBe("utf-8");
  });
});
