import { decodeAnsel } from "./ansel";
import type { GedcomIssue } from "./gedcom-report";

/**
 * Working out what character set a `.ged` file is actually in (E6-T1,
 * `YEO-46`).
 *
 * ## The chicken and egg
 *
 * A GEDCOM file declares its own character set, in a line inside itself:
 *
 * ```
 * 0 HEAD
 * 1 CHAR ANSEL
 * ```
 *
 * To read that line you have to have decoded the file, and to decode the file
 * you have to have read that line. The knot unties because every character set
 * GEDCOM permits agrees with ASCII on the bytes that spell `1 CHAR ANSEL` —
 * so the declaration can be read out of the raw bytes before anything is
 * decoded, by treating the header as ASCII and looking no further than the
 * first few hundred bytes. UTF-16 is the exception, and it announces itself
 * with a byte order mark before any of this comes up.
 *
 * ## Why the declaration is not simply believed
 *
 * Because it is frequently wrong. A file written by one program, edited by a
 * second and exported by a third carries whatever `CHAR` line survived, and
 * that is routinely not what the bytes are. The two failures are not
 * symmetrical:
 *
 * - **Declared UTF-8, actually ANSEL.** Decoding proceeds and produces
 *   mojibake or replacement characters through every accented name in the
 *   file. Nothing throws.
 * - **Declared ANSEL, actually UTF-8.** Every two-byte UTF-8 sequence becomes
 *   two ANSEL characters, so `é` becomes `Ã©` — again silently.
 *
 * So the declaration is a starting point and the bytes get the last word:
 * UTF-8 is a self-checking encoding, and a byte sequence that is not valid
 * UTF-8 is *proof* that the file is not UTF-8. That single check catches the
 * first failure outright and is what makes the second safe to guess at.
 *
 * Every override is recorded as an `encoding` issue rather than done quietly,
 * because "your file says UTF-8 and is not" is exactly the sort of thing the
 * import report (E6-T5, `YEO-50`) exists to say out loud.
 *
 * ## Why UTF-16 is here at all when the ticket names two encodings
 *
 * The acceptance criteria ask for UTF-8 and ANSEL, and those are the two that
 * matter. UTF-16 is here in ten lines because of what happens without it: a
 * UTF-16 file is half zero bytes, so it neither validates as UTF-8 nor decodes
 * as ANSEL, and the fallback would turn a perfectly good file into tens of
 * thousands of replacement characters. Detecting the byte order mark — which
 * every such file has, since that is how GEDCOM's `UNICODE` is written in
 * practice — costs almost nothing and removes a whole class of silent
 * corruption. `TextDecoder` does the actual work.
 */

/** The character sets this parser can read a file in. */
export type GedcomEncoding = "utf-8" | "utf-16le" | "utf-16be" | "ansel";

/** Bytes in, text out, plus a record of how that decision was reached. */
export type GedcomDecode = {
  /** The decoded file. Never contains a byte order mark. */
  text: string;
  /** The character set actually used. */
  encoding: GedcomEncoding;
  /**
   * The `HEAD.CHAR` value verbatim, upper-cased, or `null` when the file did
   * not declare one. Kept even when it was overridden, because a round-trip
   * (E7-T2, `YEO-52`) has to be able to write back what it read.
   */
  declared: string | null;
  issues: GedcomIssue[];
};

/**
 * How far into the file to look for the `CHAR` declaration.
 *
 * The header is the first record in every conforming file and `CHAR` is
 * required to be in it, so a kilobyte is generous. A bound rather than a scan
 * of the whole file matters for the pathological case: `1 CHAR ANSEL` sitting
 * in a `NOTE` halfway down a ten-megabyte file is not a declaration, and
 * without a limit it would be read as one.
 */
const HEADER_BYTES = 1024;

/** `1 CHAR ANSEL`, at any level, in the ASCII reading of the header. */
const CHAR_LINE = /^\s*\d+\s+CHAR\s+(\S+)\s*$/im;

/**
 * The spellings that appear in real files, and what each one means.
 *
 * `ASCII` maps to UTF-8 because ASCII *is* UTF-8 for every byte it can
 * represent; a file that says ASCII and stays inside it decodes identically
 * either way, and one that says ASCII and does not is caught by the validity
 * check like any other misdeclaration.
 *
 * `ANSI` is not a character set — it is what Windows programs called
 * Windows-1252 — and it is not in the table on purpose. Mapping it to UTF-8
 * would silently mangle exactly the accented characters somebody chose it for.
 * It falls through to the bytes, and says so in an issue.
 */
