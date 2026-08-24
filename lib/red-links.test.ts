import { describe, expect, it } from "vitest";

import { readArticleOutline } from "@/lib/article-outline";
import { entryHref } from "@/lib/entry-links";
import {
  entryLinkProps,
  entryLinkSlugs,
  type ExistingSlugLookup,
  markMissingEntryLinks,
  MISSING_ENTRY_TITLE,
  NEW_ENTRY_TITLE_PARAM,
  newEntryHref,
  resolveEntryLinks,
  scanEntryLinks,
} from "@/lib/red-links";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * A body as the editor would have stored it: links written by E2-T5's picker,
 * which is to say plain site-relative hrefs and nothing else.
 */
const BODY =
  "<p>Rose married " +
  `<a href="${entryHref("walter-hale")}">Walter Hale</a>` +
  " at " +
  `<a href="${entryHref("rose-hall")}">Rose Hall</a>` +
  ", where " +
  `<a href="${entryHref("walter-hale")}">he</a>` +
  " was born.</p>";

/**
 * A lookup that records what it was asked, so a test can assert *how many
 * times* the database would have been reached rather than only what the page
 * looks like afterwards.
 *
 * This is the assertion the ticket singles out: an implementation that
 * resolves one link at a time renders identically and is wrong, and nothing
 * about the rendered output would ever show it.
 */
function recordingLookup(existing: readonly string[]) {
  const existingSlugs = new Set(existing);
  const calls: ReadonlySet<string>[] = [];

  const lookup: ExistingSlugLookup = async (slugs) => {
    calls.push(slugs);
    return new Set([...slugs].filter((slug) => existingSlugs.has(slug)));
  };

  return { lookup, calls };
}

describe("scanEntryLinks", () => {
  it("finds every internal link, in document order", () => {
    expect(scanEntryLinks(BODY).map((link) => [link.slug, link.text])).toEqual([
      ["walter-hale", "Walter Hale"],
      ["rose-hall", "Rose Hall"],
      ["walter-hale", "he"],
    ]);
  });

  it("defers to entrySlugFromHref about what is an entry", () => {
    /**
     * Not a re-test of `lib/entry-links.ts` — those cases have their own file.
     * It is the coupling that is being asserted: E2-T5 answered these
     * questions deliberately, and this module must not answer them a second
     * time. Every href below is one that a naive `startsWith("/wiki/")` would
     * get wrong.
     */
    const html =
      '<p><a href="https://example.test/wiki/rose">absolute, so external</a>' +
      '<a href="https://heirloom.test/wiki/rose">this host, still external</a>' +
      '<a href="/wiki/rose/edit">a route, not an entry</a>' +
      '<a href="/wiki/">the index</a>' +
      '<a href="mailto:rose@example.test">not a page at all</a>' +
      '<a href="/tree?person=1">a different route</a>' +
      '<a href="/wiki/%">a broken escape</a></p>';

    expect(scanEntryLinks(html)).toEqual([]);
  });

  it("reads a fragment link as a link to its entry", () => {
    const html = `<p><a href="${entryHref("rose-hall")}#early-life">early life</a></p>`;

    expect(scanEntryLinks(html).map((link) => link.slug)).toEqual([
      "rose-hall",
    ]);
  });

  it("reads the text through markup and escapes", () => {
    const html =
      `<p><a href="${entryHref("rose-hall")}">` +
      "  Rose\n  &amp; <strong>Walter</strong> &lt;the house&gt;  " +
      "</a></p>";

    // Decoded, and with whitespace collapsed the way a browser renders it —
    // otherwise the create form opens with the editor's line breaks in the
    // title field.
    expect(scanEntryLinks(html)[0].text).toBe("Rose & Walter <the house>");
  });

  it("keeps an external link from stealing an entry link's text", () => {
    // Nested anchors are invalid HTML and the sanitiser does not emit them.
    // The stack exists so a stored body that holds them anyway degrades to a
    // link this module ignores rather than to the wrong text on the wrong
    // target.
    const html =
      `<p><a href="${entryHref("rose-hall")}">Rose ` +
      '<a href="https://example.test">elsewhere</a></a></p>';

    expect(scanEntryLinks(html).map((link) => link.slug)).toEqual([
      "rose-hall",
    ]);
  });

  it("ignores a stray closing tag and an unclosed anchor", () => {
    // Both fail safe: no occurrence, so the link is left exactly as it is.
    expect(scanEntryLinks("<p>a</a>b</p>")).toEqual([]);
    expect(
      scanEntryLinks(`<p><a href="${entryHref("rose-hall")}">Rose</p>`),
    ).toEqual([]);
  });
});

