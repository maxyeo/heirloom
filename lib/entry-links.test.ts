import { describe, expect, it } from "vitest";

import { entryHref, entrySlugFromHref, searchEntries } from "@/lib/entry-links";
import type { TitledEntry } from "@/lib/page-index";
import { sanitizeHtml } from "@/lib/sanitize-html";

const ENTRIES: TitledEntry[] = [
  { title: "Ambrose Lane", slug: "ambrose-lane" },
  { title: "Émile Lefèvre", slug: "emile-lefevre" },
  { title: "Rose Hall", slug: "rose-hall" },
  { title: "Rose Hall (the house)", slug: "rose-hall-2" },
  { title: "The Rose Window", slug: "the-rose-window" },
  { title: "Walter Hale", slug: "walter-hale" },
  { title: "北京", slug: "北京" },
];

describe("entryHref", () => {
  it("is site-relative, so it survives a domain change", () => {
    // The acceptance criterion, stated as an assertion: no scheme, no host.
    const href = entryHref("rose-hall");

    expect(href).toBe("/wiki/rose-hall");
    expect(href.startsWith("/")).toBe(true);
    expect(href.startsWith("//")).toBe(false);
  });

  it("encodes a slug that would otherwise re-point the link", () => {
    // `pages.slug` is a `text` column; nothing in the schema stops these.
    expect(entryHref("rose hall")).toBe("/wiki/rose%20hall");
    expect(entryHref("a?b")).toBe("/wiki/a%3Fb");
    expect(entryHref("a#b")).toBe("/wiki/a%23b");
    expect(entryHref("a/b")).toBe("/wiki/a%2Fb");
  });

  it("round-trips a non-Latin slug", () => {
    // Not a corner case here — see `lib/entry-slug.ts`.
    expect(entrySlugFromHref(entryHref("北京"))).toBe("北京");
  });

  it.each(ENTRIES)("round-trips $slug", ({ slug }) => {
    expect(entrySlugFromHref(entryHref(slug))).toBe(slug);
  });

  it("survives the sanitiser", () => {
    /**
     * The coupling that matters most, and the one nothing else would catch:
     * `lib/sanitize-html.ts` runs over every body on write *and* on read, so
     * a link shape it strips is one the author watches disappear after
     * saving. A relative href carries no scheme, which is exactly what
     * `allowProtocolRelative: false` is there to distinguish from `//host`.
     */
    const html = `<p><a href="${entryHref("rose-hall")}">Rose Hall</a></p>`;

    expect(sanitizeHtml(html)).toBe(html);
  });
});

describe("entrySlugFromHref", () => {
  it("reads back an entry address", () => {
    expect(entrySlugFromHref("/wiki/rose-hall")).toBe("rose-hall");
  });

  it("ignores a fragment or a query", () => {
    // Otherwise the panel reports a perfectly good link as a missing entry.
    expect(entrySlugFromHref("/wiki/rose-hall#early-life")).toBe("rose-hall");
    expect(entrySlugFromHref("/wiki/rose-hall?from=tree")).toBe("rose-hall");
  });

  it.each([
    ["an external address", "https://example.com/rose"],
    ["this host, absolutely", "https://wiki.example/wiki/rose-hall"],
    ["a protocol-relative address", "//evil.example/wiki/rose-hall"],
    ["an email", "mailto:rose@example.com"],
    ["an in-page anchor", "#early-life"],
    ["another route entirely", "/tree"],
    ["the index", "/wiki/"],
    ["the edit route", "/wiki/rose-hall/edit"],
    ["the history route", "/wiki/rose-hall/history"],
  ])("does not claim %s", (_label, href) => {
    expect(entrySlugFromHref(href)).toBeNull();
  });

  it("returns null rather than throwing on a broken escape", () => {
    // `decodeURIComponent` raises `URIError` on a lone `%`. Stored HTML is
    // not this module's to trust, and a stray character should not take the
    // editor down with it.
    expect(entrySlugFromHref("/wiki/%")).toBeNull();
  });
});

describe("searchEntries", () => {
  it("opens with entries rather than an empty list", () => {
    // An empty query is a picker that has just been opened, not a query that
    // matched nothing.
    expect(searchEntries(ENTRIES, "").map((entry) => entry.slug)).toEqual([
      "ambrose-lane",
      "emile-lefevre",
      "rose-hall",
      "rose-hall-2",
      "the-rose-window",
      "walter-hale",
      "北京",
    ]);
  });

  it("ranks a title that starts with the query first", () => {
    // "Rose Hall" before "The Rose Window" before "Ambrose Lane": a title
    // beginning with what you typed is what you meant.
    expect(searchEntries(ENTRIES, "rose").map((entry) => entry.title)).toEqual([
      "Rose Hall",
      "Rose Hall (the house)",
      "The Rose Window",
      "Ambrose Lane",
    ]);
  });

  it("treats accents as a spelling rather than a difference", () => {
    expect(searchEntries(ENTRIES, "emile")).toHaveLength(1);
    expect(searchEntries(ENTRIES, "Émile")).toHaveLength(1);
    expect(searchEntries(ENTRIES, "lefevre")[0]?.slug).toBe("emile-lefevre");
  });

  it("takes terms in any order, and requires all of them", () => {
    expect(searchEntries(ENTRIES, "hall rose")[0]?.slug).toBe("rose-hall");
    expect(searchEntries(ENTRIES, "rose hall")[0]?.slug).toBe("rose-hall");
    // Adding a word narrows. "Rose Hall" has no "window" in it.
    expect(searchEntries(ENTRIES, "rose window").map((e) => e.title)).toEqual([
      "The Rose Window",
    ]);
  });

  it("answers nothing when nothing matches", () => {
    expect(searchEntries(ENTRIES, "zeppelin")).toEqual([]);
  });

  it("breaks ties the way the index orders entries", () => {
    // Both are tier 0 for "rose hall"; the collator and then the slug decide.
    expect(searchEntries(ENTRIES, "rose hall").map((e) => e.slug)).toEqual([
      "rose-hall",
      "rose-hall-2",
    ]);
  });

  it("stops at the limit", () => {
    expect(searchEntries(ENTRIES, "", { limit: 2 })).toHaveLength(2);
  });
});
