// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EntryEditor } from "@/components/EntryEditor";
import {
  EDITOR_INPUT_OPTIONS,
  createEntryExtensions,
} from "@/lib/editor-extensions";
import { headingNodePosition } from "@/lib/section-edit";
import { render } from "@/test/render";

/**
 * The first test in this project that needs a DOM, which docs/testing.md
 * anticipated: "add it when the first component test needs it, as a third
 * project or an `environment` override".
 *
 * This is the `environment` override — the docblock on line 1, which Vitest
 * reads per file. No third project and no change to `vitest.config.mts`, so
 * the rest of the suite still runs in plain Node and pays nothing for a DOM it
 * does not use. `npm test` runs this file like any other.
 *
 * It is here rather than in `lib/editor-extensions.test.ts` because everything
 * below needs a live editor. The decisions those extensions encode are checked
 * without one, next to the module that makes them.
 */

/**
 * Type into an editor the way a keyboard does.
 *
 * ProseMirror runs input rules from its `handleTextInput` prop, one character
 * at a time — so inserting a whole string with `insertContent` would sail past
 * the very thing these tests are about. This is the same path a real keystroke
 * takes: offer the character to the handlers, and insert it plainly if none of
 * them claims it.
 */
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    // ProseMirror hands its handlers the transaction they would otherwise
    // have produced, so a rule can build on it. Passing the same thing keeps
    // this honest rather than approximate.
    const insert = () => editor.state.tr.insertText(char, from, to);

    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, char, insert),
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

function entryEditor(content = "<p></p>"): Editor {
  const editor = new Editor({
    ...EDITOR_INPUT_OPTIONS,
    extensions: createEntryExtensions(),
    content,
  });
  editor.commands.focus("end");
  return editor;
}

describe("no Markdown", () => {
  /**
   * The No-Markdown principle in docs/product.md, and the ticket's sharpest
   * acceptance criterion: typing `*` produces an asterisk.
   *
   * The control below is not testing Tiptap for Tiptap's sake. It is what
   * makes the assertion after it mean something: if `type()` did not actually
   * drive input rules, an editor with them switched off would look identical
   * to one with them on, and the real test would pass for the wrong reason.
   */
  it("would convert Markdown if the rules were left on", () => {
    const control = new Editor({
      extensions: [StarterKit],
      content: "<p></p>",
    });
    control.commands.focus("end");

    type(control, "*hello* and **bold**");

    expect(control.getHTML()).toBe(
      "<p><em>hello</em> and <strong>bold</strong></p>",
    );
    control.destroy();
  });

  it("leaves an asterisk as an asterisk", () => {
    const editor = entryEditor();

    // "Rose was born *around* 1904" is the sentence this protects.
    type(editor, "*hello* and **bold**");

    expect(editor.getHTML()).toBe("<p>*hello* and **bold**</p>");
    editor.destroy();
  });

  it.each([
    ["a heading", "# Early life"],
    ["a bullet", "- Alice"],
    ["a quote", "> said Rose"],
    ["a rule", "---"],
  ])("leaves %s as literal text", (_label, typed) => {
    const editor = entryEditor();

    type(editor, typed);

    // Asserted on the document rather than on `getHTML()`, so the expectation
    // stays the characters that were typed instead of their escaped form.
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.getText()).toBe(typed);
    editor.destroy();
  });
});