describe("entryLinkSlugs", () => {
  it("names an entry once however often it is linked", () => {
    // Three links, two entries — and so two values in the `IN` list.
    expect(entryLinkSlugs(BODY)).toEqual(new Set(["walter-hale", "rose-hall"]));
  });
});

describe("newEntryHref", () => {
  it("points at the create flow, pre-titled", () => {
    expect(newEntryHref("Walter Hale")).toBe("/wiki/new?title=Walter+Hale");
  });

  it("survives a title full of URL punctuation", () => {
    // A link's text is prose, and prose holds these. Interpolated raw, the
    // `&` would invent a second parameter and the `#` would end the URL.
    const title = 'Rose & Walter #2 ? "the house"';
    const url = new URL(newEntryHref(title), "https://heirloom.test");

    expect(url.pathname).toBe("/wiki/new");
    expect(url.searchParams.get(NEW_ENTRY_TITLE_PARAM)).toBe(title);
  });
});

describe("entryLinkProps", () => {
  /**
   * The API E11-T5 (`YEO-75`) calls: the infobox renders its links as React
   * elements from person rows rather than as a chunk of HTML, so it needs the
   * decision without the rewrite. Both go through here, which is what keeps
   * "what a red link is" a single description.
   */

  const EXISTING = new Set(["rose-hall"]);

  it("sends an existing entry to itself, with no marks", () => {
    const props = entryLinkProps(
      { slug: "rose-hall", text: "Rose Hall" },
      EXISTING,
    );

    expect(props).toEqual({ href: "/wiki/rose-hall" });
  });

  it("sends a missing entry to the create flow, pre-titled", () => {
    const props = entryLinkProps(
      { slug: "walter-hale", text: "Walter Hale" },
      EXISTING,
    );

    expect(props).toEqual({
      href: "/wiki/new?title=Walter+Hale",
      className: "new",
      title: MISSING_ENTRY_TITLE,
    });
  });

  it("reddens a target that has no slug at all", () => {
    /**
     * The infobox's own case: a person whose `individuals.page_id` is empty
     * has never had an entry, so there is no address to resolve. That is the
     * purest red link there is, and it must not need a slug invented for it.
     */
    const props = entryLinkProps({ slug: null, text: "Walter Hale" }, EXISTING);

    expect(props).toEqual({
      href: "/wiki/new?title=Walter+Hale",
      className: "new",
      title: MISSING_ENTRY_TITLE,
    });
  });

  it("resolves many targets against one set, asking nothing", () => {
    // What makes "one query per render" survive a second caller: a component
    // handed the page's resolved set renders every link from it.
    const targets = [
      { slug: "rose-hall", text: "Rose Hall" },
      { slug: "walter-hale", text: "Walter Hale" },
      { slug: null, text: "Ada Hale" },
    ];

    expect(
      targets.map((target) => entryLinkProps(target, EXISTING).className),
    ).toEqual([undefined, "new", "new"]);
  });

  it("falls back to the slug when the link has no text", () => {
    // An empty anchor, or one wrapping only markup. A create form pre-filled
    // with nothing is worse than one pre-filled with an approximation.
    expect(
      entryLinkProps({ slug: "walter-hale", text: "" }, EXISTING).href,
    ).toBe("/wiki/new?title=walter-hale");
  });
});

