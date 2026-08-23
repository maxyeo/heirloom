import { describe, expect, it } from "vitest";

import {
  ALLOWED_ATTRIBUTES,
  ALLOWED_TAGS,
  ALLOWED_URL_SCHEMES,
  sanitizeHtml,
} from "@/lib/sanitize-html";

/**
 * Pure in, pure out — no database, no DOM, no fixtures. `npm test` runs this,
 * which is exactly what a security boundary wants: it fails on the commit that
 * breaks it rather than in a suite someone runs on purpose.
 *
 * The assertions below are grouped by the threat each one covers, not by the
 * tag it happens to use, because the thing worth protecting is the property
 * ("no event handler survives"), not the example.
 */
describe("sanitizeHtml", () => {
  describe("what the toolbar produces", () => {
    // The E1-T2 toolbar is bold, italic, heading, bullet list, link. Everything
    // it can emit has to survive untouched, or the sanitiser is a bug rather
    // than a boundary — content loss on save is worse than the risk it removes.
    it.each([
      ["paragraphs", "<p>Rose married Walter.</p>"],
      ["bold and italic", "<p><strong>Rose</strong> and <em>Walter</em></p>"],
      ["hard breaks", "<p>one<br />two</p>"],
      ["headings", "<h2>Early life</h2><h3>Schooling</h3><h4>Detail</h4>"],
      ["bullet lists", "<ul><li>Alice</li><li>Brian</li></ul>"],
      ["links", '<p><a href="https://example.com">source</a></p>'],
      ["nesting", "<ul><li><strong>Alice</strong> <em>Hale</em></li></ul>"],
    ])("keeps %s", (_label, html) => {
      expect(sanitizeHtml(html)).toBe(html);
    });

    it("leaves text content and entities alone", () => {
      // A sanitiser that mangles ordinary prose gets turned off. Accented
      // characters and already-escaped markup both have to round-trip.
      expect(sanitizeHtml("<p>café &amp; co</p>")).toBe("<p>café &amp; co</p>");
      expect(sanitizeHtml("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe(
        "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
      );
    });

    it("is idempotent, because it runs on both write and read", () => {
      // The save action sanitises, then the read route sanitises the same
      // string again. If a second pass changed anything, every page would
      // drift a little further from what its author typed on every render.
      const dirty =
        '<h2>Life</h2><p onclick="x"><a href="javascript:alert(1)">a</a></p><ul><li>b</li></ul>';
      const once = sanitizeHtml(dirty);

      expect(sanitizeHtml(once)).toBe(once);
    });

    it("treats an absent body as empty rather than as an error", () => {
      // `body_html` defaults to the empty string, and E1-T8 creates pages
      // before anything is written into them.
      expect(sanitizeHtml("")).toBe("");
      expect(sanitizeHtml(null)).toBe("");
      expect(sanitizeHtml(undefined)).toBe("");
    });
  });

  describe("script execution", () => {
    it("strips <script> along with its contents", () => {
      // Discarding the tag but keeping the text would leave `alert(1)` sitting
      // in the article as prose — harmless, but it means the payload survived
      // the parse, and the next serialisation could re-animate it.
      expect(sanitizeHtml("<script>alert(1)</script><p>after</p>")).toBe(
        "<p>after</p>",
      );
    });

    it("strips scripts smuggled inside foreign-content elements", () => {
      // The classic sanitiser bypass: HTML parsers switch to SVG/MathML
      // content models where the nesting rules differ. Neither wrapper is on
      // the allowlist, so neither the wrapper nor the script survives.
      expect(sanitizeHtml("<svg><script>alert(1)</script></svg>")).toBe("");
      expect(
        sanitizeHtml("<math><mtext><script>alert(1)</script></mtext></math>"),
      ).toBe("");
    });

    it("does not treat markup after </html> as a second document", () => {
      // `enforceHtmlBoundary`. A parser that resumes after the boundary can be
      // fed a payload that the first pass never sees.
      expect(sanitizeHtml("<p>a</p></html><script>alert(1)</script>")).toBe(
        "<p>a</p>",
      );
    });
  });

  describe("event handlers", () => {
    // Not enumerated in the module — `on*` attributes are simply absent from
    // the per-tag allowlist, so they are dropped by the same rule that drops
    // everything else. These cases exist to prove the general rule holds for
    // the specific attributes an attacker reaches for first.
    it.each([
      ['<p onclick="alert(1)">t</p>', "<p>t</p>"],
      ['<p ONCLICK="alert(1)">t</p>', "<p>t</p>"],
      ['<a href="/x" onmouseover="alert(1)">t</a>', '<a href="/x">t</a>'],
      ['<strong onfocus="alert(1)" tabindex="1">t</strong>', "<strong>t</strong>"],
      // `onerror` on an image is the canonical no-user-interaction payload.
      // `img` is not allowlisted yet either, so both halves go.
      ["<img src=x onerror=alert(1)>", ""],
    ])("drops the handler in %s", (dirty, clean) => {
      expect(sanitizeHtml(dirty)).toBe(clean);
    });
  });

  describe("link hrefs", () => {
    it.each([
      ["absolute https", "https://example.com/page"],
      ["absolute http", "http://example.com/page"],
      ["mailto", "mailto:rose@example.com"],
      // Site-relative forms. These carry no scheme at all, which is why the
      // scheme allowlist alone would not have permitted them.
      ["a rooted path", "/wiki/rose"],
      ["a bare path", "rose"],
      ["a fragment", "#early-life"],
      ["a query", "?revision=3"],
    ])("keeps %s", (_label, href) => {
      expect(sanitizeHtml(`<a href="${href}">x</a>`)).toBe(
        `<a href="${href}">x</a>`,
      );
    });

    it.each([
      ["javascript:", "javascript:alert(1)"],
      ["mixed-case javascript:", "JaVaScRiPt:alert(1)"],
      // Entity-encoded and leading-whitespace variants: the parser decodes and
      // trims before the scheme is matched, so neither disguise works.
      ["entity-encoded javascript:", "java&#115;cript:alert(1)"],
      ["whitespace-padded javascript:", " javascript:alert(1)"],
      ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
      ["vbscript:", "vbscript:msgbox(1)"],
      // Not dangerous, just not on the list — the allowlist is closed.
      ["ftp:", "ftp://example.com/x"],
      // Protocol-relative. It inherits the page's scheme, so it is an absolute
      // off-site link wearing a relative URL's clothes.
      ["protocol-relative", "//evil.example/x"],
    ])("strips the href for %s", (_label, href) => {
      // The anchor itself stays and the link text with it. An `<a>` with no
      // `href` is inert — not clickable, not focusable — so removing the
      // element as well would only lose the words the author wrote.
      expect(sanitizeHtml(`<a href="${href}">click me</a>`)).toBe(
        "<a>click me</a>",
      );
    });

    it("drops link attributes that are not href", () => {
      // `target="_blank"` is absent from the allowlist on purpose: with no
      // target there is no `window.opener` to hand a new tab, so reverse
      // tabnabbing never arises and no `rel` counter-measure is needed.
      expect(
        sanitizeHtml(
          '<a href="/wiki/rose" target="_blank" rel="opener" ping="https://evil.example">x</a>',
        ),
      ).toBe('<a href="/wiki/rose">x</a>');
    });
  });

  describe("tags outside the allowlist", () => {
    it("strips <iframe> and its fallback content", () => {
      expect(
        sanitizeHtml('<iframe src="https://evil.example">fallback</iframe><p>after</p>'),
      ).toBe("<p>after</p>");
    });

    it("strips <style> and the rules inside it", () => {
      // Keeping the tag's text would dump the CSS source into the article; a
      // surviving `<style>` could hide or reposition the page chrome around it.
      expect(sanitizeHtml("<style>body{display:none}</style><p>after</p>")).toBe(
        "<p>after</p>",
      );
    });

    it.each([
      ["<object>", '<object data="evil.swf"></object><p>after</p>'],
      ["<embed>", '<embed src="evil.swf"><p>after</p>'],
      ["<form>", '<form action="https://evil.example"><input name="x"></form><p>after</p>'],
      ["<base>", '<base href="https://evil.example/"><p>after</p>'],
      ["<meta refresh>", '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>after</p>'],
      ["<link>", '<link rel="stylesheet" href="https://evil.example/x.css"><p>after</p>'],
    ])("strips %s", (_label, dirty) => {
      expect(sanitizeHtml(dirty)).toBe("<p>after</p>");
    });

    it("strips presentational and identifying attributes", () => {
      // `style` is a live vector (a fixed-position overlay can cover the real
      // page), `class` and `id` let authored content collide with the app's
      // own stylesheet and DOM ids.
      expect(
        sanitizeHtml('<p style="position:fixed;top:0" class="site-header" id="main">t</p>'),
      ).toBe("<p>t</p>");
    });

    it("drops the tags the toolbar has no button for", () => {
      // Not a security property — a scope one. These are StarterKit defaults
      // with no toolbar button, and E1-T2 is expected to disable them. If it
      // does not, this is the shape of the content loss: the block wrapper
      // goes and its inline content stays.
      expect(sanitizeHtml("<h1>title</h1>")).toBe("title");
      expect(sanitizeHtml("<ol><li>one</li></ol>")).toBe("<li>one</li>");
      expect(sanitizeHtml("<blockquote><p>q</p></blockquote>")).toBe("<p>q</p>");
      expect(sanitizeHtml("<pre><code>x</code></pre>")).toBe("x");
      expect(sanitizeHtml("<hr>")).toBe("");
      // `img` waits for E5-T3, which is blocked on this module for that reason.
      expect(sanitizeHtml('<p><img src="/photo.jpg" alt="Rose"></p>')).toBe("<p></p>");
    });
  });

  describe("the exported allowlist", () => {
    // E1-T2 has to configure TipTap to match this, and E5-T3 has to widen it.
    // Exporting the lists is what makes that a readable diff rather than a
    // grep through option objects.
    it("names only the tags the toolbar can produce", () => {
      expect([...ALLOWED_TAGS].sort()).toEqual([
        "a", "br", "em", "h2", "h3", "h4", "li", "p", "strong", "ul",
      ]);
    });

    it("permits attributes on links only", () => {
      expect(ALLOWED_ATTRIBUTES).toEqual({ a: ["href"] });
    });

    it("permits only the three schemes the ticket allows", () => {
      expect([...ALLOWED_URL_SCHEMES]).toEqual(["http", "https", "mailto"]);
    });
  });
});
