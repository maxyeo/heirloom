"use client";

import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  BLOCK_STYLES,
  EDITOR_INPUT_OPTIONS,
  HEADING_LEVELS,
  TOOLBAR_ITEMS,
  createEntryExtensions,
  normaliseLinkHref,
  type HeadingLevel,
  type ToolbarItemId,
} from "@/lib/editor-extensions";

/**
 * The WYSIWYG editor for an entry body (E1-T2, `YEO-16`).
 *
 * ## What it does not do
 *
 * It does not save. It has no server action, no `@/db` import and no idea what
 * a page or a revision is — the save action and the revision write are E1-T3
 * (`YEO-17`), and keeping them out of here is what stops the editor from
 * becoming the place every future feature is bolted onto.
 *
 * The edited HTML leaves through two doors, and a caller may use either:
 *
 * - **`onChange`** hands over the HTML after every change. This is the door
 *   E1-T3's `savePageAction` fits: it takes a typed `{ slug, title, bodyHtml }`
 *   rather than `FormData`, so its caller holds the body and passes it in.
 * - **`name`** renders a hidden input instead, for a caller that submits a
 *   plain `<form>` and reads the body out of `FormData`. Nothing does today —
 *   it is here because it costs one element and it is the only shape that
 *   keeps the parent a Server Component with no client state of its own.
 *
 * A caller uses one or the other; both work at once and neither is required.
 *
 * The HTML is *not* sanitised here, deliberately. `lib/sanitize-html.ts` runs
 * on the server on write and again on read; a client-side pass would be
 * security theatre, because anything that can post to the action can skip this
 * component entirely.
 *
 * ## Styling
 *
 * Every colour, size and rule comes from the theme tokens in
 * `app/globals.css`, and the writing surface carries `.wiki-body` — the same
 * class the read route renders into. That is the point of the class existing:
 * what you type is what the article looks like. Nothing here declares a hex,
 * which `app/globals.test.ts` enforces.
 *
 * Width is the caller's business, not this component's. Put it inside the
 * `max-w-content` column the way `app/page.tsx` does; the article shell that
 * owns that column is E11-T2.
 */
export interface EntryEditorProps {
  /** Existing body HTML to open with. Sanitised server-side before it gets here. */
  initialHtml?: string;
  /** Name for a hidden input, so the editor can be submitted by a plain form. */
  name?: string;
  /** Called with the full body HTML after every change. */
  onChange?: (html: string) => void;
  /** Accessible name for the writing surface. */
  label?: string;
}

export function EntryEditor({
  initialHtml = "",
  name,
  onChange,
  label = "Entry body",
}: EntryEditorProps) {
  const bodyFieldRef = useRef<HTMLInputElement>(null);

  // `useEditor` builds the editor once and does not rebuild it when props
  // change, so reading `onChange` directly inside `onUpdate` would pin the
  // first render's copy forever. The ref is the standard way round that.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Built once and kept. Tiptap compares extension arrays by reference, so a
  // fresh array on every render makes it re-apply options it already has.
  const [extensions] = useState(createEntryExtensions);

  const editor = useEditor({
    ...EDITOR_INPUT_OPTIONS,
    extensions,
    content: initialHtml,
    // Required under the App Router: rendering the editor during the server
    // pass would produce markup the client immediately disagrees with.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // `wiki-body` is the article's own stylesheet, so a heading typed here
        // gets the same serif and the same bottom rule it will have once
        // saved. The focus ring is the global `:focus-visible` rule.
        class: "wiki-body min-h-80 px-4 py-3",
        "aria-label": label,
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: updated }) => {
      const html = updated.getHTML();
      // Written straight to the DOM node rather than held in React state:
      // re-rendering this component on every keystroke would re-render the
      // editor's own container, which is the classic way to make a Tiptap
      // editor feel slow.
      if (bodyFieldRef.current) bodyFieldRef.current.value = html;
      onChangeRef.current?.(html);
    },
  });

  // Tiptap normalises what it is given — an empty body becomes `<p></p>` — so
  // the hidden field is seeded from the editor rather than from `initialHtml`.
  // Otherwise submitting without typing posts something the editor never
  // actually held.
  useEffect(() => {
    if (editor && bodyFieldRef.current) {
      bodyFieldRef.current.value = editor.getHTML();
    }
  }, [editor]);

  return (
    <div className="rounded-panel border border-rule bg-paper">
      {editor ? (
        <EntryEditorToolbar editor={editor} />
      ) : (
        // Same height as the real bar, so nothing jumps when the editor
        // finishes mounting.
        <div
          className="h-9 rounded-t-panel border-b border-rule bg-panel"
          aria-hidden="true"
        />
      )}

      <EditorContent editor={editor} />

      {name === undefined ? null : (
        <input
          ref={bodyFieldRef}
          type="hidden"
          name={name}
          defaultValue={initialHtml}
        />
      )}
    </div>
  );
}