describe("keyboard shortcuts", () => {
  it.each([
    ["Mod-b", "<p><strong>hello</strong></p>"],
    ["Mod-i", "<p><em>hello</em></p>"],
  ])("%s formats the selection", (shortcut, expected) => {
    const editor = entryEditor("<p>hello</p>");

    editor.commands.selectAll();
    editor.commands.keyboardShortcut(shortcut);

    expect(editor.getHTML()).toBe(expected);
    editor.destroy();
  });

  it.each([
    ["strikethrough", "Mod-Shift-x"],
    ["inline code", "Mod-e"],
    ["an ordered list", "Mod-Shift-7"],
    // h1 is the article title, which the page chrome owns (E11-T2), so it is
    // not among the configured levels and its shortcut resolves to nothing.
    ["a level-1 heading", "Mod-Alt-1"],
  ])("does nothing for %s, which has no button", (_label, shortcut) => {
    // A shortcut that still worked would produce a tag the sanitiser drops,
    // which the author would experience as the save button eating their
    // formatting.
    const editor = entryEditor("<p>hello</p>");

    editor.commands.selectAll();
    editor.commands.keyboardShortcut(shortcut);

    expect(editor.getHTML()).toBe("<p>hello</p>");
    editor.destroy();
  });
});

function linkButton(host: HTMLElement): HTMLButtonElement {
  const button = [
    ...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
  ].find((candidate) => candidate.textContent === "Link");
  if (!button) throw new Error("no Link button in the toolbar");
  return button;
}

/**
 * The editor instance behind a rendered component. ProseMirror hangs it off
 * the DOM node it manages, which is the only handle a test has — the component
 * deliberately does not expose one.
 */
function editorOf(host: HTMLElement): Editor {
  const node = host.querySelector('[contenteditable="true"]');
  const editor = (node as unknown as { editor?: Editor } | null)?.editor;
  if (!editor) throw new Error("no editor mounted");
  return editor;
}

describe("the rendered component", () => {
  const CONTENT =
    "<h2>Early life</h2><p>Rose married <strong>Walter</strong>.</p><ul><li>Alice</li></ul>";

  it("renders the six toolbar controls, with image disabled", () => {
    const host = render(<EntryEditor />);

    const buttons = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
    ];
    const selects = host.querySelectorAll('[role="toolbar"] select');

    expect(buttons.map((button) => button.textContent)).toEqual([
      "Bold",
      "Italic",
      "Bullet list",
      "Link",
      "Image",
    ]);
    // The heading control is the sixth, and is a select because one control
    // has to reach three levels.
    expect(selects).toHaveLength(1);

    const disabled = buttons.filter((button) => button.disabled);
    expect(disabled.map((button) => button.textContent)).toEqual(["Image"]);
  });

  it("writes into the same stylesheet the read route uses", () => {
    const host = render(<EntryEditor />);

    const surface = host.querySelector('[contenteditable="true"]');

    // `.wiki-body` is what makes a heading typed here look like the heading it
    // will be once saved.
    expect(surface?.className).toContain("wiki-body");
    expect(surface?.getAttribute("aria-label")).toBe("Entry body");
  });

  it("opens existing body HTML without losing anything", () => {
    const host = render(<EntryEditor initialHtml={CONTENT} />);

    const surface = host.querySelector('[contenteditable="true"]');

    // The list item gains the paragraph Tiptap wraps its content in. Both tags
    // are in the sanitiser's allowlist, and `app/globals.css` keeps the
    // bullets tight in spite of it.
    expect(surface?.innerHTML).toBe(
      "<h2>Early life</h2><p>Rose married <strong>Walter</strong>.</p>" +
        "<ul><li><p>Alice</p></li></ul>",
    );
  });

  it("exposes the body through a hidden field a form action can read", () => {
    // This is the seam E1-T3 (`YEO-17`) attaches its save action to. The
    // editor itself stays ignorant of the database.
    const host = render(<EntryEditor name="body" initialHtml={CONTENT} />);

    const field = host.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="body"]',
    );

    expect(field?.value).toContain("<strong>Walter</strong>");
  });

  it("renders no hidden field when no name is given", () => {
    const host = render(<EntryEditor />);

    expect(host.querySelector('input[type="hidden"]')).toBeNull();
  });

  it("opens a link panel rather than a browser prompt", () => {
    const host = render(<EntryEditor />);

    act(() => linkButton(host).click());

    const field = host.querySelector<HTMLInputElement>('input[type="text"]');
    expect(field).not.toBeNull();
    expect(field?.placeholder).toBe("example.com or /wiki/rose");
  });

  it("closes the link panel when the selection moves out from under it", () => {
    // The panel is seeded from the selection it was opened on. If it survived
    // the cursor moving, Apply would write the draft address onto whatever the
    // author clicked next, and Remove would strip a link they never touched.
    const host = render(
      <EntryEditor initialHtml="<p>Rose married Walter.</p>" />,
    );

    act(() => linkButton(host).click());
    expect(host.querySelector('input[type="text"]')).not.toBeNull();

    act(() => {
      editorOf(host).commands.setTextSelection({ from: 1, to: 5 });
    });

    expect(host.querySelector('input[type="text"]')).toBeNull();
  });
});

