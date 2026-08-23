import type { Extensions } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import type { StarterKitOptions } from "@tiptap/starter-kit";

import { ALLOWED_URL_SCHEMES } from "@/lib/sanitize-html";

/**
 * Everything about the editor that is a *decision* rather than a *rendering*.
 *
 * It lives in `lib/` and imports no React and no DOM, which is what lets
 * `npm test` assert the decisions directly — the toolbar's shape, the tag set
 * the editor can emit, the fact that `*` is not a formatting character. See
 * docs/testing.md: there is no jsdom in this project, and the point of putting
 * the rules here is that none is needed to check them.
 *
 * `components/EntryEditor.tsx` is the other half — it renders what this file
 * decides, and decides nothing itself.
 */

/**
 * The toolbar, in order, and the whole of it.
 *
 * This list is a product decision, not a scoping compromise. From
 * docs/product.md: the primary author is not a developer, and every extra
 * button is a thing that can be pressed by accident and not understood. The
 * bar is heading, bold, italic, bullet list, link, image — resist adding to
 * it, and note that `lib/editor-extensions.test.ts` fails if anything does.
 *
 * The list is what `components/EntryEditor.tsx` renders from, rather than a
 * description of what it renders. A seventh control cannot be added to the
 * bar without being added here first, which is where the test is looking.
 *
 * `image` is here and disabled. A button that appeared only once image upload
 * landed (E5-T3, `YEO-43`) would shift every other button sideways on the day
 * it shipped; a button that is visibly not ready yet does not. It is also why
 * `img` is absent from the sanitiser's allowlist — the button and the tag are
 * enabled in one change or not at all.
 */
export const TOOLBAR_ITEMS = [
  { id: "heading", label: "Paragraph style", hint: "Paragraph style" },
  { id: "bold", label: "Bold", hint: "Bold (⌘B / Ctrl+B)" },
  { id: "italic", label: "Italic", hint: "Italic (⌘I / Ctrl+I)" },
  { id: "bulletList", label: "Bullet list", hint: "Bullet list" },
  { id: "link", label: "Link", hint: "Link (⌘K / Ctrl+K)" },
  {
    id: "image",
    label: "Image",
    hint: "Image — available once uploads land",
    disabled: true,
  },
] as const;

export type ToolbarItem = (typeof TOOLBAR_ITEMS)[number];

export type ToolbarItemId = ToolbarItem["id"];

/**
 * The heading control is a `<select>` rather than a button, because one
 * control has to reach three levels.
 *
 * That is Wikipedia's own idiom — VisualEditor opens with a `Paragraph ▾`
 * dropdown — and it is the shape a non-developer has already met in every word
 * processor they have used. A button would only reach one level, and the
 * remaining two would then be tags the sanitiser allows but nothing can
 * produce.
 *
 * h1 is deliberately absent: the article title is h1 and the page chrome owns
 * it (E11-T2), so body headings start at h2, exactly as they do in a Wikipedia
 * article. The levels here are the `h2`/`h3`/`h4` of `ALLOWED_TAGS`.
 */
export const HEADING_LEVELS = [2, 3, 4] as const;

export type HeadingLevel = (typeof HEADING_LEVELS)[number];

/**
 * What the heading control offers, top to bottom. The labels avoid the word
 * "h2" on purpose — the author is writing an entry, not markup.
 */
export const BLOCK_STYLES = [
  { value: "paragraph", label: "Normal text" },
  { value: "2", label: "Heading" },
  { value: "3", label: "Subheading" },
  { value: "4", label: "Minor heading" },
] as const;

/**
 * Turn what someone typed into a link box into an `href` the sanitiser will
 * keep — or `null`, meaning "refuse this rather than store something that
 * silently disappears on save".
 *
 * The rules mirror `lib/sanitize-html.ts` deliberately, because the failure
 * they prevent is content loss: a link the editor accepts but the allowlist
 * strips looks to the author like the save button ate their work.
 *
 * - A bare host (`example.com`) gets `https://`, because that is what someone
 *   pasting an address means and demanding a scheme is developer's pedantry.
 * - Site-relative (`/wiki/rose`) and in-page (`#early-life`) hrefs pass
 *   through untouched. They carry no scheme, and they are how one entry links
 *   to another.
 * - `//evil.example` is refused. It reads as relative but is not — it inherits
 *   the page's scheme — and `allowProtocolRelative: false` in the sanitiser
 *   exists to stop exactly this.
 * - Anything with a scheme is kept only if the scheme is one of
 *   `ALLOWED_URL_SCHEMES`, which is what disposes of `javascript:` and
 *   `data:`.
 */
export function normaliseLinkHref(input: string): string | null {
  const href = input.trim();

  if (href === "") return null;
  // Whitespace and control characters *inside* an href are how a blocked
  // scheme gets past a check that only reads the start: a browser ignores a
  // newline sitting in the middle of `javascript:`, so the scheme it acts on
  // is not the scheme this function saw. Nothing legitimate needs these
  // characters — a real space in a URL is `%20` — so refuse rather than strip.
  if ([...href].some((char) => char.charCodeAt(0) <= 0x20)) return null;

  // Protocol-relative, before the relative check below would wave it through.
  if (href.startsWith("//")) return null;
  if (href.startsWith("/") || href.startsWith("#")) return href;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1];
  if (scheme === undefined) return `https://${href}`;

  return ALLOWED_URL_SCHEMES.includes(
    scheme.toLowerCase() as (typeof ALLOWED_URL_SCHEMES)[number],
  )
    ? href
    : null;
}