/**
 * The toolbar is its own component because it is the only thing that needs to
 * re-render as the cursor moves. `useEditorState` re-renders whatever calls
 * it, so keeping it out of `EntryEditor` keeps the writing surface still while
 * the buttons light up.
 */
function EntryEditorToolbar({ editor }: { editor: Editor }) {
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      bulletList: current.isActive("bulletList"),
      link: current.isActive("link"),
      blockStyle:
        HEADING_LEVELS.find((level) =>
          current.isActive("heading", { level }),
        )?.toString() ?? "paragraph",
    }),
  });

  const openLinkPanel = useCallback(() => {
    const href: unknown = editor.getAttributes("link").href;
    setLinkDraft(typeof href === "string" ? href : "");
  }, [editor]);

  const linkPanelOpen = linkDraft !== null;

  /**
   * The panel is seeded from the selection it was opened on, so it stops
   * describing anything the moment the cursor moves. Leaving it up would let
   * "Apply" write a draft address onto whatever the author clicked next, and
   * "Remove" strip a link they never asked to edit.
   *
   * Closing is the right response rather than resyncing: a panel that
   * silently rewrote itself as the author clicked around the document would
   * be harder to understand, not easier.
   */
  useEffect(() => {
    if (!linkPanelOpen) return;

    const close = () => setLinkDraft(null);
    editor.on("selectionUpdate", close);
    return () => {
      editor.off("selectionUpdate", close);
    };
  }, [editor, linkPanelOpen]);

  function isPressed(id: ToolbarItemId): boolean {
    switch (id) {
      case "bold":
        return state.bold;
      case "italic":
        return state.italic;
      case "bulletList":
        return state.bulletList;
      case "link":
        return state.link || linkDraft !== null;
      default:
        return false;
    }
  }

  function activate(id: ToolbarItemId): void {
    switch (id) {
      case "bold":
        editor.chain().focus().toggleBold().run();
        return;
      case "italic":
        editor.chain().focus().toggleItalic().run();
        return;
      case "bulletList":
        editor.chain().focus().toggleBulletList().run();
        return;
      case "link":
        if (linkDraft === null) openLinkPanel();
        else setLinkDraft(null);
        return;
      // Rendered as a `<select>` below, and never routed here.
      case "heading":
      // Disabled until E5-T3 gives it something to do.
      case "image":
        return;
    }
  }

  function selectBlockStyle(value: string): void {
    if (value === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }
    editor
      .chain()
      .focus()
      .setHeading({ level: Number(value) as HeadingLevel })
      .run();
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        className="flex flex-wrap items-center gap-1 rounded-t-panel border-b border-rule bg-panel px-2 py-1"
      >
        {TOOLBAR_ITEMS.map((item) =>
          item.id === "heading" ? (
            <select
              key={item.id}
              aria-label={item.label}
              title={item.hint}
              value={state.blockStyle}
              onChange={(event) => selectBlockStyle(event.target.value)}
              className="rounded-panel border border-rule-soft bg-paper px-1.5 py-1 text-note text-ink"
            >
              {BLOCK_STYLES.map((style) => (
                <option key={style.value} value={style.value}>
                  {style.label}
                </option>
              ))}
            </select>
          ) : (
            <button
              key={item.id}
              type="button"
              title={item.hint}
              disabled={"disabled" in item && item.disabled}
              aria-pressed={isPressed(item.id)}
              onClick={() => activate(item.id)}
              className={toolbarButtonClass(item.id, isPressed(item.id))}
            >
              {item.label}
            </button>
          ),
        )}
      </div>

      {linkDraft === null ? null : (
        <LinkPanel
          draft={linkDraft}
          onDraftChange={setLinkDraft}
          isOnALink={state.link}
          onClose={() => {
            setLinkDraft(null);
            // Dismissing a panel should not leave focus nowhere.
            editor.commands.focus();
          }}
          onApply={(href) => {
            const { empty } = editor.state.selection;
            if (empty && !state.link) {
              // No selection to wrap, so the address becomes its own link
              // text. Better than silently doing nothing, which is what
              // `setLink` on an empty selection would do.
              editor
                .chain()
                .focus()
                .insertContent({
                  type: "text",
                  text: href,
                  marks: [{ type: "link", attrs: { href } }],
                })
                .run();
            } else {
              // `extendMarkRange` is what makes "click inside a link, retype
              // the address" work without selecting the words first.
              editor
                .chain()
                .focus()
                .extendMarkRange("link")
                .setLink({ href })
                .run();
            }
            setLinkDraft(null);
          }}
          onRemove={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            setLinkDraft(null);
          }}
        />
      )}
    </>
  );
}

