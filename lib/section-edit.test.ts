import { describe, expect, it } from "vitest";

import { readArticleOutline } from "@/lib/article-outline";
import { entryHref } from "@/lib/entry-links";
import { MISSING_ENTRY_TITLE, resolveEntryLinks } from "@/lib/red-links";
import { sanitizeHtml } from "@/lib/sanitize-html";
import {
  insertSectionEditLinks,
  SECTION_PARAM,
  sectionEditHref,
  sectionHeadingIndex,
  sectionParam,
} from "@/lib/section-edit";

/**
 * The section `[edit]` links (E11-T4, `YEO-74`).
 *
 * Three properties are worth stating here, because each of them fails
 * silently: that the ids the links carry are the contents panel's own ids and
 * not a second slugging of the same text; that a link whose section has since
 * been renamed degrades to an editor open at the top rather than to an error;
 * and that inserting this markup does not disturb the red links, which is the
 * ordering trap `lib/red-links.test.ts` documents from the other side.
 *
 * The one thing not tested here is the editor end of the trip —
 * `headingNodePosition` needs a live document, so it is asserted in
 * `components/EntryEditor.test.tsx` alongside the other editor behaviour.
 */

/** The href a heading's `[edit]` points at, as it appears in the markup. */
function editHrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*\/edit\?[^"]*)"/g)].map(
    (match) => match[1],
  );
}

describe("sectionEditHref", () => {
  it("addresses the editor, with the section as a query parameter", () => {
    expect(sectionEditHref("rose-hall", "early-life")).toBe(
      "/wiki/rose-hall/edit?section=early-life",
    );
  });

  it("goes through entryHref, so the slug is encoded once and the same way", () => {
    expect(sectionEditHref("rose hall", "early-life")).toBe(
      `${entryHref("rose hall")}/edit?section=early-life`,
    );
  });

  it("encodes a heading id that is not Latin, and reads back intact", () => {
    const href = sectionEditHref("mihara", "三原村");
    const query = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(query.get(SECTION_PARAM)).toBe("三原村");
  });

  /**
   * A heading called "Rose & Walter" slugs to `rose-walter`, so the ampersand
   * is not reachable today. The escaping is asserted anyway: it is the
   * difference between a link that is safe and one that is safe by accident.
   */
  it("survives an id with URL punctuation in it", () => {
    const href = sectionEditHref("rose-hall", "a&b=c?d");
    const query = new URLSearchParams(href.slice(href.indexOf("?")));
    expect(query.get(SECTION_PARAM)).toBe("a&b=c?d");
  });
});

describe("sectionParam", () => {
  it("reads the section a request asks for", () => {
    expect(sectionParam("early-life")).toBe("early-life");
  });

  it("is null when nothing was asked for", () => {
    expect(sectionParam(undefined)).toBeNull();
    expect(sectionParam("")).toBeNull();
  });

  it("takes the first of a repeated parameter rather than choking on it", () => {
    expect(sectionParam(["early-life", "marriage"])).toBe("early-life");
    expect(sectionParam([])).toBeNull();
  });
});

describe("sectionHeadingIndex", () => {
  const headings = readArticleOutline(
    "<h2>Early life</h2><h3>School</h3><h2>Marriage</h2>",
  ).headings;

  it("finds a heading by the id the outline gave it", () => {
    expect(sectionHeadingIndex(headings, "early-life")).toBe(0);
    expect(sectionHeadingIndex(headings, "school")).toBe(1);
    expect(sectionHeadingIndex(headings, "marriage")).toBe(2);
  });

  /**
   * The case the ticket calls the common one rather than an edge: heading ids
   * are derived from heading text and never stored, so the first save that
   * renames "Early life" to "Childhood" invalidates every `[edit]` link an
   * open tab is still showing.
   */
  it("returns null for a heading that has been renamed away", () => {
    expect(sectionHeadingIndex(headings, "childhood")).toBeNull();
  });

  it("returns null when no section was asked for, or there are none", () => {
    expect(sectionHeadingIndex(headings, null)).toBeNull();
    expect(sectionHeadingIndex([], "early-life")).toBeNull();
  });
});

