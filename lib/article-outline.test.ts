import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_CONTENTS_SLOT_ID,
  FALLBACK_HEADING_ID,
  headingId,
  nestHeadings,
  type OutlineHeading,
  readArticleOutline,
  RESERVED_HEADING_IDS,
} from "@/lib/article-outline";

/**
 * The heading ids are a shared mechanism, not an implementation detail of the
 * contents panel: E11-T4 (`YEO-74`) builds its section `[edit]` links from the
 * same function, and the two agreeing is the whole point of it being one
 * function. So the assertions here are about the id itself — that it is
 * derived from the text, that it is unique in the document, and that it is the
 * same id in `headings` as in `html` — rather than about how a panel draws it.
 *
 * `readArticleOutline` is given HTML that has already been through
 * `sanitizeHtml`, because that is what the read route hands it. Several tests
 * hand it something dirtier on purpose: writing the ids is a second pass
 * through the sanitiser, and that has to stay true or "derive the ids at
 * render time" becomes a way around the allowlist.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function source(file: string): string {
  return readFileSync(join(repoRoot, file), "utf8");
}

/** Just the ids, which is what most of these tests are actually about. */
function idsOf(bodyHtml: string): string[] {
  return readArticleOutline(bodyHtml).headings.map((heading) => heading.id);
}

describe("headingId", () => {
  it("derives an id from the heading's text", () => {
    expect(headingId("Early life")).toBe("early-life");
  });

  it("folds Latin accents and drops apostrophes, as an entry address does", () => {
    // Delegated to `slugFromTitle` rather than re-decided; this is the
    // assertion that says so.
    expect(headingId("Émile Lefèvre — O'Brien")).toBe("emile-lefevre-obrien");
  });

  it("keeps non-Latin letters rather than emptying the id", () => {
    // A family wiki is exactly where this is not a corner case. See the header
    // of `lib/entry-slug.ts`.
    expect(headingId("北京 Beijing")).toBe("北京-beijing");
  });

  it("calls a heading with no letters or digits a section, not an entry", () => {
    // `slugFromTitle`'s own fallback is the word "entry", which is the right
    // answer for an address and the wrong one for a section of one.
    expect(headingId("———")).toBe(FALLBACK_HEADING_ID);
    expect(headingId("😀")).toBe(FALLBACK_HEADING_ID);
    expect(headingId("")).toBe(FALLBACK_HEADING_ID);
  });

  it("is deterministic, so an anchor survives a reload", () => {
    // The one thing an id must never do is differ between two renders of the
    // same body — `slugCandidate`'s random tail would be a bug here.
    expect(headingId("Notes")).toBe(headingId("Notes"));
  });
});

