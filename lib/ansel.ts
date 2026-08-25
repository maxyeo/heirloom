/**
 * ANSEL, the character set GEDCOM files were written in before Unicode won
 * (E6-T1, `YEO-46`).
 *
 * ## Why a repository in 2025 needs this at all
 *
 * GEDCOM 5.5.1 names ANSEL (ANSI/NISO Z39.47) as its default character set,
 * and the desktop genealogy programs people have been keeping their families
 * in since the 1990s still emit it. A `.ged` exported from a twenty-year-old
 * copy of PAF or Family Tree Maker is an ANSEL file, and the people most
 * likely to have one are exactly the people whose trees are worth importing —
 * decades of work that predates anybody agreeing on UTF-8.
 *
 * Decoding it as UTF-8 does not fail loudly. It produces `Bj?rk` and
 * `Fran?ois` and a tree full of mojibake surnames that nobody notices until
 * they search for a name and get nothing back. So this exists to make the
 * difference between "we support ANSEL" and "we corrupt half of the diacritics
 * in an imported tree, silently".
 *
 * ## The one structural difference from Unicode
 *
 * **In ANSEL a diacritic comes _before_ the letter it modifies.** `0xE2 0x65`
 * is é: acute-accent, then `e`. Unicode combining marks run the other way —
 * `e` then U+0301. That reversal is the whole of the interesting work here,
 * and it is why this cannot be a lookup table applied byte by byte: a mark has
 * to be held until its base character arrives, and several marks can stack in
 * front of one letter.
 *
 * The result is then run through NFC, so `e` + U+0301 becomes the single code
 * point `é`. Without that step the decoded text still _renders_ correctly and
 * still compares unequal to the `é` somebody types into the search box, which
 * is the kind of bug that only ever shows up as "search is broken for my
 * grandmother".
 *
 * ## Why a module of its own
 *
 * No imports, and one exported function from bytes to a string. That keeps it
 * testable as a table of byte sequences and expected strings — `lib/ansel.test.ts`
 * is exactly that — and keeps the GEDCOM parser free of a 60-entry lookup
 * table it would otherwise have to carry in the middle of its grammar.
 */

/**
 * The ANSEL bytes that stand for one character on their own.
 *
 * `0x00`–`0x7F` is ASCII and is not listed: it is identical in both character
 * sets, so it is handled by a range check rather than sixty-four table
 * entries. What is listed is the upper half, which is where ANSEL and every
 * other 8-bit encoding disagree.
 *
 * Only the assignments the standard actually makes are here. GEDCOM's own
 * appendix adds a few more in the gaps, and various programs added their own
 * on top of that; guessing at those would put a plausible-looking wrong letter
 * into somebody's surname, which is strictly worse than the visible
 * replacement character an unmapped byte gets below.
 */
const ANSEL_GRAPHIC: Readonly<Record<number, string>> = {
  0xa1: "Ł", // Ł
  0xa2: "Ø", // Ø
  0xa3: "Đ", // Đ
  0xa4: "Þ", // Þ
  0xa5: "Æ", // Æ
  0xa6: "Œ", // Œ
  0xa7: "ʹ", // ʹ modifier prime (transliterated soft sign)
  0xa8: "·", // ·
  0xa9: "♭", // ♭
  0xaa: "®", // ®
  0xab: "±", // ±
  0xac: "Ơ", // Ơ
  0xad: "Ư", // Ư
  0xae: "ʼ", // ʼ modifier apostrophe (alif)
  0xb0: "ʻ", // ʻ modifier turned comma (ayn)
  0xb1: "ł", // ł
  0xb2: "ø", // ø
  0xb3: "đ", // đ
  0xb4: "þ", // þ
  0xb5: "æ", // æ
  0xb6: "œ", // œ
  0xb7: "ʺ", // ʺ modifier double prime (transliterated hard sign)
  0xb8: "ı", // ı dotless i
  0xb9: "£", // £
  0xba: "ð", // ð
  0xc0: "°", // °
  0xc1: "ℓ", // ℓ
  0xc2: "℗", // ℗
  0xc3: "©", // ©
  0xc4: "♯", // ♯
  0xc5: "¿", // ¿
  0xc6: "¡", // ¡
};