describe("markMissingEntryLinks", () => {
  it("leaves a body whose links all resolve exactly as it found it", () => {
    // Byte-identical, not merely equivalent: nothing is re-serialised, so no
    // escaping can be lost on the way through.
    const existing = new Set(["walter-hale", "rose-hall"]);

    expect(markMissingEntryLinks(BODY, existing)).toBe(BODY);
  });

  it("marks an unresolved link red and points it at the create flow", () => {
    const marked = markMissingEntryLinks(BODY, new Set(["rose-hall"]));

    // Both links to the missing entry, each pre-titled with its own text.
    expect(marked).toContain(
      '<a href="/wiki/new?title=Walter+Hale" class="new" title="page does not exist">Walter Hale</a>',
    );
    expect(marked).toContain(
      '<a href="/wiki/new?title=he" class="new" title="page does not exist">he</a>',
    );
    // And the one that resolves is untouched.
    expect(marked).toContain(
      `<a href="${entryHref("rose-hall")}">Rose Hall</a>`,
    );
  });

  it("spells the tooltip the way the acceptance criterion does", () => {
    expect(MISSING_ENTRY_TITLE).toBe("page does not exist");
  });

  it("carries the red through to the token the stylesheet paints", () => {
    /**
     * The criterion names a colour, and `app/globals.css` is the only file
     * allowed to name it — `app/globals.test.ts` fails the build for a hex
     * declared anywhere else, this file included. So the assertion available
     * here is the other half of the same wiring: the class this module emits
     * is the one `a.new` selects, and `--color-link-new` is what that rule
     * paints.
     */
    const marked = markMissingEntryLinks(BODY, new Set());

    expect(marked).toContain('class="new"');
  });

  it("changes nothing but the opening tags it marks", () => {
    const marked = markMissingEntryLinks(BODY, new Set(["rose-hall"]));

    // The prose, the closing tags and the link text all survive.
    expect(marked).toContain("<p>Rose married ");
    expect(marked).toContain(" was born.</p>");
    expect(marked.match(/<\/a>/g)).toHaveLength(3);
  });

  it("turns a red link blue when the entry appears, with no edit to this body", () => {
    /**
     * The fourth acceptance criterion, stated as an assertion. The input is
     * the *same stored HTML* in both calls — nothing about the linking entry
     * changes, and nothing is denormalised into it. Only the answer from
     * `pages.slug` differs.
     */
    const before = markMissingEntryLinks(BODY, new Set(["rose-hall"]));
    const after = markMissingEntryLinks(
      BODY,
      new Set(["rose-hall", "walter-hale"]),
    );

    expect(before).toContain('class="new"');
    expect(after).not.toContain('class="new"');
    expect(after).toBe(BODY);
  });

  it("writes an opening tag that carries only the attributes it meant to", () => {
    /**
     * The link text becomes a query parameter in generated markup that goes
     * to `dangerouslySetInnerHTML`, so text engineered to close the attribute
     * it lands in is the shape worth pinning. Two layers stop it and both are
     * here on purpose: `URLSearchParams` percent-encodes the quote, and
     * `escapeHtmlAttribute` would catch it even if it did not.
     */
    const html = `<p><a href="${entryHref("x")}">a" onmouseover="alert(1)</a></p>`;

    const marked = markMissingEntryLinks(html, new Set());
    const openingTag = /<a\s[^>]*>/.exec(marked)?.[0] ?? "";

    // Exactly three attributes, whatever the text tried to add.
    expect(
      [...openingTag.matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]),
    ).toEqual(["href", "class", "title"]);
    // The quote never appears as a quote.
    expect(openingTag).toContain("a%22");
    expect(openingTag).not.toContain('onmouseover="alert');
  });
});

describe("resolveEntryLinks", () => {
  it("asks once for a body with many links", async () => {
    // The criterion that a correct-looking implementation fails silently: one
    // query per page render, not one per link.
    const { lookup, calls } = recordingLookup(["rose-hall"]);

    await resolveEntryLinks(BODY, lookup);

    expect(calls).toHaveLength(1);
  });

  it("asks for every slug in that one call, each once", async () => {
    const { lookup, calls } = recordingLookup(["rose-hall"]);

    await resolveEntryLinks(BODY, lookup);

    expect(calls[0]).toEqual(new Set(["walter-hale", "rose-hall"]));
  });

  it("does not ask at all when there is nothing to resolve", async () => {
    const { lookup, calls } = recordingLookup([]);

    const html =
      '<p>Rose married Walter at <a href="https://example.test">the hall</a>.</p>';
    expect(await resolveEntryLinks(html, lookup)).toBe(html);
    expect(calls).toHaveLength(0);
  });

  it("scales the query count with pages, not with links", async () => {
    // Thirty links to thirty entries is still one call. A per-link
    // implementation passes every assertion above except this one.
    const links = Array.from(
      { length: 30 },
      (_unused, index) =>
        `<a href="${entryHref(`person-${index}`)}">Person ${index}</a>`,
    ).join(" ");
    const { lookup, calls } = recordingLookup([]);

    const resolved = await resolveEntryLinks(`<p>${links}</p>`, lookup);

    expect(calls).toHaveLength(1);
    expect(calls[0].size).toBe(30);
    expect(resolved.match(/class="new"/g)).toHaveLength(30);
  });

  it("renders the red links the lookup did not account for", async () => {
    const { lookup } = recordingLookup(["rose-hall"]);

    const resolved = await resolveEntryLinks(BODY, lookup);

    expect(resolved).toContain(
      '<a href="/wiki/new?title=Walter+Hale" class="new" title="page does not exist">',
    );
    expect(resolved).toContain(
      `<a href="${entryHref("rose-hall")}">Rose Hall</a>`,
    );
  });
});