/**
 * How StarterKit is cut down to the toolbar.
 *
 * Exported as a plain object rather than written inline in the `configure`
 * call below, so that `lib/editor-extensions.test.ts` can assert on it
 * directly. That matters because the obvious alternative is not available:
 * constructing a real `Editor` throws without a DOM, and this project has no
 * jsdom (docs/testing.md). A plain-object assertion is the only DOM-free way
 * to hold these decisions in place.
 *
 * Every `false` below is load-bearing. `lib/sanitize-html.ts` is an allowlist
 * of nine tags, and its doc comment names this file's job: the editor must not
 * be able to emit anything absent from it. A button-less extension that stays
 * on is not a harmless extra — it is a keyboard shortcut or a paste handler
 * that produces markup the sanitiser silently discards, which the author
 * experiences as losing a paragraph.
 */
export const STARTER_KIT_OPTIONS = {
  // ---- Off, because the toolbar has no button for them ---------------
  // Each of these is a tag missing from ALLOWED_TAGS. Keeping them on
  // would mean ⌘⇧X still strikes text through and the strike survives
  // until save, then does not.
  blockquote: false,
  code: false,
  codeBlock: false,
  horizontalRule: false,
  // Not `ol`: the toolbar offers one kind of list. Wikipedia articles are
  // overwhelmingly bulleted, and a second list button is a second thing to
  // understand.
  orderedList: false,
  strike: false,
  underline: false,

  // ---- On, and constrained -------------------------------------------
  heading: { levels: [...HEADING_LEVELS] },

  link: {
    // The sanitiser allows exactly one attribute on `a`, and it is `href`.
    // Tiptap's default adds `target="_blank"` and a `rel`, both of which
    // would be stripped on save — so the editor would show a link that
    // opens in a new tab and the saved article would not. Emit what
    // survives.
    HTMLAttributes: {},
    // Clicking a link while writing should put the cursor in it, not
    // navigate away from a half-written entry.
    openOnClick: false,
    // Off for the same reason input rules are: `[text](url)` is Markdown,
    // and Markdown is the thing this editor exists not to have.
    markdownLinks: false,
    // A pasted or typed address becoming a link is not a Markdown
    // surprise — it is the behaviour of every mail client and chat window
    // the author has used, and it produces a plain `<a href>`.
    autolink: true,
    linkOnPaste: true,
    // Typing `example.com` means the public web, not `http://`.
    defaultProtocol: "https",
    // `protocols` is deliberately left alone. It registers *additional*
    // schemes with linkify, and http, https and mailto — the whole of
    // ALLOWED_URL_SCHEMES — are already built in; passing them again makes
    // linkify warn on every editor it builds. The gate that actually holds is
    // `isAllowedUri` below.
    //
    // This is the last word on what the autolinker and the paste handler may
    // create, so neither can route around the toolbar's own validation, and
    // both are held to the same list the sanitiser keeps.
    isAllowedUri: (url) => normaliseLinkHref(url) !== null,
  },

  // `undoRedo` stays on: ⌘Z is not a formatting decision, and its absence is
  // the single most alarming thing that can happen to someone writing.
} satisfies Partial<StarterKitOptions>;

/**
 * The extension set, as a fresh array per call.
 *
 * Fresh rather than a shared constant because a Tiptap extension instance
 * carries per-editor `storage`; handing the same instance to two editors makes
 * them share it. There is only one editor on a page today, and this keeps that
 * an implementation detail rather than a constraint.
 */
export function createEntryExtensions(): Extensions {
  return [StarterKit.configure(STARTER_KIT_OPTIONS)];
}

/**
 * Editor options that are neither extensions nor rendering.
 *
 * Input rules are Tiptap's Markdown-as-you-type: `**bold**`, `# heading`,
 * `- item`, `> quote`. Turning them off globally is the whole of the
 * No-Markdown principle in docs/product.md — typing `*` produces an asterisk,
 * which is what someone writing "Rose was born *around* 1904" meant.
 *
 * Global rather than per-extension because the property worth having is "no
 * character I type is secretly a command", and that has to hold for extensions
 * nobody has added yet. Per-extension stripping would be a list to remember to
 * update, and the first person to forget would ship the surprise.
 *
 * Paste rules are the same transformation applied to pasted text, and go for
 * the same reason: pasting a paragraph from an email that happens to contain
 * `**` should paste asterisks. This does not affect linking on paste, which is
 * a separate handler in the Link extension.
 *
 * None of this touches keyboard shortcuts. ⌘B and ⌘I are keymaps, not input
 * rules, and are unaffected.
 */
export const EDITOR_INPUT_OPTIONS = {
  enableInputRules: false,
  enablePasteRules: false,
} as const;
