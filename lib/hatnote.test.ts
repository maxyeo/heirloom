import { describe, expect, it } from "vitest";

import {
  describeExtraNamesakes,
  formatNamesake,
  hatnoteText,
  namesakeHatnoteLead,
  namesakeSeparator,
  NAMESAKE_LIMIT,
  normaliseHatnote,
  type NamesakePerson,
} from "@/lib/hatnote";
import { ALLOWED_TAGS } from "@/lib/sanitize-html";

/** A namesake with no dates, so each test states only the ones it is about. */
function namesake(fields: Partial<NamesakePerson> = {}): NamesakePerson {
  return {
    id: "n1",
    givenName: "Rose",
    surname: "Whitfield",
    slug: null,
    birthDate: null,
    birthDateQualifier: "exact",
    birthDateUpper: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDateUpper: null,
    ...fields,
  };
}

describe("normaliseHatnote", () => {
  it("keeps text and links, and nothing else", () => {
    expect(
      normaliseHatnote(
        '<p>For the house, see <a href="/wiki/rose-hall">Rose Hall</a>.</p>',
      ),
    ).toBe('For the house, see <a href="/wiki/rose-hall">Rose Hall</a>.');
  });

  it("drops the wrapper element rather than storing one", () => {
    // The wrapper is the renderer's (`components/ArticleHatnote.tsx`), so a
    // stored `<p>` would produce a block inside a block.
    expect(normaliseHatnote("<p>Not the ship.</p>")).toBe("Not the ship.");
  });

  it("flattens emphasis to its own text", () => {
    // The line is already italic; a `<strong>` in it is a formatting decision
    // the field does not offer, and its text is still what the author typed.
    expect(normaliseHatnote("<p>Not <strong>that</strong> Rose.</p>")).toBe(
      "Not that Rose.",
    );
  });

  it("turns a block boundary into a space rather than a join", () => {
    expect(normaliseHatnote("<p>one</p><p>two</p>")).toBe("one two");
    expect(normaliseHatnote("<p>one<br />two</p>")).toBe("one two");
    expect(normaliseHatnote("<ul><li>one</li><li>two</li></ul>")).toBe(
      "one two",
    );
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(normaliseHatnote("<p>  see    also  </p>")).toBe("see also");
  });

  it("strips a script rather than keeping its text", () => {
    // `nonTextTags` in `lib/sanitize-html.ts` is what does this, which is the
    // point of going through it rather than around it.
    expect(normaliseHatnote('<p>hi<script>alert("x")</script></p>')).toBe("hi");
  });

  it("refuses a javascript: href, because the one allowlist refuses it", () => {
    const result = normaliseHatnote(
      '<p><a href="javascript:alert(1)">click</a></p>',
    );
    expect(result).not.toContain("javascript:");
    expect(hatnoteText(result)).toBe("click");
  });

  it("keeps an href with markup characters in it escaped", () => {
    const result = normaliseHatnote(
      '<p>see <a href="/wiki/a&amp;b">A &amp; B</a></p>',
    );
    expect(result).toBe('see <a href="/wiki/a&amp;b">A &amp; B</a>');
  });

  it("is idempotent, so read-path normalisation costs a parse and nothing else", () => {
    const once = normaliseHatnote(
      '<p>For the house, see <a href="/wiki/rose-hall">Rose Hall</a>.</p>',
    );
    expect(normaliseHatnote(once)).toBe(once);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["whitespace", "   \n  "],
    ["an empty paragraph", "<p></p>"],
    ["markup with no text", "<p><strong></strong></p>"],
    ["a link with no text", '<p><a href="/wiki/rose"></a></p>'],
  ])("is empty for %s", (_label, input) => {
    expect(normaliseHatnote(input)).toBe("");
  });

  it("emits no tag the entry-body allowlist does not already permit", () => {
    // The narrowing is a transform over `sanitizeHtml`'s output, so it can
    // only ever remove. This is the assertion that keeps it that way.
    const result = normaliseHatnote(
      '<h2>Head</h2><p><em>x</em> <a href="/wiki/a">a</a></p>',
    );
    for (const [, tag] of result.matchAll(/<\/?([a-zA-Z][^\s/>]*)/g)) {
      expect(ALLOWED_TAGS).toContain(tag.toLowerCase());
    }
    expect(result).toBe('Head x <a href="/wiki/a">a</a>');
  });
});

describe("hatnoteText", () => {
  it("reads the line as a reader hears it", () => {
    expect(
      hatnoteText(
        'For the house, see <a href="/wiki/rose-hall">Rose Hall</a>.',
      ),
    ).toBe("For the house, see Rose Hall.");
  });

  it("decodes escapes rather than reporting them", () => {
    expect(hatnoteText("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });
});

describe("formatNamesake", () => {
  it("puts the lifespan in brackets, because that is what tells them apart", () => {
    expect(
      formatNamesake(
        namesake({ birthDate: "1890-01-01", deathDate: "1962-01-01" }),
      ),
    ).toBe("Rose Whitfield (1890–1962)");
  });

  it("carries the qualifier, so a guess does not read as a fact", () => {
    expect(
      formatNamesake(
        namesake({ birthDate: "1890-01-01", birthDateQualifier: "about" }),
      ),
    ).toBe("Rose Whitfield (b. about 1890)");
  });

  it("renders no brackets at all when neither date is recorded", () => {
    expect(formatNamesake(namesake())).toBe("Rose Whitfield");
  });

  it("drops the empty half of a name rather than leaving a trailing space", () => {
    expect(formatNamesake(namesake({ surname: null }))).toBe("Rose");
  });
});

describe("the sentence", () => {
  it("leads with the shared name", () => {
    expect(namesakeHatnoteLead("Rose Whitfield")).toBe(
      "For other people named Rose Whitfield, see",
    );
  });

  it("joins two names with a word and not a comma", () => {
    expect(namesakeSeparator(0, 2, false)).toBe(" ");
    expect(namesakeSeparator(1, 2, false)).toBe(" and ");
  });

  it("commas the middle of a longer list", () => {
    expect(namesakeSeparator(1, 3, false)).toBe(", ");
    expect(namesakeSeparator(2, 3, false)).toBe(" and ");
  });

  it("keeps the last comma when a count follows, so the 'and' lands once", () => {
    expect(namesakeSeparator(NAMESAKE_LIMIT - 1, NAMESAKE_LIMIT, true)).toBe(
      ", ",
    );
  });

  it("counts the overflow in words", () => {
    expect(describeExtraNamesakes(1)).toBe("and 1 other");
    expect(describeExtraNamesakes(3)).toBe("and 3 others");
  });
});