describe("readArticleOutline", () => {
  it("reads every heading level, in document order", () => {
    const { headings } = readArticleOutline(
      "<h2>Early life</h2><p>x</p><h3>School</h3><h4>Sports</h4>",
    );

    expect(headings).toEqual<OutlineHeading[]>([
      { id: "early-life", level: 2, text: "Early life" },
      { id: "school", level: 3, text: "School" },
      { id: "sports", level: 4, text: "Sports" },
    ]);
  });

  it("puts each id on its own heading, and changes nothing else", () => {
    const { html } = readArticleOutline(
      "<h2>Early life</h2><p>Born in 1904.</p><h3>School</h3>",
    );

    expect(html).toBe(
      '<h2 id="early-life">Early life</h2>' +
        "<p>Born in 1904.</p>" +
        '<h3 id="school">School</h3>',
    );
  });

  it("has no headings, and so no panel, for a body without any", () => {
    // The acceptance criterion "an entry with no headings shows no contents
    // panel" is this array being empty.
    expect(readArticleOutline("<p>Just prose.</p>").headings).toEqual([]);
  });

  it("answers an empty body with an empty one", () => {
    expect(readArticleOutline("")).toEqual({ html: "", headings: [] });
  });

  describe("duplicate headings", () => {
    /**
     * The case that breaks anchors silently. Two sections called "Notes" is
     * ordinary in a wiki, and without a suffix both headings carry the same
     * id: the document is invalid, every link to the second one lands on the
     * first, and nothing anywhere reports it.
     */
    it("numbers the second and later of an identical heading", () => {
      expect(idsOf("<h2>Notes</h2><h2>Notes</h2><h2>Notes</h2>")).toEqual([
        "notes",
        "notes-2",
        "notes-3",
      ]);
    });

    it("counts from two, because that is how a person counts", () => {
      // Not `notes-1`, which implies a `notes-0` that does not exist.
      expect(idsOf("<h2>Notes</h2><h2>Notes</h2>")[1]).toBe("notes-2");
    });

    it("deduplicates across levels, not within one", () => {
      // An `h2` and an `h3` both called "Sources" collide just as badly.
      expect(idsOf("<h2>Sources</h2><h3>Sources</h3>")).toEqual([
        "sources",
        "sources-2",
      ]);
    });

    it("deduplicates headings that differ only in what the slug drops", () => {
      // "Notes!" and "Notes?" both slug to `notes`; the collision is real even
      // though the text is not identical.
      expect(idsOf("<h2>Notes!</h2><h2>Notes?</h2>")).toEqual([
        "notes",
        "notes-2",
      ]);
    });

    it("gives untitled headings distinct ids too", () => {
      expect(idsOf("<h2>———</h2><h2>😀</h2>")).toEqual([
        FALLBACK_HEADING_ID,
        `${FALLBACK_HEADING_ID}-2`,
      ]);
    });

    it("keeps html and headings agreeing about which id went where", () => {
      // What E11-T4 depends on: the nth id in the list is the id on the nth
      // heading in the markup.
      const { html, headings } = readArticleOutline(
        "<h2>Notes</h2><p>a</p><h2>Notes</h2>",
      );

      for (const heading of headings) {
        expect(html).toContain(`<h2 id="${heading.id}">${heading.text}</h2>`);
      }
      expect(new Set(headings.map((heading) => heading.id)).size).toBe(2);
    });
  });

  describe("heading text", () => {
    it("reads through inline markup", () => {
      const { headings } = readArticleOutline(
        '<h2><strong>Bold</strong> and <a href="/wiki/x">linked</a></h2>',
      );

      expect(headings[0].text).toBe("Bold and linked");
      expect(headings[0].id).toBe("bold-and-linked");
    });

    it("decodes entities for the label but leaves the markup escaped", () => {
      // The parser hands text back re-escaped. Left undecoded, the contents
      // panel would print the five characters `&amp;` at the reader.
      const { html, headings } = readArticleOutline(
        "<h2>Salt &amp; Pepper</h2>",
      );

      expect(headings[0].text).toBe("Salt & Pepper");
      expect(headings[0].id).toBe("salt-pepper");
      expect(html).toContain("Salt &amp; Pepper");
    });

    it("collapses the whitespace a heading was typed across", () => {
      const { headings } = readArticleOutline("<h2>  Early\n  life  </h2>");

      expect(headings[0].text).toBe("Early life");
    });

    it("keeps an empty heading, because it still needs an id", () => {
      // E11-T4 puts an `[edit]` link beside every heading, including this one.
      // The contents panel is what decides not to list it.
      const { headings } = readArticleOutline("<h2></h2>");

      expect(headings).toEqual([
        { id: FALLBACK_HEADING_ID, level: 2, text: "" },
      ]);
    });
  });

  describe("the sanitiser", () => {
    it("discards an id that arrived on the heading", () => {
      // `lib/sanitize-html.ts` allows no `id` through, deliberately, so this
      // should be unreachable from stored content — but writing ids must not
      // be the thing that lets one in.
      const { html, headings } = readArticleOutline('<h2 id="evil">Taken</h2>');

      expect(html).toBe('<h2 id="taken">Taken</h2>');
      expect(headings[0].id).toBe("taken");
    });

    it("still drops what the allowlist drops", () => {
      // The whole reason ids are written by a second sanitiser pass rather
      // than spliced into its output: the return value is sanitiser output
      // whatever the input was.
      const { html } = readArticleOutline(
        '<script>alert(1)</script><h2 onclick="steal()">Kept</h2>',
      );

      expect(html).toBe('<h2 id="kept">Kept</h2>');
    });

    it("allows an id on headings and on nothing else", () => {
      const { html } = readArticleOutline(
        '<h2>Sources</h2><p id="p">prose</p><a href="/wiki/x" id="a">link</a>',
      );

      expect(html).toContain('<h2 id="sources">');
      expect(html).toContain("<p>prose</p>");
      expect(html).toContain('<a href="/wiki/x">link</a>');
    });
  });

  describe("ids the page chrome has already taken", () => {
    it("does not hand a heading an id the shell is using", () => {
      // Two elements with `id="site-sidebar"` is invalid HTML, and the one a
      // fragment link finds is the shell's — it renders first.
      expect(idsOf("<h2>Site sidebar</h2>")).toEqual(["site-sidebar-2"]);
    });

    it("reserves the ids the shell and the panel actually declare", () => {
      // A tripwire, in the manner of `RESERVED_SLUGS`: `lib/` cannot import
      // from `components/` without inverting the layering, so the literals are
      // repeated there and checked here. Renaming one without updating the set
      // fails this rather than producing a duplicate id at some later date.
      expect(source("components/AppShell.tsx")).toContain(
        'const SIDEBAR_ID = "site-sidebar";',
      );
      expect(source("components/SiteSidebar.tsx")).toContain("`${id}-heading`");

      const panel = source("components/ArticleContents.tsx");
      expect(panel).toContain("`${ARTICLE_CONTENTS_SLOT_ID}-heading`");
      expect(panel).toContain("`${ARTICLE_CONTENTS_SLOT_ID}-list`");

      for (const id of [
        "site-sidebar",
        "site-sidebar-heading",
        ARTICLE_CONTENTS_SLOT_ID,
        `${ARTICLE_CONTENTS_SLOT_ID}-heading`,
        `${ARTICLE_CONTENTS_SLOT_ID}-list`,
      ]) {
        expect(RESERVED_HEADING_IDS.has(id)).toBe(true);
      }
    });

    it("puts the slot in the sidebar the shell renders", () => {
      expect(source("components/AppShell.tsx")).toContain(
        "<div id={ARTICLE_CONTENTS_SLOT_ID} />",
      );
    });
  });
});

