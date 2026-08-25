import { getSchema } from "@tiptap/core";
import { Link } from "@tiptap/extension-link";
import { describe, expect, it } from "vitest";

import {
  BLOCK_STYLES,
  EDITOR_INPUT_OPTIONS,
  HATNOTE_STARTER_KIT_OPTIONS,
  HATNOTE_TOOLBAR_ITEMS,
  HEADING_LEVELS,
  STARTER_KIT_OPTIONS,
  TOOLBAR_ITEMS,
  createEntryExtensions,
  createHatnoteExtensions,
  normaliseLinkHref,
} from "@/lib/editor-extensions";
import {
  ALLOWED_TAGS,
  ALLOWED_URL_SCHEMES,
  sanitizeHtml,
} from "@/lib/sanitize-html";

/**
 * The editor's decisions, checked without a DOM.
 *
 * This project has no jsdom (docs/testing.md), and a Tiptap `Editor` cannot be
 * constructed without a `window` — so none of this drives the editor. What it
 * can do is better than a smoke test anyway: `getSchema()` builds the real
 * ProseMirror schema from the real extension list in plain Node, which is the
 * authoritative answer to "what markup can this editor produce".
 *
 * What is deliberately *not* covered, so nobody is misled: that typing `*`
 * really produces an asterisk. That is a running editor's behaviour. What is
 * covered is the setting that decides it, which is the part this repo owns.
 */

/**
 * The Link extension's options *after* Tiptap has merged them with its own
 * defaults — which is the only version of them that describes what the editor
 * will actually emit. `STARTER_KIT_OPTIONS.link` is what this repo asked for;
 * this is what it got.
 *
 * `configure()` is the same call StarterKit makes internally for its `link`
 * child, so this resolves the identical options without a DOM and without
 * reaching into how StarterKit assembles itself.
 */
function resolvedLinkOptions(): { HTMLAttributes: Record<string, unknown> } {
  return Link.configure(STARTER_KIT_OPTIONS.link).options as {
    HTMLAttributes: Record<string, unknown>;
  };
}

describe("the toolbar", () => {
  // From docs/product.md: the author is not a developer, and every extra
  // button is a thing that can be pressed by accident and not understood. This
  // assertion is the ticket's "resist adding to it", written down where a
  // seventh button will trip over it.
  it("is these six controls and nothing else", () => {
    expect(TOOLBAR_ITEMS.map((item) => item.id)).toEqual([
      "heading",
      "bold",
      "italic",
      "bulletList",
      "link",
      "image",
    ]);
  });

  it("ships no inert buttons", () => {
    // The image button was the last one, disabled until E5-T3 (`YEO-43`) gave
    // it something to do. `disabled` is gone from the shape entirely rather
    // than set to `false`, so a future placeholder has to reintroduce the
    // field and argue for it — the bar not changing shape when a feature
    // lands is worth a placeholder, and a placeholder nobody removes is not.
    const inert = TOOLBAR_ITEMS.filter((item) => "disabled" in item);

    expect(inert).toEqual([]);
  });

  it("offers exactly the heading levels the sanitiser keeps", () => {
    // The heading control is a select, so its options are the other half of
    // the toolbar's promise: three levels, plus a way back to body text.
    expect(BLOCK_STYLES.map((style) => style.value)).toEqual([
      "paragraph",
      ...HEADING_LEVELS.map(String),
    ]);
  });
});

