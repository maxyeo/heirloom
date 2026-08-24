import { describe, expect, it } from "vitest";

import {
  collapseWhitespace,
  decodeHtmlEscapes,
  escapeHtmlAttribute,
  HTML_TOKEN_PATTERN,
} from "@/lib/html-text";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * The scanner itself is exercised through its two callers —
 * `lib/content-diff.test.ts` reads text out of documents with it, and
 * `lib/red-links.test.ts` reads links out of them. What is worth asserting
 * here is the part neither of those would notice going wrong: the shape of a
 * token, and the two string functions that have to be exact inverses of what
 * `sanitizeHtml` emits.
 */

describe("HTML_TOKEN_PATTERN", () => {
  it("separates a tag into its name, its attributes and its text", () => {
    const tokens = [
      ...'<a href="/wiki/rose" class="new">Rose</a>'.matchAll(
        HTML_TOKEN_PATTERN,
      ),
    ];

    expect(
      tokens.map((token) => [token[1], token[2], token[3], token[4]]),
    ).toEqual([
      ["", "a", ' href="/wiki/rose" class="new"', undefined],
      [undefined, undefined, undefined, "Rose"],
      ["/", "a", "", undefined],
    ]);
  });

  it("locates each token in the source", () => {
    // The offsets are what let a caller rewrite one tag and copy every other
    // byte across untouched. See `markMissingEntryLinks`.
    const html = "<p>Rose</p>";
    const [open] = [...html.matchAll(HTML_TOKEN_PATTERN)];

    expect(html.slice(open.index, open.index + open[0].length)).toBe("<p>");
  });

  it("does not let a comment terminate a phantom tag", () => {
    const tokens = [..."<!-- a > b -->Rose".matchAll(HTML_TOKEN_PATTERN)];

    expect(tokens).toHaveLength(2);
    expect(tokens[1][4]).toBe("Rose");
  });

  it("does not mistake a raw `<` in prose for a tag", () => {
    /**
     * Out of the sanitiser a literal `<` is always `&lt;`, so this is only
     * reachable from a row written before the sanitiser existed or by a
     * hand-run `UPDATE`. The character itself is dropped — neither
     * alternative matches it — which is the safe direction: it is never read
     * as opening a tag, and never swallows the prose after it.
     */
    const tokens = [..."a < b".matchAll(HTML_TOKEN_PATTERN)];

    expect(tokens.map((token) => token[4])).toEqual(["a ", " b"]);
  });

  it("can be shared between callers without carrying state", () => {
    // Declared with `g` at module scope; `matchAll` clones rather than
    // advancing `lastIndex`, so two consumers cannot interfere.
    const html = "<p>a</p>";

    expect([...html.matchAll(HTML_TOKEN_PATTERN)]).toHaveLength(3);
    expect([...html.matchAll(HTML_TOKEN_PATTERN)]).toHaveLength(3);
  });
});

describe("decodeHtmlEscapes", () => {
  it("decodes exactly the four escapes the sanitiser emits", () => {
    expect(decodeHtmlEscapes("&amp;&lt;&gt;&quot;")).toBe('&<>"');
  });

  it("decodes each escape once, so stored text survives a round trip", () => {
    // `&amp;lt;` is how a literal `&lt;` in the prose is stored. Decoding
    // `&amp;` before `&lt;` would turn it into `<`.
    expect(decodeHtmlEscapes("&amp;lt;")).toBe("&lt;");
  });

  it("leaves a reference the sanitiser would already have resolved", () => {
    // htmlparser2 decodes every entity on the way in and re-escapes only
    // those four on the way out, so nothing else can still be in the string.
    expect(decodeHtmlEscapes("&mdash;")).toBe("&mdash;");
  });

  it("inverts what the sanitiser writes", () => {
    const text = 'Rose & Walter <the house> said "hi"';
    const safe = sanitizeHtml(
      `<p>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</p>`,
    );

    expect(decodeHtmlEscapes(safe.slice("<p>".length, -"</p>".length))).toBe(
      text,
    );
  });
});

describe("collapseWhitespace", () => {
  it("renders a run of whitespace as one space, and trims the ends", () => {
    expect(collapseWhitespace("  Rose\n\t  Hall  ")).toBe("Rose Hall");
  });

  it("collapses a non-breaking space with the rest", () => {
    // It renders as a space, so it counts as one.
    expect(collapseWhitespace("Rose  Hall")).toBe("Rose Hall");
  });

  it("has nothing to say about a string that is only whitespace", () => {
    expect(collapseWhitespace(" \n ")).toBe("");
  });
});

describe("escapeHtmlAttribute", () => {
  it("neutralises everything that could close an attribute or a tag", () => {
    expect(escapeHtmlAttribute('a" onmouseover="x')).toBe(
      "a&quot; onmouseover=&quot;x",
    );
    expect(escapeHtmlAttribute("<script>")).toBe("&lt;script&gt;");
  });

  it("does not double-escape an ampersand", () => {
    // One pass over one alternation, so `&` in `&amp;` is not re-escaped
    // into `&amp;amp;`.
    expect(escapeHtmlAttribute("&amp;")).toBe("&amp;amp;");
    expect(decodeHtmlEscapes(escapeHtmlAttribute("&amp;"))).toBe("&amp;");
  });

  it("closes a single-quoted attribute too", () => {
    // Not reachable from today's caller, which writes into `attr="…"`. It is
    // covered so the function is safe by construction rather than safe as
    // long as every future caller remembers which quote it chose.
    expect(escapeHtmlAttribute("a' onmouseover='x")).toBe(
      "a&#39; onmouseover=&#39;x",
    );
  });

  it("round-trips through the decoder, over what the sanitiser emits", () => {
    // Deliberately scoped: the escaper is *wider* than the decoder, because
    // it has to cover everything dangerous while the decoder only has to read
    // back what `sanitizeHtml` actually writes. `'` is the difference.
    const value = 'Rose & <Walter> said "hi"';

    expect(decodeHtmlEscapes(escapeHtmlAttribute(value))).toBe(value);
  });
});