describe("insertSectionEditLinks", () => {
  /** The whole chain the read route runs, minus the red links. */
  function withEditLinks(bodyHtml: string, slug = "rose-hall"): string {
    const outline = readArticleOutline(sanitizeHtml(bodyHtml));
    return insertSectionEditLinks(outline.html, outline.headings, slug);
  }

  it("puts one link inside every heading, at every level", () => {
    const html = withEditLinks(
      "<h2>Early life</h2><p>Born.</p><h3>School</h3><h4>Prizes</h4>",
    );

    expect(editHrefs(html)).toEqual([
      "/wiki/rose-hall/edit?section=early-life",
      "/wiki/rose-hall/edit?section=school",
      "/wiki/rose-hall/edit?section=prizes",
    ]);
  });

  it("closes each link before the heading it belongs to closes", () => {
    expect(withEditLinks("<h2>Early life</h2>")).toBe(
      '<h2 id="early-life">Early life' +
        '<span class="wiki-editsection">' +
        '<span aria-hidden="true">[</span>' +
        '<a href="/wiki/rose-hall/edit?section=early-life"' +
        ' title="Edit section: Early life">edit</a>' +
        '<span aria-hidden="true">]</span>' +
        "</span></h2>",
    );
  });

  /**
   * The acceptance criterion that ties this ticket to E11-T3: the `[edit]`
   * link and the contents panel's anchor are the same id, because they are the
   * same call. A second slugging of the heading text would pass every other
   * test in this file.
   */
  it("carries exactly the ids the contents panel anchors to", () => {
    const outline = readArticleOutline(
      sanitizeHtml("<h2>Émile's house</h2><h2>Émile's house</h2><h2>—</h2>"),
    );
    const html = insertSectionEditLinks(
      outline.html,
      outline.headings,
      "rose-hall",
    );

    expect(outline.headings.map((heading) => heading.id)).toEqual([
      "emiles-house",
      "emiles-house-2",
      "section",
    ]);
    for (const heading of outline.headings) {
      expect(html).toContain(`id="${heading.id}"`);
      expect(html).toContain(`?section=${heading.id}"`);
    }
  });

  it("puts the link after markup inside the heading, not inside it", () => {
    const html = withEditLinks("<h2><strong>Early</strong> life</h2>");
    expect(html).toContain('life<span class="wiki-editsection">');
    expect(html).toContain("</span></h2>");
  });

  it("names the section in the tooltip, escaping what an author typed", () => {
    const html = withEditLinks('<h2>Rose &amp; "Walter" &lt;1904&gt;</h2>');
    expect(html).toContain(
      'title="Edit section: Rose &amp; &quot;Walter&quot; &lt;1904&gt;"',
    );
  });

  /**
   * A heading with no text still gets an id and still gets an `[edit]` — it is
   * a section of the document whether or not it is a nameable one. There is
   * simply no name to put in the tooltip.
   */
  it("still links a heading that has no text", () => {
    const html = withEditLinks("<h2></h2>");
    expect(html).toContain('title="Edit section"');
    expect(editHrefs(html)).toEqual(["/wiki/rose-hall/edit?section=section"]);
  });

  it("names a heading that has text but no letters in it", () => {
    // `FALLBACK_HEADING_ID` covers the id; the tooltip can still say what the
    // author actually wrote.
    const html = withEditLinks("<h2>—</h2>");
    expect(html).toContain('title="Edit section: —"');
    expect(editHrefs(html)).toEqual(["/wiki/rose-hall/edit?section=section"]);
  });

  it("leaves a body with no headings exactly as it found it", () => {
    const outline = readArticleOutline(
      sanitizeHtml("<p>Born at Rose Hall.</p><ul><li><p>A note</p></li></ul>"),
    );
    const html = insertSectionEditLinks(
      outline.html,
      outline.headings,
      "rose-hall",
    );

    expect(outline.headings).toEqual([]);
    // Byte-identical, which is the whole of "no headings, no chrome": not a
    // span, not a bracket, not a stray closing tag.
    expect(html).toBe(outline.html);
    expect(html).not.toContain("wiki-editsection");
    expect(html).not.toContain("[");
  });

  it("does nothing to an empty body", () => {
    expect(insertSectionEditLinks("", [], "rose-hall")).toBe("");
  });

  /**
   * The list and the document come from one call to `readArticleOutline`, so
   * they cannot disagree. If they ever did, an `[edit]` pointing at the wrong
   * section would be worse than a heading without one.
   */
  it("stops rather than guessing when it runs out of headings", () => {
    const html = insertSectionEditLinks(
      '<h2 id="one">One</h2><h2 id="two">Two</h2>',
      [{ id: "one", level: 2, text: "One" }],
      "rose-hall",
    );

    expect(editHrefs(html)).toEqual(["/wiki/rose-hall/edit?section=one"]);
    expect(html).toContain('<h2 id="two">Two</h2>');
  });

  it("keeps a heading's scroll anchor and its link in the same element", () => {
    const html = withEditLinks("<h2>Early life</h2>");
    const heading = html.slice(html.indexOf("<h2"), html.indexOf("</h2>"));
    expect(heading).toContain('id="early-life"');
    expect(heading).toContain("?section=early-life");
  });
});