describe("the order this runs in", () => {
  it("is undone by sanitising afterwards, which is why it runs after", () => {
    /**
     * Not a bug being documented — a constraint being pinned. The sanitiser
     * allows exactly one attribute on an `a` and it is `href`
     * (`lib/sanitize-html.ts`), which is the whole reason resolution happens
     * at render time rather than being written into the body. It also means a
     * call site that sanitised *after* resolving would silently strip the
     * feature back out, with no error and no visible difference except that
     * every link is blue again.
     *
     * `app/wiki/[slug]/page.tsx` sanitises first and resolves second.
     */
    const marked = markMissingEntryLinks(BODY, new Set(["rose-hall"]));

    expect(marked).toContain('class="new"');
    expect(sanitizeHtml(marked)).not.toContain('class="new"');
    expect(sanitizeHtml(marked)).not.toContain(MISSING_ENTRY_TITLE);
  });

  it("marks a body the sanitiser has already been over", () => {
    // The real call order, end to end: what the route stores, sanitises and
    // then resolves.
    const stored = `<p><a href="${entryHref("walter-hale")}" class="new">Walter</a></p>`;
    const safe = sanitizeHtml(stored);

    // The author cannot pre-mark a link red: the class did not survive.
    expect(safe).toBe(
      `<p><a href="${entryHref("walter-hale")}">Walter</a></p>`,
    );

    expect(markMissingEntryLinks(safe, new Set())).toBe(
      '<p><a href="/wiki/new?title=Walter" class="new" title="page does not exist">Walter</a></p>',
    );
  });
});

/**
 * E11-T3 (`YEO-73`) and E11-T6 (`YEO-76`) both rewrite the sanitised body, and
 * the article route chains them: `readArticleOutline` writes heading ids by
 * running the body back through the sanitiser, and `resolveEntryLinks` then
 * marks the dead links.
 *
 * The order is load-bearing in one direction only. `markMissingEntryLinks`
 * adds `class` and `title` to an anchor, and the allowlist permits neither, so
 * a sanitiser pass afterwards strips the red links back out — silently, with
 * every other test in both files still passing. These assert the chain the
 * route actually uses, so reordering it fails here rather than in production.
 */
describe("chained with the article outline", () => {
  const BODY_WITH_HEADINGS =
    "<h2>Marriage</h2>" +
    `<p>Rose married <a href="${entryHref("walter-hale")}">Walter Hale</a>.</p>` +
    "<h2>Children</h2>" +
    `<p>Then <a href="${entryHref("rose-hall")}">Rose Hall</a>.</p>`;

  it("keeps the heading ids and the red links in one body", async () => {
    const outline = readArticleOutline(sanitizeHtml(BODY_WITH_HEADINGS));
    const html = await resolveEntryLinks(
      outline.html,
      recordingLookup(["rose-hall"]).lookup,
    );

    for (const heading of outline.headings) {
      expect(html).toContain(`id="${heading.id}"`);
    }
    expect(outline.headings).toHaveLength(2);
    expect(html).toContain(MISSING_ENTRY_TITLE);
    expect(html).toContain(newEntryHref("Walter Hale"));
    expect(html).not.toContain(`>${MISSING_ENTRY_TITLE}<`);
  });

  it("loses the red links if the outline runs last, which is why it does not", async () => {
    const marked = await resolveEntryLinks(
      sanitizeHtml(BODY_WITH_HEADINGS),
      recordingLookup(["rose-hall"]).lookup,
    );
    expect(marked).toContain(MISSING_ENTRY_TITLE);

    expect(readArticleOutline(marked).html).not.toContain(MISSING_ENTRY_TITLE);
  });
});
