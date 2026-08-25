// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { StarterKit } from "@tiptap/starter-kit";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntryEditor } from "@/components/EntryEditor";
import {
  EDITOR_INPUT_OPTIONS,
  createEntryExtensions,
} from "@/lib/editor-extensions";
import { IMAGE_ACCEPT } from "@/lib/image-insert";
import { headingNodePosition } from "@/lib/section-edit";
import { render, unmount } from "@/test/render";

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

  it("renders the six toolbar controls, all of them live", () => {
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

    // Image was the one disabled control, until E5-T3 (`YEO-43`) gave it
    // something to do.
    expect(buttons.filter((button) => button.disabled)).toEqual([]);
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

/**
 * Photographs (E5-T3, `YEO-43`).
 *
 * Four of the ticket's five acceptance criteria are properties of a *flow*
 * rather than of a value, and none of them can be asserted anywhere but here:
 * that the button opens a file picker and never a URL field, that a drop and a
 * paste both reach the same upload, that progress is shown while it runs, and
 * that the picture lands in the document at the end of it.
 *
 * The fifth — `img` and its `src` on the sanitiser's allowlist, restricted to
 * the storage host — is a value, and lives in `lib/sanitize-html.test.ts`.
 *
 * ## What is stubbed, and what is not
 *
 * `XMLHttpRequest`, and nothing else. docs/testing.md settles that this is
 * allowed and why: "the network is not a module boundary — it is the boundary
 * itself", the rule `components/SearchBox.test.tsx` established for `fetch`.
 * The upload path uses XHR rather than `fetch` because `fetch` cannot report
 * how far a request body has got, which is the whole of the progress
 * criterion.
 *
 * Everything on this side of that seam is real: the real editor, the real
 * queue, the real `lib/image-insert.ts` decisions, the real image node. The
 * canvas is never reached, because the files below are small and
 * `needsDownscale` says no — which is also true of most real uploads.
 */
describe("photographs", () => {
  /** A stand-in for `XMLHttpRequest`, driven by the test rather than by a server. */
  class FakeXhr extends EventTarget {
    static instances: FakeXhr[] = [];

    readonly upload = new EventTarget();
    status = 0;
    responseText = "";
    responseType = "";
    url = "";
    method = "";
    sent: FormData | null = null;
    aborted = false;

    constructor() {
      super();
      FakeXhr.instances.push(this);
    }

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }

    send(body: FormData): void {
      this.sent = body;
    }

    abort(): void {
      this.aborted = true;
      this.dispatchEvent(new Event("abort"));
    }

    /** Report progress on the request body, the way a real upload does. */
    progress(loaded: number, total: number): void {
      this.upload.dispatchEvent(
        new ProgressEvent("progress", {
          lengthComputable: total > 0,
          loaded,
          total,
        }),
      );
    }

    /** Answer it. `body` is stringified unless it already is a string. */
    respond(status: number, body: unknown): void {
      this.status = status;
      this.responseText =
        typeof body === "string" ? body : JSON.stringify(body);
      this.dispatchEvent(new Event("load"));
    }
  }

  const KEY = "images/ab/8f14e45f-ea0f-4b76-9d7c-1a2b3c4d5e6f.jpg";
  const PATH = `/api/images/ab/8f14e45f-ea0f-4b76-9d7c-1a2b3c4d5e6f.jpg`;
  const ACCEPTED = { key: KEY, path: PATH, contentType: "image/jpeg" };

  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);

    /**
     * A third jsdom gap, in the genre docs/testing.md already names: jsdom
     * implements no `document.elementFromPoint`, and ProseMirror's
     * `posAtCoords` — which is how a drop finds the place it was aimed at —
     * calls it unguarded and throws without it.
     *
     * `null` is a truthful stub rather than a convenient one. There is no
     * layout in jsdom, so there is genuinely no element under a coordinate,
     * and `posAtCoords` answering `null` is exactly what a real browser does
     * for a drop outside the text — which the component already handles by
     * inserting at the cursor.
     */
    document.elementFromPoint = () => null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  /** Let React and the upload promise settle. */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function picture(name: string, type = "image/jpeg"): File {
    // Small on purpose: `needsDownscale` says no, so no canvas is reached.
    return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type });
  }

  function imageButton(host: HTMLElement): HTMLButtonElement {
    const button = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
    ].find((candidate) => candidate.textContent === "Image");
    if (!button) throw new Error("no Image button in the toolbar");
    return button;
  }

  /**
   * Drop files on the writing surface.
   *
   * Through `someProp`, the same way `type()` at the top of this file drives
   * input rules: it is the path ProseMirror itself takes to reach the handler,
   * and it avoids jsdom's `DataTransfer`, which cannot be given files.
   */
  function drop(
    editor: Editor,
    files: readonly File[],
  ): boolean | void | undefined {
    const event = {
      dataTransfer: { files },
      clientX: 0,
      clientY: 0,
      preventDefault: () => {},
    } as unknown as DragEvent;

    return editor.view.someProp("handleDrop", (handler) =>
      handler(editor.view, event, Slice.empty, false),
    );
  }

  /** Paste them. */
  function paste(
    editor: Editor,
    files: readonly File[],
  ): boolean | void | undefined {
    const event = {
      clipboardData: { files },
      preventDefault: () => {},
    } as unknown as ClipboardEvent;

    return editor.view.someProp("handlePaste", (handler) =>
      handler(editor.view, event, Slice.empty),
    );
  }

  function strip(host: HTMLElement): HTMLElement | null {
    return host.querySelector('[role="status"], [role="alert"]');
  }

  it("opens a file picker, and offers no URL field anywhere", () => {
    // The ticket's second criterion is an absence: "**No URL field** — the
    // author picks a file, the same way they would in any other program".
    const host = render(<EntryEditor />);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    expect(input?.accept).toBe(IMAGE_ACCEPT);
    expect(input?.multiple).toBe(true);

    const opened = vi.fn();
    input!.click = opened;
    act(() => imageButton(host).click());

    expect(opened).toHaveBeenCalledTimes(1);
    // Nothing to type an address into appeared.
    expect(host.querySelectorAll('input[type="url"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(0);
  });

  it("posts a dropped picture to the upload endpoint and inserts what comes back", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    let handled: boolean | void | undefined;
    act(() => {
      handled = drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    // Returning true is what stops ProseMirror pasting the filename in as
    // text, which is its own answer to a file drop.
    expect(handled).toBe(true);

    const request = FakeXhr.instances[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/images");
    expect(request.sent?.get("file")).toBeInstanceOf(Blob);

    await act(async () => {
      request.respond(201, ACCEPTED);
      await Promise.resolve();
    });
    await settle();

    // The site-relative path, never the storage URL: what goes in a body has
    // to outlive a signature that expires in fifteen minutes.
    expect(editor.getHTML()).toContain(`<img src="${PATH}"`);
    // And the alt text the filename was worth.
    expect(editor.getHTML()).toContain('alt="Rose at Southwold"');
  });

  it("takes one from the clipboard too", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      expect(paste(editor, [picture("Walter 1918.png", "image/png")])).toBe(
        true,
      );
    });

    await act(async () => {
      FakeXhr.instances[0].respond(201, ACCEPTED);
      await Promise.resolve();
    });
    await settle();

    expect(editor.getHTML()).toContain(`<img src="${PATH}"`);
  });

  it("leaves an ordinary paste alone", () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    // No picture in the payload, so the handler declines — `someProp` answers
    // `undefined` for a handler that returned false — and the Link
    // extension's paste handler and ProseMirror's own HTML parsing run
    // exactly as they did before.
    act(() => {
      expect(paste(editor, [])).toBeUndefined();
      expect(drop(editor, [])).toBeUndefined();
    });

    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("ignores a drop that is not a picture", () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      expect(
        drop(editor, [
          new File(["0 HEAD"], "family.ged", { type: "text/plain" }),
        ]),
      ).toBeUndefined();
    });

    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("shows progress while a large file is going up", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    const bar = host.querySelector("progress");
    expect(bar).not.toBeNull();
    expect(strip(host)?.textContent).toBe("Adding picture…");

    await act(async () => {
      FakeXhr.instances[0].progress(512_000, 1_024_000);
      await Promise.resolve();
    });

    expect(host.querySelector("progress")?.value).toBe(50);

    await act(async () => {
      FakeXhr.instances[0].respond(201, ACCEPTED);
      await Promise.resolve();
    });
    await settle();

    // Gone once there is nothing to report.
    expect(host.querySelector("progress")).toBeNull();
    expect(editor.getHTML()).toContain("<img");
  });

  it("says something is happening even when the browser cannot measure it", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    await act(async () => {
      // `lengthComputable: false`, which arrives as a total of zero.
      FakeXhr.instances[0].progress(0, 0);
      await Promise.resolve();
    });

    // An indeterminate bar — no `value` — rather than a confident 0%.
    expect(host.querySelector("progress")?.hasAttribute("value")).toBe(false);
    expect(strip(host)?.textContent).toBe("Adding picture…");
  });

  it("counts a batch, and uploads it one at a time", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [
        picture("Rose at Southwold.jpg"),
        picture("Walter at Southwold.jpg"),
      ]);
    });

    // Serial, not parallel: two 4 MB posts at once on a domestic uplink
    // finish no sooner and make the bar meaningless.
    expect(FakeXhr.instances).toHaveLength(1);
    expect(strip(host)?.textContent).toBe("Adding picture 1 of 2…");

    await act(async () => {
      FakeXhr.instances[0].respond(201, ACCEPTED);
      await Promise.resolve();
    });
    await settle();

    expect(FakeXhr.instances).toHaveLength(2);
    expect(strip(host)?.textContent).toBe("Adding picture 2 of 2…");

    await act(async () => {
      FakeXhr.instances[1].respond(201, ACCEPTED);
      await Promise.resolve();
    });
    await settle();

    expect(strip(host)).toBeNull();
    expect(editor.getHTML().match(/<img/g)).toHaveLength(2);
  });

  it("keeps the bar up when a second picture arrives mid-upload", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("one.jpg")]);
    });
    await act(async () => {
      FakeXhr.instances[0].progress(250, 1000);
      await Promise.resolve();
    });

    act(() => {
      drop(editor, [picture("two.jpg")]);
    });

    // The bar does not blink out: a second drop clears a *failure*, not an
    // upload in progress, which would otherwise leave the strip blank for the
    // rest of the file already going up.
    expect(host.querySelector("progress")?.value).toBe(25);

    await act(async () => {
      FakeXhr.instances[0].progress(500, 1000);
      await Promise.resolve();
    });

    // And the count catches up with the queue rather than waiting for the
    // batch to restart.
    expect(strip(host)?.textContent).toBe("Adding picture 1 of 2…");
    expect(host.querySelector("progress")?.value).toBe(50);
  });

  it("shows the endpoint's own refusal, and inserts nothing", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);
    const before = editor.getHTML();

    act(() => {
      drop(editor, [picture("IMG_4021.JPG")]);
    });

    await act(async () => {
      FakeXhr.instances[0].respond(413, {
        error: "Images must be 4 MB or smaller.",
      });
      await Promise.resolve();
    });
    await settle();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Images must be 4 MB or smaller.");
    expect(editor.getHTML()).toBe(before);
  });

  it("says something useful when the answer carries no message at all", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    await act(async () => {
      // What an expired session actually looks like: the bare string
      // `Unauthorized` from `requireSessionOr401`.
      FakeXhr.instances[0].respond(401, "Unauthorized");
      await Promise.resolve();
    });
    await settle();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Sign in again",
    );
  });

  it("abandons the rest of the batch after a refusal", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("one.jpg"), picture("two.jpg")]);
    });

    await act(async () => {
      FakeXhr.instances[0].respond(415, { error: "Images must be one of: …" });
      await Promise.resolve();
    });
    await settle();

    // Every reason an upload is refused applies to the next one too, so
    // carrying on would show the same sentence twice.
    expect(FakeXhr.instances).toHaveLength(1);
    expect(editor.getHTML()).not.toContain("<img");
  });

  it("clears a refusal when the author tries again", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("one.jpg")]);
    });
    await act(async () => {
      FakeXhr.instances[0].respond(413, { error: "Images must be smaller." });
      await Promise.resolve();
    });
    await settle();

    expect(host.querySelector('[role="alert"]')).not.toBeNull();

    act(() => {
      drop(editor, [picture("two.jpg")]);
    });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(strip(host)?.textContent).toBe("Adding picture…");
  });

  it("refuses to insert a 201 whose body is not the shape it should be", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    await act(async () => {
      // `<img src="undefined">` in a revision that is append-only and can
      // never be edited back is the failure being prevented.
      FakeXhr.instances[0].respond(201, { key: KEY });
      await Promise.resolve();
    });
    await settle();

    expect(editor.getHTML()).not.toContain("<img");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("disables the button while one is going up, and nothing else", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    const buttons = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
    ];
    expect(
      buttons.filter((button) => button.disabled).map((b) => b.textContent),
    ).toEqual(["Image"]);

    await act(async () => {
      FakeXhr.instances[0].respond(201, ACCEPTED);
      await Promise.resolve();
    });
    await settle();

    expect(buttons.filter((button) => button.disabled)).toEqual([]);
  });

  it("abandons an upload when the editor goes away", async () => {
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });
    const request = FakeXhr.instances[0];
    expect(request.aborted).toBe(false);

    // `unmount()` rather than leaving it to the teardown, because this
    // assertion is *about* unmounting — docs/testing.md names that as what the
    // helper is for.
    await act(async () => {
      unmount(host);
      await Promise.resolve();
    });
    await settle();

    // An author who navigates away mid-upload leaves nothing running behind
    // them.
    expect(request.aborted).toBe(true);
  });

  it("renders no failure for an abandoned upload", async () => {
    // An abort is not a refusal. The catch branch returns before any state is
    // written, which is also what keeps React from warning about a set on an
    // unmounted component.
    const host = render(<EntryEditor />);
    const editor = editorOf(host);

    act(() => {
      drop(editor, [picture("Rose at Southwold.jpg")]);
    });

    await act(async () => {
      FakeXhr.instances[0].abort();
      await Promise.resolve();
    });
    await settle();

    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("takes no pictures in the hatnote, which has nowhere to put one", () => {
    // The hatnote is one line of text and links: no image button, no image
    // node, and therefore no drop target either. A handler here would upload
    // a photograph and then fail to insert it.
    const host = render(<EntryEditor variant="hatnote" />);
    const editor = editorOf(host);

    expect(host.querySelector('input[type="file"]')).toBeNull();
    // Nothing in the schema to hold one, which is the fact the handlers are
    // keyed off: an upload here would succeed and then have nowhere to go.
    expect(editor.schema.nodes.image).toBeUndefined();

    act(() => {
      drop(editor, [picture("Rose.jpg")]);
      paste(editor, [picture("Rose.jpg")]);
    });

    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("will not take an image from somebody else's server, however it arrives", () => {
    // The editor's parse rule is the same predicate the sanitiser uses, so a
    // pasted page full of tracking pixels does not arrive at all — rather
    // than arriving, being shown to the author, and being deleted on save.
    const editor = entryEditor("<p></p>");

    editor.commands.setContent(
      `<p>before</p><img src="https://evil.example/track.png"><img src="${PATH}"><p>after</p>`,
    );

    const html = editor.getHTML();
    expect(html).not.toContain("evil.example");
    expect(html).toContain(`<img src="${PATH}"`);
    editor.destroy();
  });
});
