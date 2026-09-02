import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FALLBACK_SLUG,
  MAX_SLUG_LENGTH,
  NUMBERED_CANDIDATES,
  RESERVED_SLUGS,
  SLUG_FORMAT,
  slugCandidate,
  slugFromTitle,
} from "@/lib/entry-slug";

/**
 * Slug derivation is a pure function of a string, so it is tested the way
 * `lib/tree-layout.ts` is: a literal in, a value out, no fixtures and no
 * database. That is the whole reason it lives in `lib/` rather than inside
 * the create action — see docs/testing.md.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("slugFromTitle", () => {
  it("lowercases and hyphenates an ordinary name", () => {
    expect(slugFromTitle("Rose Hall")).toBe("rose-hall");
  });

  it("collapses runs of punctuation and spacing into one hyphen", () => {
    expect(slugFromTitle("Rose  Hall -- Smith")).toBe("rose-hall-smith");
    expect(slugFromTitle("Rose (née Hall), 1901–1984")).toBe(
      "rose-nee-hall-1901-1984",
    );
  });

  it("leaves no leading or trailing hyphen", () => {
    expect(slugFromTitle("  ...Rose Hall!  ")).toBe("rose-hall");
  });

  describe("accents", () => {
    it("folds accented Latin letters to their base letter", () => {
      expect(slugFromTitle("Émile Zola")).toBe("emile-zola");
      expect(slugFromTitle("café")).toBe("cafe");
      expect(slugFromTitle("Ångström")).toBe("angstrom");
      expect(slugFromTitle("François Müller")).toBe("francois-muller");
    });

    it("folds a title whichever way it was normalised on the way in", () => {
      // The same name as one precomposed character and as a plain letter
      // plus a combining mark. macOS filenames and some paste sources produce
      // the second; both must reach the same entry.
      expect(slugFromTitle("Zo\u00EB")).toBe("zoe");
      expect(slugFromTitle("Zoe\u0308")).toBe("zoe");
    });

    it("does not fold a mark that is part of a non-Latin spelling", () => {
      // Cyrillic ё is its own letter, not an accented е, and Greek tonos
      // marks the stressed syllable. Folding either changes the word rather
      // than simplifying it.
      expect(slugFromTitle("Пётр Ильич")).toBe("пётр-ильич");
      expect(slugFromTitle("Ελληνικά")).toBe("ελληνικά");
    });
  });

  describe("apostrophes", () => {
    it("removes an apostrophe instead of breaking the word at it", () => {
      expect(slugFromTitle("O'Brien")).toBe("obrien");
      expect(slugFromTitle("d'Arcy")).toBe("darcy");
    });

    it("treats a typographic apostrophe as the same character", () => {
      // A word processor and a phone keyboard both produce U+2019, so the
      // two spellings of one name must not become two entries.
      expect(slugFromTitle("O’Brien")).toBe("obrien");
      expect(slugFromTitle("O’Brien")).toBe(slugFromTitle("O'Brien"));
    });

    it("collides an apostrophised name with its unapostrophised spelling", () => {
      // Stated as a deliberate consequence rather than left to be discovered:
      // "OBrien" and "O'Brien" share an address, so the second one written
      // gets a suffix. That is the intended behaviour for two spellings of
      // one name, and collision handling makes it harmless.
      expect(slugFromTitle("OBrien")).toBe(slugFromTitle("O'Brien"));
    });
  });

  describe("non-Latin titles", () => {
    it("keeps the characters rather than stripping them to nothing", () => {
      expect(slugFromTitle("日本語")).toBe("日本語");
      expect(slugFromTitle("한국어")).toBe("한국어");
      expect(slugFromTitle("مرحبا")).toBe("مرحبا");
    });

    it("hyphenates a non-Latin title on its spaces like any other", () => {
      expect(slugFromTitle("Пётр Ильич Чайковский")).toBe(
        "пётр-ильич-чайковский",
      );
    });

    it("mixes scripts without losing either", () => {
      expect(slugFromTitle("Rose 日本語 Hall")).toBe("rose-日本語-hall");
    });

    it("survives the round trip through a URL", () => {
      // The property the whole decision rests on: Next decodes the `[slug]`
      // segment before `getPageBySlug` sees it, so a non-Latin slug matches
      // the stored text exactly.
      const slug = slugFromTitle("日本語");
      expect(decodeURIComponent(encodeURIComponent(slug))).toBe(slug);
    });
  });

  describe("titles with nothing to derive from", () => {
    it("falls back for a title with no letters or digits", () => {
      expect(slugFromTitle("!!!")).toBe(FALLBACK_SLUG);
      expect(slugFromTitle("🎉🎉")).toBe(FALLBACK_SLUG);
      expect(slugFromTitle("—")).toBe(FALLBACK_SLUG);
    });

    it("falls back rather than returning an empty slug", () => {
      // An empty title is rejected before this is reached (`createPage`
      // returns `empty-title`), but the function still has to be total.
      expect(slugFromTitle("")).toBe(FALLBACK_SLUG);
      expect(slugFromTitle("   ")).toBe(FALLBACK_SLUG);
    });
  });

  describe("length", () => {
    it("caps a long title", () => {
      const slug = slugFromTitle("Rose ".repeat(40));
      expect([...slug].length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      expect(slug.startsWith("rose-rose")).toBe(true);
    });

    it("cuts at a word boundary and leaves no trailing hyphen", () => {
      const slug = slugFromTitle(`${"a".repeat(70)} bbbbbbbbbbbbbbbbbbbb tail`);
      expect(slug).toBe("a".repeat(70));
    });

    it("cuts a single unbroken word at the cap", () => {
      const slug = slugFromTitle("x".repeat(200));
      expect(slug).toBe("x".repeat(MAX_SLUG_LENGTH));
    });

    it("counts code points, so it never splits a character in half", () => {
      // A CJK title has no spaces to hyphenate on, so it truncates mid-word —
      // the case where slicing by UTF-16 index could leave half a surrogate
      // pair behind. Every code point must still be whole.
      const slug = slugFromTitle("𠮷".repeat(200));
      expect([...slug].length).toBe(MAX_SLUG_LENGTH);
      expect(slug).not.toContain("�");
      expect(slug).toBe(slug.normalize("NFC"));
    });
  });
});

describe("slugCandidate", () => {
  it("offers the base slug first", () => {
    expect(slugCandidate("rose-hall", 0)).toBe("rose-hall");
  });

  it("counts from two, the way a person names a second Rose Hall", () => {
    expect(slugCandidate("rose-hall", 1)).toBe("rose-hall-2");
    expect(slugCandidate("rose-hall", 2)).toBe("rose-hall-3");
  });

  it("never repeats an address it has already offered", () => {
    const offered = Array.from({ length: NUMBERED_CANDIDATES }, (_, n) =>
      slugCandidate("rose-hall", n),
    );
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("stops counting and goes random once the numbers run out", () => {
    // Twenty entries with one title is past anything real; what matters is
    // that creation still ends, rather than counting towards infinity with a
    // round trip to Postgres for each number.
    expect(
      slugCandidate("rose-hall", NUMBERED_CANDIDATES, () => "a1b2c3"),
    ).toBe("rose-hall-a1b2c3");
  });

  it("produces a fresh random suffix each time past the cap", () => {
    const first = slugCandidate("rose-hall", 40);
    const second = slugCandidate("rose-hall", 40);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^rose-hall-[0-9a-f]{6}$/);
  });
});

describe("RESERVED_SLUGS", () => {
  it("holds the create form's own address", () => {
    expect(RESERVED_SLUGS.has("new")).toBe(true);
  });

  /**
   * The guard that keeps the set honest. Next resolves a static segment
   * before the dynamic one, so any directory added under `app/wiki` takes
   * that address away from entries — silently, and only for the unlucky
   * author whose title happens to derive to it. Reading the directory rather
   * than listing the routes here means a new one cannot be forgotten.
   */
  it("names every static route that would shadow an entry", () => {
    const staticSegments = readdirSync(join(repoRoot, "app/wiki"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("["))
      .map((entry) => entry.name);

    // A guard that scans nothing passes for the wrong reason.
    expect(staticSegments).toContain("new");
    expect(
      staticSegments.filter((segment) => !RESERVED_SLUGS.has(segment)),
    ).toEqual([]);
  });
});