describe("what the editor can emit", () => {
  /**
   * Every node and mark the schema can hold, and the tag each one renders as.
   *
   * The table is written out rather than derived because it is the claim under
   * test: these two lists are two views of one decision, and the assertions
   * below fail if either side moves without the other. Adding a tag to
   * `ALLOWED_TAGS` with no way to produce it, or enabling an extension that
   * emits something the sanitiser drops, both land here.
   */
  const TAGS_BY_SCHEMA_NAME: Readonly<Record<string, readonly string[]>> = {
    // Structural, and not markup an author chooses.
    doc: [],
    text: [],

    paragraph: ["p"],
    hardBreak: ["br"],
    heading: ["h2", "h3", "h4"],
    bulletList: ["ul"],
    listItem: ["li"],

    // The photograph (E5-T3, `YEO-43`). A node of this repository's own
    // rather than `@tiptap/extension-image`, so that what it will parse is
    // held to the same predicate the sanitiser uses — see `EntryImage`.
    image: ["img"],

    bold: ["strong"],
    italic: ["em"],
    link: ["a"],
  };

  const schema = getSchema(createEntryExtensions());
  const schemaNames = [
    ...Object.keys(schema.nodes),
    ...Object.keys(schema.marks),
  ].sort();

  it("registers no node or mark the table does not account for", () => {
    // A StarterKit extension left on by accident shows up here first.
    expect(schemaNames).toEqual(Object.keys(TAGS_BY_SCHEMA_NAME).sort());
  });

  it("produces exactly the tags the sanitiser allows", () => {
    const producible = new Set(
      schemaNames.flatMap((name) => TAGS_BY_SCHEMA_NAME[name]),
    );

    // Set equality, both directions. A tag the editor emits but the allowlist
    // drops is silent content loss on save; a tag the allowlist keeps but
    // nothing can produce is a tag no one has looked at.
    expect([...producible].sort()).toEqual([...ALLOWED_TAGS].sort());
  });

  it("caps headings at the levels below the article title", () => {
    // h1 is the entry's title and the page chrome owns it (E11-T2), so body
    // headings start at h2 — the convention Wikipedia articles follow.
    expect(STARTER_KIT_OPTIONS.heading.levels).toEqual([2, 3, 4]);
  });

  it("cannot render an h1 even from a heading node that claims level 1", () => {
    // The heading node's `level` attribute still defaults to 1, so this is
    // worth pinning down rather than assuming: Tiptap falls back to the first
    // configured level when a node's level is not one it was configured with.
    // Building the node and asking for its DOM spec needs no document.
    const level1 = schema.nodes.heading.create({ level: 1 });
    const [tag] = schema.nodes.heading.spec.toDOM?.(level1) as [string];

    expect(tag).toBe("h2");
  });

  it("turns off every StarterKit extension with no button", () => {
    // Named individually rather than looped, so the failure message says which
    // one came back on.
    expect(STARTER_KIT_OPTIONS.blockquote).toBe(false);
    expect(STARTER_KIT_OPTIONS.code).toBe(false);
    expect(STARTER_KIT_OPTIONS.codeBlock).toBe(false);
    expect(STARTER_KIT_OPTIONS.horizontalRule).toBe(false);
    expect(STARTER_KIT_OPTIONS.orderedList).toBe(false);
    expect(STARTER_KIT_OPTIONS.strike).toBe(false);
    expect(STARTER_KIT_OPTIONS.underline).toBe(false);
  });
});

describe("no Markdown", () => {
  /**
   * The No-Markdown principle in docs/product.md, as a setting. Tiptap's input
   * rules are what turn `**x**` into bold and `# ` into a heading as you type;
   * the paste rules are the same transformation on pasted text.
   *
   * Both off means an asterisk is an asterisk — which is what someone writing
   * "Rose was born *around* 1904" meant.
   */
  it("disables input and paste rules", () => {
    expect(EDITOR_INPUT_OPTIONS.enableInputRules).toBe(false);
    expect(EDITOR_INPUT_OPTIONS.enablePasteRules).toBe(false);
  });

  it("does not accept Markdown link syntax either", () => {
    expect(STARTER_KIT_OPTIONS.link.markdownLinks).toBe(false);
  });
});

describe("links", () => {
  it("emits only the one attribute the sanitiser keeps on an anchor", () => {
    // Tiptap's default adds `target="_blank"` and a `rel`. Both are stripped
    // on save, so the editor would show behaviour the saved article lacks.
    //
    // This resolves the option through `configure()` rather than reading the
    // literal above, because the literal cannot answer the question. Tiptap
    // merges with `mergeDeep`, so an `HTMLAttributes` that simply omits
    // `target` leaves the default in place — an assertion that the literal
    // equals `{}` passes while the editor emits both attributes. Ask the
    // extension what it resolved to instead. No DOM is needed for this, which
    // is the same reason the rest of this file can exist (docs/testing.md).
    const linkOptions = resolvedLinkOptions();

    for (const attribute of ["target", "rel"]) {
      expect(linkOptions.HTMLAttributes[attribute] ?? null).toBeNull();
    }

    // Nothing else may render either: ProseMirror writes every non-null
    // attribute, so a future default gaining a value would reach the DOM.
    const rendered = Object.entries(linkOptions.HTMLAttributes)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([name]) => name);
    expect(rendered).toEqual([]);
  });

  it("does not navigate away from a half-written entry", () => {
    expect(STARTER_KIT_OPTIONS.link.openOnClick).toBe(false);
  });

  it("holds the autolinker to the schemes the sanitiser keeps", () => {
    // Typing an address and pressing space, or pasting one over a selection,
    // both create links without going near the toolbar. `isAllowedUri` is the
    // one gate they share, so it has to enforce the same list.
    const { isAllowedUri } = STARTER_KIT_OPTIONS.link;

    for (const scheme of ALLOWED_URL_SCHEMES) {
      expect(isAllowedUri(`${scheme}:example.com`)).toBe(true);
    }
    expect(isAllowedUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedUri("ftp://example.com")).toBe(false);
  });

  describe("normaliseLinkHref", () => {
    it.each([
      // A bare host is what someone pasting an address actually types.
      ["example.com", "https://example.com"],
      ["my-site.co.uk/rose", "https://my-site.co.uk/rose"],
      ["  example.com  ", "https://example.com"],
      // Already addressed, and left alone.
      ["https://example.com/a?b=c#d", "https://example.com/a?b=c#d"],
      ["http://example.com", "http://example.com"],
      ["mailto:rose@example.com", "mailto:rose@example.com"],
      // A bare email, which `https://` in front of would turn into a link to
      // example.com with `rose` as the username — somewhere real, and not
      // where the author meant.
      ["rose@example.com", "mailto:rose@example.com"],
      // Still a web address, despite the `@`.
      ["example.com/photos?by=a@b.co", "https://example.com/photos?by=a@b.co"],
      ["HTTPS://Example.com", "HTTPS://Example.com"],
      // How one entry links to another, and to a section of itself.
      ["/wiki/rose", "/wiki/rose"],
      ["#early-life", "#early-life"],
    ])("accepts %s as %s", (input, expected) => {
      expect(normaliseLinkHref(input)).toBe(expected);
    });

    it.each([
      ["nothing at all", ""],
      ["only whitespace", "   "],
      // Reads as relative, is not: it inherits the page's scheme.
      ["a protocol-relative host", "//evil.example/x"],
      ["a script URL", "javascript:alert(1)"],
      ["a script URL in disguise", "JaVaScRiPt:alert(1)"],
      // A browser ignores the newline; a check that only reads the start does
      // not. Refusing anything with whitespace inside is what closes that gap.
      ["a script URL split by a newline", "java\nscript:alert(1)"],
      ["an inline document", "data:text/html,<script>alert(1)</script>"],
      // Not dangerous, but the sanitiser drops it, so accepting it here would
      // mean a link that vanishes on save.
      ["a scheme the sanitiser strips", "ftp://example.com"],
    ])("refuses %s", (_label, input) => {
      expect(normaliseLinkHref(input)).toBeNull();
    });

    it("never accepts an href the sanitiser would then strip", () => {
      // The property that makes this function worth having: the editor must
      // not accept a link that disappears when the entry is saved. This is the
      // one assertion that checks the two modules against each other rather
      // than against a hardcoded list.
      const candidates = [
        "example.com",
        "https://example.com/a",
        "http://example.com",
        "mailto:rose@example.com",
        "rose@example.com",
        "/wiki/rose",
        "#early-life",
        "javascript:alert(1)",
        "//evil.example",
        "data:text/html,x",
        "ftp://example.com",
      ];

      for (const candidate of candidates) {
        const href = normaliseLinkHref(candidate);
        if (href === null) continue;

        expect(sanitizeHtml(`<p><a href="${href}">source</a></p>`)).toBe(
          `<p><a href="${href}">source</a></p>`,
        );
      }
    });
  });
});

