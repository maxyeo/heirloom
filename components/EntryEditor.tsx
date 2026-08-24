"use client";

import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

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
import { entryHref, entrySlugFromHref, searchEntries } from "@/lib/entry-links";
import type { TitledEntry } from "@/lib/page-index";

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
 * `max-w-content` column the way `app/page.tsx` does. The E11-T2 shell puts
 * that column beside the sidebar; it deliberately does not impose the measure
 * itself, so the route stays the one place a page's width is decided.
 *
 * ## Linking to other entries (E2-T5, `YEO-28`)
 *
 * The link button offers the wiki's own entries by title, which is what makes
 * this a wiki rather than a folder of documents. The entries arrive as a
 * *prop* rather than being fetched here, for the reason docs/testing.md gives
 * about server actions: a Client Component that reaches for `@/db` drags
 * postgres.js into any suite that mounts it. `app/wiki/[slug]/edit/page.tsx`
 * is a Server Component already reading the database, so it passes the list
 * down — the framework's own composition pattern, and the same shape
 * `PartnerPicker` takes its `people` in.
 *
 * Given no `entries`, the link panel is exactly what it was before E2-T5: a
 * single address field. Nothing here requires the list.
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
  /**
   * Every entry that exists, so the link button can offer them by title and
   * so a link to one that has since been deleted can be reported as such.
   *
   * The whole list rather than a search endpoint: the corpus is a family's
   * entries, and `lib/pages.ts` already makes that judgement for the index it
   * reads without a `LIMIT`. See `lib/entry-links.ts`.
   */
  entries?: readonly TitledEntry[];
}

/**
 * The default for `entries`, hoisted rather than written as `= []` in the
 * destructuring. A fresh array literal every render is a fresh dependency for
 * the `useMemo` the panel searches inside, which would recompute the result
 * list on every keystroke in the *title* field two components up.
 */
const NO_ENTRIES: readonly TitledEntry[] = [];