function toolbarButtonClass(id: ToolbarItemId, pressed: boolean): string {
  const base =
    "rounded-panel px-2 py-1 text-note text-ink enabled:hover:bg-wash disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60";
  const emphasis =
    id === "bold" ? " font-bold" : id === "italic" ? " italic" : "";
  return `${base}${emphasis}${pressed ? " bg-wash" : ""}`;
}

/**
 * The link editor. A panel rather than a `window.prompt` because a prompt is
 * unstyleable, unlabelled, and looks to a non-technical author like the
 * browser has caught them doing something wrong.
 *
 * Validation happens on submit rather than as you type: telling someone their
 * address is invalid while they are still halfway through typing it is noise.
 */
function LinkPanel({
  draft,
  onDraftChange,
  isOnALink,
  onApply,
  onRemove,
  onClose,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  isOnALink: boolean;
  onApply: (href: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [rejected, setRejected] = useState(false);

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-rule bg-panel px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        const href = normaliseLinkHref(draft);
        if (href === null) {
          setRejected(true);
          return;
        }
        onApply(href);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <label htmlFor={inputId} className="text-note text-ink-muted">
        Link to
      </label>
      <input
        id={inputId}
        // The field exists only because the author just pressed Link, so the
        // cursor belongs in it.
        autoFocus
        type="text"
        value={draft}
        placeholder="example.com or /wiki/rose"
        aria-invalid={rejected}
        aria-describedby={rejected ? errorId : undefined}
        onChange={(event) => {
          setRejected(false);
          onDraftChange(event.target.value);
        }}
        className="min-w-0 flex-1 rounded-panel border border-rule-soft bg-paper px-2 py-1 text-note text-ink"
      />
      <button
        type="submit"
        className="rounded-panel px-2 py-1 text-note text-link hover:underline"
      >
        Apply
      </button>
      {isOnALink ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-panel px-2 py-1 text-note text-ink-muted hover:underline"
        >
          Remove
        </button>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        className="rounded-panel px-2 py-1 text-note text-ink-muted hover:underline"
      >
        Cancel
      </button>
      {rejected ? (
        <p id={errorId} role="alert" className="basis-full text-note text-ink">
          That is not an address this wiki can link to. Try something like
          example.com, /wiki/rose or an email address.
        </p>
      ) : null}
    </form>
  );
}