/**
 * The hatnote field (E11-T9, `YEO-79`), whose whole specification is a
 * subtraction: "plain text plus links; not a full editor surface".
 *
 * Checked the same DOM-free way the body is, and for the same reason —
 * `getSchema()` builds the real ProseMirror schema from the real extension
 * list, which is the authoritative answer to what markup this editor can
 * produce. An extension left on by accident is a keyboard shortcut that emits
 * something `normaliseHatnote` then flattens away on save, which the author
 * experiences as the field eating their formatting.
 */
describe("the hatnote editor", () => {
  it("offers exactly one control, and it is Link", () => {
    expect(HATNOTE_TOOLBAR_ITEMS.map((item) => item.id)).toEqual(["link"]);
  });

  it("offers the *same* Link control the body does", () => {
    // Derived rather than restated, so the two fields cannot end up with
    // different labels or different tooltips for one action.
    expect(HATNOTE_TOOLBAR_ITEMS[0]).toBe(
      TOOLBAR_ITEMS.find((item) => item.id === "link"),
    );
  });

  it("produces one paragraph, text, and links — and nothing else", () => {
    const schema = getSchema(createHatnoteExtensions());
    const names = [
      ...Object.keys(schema.nodes),
      ...Object.keys(schema.marks),
    ].sort();

    // `doc`, `paragraph` and `text` are structural. `link` is the feature.
    // Everything that would put a tag in the stored line is absent, which is
    // what makes "plain text plus links" a property of the editor rather than
    // a rule the save path has to clean up after.
    expect(names).toEqual(["doc", "link", "paragraph", "text"]);
  });

  it("keeps the body's link configuration rather than a copy of it", () => {
    expect(HATNOTE_STARTER_KIT_OPTIONS.link).toBe(STARTER_KIT_OPTIONS.link);
  });

  it("switches off every control the field has no button for", () => {
    expect(HATNOTE_STARTER_KIT_OPTIONS.bold).toBe(false);
    expect(HATNOTE_STARTER_KIT_OPTIONS.italic).toBe(false);
    expect(HATNOTE_STARTER_KIT_OPTIONS.bulletList).toBe(false);
    expect(HATNOTE_STARTER_KIT_OPTIONS.heading).toBe(false);
    // One line: with `hardBreak` on, shift+Enter would put a `<br>` in a field
    // whose stored form has no room for one.
    expect(HATNOTE_STARTER_KIT_OPTIONS.hardBreak).toBe(false);
  });

  it("hands out a fresh extension array per editor", () => {
    // There are genuinely two editors on the edit page now, and a Tiptap
    // extension instance carries per-editor storage.
    expect(createHatnoteExtensions()).not.toBe(createHatnoteExtensions());
  });
});
