import { describe, expect, it } from "vitest";

import { foldName, nameKey, withinOneEdit } from "@/lib/name-match";

/**
 * `literalTermRank` is not re-tested here: it is the same function, called
 * the same way, that `lib/partner-search.test.ts` already exercises under
 * its old private name. Duplicating that coverage under a new import would
 * assert nothing this module changed. What is new in this file is
 * `foldName`'s own boundary (folding was previously only ever asserted
 * indirectly, through `searchPartners`), `nameKey`'s validated spelling-
 * variant table, and `withinOneEdit`'s edit-distance boundary.
 */

describe("foldName", () => {
  it("lowercases", () => {
    expect(foldName("ROSE")).toBe("rose");
  });

  it("strips a combining accent, in both directions", () => {
    // "José" written with a precomposed é and written as e + combining
    // acute both fold to the same plain letters.
    expect(foldName("José")).toBe("jose");
    expect(foldName("José")).toBe("jose");
  });

  it("leaves plain ASCII untouched apart from case", () => {
    expect(foldName("Hale")).toBe("hale");
  });
});

/**
 * The validated pairs from the ticket: every one of these must produce equal
 * keys. Each pair is the *reason* a search for one spelling has to find
 * record of the other — a name transcribed off a census, a headstone, an
 * emigration record, spelled however the transcriber heard it.
 */
const VARIANT_PAIRS: [string, string][] = [
  ["Catherine", "Katharine"],
  ["Catherine", "Kathryn"],
  ["Elisabeth", "Elizabeth"],
  ["Sara", "Sarah"],
  ["Margaret", "Margarethe"],
  ["Johann", "Johan"],
  ["Smith", "Smyth"],
  ["McDonald", "MacDonald"],
  ["Stewart", "Stuart"],
  ["Ann", "Anne"],
  ["Philip", "Phillip"],
  ["Isabel", "Isabella"],
  ["Jon", "John"],
  ["Frederic", "Frederick"],
  ["Reid", "Reed"],
  ["Thomas", "Tomas"],
  ["Sophia", "Sofia"],
  ["Christina", "Kristina"],
  ["Geoffrey", "Jeffrey"],
  ["Alice", "Alyce"],
  ["Mary", "Marie"],
  ["Hale", "Hail"],
];

describe("nameKey", () => {
  it.each(VARIANT_PAIRS)("keys %s the same as %s", (a, b) => {
    expect(nameKey(a)).toBe(nameKey(b));
  });

  it("keys Catherine and Katharine to ktrn specifically", () => {
    // The worked example the ticket names: pinned to the literal value, not
    // just to equality with its pair, so a change to the algorithm that
    // still happens to keep the pair equal cannot drift unnoticed.
    expect(nameKey("Catherine")).toBe("ktrn");
    expect(nameKey("Katharine")).toBe("ktrn");
  });

  it("returns empty for a word with no letters", () => {
    // Empty in, empty out: there is nothing to key, and nothing should be
    // invented in place of a key.
    expect(nameKey("")).toBe("");
    expect(nameKey("''")).toBe("");
    expect(nameKey("123")).toBe("");
  });

  it("folds accents before keying, so José and Jose key the same", () => {
    expect(nameKey("José")).toBe(nameKey("Jose"));
  });

  /**
   * The deliberate over-collapse (see `nameKey`'s own docblock): these are
   * real, different names that share a key. Pinned here as much to document
   * the trade-off as to guard the algorithm — a change that stopped these
   * colliding would be a change to a decision, not a bug fix.
   */
  describe("the deliberate collisions", () => {
    it("collapses Rose and Ross onto one key", () => {
      expect(nameKey("Rose")).toBe(nameKey("Ross"));
    });

    it("collapses Hale and Hall onto one key", () => {
      expect(nameKey("Hale")).toBe(nameKey("Hall"));
    });

    it("collapses Mary and Moore onto one key", () => {
      expect(nameKey("Mary")).toBe(nameKey("Moore"));
    });
  });

  /**
   * The case a phonetic key cannot catch, and the reason `withinOneEdit`
   * exists beside it: a substituted letter that survives the vowel-dropping
   * step differently on each side of the pair.
   */
  it("does not catch Rosalind against Rosaline — that is withinOneEdit's job", () => {
    expect(nameKey("Rosalind")).toBe("rslnd");
    expect(nameKey("Rosaline")).toBe("rsln");
    expect(nameKey("Rosalind")).not.toBe(nameKey("Rosaline"));
  });
});

describe("withinOneEdit", () => {
  it("is true for two equal words", () => {
    expect(withinOneEdit("rosalind", "rosalind")).toBe(true);
  });

  it("is true for one substitution", () => {
    expect(withinOneEdit("rosalind", "rosaline")).toBe(true);
  });

  it("is true for one insertion", () => {
    expect(withinOneEdit("cat", "cart")).toBe(true);
  });

  it("is true for one deletion", () => {
    // The same case, read the other way round.
    expect(withinOneEdit("cart", "cat")).toBe(true);
  });

  it("is true for one transposition of adjacent letters", () => {
    expect(withinOneEdit("smith", "smtih")).toBe(true);
  });

  it("is false for two edits", () => {
    // "cat" -> "cort" is a substitution and an insertion: two edits.
    expect(withinOneEdit("cat", "cort")).toBe(false);
  });

  it("is false for two substitutions in an equal-length pair", () => {
    expect(withinOneEdit("rose", "rise")).toBe(true); // one substitution
    expect(withinOneEdit("rose", "rife")).toBe(false); // two substitutions
  });

  it("bails fast on wildly different lengths, without walking either string", () => {
    expect(withinOneEdit("al", "alexandria")).toBe(false);
  });

  it("rejects two non-adjacent mismatches as a transposition", () => {
    // "abcd" vs "cbad": positions 0 and 3 differ, but they are not adjacent,
    // so this is not one transposition — it is (at least) two edits.
    expect(withinOneEdit("abcd", "cbad")).toBe(false);
  });
});