describe("SLUG_FORMAT", () => {
  /**
   * The invariant `db/schema.ts` documents the `slug` columns as holding
   * (`YEO-132`), asserted against the only thing that enforces it.
   *
   * These are not edge cases hunted for; they are the cases the rest of this
   * file already establishes matter — non-Latin scripts, accents, apostrophes,
   * punctuation-only titles, the length cap — re-read as a single question:
   * whatever came out, is it a slug? Nothing outside this module mints one,
   * so if every path through `slugFromTitle` satisfies this, every stored
   * slug does.
   */
  const TITLES = [
    "Rose Hall",
    "  ...Rose Hall!  ",
    "Rose (née Hall), 1901–1984",
    "O'Brien",
    "Émile Zola",
    "Пётр Ильич",
    "Ελληνικά",
    "Gerard Yeo 楊",
    "北京",
    "日本語",
    // Numbers Unicode calls letters and digits that POSIX does not — the
    // pair that decides the schema's argument. See `db/slug-format.db.test.ts`.
    "Henry Ⅷ",
    "½ Acre Farm",
    // Nothing survives the separator pass, so `FALLBACK_SLUG` answers.
    "🙂",
    "…",
    "!!!",
    "",
    "   ",
    // Past `MAX_SLUG_LENGTH`, with and without a boundary to cut at.
    "Rose ".repeat(40),
    "R".repeat(200),
    "北".repeat(200),
  ];

  it("describes everything slugFromTitle mints", () => {
    for (const title of TITLES) {
      const slug = slugFromTitle(title);
      expect(slug, `slugFromTitle(${JSON.stringify(title)})`).toMatch(
        SLUG_FORMAT,
      );
    }
  });

  it("survives the disambiguating suffixes", () => {
    // `slugCandidate` is the other half of the mint path: a base that
    // satisfies the invariant must still satisfy it once numbered, and once
    // the numbering runs out and the tail goes random.
    for (const title of TITLES) {
      const base = slugFromTitle(title);
      for (const attempt of [0, 1, 2, NUMBERED_CANDIDATES - 1]) {
        expect(slugCandidate(base, attempt)).toMatch(SLUG_FORMAT);
      }
      expect(slugCandidate(base, NUMBERED_CANDIDATES)).toMatch(SLUG_FORMAT);
    }
  });

  it("rejects the characters the path builders exist to escape", () => {
    // The complement, so the assertion above cannot pass by being vacuous.
    // Each of these is a character `lib/wiki-paths.ts` names as breaking an
    // href or a cache tag, and none of them is a slug this module can mint.
    for (const bad of [
      "rose hall",
      "rose#hall",
      "rose?hall",
      "rose/hall",
      "",
    ]) {
      expect(bad).not.toMatch(SLUG_FORMAT);
    }
  });
});