/**
 * The article route runs three rewrites over one body: heading ids, then
 * `[edit]` links, then red links. The last of those adds `class` and `title`
 * to anchors that the sanitiser's allowlist permits on neither, which is why
 * it goes last and why `lib/red-links.test.ts` asserts what happens when it
 * does not.
 *
 * This ticket inserts a step in the middle of that chain, so it has to show
 * that it is not a fourth sanitiser pass and not a source of anchors the
 * red-link scan will misread. Both directions are asserted: the red links
 * survive, and no `[edit]` link is ever painted red.
 */
describe("chained with the red links", () => {
  const BODY =
    "<h2>Marriage</h2>" +
    `<p>Rose married <a href="${entryHref("walter-hale")}">Walter Hale</a>.</p>` +
    "<h3>Children</h3>" +
    `<p>Then <a href="${entryHref("rose-hall")}">Rose Hall</a>.</p>`;

  /** Exactly what `app/wiki/[slug]/page.tsx` does, in the same order. */
  async function articleHtml(): Promise<string> {
    const outline = readArticleOutline(sanitizeHtml(BODY));
    return resolveEntryLinks(
      insertSectionEditLinks(outline.html, outline.headings, "rose-hall"),
      async () => new Set(["rose-hall"]),
    );
  }

  it("marks the missing entry red with the [edit] links already in place", async () => {
    const html = await articleHtml();

    expect(html).toContain(`class="new"`);
    expect(html).toContain(MISSING_ENTRY_TITLE);
    // And the link to the entry that does exist is untouched.
    expect(html).toContain(`<a href="${entryHref("rose-hall")}">Rose Hall</a>`);
  });

  it("never mistakes an [edit] link for a link to an entry", async () => {
    const html = await articleHtml();

    expect(editHrefs(html)).toEqual([
      "/wiki/rose-hall/edit?section=marriage",
      "/wiki/rose-hall/edit?section=children",
    ]);
    // `entrySlugFromHref` rejects `/wiki/rose-hall/edit` as the deeper path it
    // is, so the scan never offers it to the lookup and the rewrite never
    // reaches it. A red `[edit]` on every heading is what getting this wrong
    // would look like.
    expect(html).not.toMatch(/<a href="[^"]*\/edit\?[^"]*" class="new"/);
  });

  it("asks about the entry links only, however many headings there are", async () => {
    const outline = readArticleOutline(sanitizeHtml(BODY));
    const asked: ReadonlySet<string>[] = [];

    await resolveEntryLinks(
      insertSectionEditLinks(outline.html, outline.headings, "rose-hall"),
      async (slugs) => {
        asked.push(slugs);
        return new Set(["rose-hall"]);
      },
    );

    expect(asked).toHaveLength(1);
    expect([...asked[0]].sort()).toEqual(["rose-hall", "walter-hale"]);
  });
});