export function EntryEditor({
  initialHtml = "",
  name,
  onChange,
  label = "Entry body",
  entries = NO_ENTRIES,
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
        <EntryEditorToolbar editor={editor} entries={entries} />
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
function EntryEditorToolbar({
  editor,
  entries,
}: {
  editor: Editor;
  entries: readonly TitledEntry[];
}) {
  /**
   * The href the panel was opened on, or `null` when it is closed. Held as an
   * object rather than as a bare string so that "closed" and "open on a
   * link that has no address yet" stay distinguishable — `""` is a real
   * starting state, and `null` is not one of its values.
   *
   * The panel edits its own copy from here on. Before E2-T5 this state was
   * the live draft, which worked while there was one field to draft in; with
   * two modes the panel is the only thing that knows which of them is being
   * edited, so the draft belongs there and this is the seed.
   */
  const [linkPanel, setLinkPanel] = useState<{ href: string } | null>(null);

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
    setLinkPanel({ href: typeof href === "string" ? href : "" });
  }, [editor]);

  const linkPanelOpen = linkPanel !== null;

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

    const close = () => setLinkPanel(null);
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
        return state.link || linkPanelOpen;
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
        if (linkPanel === null) openLinkPanel();
        else setLinkPanel(null);
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

      {linkPanel === null ? null : (
        <LinkPanel
          href={linkPanel.href}
          entries={entries}
          isOnALink={state.link}
          onClose={() => {
            setLinkPanel(null);
            // Dismissing a panel should not leave focus nowhere.
            editor.commands.focus();
          }}
          onApply={(href, text) => {
            const { empty } = editor.state.selection;
            if (empty && !state.link) {
              /**
               * No selection to wrap, so the link has to bring its own text.
               * For an entry that is its title — picking "Rose Hall" out of a
               * list and getting the words `/wiki/rose-hall` in the sentence
               * would be nonsense. For a raw address the address itself is
               * still the best available answer, and better than silently
               * doing nothing, which is what `setLink` on an empty selection
               * would do.
               */
              editor
                .chain()
                .focus()
                .insertContent({
                  type: "text",
                  text: text ?? href,
                  marks: [{ type: "link", attrs: { href } }],
                })
                .run();
            } else {
              // `extendMarkRange` is what makes "click inside a link, pick a
              // different entry" work without selecting the words first. The
              // author's own words are kept: a selection reading "her
              // mother's house" stays that, pointed at Rose Hall.
              editor
                .chain()
                .focus()
                .extendMarkRange("link")
                .setLink({ href })
                .run();
            }
            setLinkPanel(null);
          }}
          onRemove={() => {
            editor.chain().focus().extendMarkRange("link").unsetLink().run();
            setLinkPanel(null);
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

/** Which of the two things a link can point at is being chosen. */
type LinkMode = "entry" | "url";

/**
 * The two modes, in order, and their labels.
 *
 * "An entry" comes first because it is the one that makes this a wiki, and
 * because it is the answer most of the time: an entry about a grandmother
 * links to her husband, her village and her sister far more often than it
 * links off-site. The wording avoids "internal", "external" and "URL" —
 * words about addresses rather than about what the author is doing.
 */
const LINK_MODES: readonly { value: LinkMode; label: string }[] = [
  { value: "entry", label: "An entry" },
  { value: "url", label: "A web address" },
];

/**
 * Which mode the panel should open in.
 *
 * Opening on an existing link opens the mode that link is already in, so that
 * pressing Link on a link shows what it points at rather than an empty box.
 * Opening on nothing offers the entry list, which is the wiki-shaped default.
 * With no entries to offer there is only one mode, and the panel is exactly
 * the address field it was before E2-T5.
 */
function initialLinkMode(href: string, canPickEntries: boolean): LinkMode {
  if (!canPickEntries) return "url";
  if (href === "") return "entry";
  return entrySlugFromHref(href) === null ? "url" : "entry";
}

/**
 * The link editor (E1-T2, and the entry picker from E2-T5, `YEO-28`).
 *
 * A panel rather than a `window.prompt` because a prompt is unstyleable,
 * unlabelled, and looks to a non-technical author like the browser has caught
 * them doing something wrong.
 *
 * ## Two modes, one form
 *
 * The ticket asks for a searchable list of entries *and* for raw addresses to
 * keep working, so the panel has both behind a radio pair. Not two buttons on
 * the toolbar: the author's intent is "link this", and which kind of thing
 * they are linking to is a detail of that one action. A second toolbar button
 * would also break the rule `lib/editor-extensions.ts` states about the bar
 * being exactly six controls.
 *
 * Both modes end in the same `onApply`. The entry mode passes the entry's
 * title alongside the href, because a link inserted with no selection has to
 * bring its own text and `/wiki/rose-hall` is not a phrase anybody wrote.
 *
 * ## What is deliberately not here
 *
 * No "create the entry you just searched for". `PartnerPicker` offers exactly
 * that for people, and it is right there because half the people in a family
 * tree arrive as somebody's spouse. An entry is not like that: creating one
 * means leaving this one mid-sentence, and the wiki already has an answer for
 * linking to something unwritten — a link to an address nobody has filled in
 * yet, which E11-T6 (`YEO-76`) renders red as an invitation to write it. That
 * is the same answer Wikipedia gives, and it belongs to that ticket.
 *
 * Validation happens on submit rather than as you type: telling someone their
 * address is invalid while they are still halfway through typing it is noise.
 */
function LinkPanel({
  href,
  entries,
  isOnALink,
  onApply,
  onRemove,
  onClose,
}: {
  /** The address the link already has, or `""` — the seed, not a live value. */
  href: string;
  entries: readonly TitledEntry[];
  isOnALink: boolean;
  /**
   * Apply an address. `text` is what the link should say when there is no
   * selection to wrap — an entry's title. Omitted, the address speaks for
   * itself.
   */
  onApply: (href: string, text?: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const modeName = useId();
  const searchId = useId();
  const urlId = useId();
  const errorId = useId();
  const missingId = useId();

  /**
   * Whether there is a list to offer at all. In the running application there
   * always is — the entry being edited is itself in it — so this is really
   * about a caller that passed no `entries`, and about not claiming a link is
   * broken on the strength of a list that was never supplied.
   */
  const canPickEntries = entries.length > 0;

  const [mode, setMode] = useState<LinkMode>(() =>
    initialLinkMode(href, canPickEntries),
  );
  const [url, setUrl] = useState(href);
  const [query, setQuery] = useState("");
  const [rejected, setRejected] = useState(false);

  const results = useMemo(
    () => searchEntries(entries, query),
    [entries, query],
  );

  /**
   * What this link already points at, when it points at an entry.
   *
   * `href` does not change while the panel is open — the panel edits its own
   * copies — so these are stable for as long as they are on screen.
   */
  const linkedSlug = canPickEntries ? entrySlugFromHref(href) : null;
  const linkedEntry =
    linkedSlug === null
      ? undefined
      : entries.find((entry) => entry.slug === linkedSlug);
  /**
   * The acceptance criterion about links degrading visibly. An entry link
   * whose slug matches no entry is one whose target has been deleted or
   * renamed, and the author is standing in front of the only place it can be
   * fixed. Saying so here is the half of that criterion this ticket owns; the
   * other half — a red link for the *reader* — is E11-T6 (`YEO-76`), which
   * resolves the same site-relative hrefs against `pages.slug` at render
   * time. It has to work that way round: `lib/sanitize-html.ts` allows exactly
   * one attribute on an `a`, and it is `href`, so no marker this component
   * could write onto the link would survive being saved.
   */
  const linkIsBroken = linkedSlug !== null && linkedEntry === undefined;

  function applyEntry(entry: TitledEntry): void {
    onApply(entryHref(entry.slug), entry.title);
  }

  return (
    <form
      className="border-b border-rule bg-panel px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (mode === "entry") {
          // Enter takes the best match, which is what the list is already
          // showing at the top. Nothing to take is not an error worth a
          // message — the list is saying so directly above.
          const best = results[0];
          if (best) applyEntry(best);
          return;
        }

        const address = normaliseLinkHref(url);
        if (address === null) {
          setRejected(true);
          return;
        }
        onApply(address);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {canPickEntries ? (
          <fieldset className="flex items-center gap-3">
            {/* The visible question is the panel itself; a screen reader gets
                it said out loud rather than inferred from two radio labels. */}
            <legend className="sr-only">What to link to</legend>
            {LINK_MODES.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-1 text-note text-ink"
              >
                <input
                  type="radio"
                  name={modeName}
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => {
                    // A rejection belongs to the address that caused it.
                    setRejected(false);
                    setMode(option.value);
                  }}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        ) : null}

        {/* Leaving the panel, kept together and out of the working area. */}
        <span className="ml-auto flex items-center gap-2">
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
        </span>
      </div>

      {linkIsBroken ? (
        // `text-link-new` is the red this design already reserves for an
        // entry that is not there (docs/design-tokens.md).
        <p id={missingId} className="mt-2 text-note text-link-new">
          This links to an entry that no longer exists. Choose another below, or
          remove the link.
        </p>
      ) : linkedEntry ? (
        <p className="mt-2 text-note text-ink-muted">
          Currently links to{" "}
          <span className="text-ink">{linkedEntry.title}</span>.
        </p>
      ) : null}

      {mode === "entry" ? (
        <div className="mt-2">
          {/* The placeholder says the same thing, but a placeholder is not a
              label and disappears the moment anything is typed. */}
          <label htmlFor={searchId} className="sr-only">
            Search entries by title
          </label>
          <input
            id={searchId}
            // The field exists only because the author just pressed Link, so
            // the cursor belongs in it.
            autoFocus
            type="search"
            value={query}
            placeholder="Search entries by title"
            // The browser's own history of what was typed into a search box
            // is noise over a list of this wiki's actual entries.
            autoComplete="off"
            aria-describedby={linkIsBroken ? missingId : undefined}
            onChange={(event) => setQuery(event.target.value)}
            className="block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1 text-note text-ink"
          />

          {/* Not debounced, and nothing to debounce against: the entries are
              already in the browser, so a keystroke costs one pass over an
              array. See `lib/entry-links.ts`. */}
          <ul
            aria-label="Matching entries"
            className="mt-1 max-h-40 overflow-y-auto rounded-panel border border-rule-soft"
          >
            {results.length === 0 ? (
              <li className="px-2 py-1.5 text-note text-ink-muted">
                No entry matches that.
              </li>
            ) : (
              results.map((entry) => (
                <li key={entry.slug}>
                  <button
                    type="button"
                    onClick={() => applyEntry(entry)}
                    className="block w-full px-2 py-1.5 text-left text-note text-ink hover:bg-wash"
                  >
                    {entry.title}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={urlId} className="text-note text-ink-muted">
            Address
          </label>
          <input
            id={urlId}
            autoFocus
            type="text"
            value={url}
            placeholder="example.com or /wiki/rose"
            aria-invalid={rejected}
            aria-describedby={rejected ? errorId : undefined}
            onChange={(event) => {
              setRejected(false);
              setUrl(event.target.value);
            }}
            className="min-w-0 flex-1 rounded-panel border border-rule-soft bg-paper px-2 py-1 text-note text-ink"
          />
          <button
            type="submit"
            className="rounded-panel px-2 py-1 text-note text-link hover:underline"
          >
            Apply
          </button>
        </div>
      )}

      {rejected ? (
        <p id={errorId} role="alert" className="mt-2 text-note text-ink">
          That is not an address this wiki can link to. Try something like
          example.com, /wiki/rose or an email address.
        </p>
      ) : null}
    </form>
  );
}