describe("nestHeadings", () => {
  function outline(...levels: HeadingLevelInput[]): OutlineHeading[] {
    return levels.map(([level, id]) => ({ id, level, text: id }));
  }
  type HeadingLevelInput = [2 | 3 | 4, string];

  it("nests h3 and h4 under the h2 above them", () => {
    const tree = nestHeadings(
      outline([2, "life"], [3, "school"], [4, "sports"], [2, "work"]),
    );

    expect(tree.map((node) => node.id)).toEqual(["life", "work"]);
    expect(tree[0].children.map((node) => node.id)).toEqual(["school"]);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual([
      "sports",
    ]);
    expect(tree[1].children).toEqual([]);
  });

  it("keeps siblings at the same level side by side", () => {
    const tree = nestHeadings(outline([2, "a"], [3, "b"], [3, "c"]));

    expect(tree[0].children.map((node) => node.id)).toEqual(["b", "c"]);
  });

  it("hangs a skipped level off the nearest shallower heading", () => {
    // An h4 straight after an h2 is that h2's child, not the start of a
    // phantom h3.
    const tree = nestHeadings(outline([2, "a"], [4, "b"]));

    expect(tree.map((node) => node.id)).toEqual(["a"]);
    expect(tree[0].children.map((node) => node.id)).toEqual(["b"]);
  });

  it("puts a heading with nothing shallower before it at the top", () => {
    // Nothing stops an author reaching for "Heading 3" first.
    const tree = nestHeadings(outline([3, "deep"], [2, "shallow"]));

    expect(tree.map((node) => node.id)).toEqual(["deep", "shallow"]);
  });

  it("closes a deep run when a shallower heading arrives", () => {
    const tree = nestHeadings(
      outline([2, "a"], [3, "b"], [4, "c"], [3, "d"], [2, "e"]),
    );

    expect(tree.map((node) => node.id)).toEqual(["a", "e"]);
    expect(tree[0].children.map((node) => node.id)).toEqual(["b", "d"]);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual(["c"]);
  });

  it("answers an article with no headings with no tree", () => {
    expect(nestHeadings([])).toEqual([]);
  });
});