/**
 * Cross-entry linking (E2-T5, `YEO-28`).
 *
 * The ranking, the address arithmetic and the fact that the markup survives
 * the sanitiser are all checked without a document in
 * `lib/entry-links.test.ts`, which is where docs/testing.md wants them. What
 * is left here is what genuinely needs a live editor: that clicking an entry
 * in the list puts the right mark on the right text, and that the panel
 * reports what an existing link already points at.
 */
const ENTRIES = [
  { title: "Ambrose Lane", slug: "ambrose-lane" },
  { title: "Rose Hall", slug: "rose-hall" },
  { title: "Walter Hale", slug: "walter-hale" },
];

/** Type into a controlled input the way React can see. */
function typeInto(input: HTMLInputElement, text: string): void {
  act(() => {
    // React tracks the last value it wrote to the node, so assigning `.value`
    // directly makes it treat an identical value as "no change". Going through
    // the prototype setter is what makes the change visible to React.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function entrySearch(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("no entry search box");
  return input;
}

function offeredTitles(host: HTMLElement): string[] {
  const list = host.querySelector('ul[aria-label="Matching entries"]');
  return [...(list?.querySelectorAll("button") ?? [])].map((button) =>
    (button.textContent ?? "").trim(),
  );
}

function offered(host: HTMLElement, title: string): HTMLButtonElement {
  const list = host.querySelector('ul[aria-label="Matching entries"]');
  const found = [...(list?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === title,
  );
  if (!found) throw new Error(`"${title}" is not offered`);
  return found;
}

function modeRadio(host: HTMLElement, label: string): HTMLInputElement {
  const found = [...host.querySelectorAll("label")].find((element) =>
    element.textContent?.includes(label),
  );
  const input = found?.querySelector<HTMLInputElement>('input[type="radio"]');
  if (!input) throw new Error(`no "${label}" choice`);
  return input;
}

/** Open the link panel with the cursor somewhere in particular. */
function openLinkPanelAt(host: HTMLElement, from: number, to = from): void {
  // Before opening, never after: the panel closes when the selection moves
  // out from under it, which is the behaviour the test above this one covers.
  act(() => {
    editorOf(host).commands.setTextSelection({ from, to });
  });
  act(() => linkButton(host).click());
}

describe("linking to another entry", () => {
  it("offers the wiki's entries by title, without adding a toolbar button", () => {
    const host = render(<EntryEditor entries={ENTRIES} />);

    act(() => linkButton(host).click());

    // Alphabetical, the way `/wiki` lists them: an empty query is a picker
    // that has just been opened, not a search that found nothing.
    expect(offeredTitles(host)).toEqual([
      "Ambrose Lane",
      "Rose Hall",
      "Walter Hale",
    ]);
    // The bar is still the six controls `lib/editor-extensions.ts` fixes it
    // at — the picker lives inside the link panel, not beside it.
    expect(host.querySelectorAll('[role="toolbar"] button')).toHaveLength(5);
    expect(host.querySelectorAll('[role="toolbar"] select')).toHaveLength(1);
  });

  it("narrows the list as the author types", () => {
    const host = render(<EntryEditor entries={ENTRIES} />);

    act(() => linkButton(host).click());
    typeInto(entrySearch(host), "hal");

    // "Walter Hale" matches on its surname; "Rose Hall" on its second word.
    expect(offeredTitles(host)).toEqual(["Rose Hall", "Walter Hale"]);
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    const host = render(<EntryEditor entries={ENTRIES} />);

    act(() => linkButton(host).click());
    typeInto(entrySearch(host), "zeppelin");

    expect(offeredTitles(host)).toEqual([]);
    expect(host.textContent).toContain("No entry matches that.");
  });

  it("inserts a site-relative link that reads as the entry's title", () => {
    // The acceptance criterion twice over: the href carries no origin, so it
    // survives a domain change; and the words in the sentence are the entry's
    // title rather than its address.
    const host = render(<EntryEditor entries={ENTRIES} />);

    act(() => linkButton(host).click());
    act(() => offered(host, "Rose Hall").click());

    expect(editorOf(host).getHTML()).toBe(
      '<p><a href="/wiki/rose-hall">Rose Hall</a></p>',
    );
  });

  it("links the author's own words when there is a selection", () => {
    const host = render(
      <EntryEditor
        entries={ENTRIES}
        initialHtml="<p>She grew up at her grandmother's house.</p>"
      />,
    );

    // "her grandmother's house" — the paragraph's text starts at 1.
    openLinkPanelAt(host, 16, 39);
    act(() => offered(host, "Rose Hall").click());

    expect(editorOf(host).getHTML()).toBe(
      "<p>She grew up at " +
        `<a href="/wiki/rose-hall">her grandmother's house</a>.</p>`,
    );
  });

  it("re-points an existing link without disturbing its text", () => {
    const host = render(
      <EntryEditor
        entries={ENTRIES}
        initialHtml='<p><a href="/wiki/ambrose-lane">the old house</a></p>'
      />,
    );

    openLinkPanelAt(host, 3);
    act(() => offered(host, "Rose Hall").click());

    expect(editorOf(host).getHTML()).toBe(
      '<p><a href="/wiki/rose-hall">the old house</a></p>',
    );
  });

  it("names the entry a link already points at", () => {
    const host = render(
      <EntryEditor
        entries={ENTRIES}
        initialHtml='<p><a href="/wiki/rose-hall">the old house</a></p>'
      />,
    );

    openLinkPanelAt(host, 3);

    expect(host.textContent).toContain("Currently links to");
    expect(host.textContent).toContain("Rose Hall");
  });

  it("degrades visibly when the entry a link points at is gone", () => {
    /**
     * The fourth acceptance criterion, in the one place this ticket owns.
     * The author is standing in front of the only screen the link can be
     * fixed on, so the panel says the target is missing instead of showing
     * an address that looks as good as any other. The reader's half of the
     * same fact — a red link on the rendered page — is E11-T6 (`YEO-76`).
     */
    const host = render(
      <EntryEditor
        entries={ENTRIES}
        initialHtml='<p><a href="/wiki/demolished">the old house</a></p>'
      />,
    );

    openLinkPanelAt(host, 3);

    expect(host.textContent).toContain("no longer exists");
    // And the fix is right there: the list is open, and Remove is offered.
    expect(offeredTitles(host)).toEqual([
      "Ambrose Lane",
      "Rose Hall",
      "Walter Hale",
    ]);
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Remove",
      ),
    ).toBe(true);
  });

  it("does not call an external link broken", () => {
    const host = render(
      <EntryEditor
        entries={ENTRIES}
        initialHtml='<p><a href="https://example.com/x">a source</a></p>'
      />,
    );

    openLinkPanelAt(host, 3);

    expect(host.textContent).not.toContain("no longer exists");
    // Opened in the mode the link is already in, showing its address.
    expect(
      host.querySelector<HTMLInputElement>('input[type="text"]')?.value,
    ).toBe("https://example.com/x");
  });

  it("still takes a raw address for an external link", () => {
    const host = render(<EntryEditor entries={ENTRIES} />);

    act(() => linkButton(host).click());
    act(() => modeRadio(host, "A web address").click());

    const field = host.querySelector<HTMLInputElement>('input[type="text"]');
    if (!field) throw new Error("no address field");
    typeInto(field, "example.com/photos");
    act(() => {
      field.form?.requestSubmit();
    });

    // `normaliseLinkHref` supplies the scheme, as it did before E2-T5.
    expect(editorOf(host).getHTML()).toBe(
      '<p><a href="https://example.com/photos">https://example.com/photos</a></p>',
    );
  });

  it("keeps the address field alone when given no entries to offer", () => {
    // Nothing about the picker is required. A caller that passes no entries
    // gets exactly the panel E1-T2 shipped.
    const host = render(<EntryEditor />);

    act(() => linkButton(host).click());

    expect(host.querySelector('input[type="search"]')).toBeNull();
    expect(host.querySelector('input[type="radio"]')).toBeNull();
    expect(
      host.querySelector<HTMLInputElement>('input[type="text"]')?.placeholder,
    ).toBe("example.com or /wiki/rose");
  });
});

/**
 * Opening the editor on one section (E11-T4, `YEO-74`).
 *
 * The `[edit]` beside a heading opens the *whole* editor and lands the author
 * in that section — see `lib/section-edit.ts` for why it is not true section
 * editing. The half that ticket can test without a document is over there;
 * this is the half that needs one: finding the nth heading in a live document
 * and putting the cursor in it.
 *
 * The index, not the heading id, is what crosses into the editor. This
 * document has no ids in it at all — the sanitiser allows none — so "the third
 * heading" is the only thing both ends can agree on. That agreement is exactly
 * what the first test below is about.
 */
describe("opening on a section", () => {
  const BODY =
    "<h2>Early life</h2><p>Born at Rose Hall.</p>" +
    "<h3>School</h3><p>Then school.</p>" +
    "<h2>Marriage</h2><p>Then Walter.</p>";

  /**
   * jsdom does no layout and so implements no `scrollIntoView`. Standing one
   * up records what the component asked to scroll, which is the assertion
   * worth making anyway — that it scrolled the heading rather than the
   * editor, so the `scroll-margin-top` under the sticky header applies.
   */
  const scrolled: Element[] = [];

  /** The block the cursor is in, by its text. */
  function openedAt(editor: Editor): string {
    return editor.state.selection.$from.parent.textContent;
  }

  beforeEach(() => {
    scrolled.length = 0;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  describe("headingNodePosition", () => {
    it("counts headings in document order, whatever their level", () => {
      const editor = entryEditor(BODY);
      const { doc } = editor.state;

      const texts = [0, 1, 2].map((index) => {
        const position = headingNodePosition(doc, index);
        if (position === null) throw new Error(`no heading ${index}`);
        return doc.nodeAt(position)?.textContent;
      });

      expect(texts).toEqual(["Early life", "School", "Marriage"]);
    });

    it("is null for an index the document has no heading for", () => {
      const editor = entryEditor(BODY);

      // The stale link, arriving as an index that used to mean something.
      expect(headingNodePosition(editor.state.doc, 3)).toBeNull();
      expect(headingNodePosition(editor.state.doc, -1)).toBeNull();
      const noHeadings = entryEditor("<p>No headings here.</p>");
      expect(headingNodePosition(noHeadings.state.doc, 0)).toBeNull();
    });
  });

  it("puts the cursor in the section that was asked for", () => {
    const host = render(
      <EntryEditor initialHtml={BODY} initialHeadingIndex={1} />,
    );
    const editor = editorOf(host);

    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe("heading");
    expect($from.parent.textContent).toBe("School");
    // At the start of it, so typing retitles the section rather than appending
    // to its name.
    expect($from.parentOffset).toBe(0);
  });

  it("scrolls the heading itself, not the editor around it", () => {
    render(<EntryEditor initialHtml={BODY} initialHeadingIndex={2} />);

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].tagName).toBe("H2");
    expect(scrolled[0].textContent).toBe("Marriage");
  });

  it("opens at the top when the section has been renamed away", () => {
    // `sectionHeadingIndex` answers `null` for an id no heading has, and this
    // is what the editor does with that answer: nothing at all. The cursor is
    // where Tiptap puts it on a fresh document — the start of the first
    // heading, which is the top of the entry.
    const host = render(
      <EntryEditor initialHtml={BODY} initialHeadingIndex={null} />,
    );

    expect(scrolled).toEqual([]);
    expect(openedAt(editorOf(host))).toBe("Early life");
  });

  it("opens at the top rather than throwing on an index it cannot reach", () => {
    const host = render(
      <EntryEditor initialHtml={BODY} initialHeadingIndex={9} />,
    );

    expect(scrolled).toEqual([]);
    expect(openedAt(editorOf(host))).toBe("Early life");
  });

  it("leaves the cursor alone when no section was asked for", () => {
    const host = render(<EntryEditor initialHtml={BODY} />);

    expect(scrolled).toEqual([]);
    expect(openedAt(editorOf(host))).toBe("Early life");
  });
});

/**
 * The hatnote variant (E11-T9, `YEO-79`) — "plain text plus links; not a full
 * editor surface", as the mounted component rather than as configuration.
 *
 * `lib/editor-extensions.test.ts` already asserts the schema this variant can
 * produce, with no DOM. What needs one is the part that is markup: which
 * controls are on the bar, and how the writing surface is described to a
 * screen reader — the latter because a `contenteditable` inside ProseMirror's
 * own DOM has no `<label for>` relationship to inherit, so a hint sitting next
 * to it in the form is announced only if it is wired up explicitly.
 */
describe("the hatnote variant", () => {
  it("offers the Link button and nothing else", () => {
    const host = render(<EntryEditor variant="hatnote" />);

    const buttons = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
    ];

    expect(buttons.map((button) => button.textContent)).toEqual(["Link"]);
    // No paragraph-style control: there are no headings to reach.
    expect(host.querySelectorAll('[role="toolbar"] select')).toHaveLength(0);
  });

  it("does not throw asking about marks it has no extension for", () => {
    // `isActive("bold")` resolves a name to a mark type and raises when there
    // is none, so an unguarded selector would take the whole page down rather
    // than render a smaller bar. Mounting at all is the assertion.
    expect(() => render(<EntryEditor variant="hatnote" />)).not.toThrow();
  });

  it("looks like the line it becomes", () => {
    const host = render(<EntryEditor variant="hatnote" />);
    const surface = host.querySelector('[contenteditable="true"]');

    // `hatnote` beside `wiki-body`, so the author sees the italic indent while
    // typing rather than after saving.
    expect(surface?.className).toContain("hatnote");
    expect(surface?.className).toContain("wiki-body");
    // One line, and said so rather than left to be discovered by pressing
    // Enter and watching nothing happen.
    expect(surface?.getAttribute("aria-multiline")).toBe("false");
  });

  it("announces the hint beside it, when given one", () => {
    const host = render(
      <EntryEditor variant="hatnote" describedBy="hatnote-hint" />,
    );
    const surface = host.querySelector('[contenteditable="true"]');

    expect(surface?.getAttribute("aria-describedby")).toBe("hatnote-hint");
  });

  it("carries no description attribute when there is nothing to describe it", () => {
    const host = render(<EntryEditor variant="hatnote" />);
    const surface = host.querySelector('[contenteditable="true"]');

    // Absent, not `"undefined"`: ProseMirror writes every key of the attribute
    // record onto the node, so a description that is not there has to be a key
    // that is not there.
    expect(surface?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("leaves the body variant undescribed and multiline", () => {
    const host = render(<EntryEditor />);
    const surface = host.querySelector('[contenteditable="true"]');

    expect(surface?.getAttribute("aria-multiline")).toBe("true");
    expect(surface?.hasAttribute("aria-describedby")).toBe(false);
    expect(surface?.className).not.toContain("hatnote");
  });
});
