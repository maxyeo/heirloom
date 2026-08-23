// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { EntryEditor } from "@/components/EntryEditor";
import {
  EDITOR_INPUT_OPTIONS,
  createEntryExtensions,
} from "@/lib/editor-extensions";

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

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.innerHTML = "";
});

function render(ui: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  roots.push(() => act(() => root.unmount()));
  return host;
}

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
    const control = new Editor({ extensions: [StarterKit], content: "<p></p>" });
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
    const link = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
    ].find((button) => button.textContent === "Link");

    act(() => link?.click());

    const field = host.querySelector<HTMLInputElement>('input[type="text"]');
    expect(field).not.toBeNull();
    expect(field?.placeholder).toBe("example.com or /wiki/rose");
  });
});
