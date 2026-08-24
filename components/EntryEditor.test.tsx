// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { EntryEditor } from "@/components/EntryEditor";
import {
  EDITOR_INPUT_OPTIONS,
  createEntryExtensions,
} from "@/lib/editor-extensions";
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