const DECLARED_ENCODINGS: Readonly<Record<string, GedcomEncoding>> = {
  ANSEL: "ansel",
  "UTF-8": "utf-8",
  UTF8: "utf-8",
  ASCII: "utf-8",
};

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/**
 * Decode a `.ged` file, choosing the character set the way described above.
 *
 * Total: every byte sequence decodes to something, and nothing throws. An
 * import that cannot decode a file has nothing useful to say about it, whereas
 * one that decodes it badly can at least show a preview and let a person see
 * that it went wrong (E6-T3, `YEO-48`).
 *
 * @param bytes the raw file contents
 */
export function decodeGedcom(bytes: Uint8Array): GedcomDecode {
  const issues: GedcomIssue[] = [];

  // A byte order mark is the one statement about encoding that is made in the
  // encoding itself, so it outranks a `CHAR` line written by whichever program
  // touched the file last.
  const marked = readByteOrderMark(bytes);
  if (marked !== null) {
    return {
      text: decodeWith(marked.encoding, bytes.subarray(marked.length)),
      encoding: marked.encoding,
      declared: readDeclaredEncoding(bytes),
      issues,
    };
  }

  const declared = readDeclaredEncoding(bytes);
  const valid = isValidUtf8(bytes);

  const encoding = chooseEncoding(declared, valid, issues);

  return { text: decodeWith(encoding, bytes), encoding, declared, issues };
}

/**
 * The encoding to use, and an issue for every way the file disagreed with
 * itself.
 *
 * Split out because the decision is the whole of the interesting behaviour
 * here — five cases, each with a different thing to say to the author — and it
 * reads far better as a list of them than as branches wrapped around a decode
 * call.
 */
function chooseEncoding(
  declared: string | null,
  validUtf8: boolean,
  issues: GedcomIssue[],
): GedcomEncoding {
  const named = declared === null ? undefined : DECLARED_ENCODINGS[declared];

  if (named === "ansel") return "ansel";

  if (named === "utf-8") {
    if (validUtf8) return "utf-8";
    // The bytes are proof and the declaration is a claim. ANSEL is the only
    // other thing an eight-bit GEDCOM is likely to be.
    issues.push({
      kind: "encoding",
      line: 0,
      message: `The file declares ${declared} but is not valid UTF-8. It was read as ANSEL instead; check any accented names.`,
    });
    return "ansel";
  }

  if (declared === "UNICODE") {
    // The spec's `UNICODE` means UTF-16, which in practice always carries a
    // byte order mark — and this function only runs when there was none.
    issues.push({
      kind: "encoding",
      line: 0,
      message:
        "The file declares UNICODE but has no byte order mark, so the byte order is unknown. It was read as UTF-8.",
    });
    return validUtf8 ? "utf-8" : "ansel";
  }

  if (declared !== null && named === undefined) {
    issues.push({
      kind: "encoding",
      line: 0,
      message: `${declared} is not a character set this import understands. The file was read as ${validUtf8 ? "UTF-8" : "ANSEL"}; check any accented names.`,
    });
    return validUtf8 ? "utf-8" : "ansel";
  }

  if (declared === null) {
    issues.push({
      kind: "encoding",
      line: 0,
      message: `The file does not say what character set it is in. It was read as ${validUtf8 ? "UTF-8" : "ANSEL"}; check any accented names.`,
    });
  }

  return validUtf8 ? "utf-8" : "ansel";
}

/** The encoding a leading byte order mark names, and how long the mark is. */
function readByteOrderMark(
  bytes: Uint8Array,
): { encoding: GedcomEncoding; length: number } | null {
  if (startsWith(bytes, UTF8_BOM)) return { encoding: "utf-8", length: 3 };
  if (startsWith(bytes, UTF16LE_BOM))
    return { encoding: "utf-16le", length: 2 };
  if (startsWith(bytes, UTF16BE_BOM))
    return { encoding: "utf-16be", length: 2 };
  return null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * The `CHAR` value from the header, read as ASCII.
 *
 * Latin-1 rather than UTF-8 for the sniff, because it cannot fail: every byte
 * maps to a character, so a header containing an accented `SOUR` name above
 * the `CHAR` line cannot throw the sniff off. Only the ASCII part of the
 * result is ever matched against.
 */
function readDeclaredEncoding(bytes: Uint8Array): string | null {
  const header = new TextDecoder("latin1").decode(
    bytes.subarray(0, HEADER_BYTES),
  );

  const match = CHAR_LINE.exec(header);
  return match === null ? null : match[1].toUpperCase();
}

/** Whether the bytes are a well-formed UTF-8 sequence. */
function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeWith(encoding: GedcomEncoding, bytes: Uint8Array): string {
  if (encoding === "ansel") return decodeAnsel(bytes);

  // Non-fatal on purpose: by this point the encoding has already been chosen
  // and a stray bad byte should cost one character, not the whole import.
  return new TextDecoder(encoding).decode(bytes);
}