/**
 * The ANSEL bytes that modify the character _after_ them, and the Unicode
 * combining mark each becomes.
 *
 * Every value here is a combining code point (general category Mn), which is
 * what lets NFC afterwards fold the common pairs back into single characters.
 * The two half-ligature and two half-tilde marks have no precomposed form and
 * stay as they are; they are also the reason this maps to marks rather than
 * to a table of precomposed letters, which could not express them at all.
 */
const ANSEL_COMBINING: Readonly<Record<number, string>> = {
  0xe0: "̉", // hook above (pseudo question mark)
  0xe1: "̀", // grave
  0xe2: "́", // acute
  0xe3: "̂", // circumflex
  0xe4: "̃", // tilde
  0xe5: "̄", // macron
  0xe6: "̆", // breve
  0xe7: "̇", // dot above
  0xe8: "̈", // diaeresis (umlaut)
  0xe9: "̌", // caron (haček)
  0xea: "̊", // ring above
  0xeb: "︠", // ligature, left half
  0xec: "︡", // ligature, right half
  0xed: "̕", // comma above right
  0xee: "̋", // double acute
  0xef: "̐", // candrabindu
  0xf0: "̧", // cedilla
  0xf1: "̨", // ogonek (right hook)
  0xf2: "̣", // dot below
  0xf3: "̤", // double dot below
  0xf4: "̥", // ring below
  0xf5: "̳", // double low line
  0xf6: "̲", // low line
  0xf7: "̦", // comma below
  0xf8: "̜", // left half ring below
  0xf9: "̮", // breve below
  0xfa: "︢", // double tilde, left half
  0xfb: "︣", // double tilde, right half
  0xfe: "̓", // comma above
};

/**
 * What an unassigned byte becomes.
 *
 * U+FFFD rather than dropping the byte or passing it through as Latin-1. A
 * dropped byte is invisible — the name simply comes out one letter short and
 * looks like a typo in the source file. A guessed Latin-1 letter is worse
 * still, because it looks right. The replacement character is the only one of
 * the three that a person reading the import report can act on.
 */
const REPLACEMENT = "�";

/**
 * Decode ANSEL bytes to a string.
 *
 * Total: every byte sequence produces a string, and nothing throws. A file
 * that turns out not to be ANSEL after all decodes to something ugly rather
 * than to an exception, which is the right failure for an import that wants to
 * show a preview before it writes anything.
 *
 * @param bytes the raw file contents
 */
export function decodeAnsel(bytes: Uint8Array): string {
  const out: string[] = [];

  // Marks seen since the last base character, in the order they appeared.
  // ANSEL writes them before their letter and Unicode writes them after, so
  // this is what holds them across the reversal.
  let pending: string[] = [];

  for (const byte of bytes) {
    const combining = ANSEL_COMBINING[byte];
    if (combining !== undefined) {
      pending.push(combining);
      continue;
    }

    out.push(baseCharacter(byte));

    if (pending.length > 0) {
      out.push(...pending);
      pending = [];
    }
  }

  // A file that ends mid-sequence — a truncated download, or a diacritic
  // applied to nothing — still has to produce those marks rather than eat
  // them, so that what came out can be compared against what went in.
  out.push(...pending);

  // NFC last, over the whole string rather than per character: composition is
  // defined on sequences, and a base with two stacked marks only composes
  // correctly when they are normalised together.
  return out.join("").normalize("NFC");
}

/** One non-combining byte, as ASCII, a table entry, or the visible refusal. */
function baseCharacter(byte: number): string {
  // ASCII is byte-identical in ANSEL, and it is the overwhelming majority of
  // any real file: every tag, every level number, every date.
  if (byte < 0x80) return String.fromCharCode(byte);

  return ANSEL_GRAPHIC[byte] ?? REPLACEMENT;
}
