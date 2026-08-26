"use client";

import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor, Extensions } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { ImageUploadError, uploadImage } from "@/components/image-upload";
import {
  BLOCK_STYLES,
  EDITOR_INPUT_OPTIONS,
  HATNOTE_TOOLBAR_ITEMS,
  HEADING_LEVELS,
  IMAGE_NODE,
  TOOLBAR_ITEMS,
  createEntryExtensions,
  createHatnoteExtensions,
  normaliseLinkHref,
  type HeadingLevel,
  type ToolbarItem,
  type ToolbarItemId,
} from "@/lib/editor-extensions";
import { entryHref, entrySlugFromHref, searchEntries } from "@/lib/entry-links";
import {
  IMAGE_ACCEPT,
  altTextFromFilename,
  picturesAmong,
} from "@/lib/image-insert";
import type { TitledEntry } from "@/lib/page-index";
import { headingNodePosition } from "@/lib/section-edit";

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
 *
 * ## The hatnote variant (E11-T9, `YEO-79`)
 *
 * `variant="hatnote"` is the same component with a smaller document model: one
 * line, one toolbar button, no block structure. It is a variant rather than a
 * second component because the part worth not duplicating is the link panel —
 * the entry picker, the two modes, the "insert with its own text when there is
 * no selection" rule — which is a great many decisions that would immediately
 * begin to diverge in a copy. What the variant changes is *data*: which
 * extensions, which toolbar items, which surface class. Nothing in `LinkPanel`
 * knows there are two.
 *
 * See `VARIANTS` below for what each one is, and `lib/hatnote.ts` for why the
 * hatnote's stored form has room for text and links and nothing else.
 *
 * ## Photographs (E5-T3, `YEO-43`)
 *
 * The image button, a drop target and a paste handler, all reaching the same
 * upload. There is **no URL field**, which is the acceptance criterion stated
 * as an absence: the author picks a file the way they would in any other
 * program, and what goes into the body is a site-relative path of this
 * application's own — never a storage URL, which expires in fifteen minutes
 * (docs/architecture.md#the-storage-seam).
 *
 * The work is split three ways, and the split is the same one the rest of this
 * component follows. What is a *decision* — which files are pictures, what
 * `alt` should say, when a photograph has to be shrunk — is in
 * `lib/image-insert.ts` and tested with no DOM. What needs a browser — a
 * canvas, an `XMLHttpRequest` whose progress can be watched — is in
 * `components/image-upload.ts`. What is left here is the queue, the strip that
 * reports on it, and the insert.
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
   * The id of an element describing this field, announced after its name.
   *
   * The writing surface is a `contenteditable` inside ProseMirror's own DOM,
   * so a `<p>` sitting next to it in the form is not associated with it by
   * anything a screen reader can see — there is no `<label for>` relationship
   * to inherit and no wrapper to imply one. This is the only way a hint gets
   * read out, which matters most for the hatnote field (E11-T9, `YEO-79`),
   * whose hint carries the one thing nobody would guess: that an entry about
   * a person who shares a name already gets a hatnote without anybody writing
   * one.
   */
  describedBy?: string;
  /**
   * Every entry that exists, so the link button can offer them by title and
   * so a link to one that has since been deleted can be reported as such.
   *
   * The whole list rather than a search endpoint: the corpus is a family's
   * entries, and `lib/pages.ts` already makes that judgement for the index it
   * reads without a `LIMIT`. See `lib/entry-links.ts`.
   */
  entries?: readonly TitledEntry[];
  /**
   * Which heading to put the cursor in when the editor mounts, in document
   * order — E11-T4's section `[edit]` links (`YEO-74`), which open the whole
   * editor rather than a fragment of the document and make up for it by
   * landing the author in the section they clicked.
   *
   * An index rather than a heading id because this document has no ids in it:
   * `lib/sanitize-html.ts` allows none through, so the ids in the article are
   * minted at render time by `lib/article-outline.ts` and exist only there.
   * The nth heading is the same heading in both, which is all this needs. The
   * route resolves the one for the other; see `lib/section-edit.ts`.
   *
   * Read once, when the editor is created. Nothing re-reads it, because
   * moving an author's cursor for them is only ever defensible as an answer
   * to the click that brought them here.
   */
  initialHeadingIndex?: number | null;
  /**
   * Which document this editor is editing: an entry body, or the one-line
   * hatnote above it (E11-T9, `YEO-79`).
   *
   * Defaults to the body, so every call site that predates it means what it
   * meant.
   */
  variant?: EditorVariant;
}

/** The two documents this component can edit. See `VARIANTS`. */
export type EditorVariant = "body" | "hatnote";

/**
 * What each variant is, as data rather than as branches through the render.
 *
 * Collected here so that "what is different about a hatnote editor" is one
 * short table to read rather than four `variant === "hatnote"` checks spread
 * across a component. Anything not in this table is deliberately the same in
 * both.
 */
const VARIANTS: Readonly<
  Record<
    EditorVariant,
    {
      /** The extension set — the tags this editor can produce at all. */
      createExtensions: () => Extensions;
      /** The buttons. */
      items: readonly ToolbarItem[];
      /** Classes on the writing surface itself. */
      surfaceClass: string;
      /** Whether Enter starts a new block, and what a screen reader is told. */
      multiline: boolean;
    }
  >
> = {
  body: {
    createExtensions: createEntryExtensions,
    items: TOOLBAR_ITEMS,
    // `wiki-body` is the article's own stylesheet, so a heading typed here
    // gets the same serif and the same bottom rule it will have once saved.
    // The focus ring is the global `:focus-visible` rule.
    surfaceClass: "wiki-body min-h-80 px-4 py-3",
    multiline: true,
  },
  hatnote: {
    createExtensions: createHatnoteExtensions,
    items: HATNOTE_TOOLBAR_ITEMS,
    // `hatnote` alongside `wiki-body` for the reason `wiki-body` is on the
    // body's surface: the field should look like the line it becomes, so an
    // author sees the italic indent while typing rather than after saving.
    surfaceClass: "wiki-body hatnote px-4 py-2",
    multiline: false,
  },
};

/**
 * The default for `entries`, hoisted rather than written as `= []` in the
 * destructuring. A fresh array literal every render is a fresh dependency for
 * the `useMemo` the panel searches inside, which would recompute the result
 * list on every keystroke in the *title* field two components up.
 */
const NO_ENTRIES: readonly TitledEntry[] = [];

/**
 * What the strip under the toolbar is saying, or `null` for "nothing is
 * happening" (E5-T3, `YEO-43`).
 *
 * One state for the whole editor rather than one per picture. An author who
 * drops four photographs at once is watching one thing happen four times, not
 * four things at once — the uploads are deliberately serialised, because four
 * parallel 4 MB posts on a domestic connection make all four slower and the
 * progress bar meaningless.
 */
type UploadState =
  | {
      status: "uploading";
      /** 0–100, or `null` when the browser cannot measure the body. */
      percent: number | null;
      /** Which picture of how many, both 1-based, for "2 of 4". */
      position: number;
      total: number;
    }
  | { status: "error"; message: string }
  | null;

/** One queued picture, and where it should land. */
interface QueuedPicture {
  file: File;
  /**
   * The document position to insert at, or `null` for "wherever the cursor
   * is".
   *
   * Only ever set for the first file of a drop, which is the only one with a
   * place it was aimed at; the rest go immediately after the one before, which
   * the drain loop tracks for itself. A drop that arrives while an earlier
   * batch is still uploading keeps its position and has it clamped, for the
   * reason the clamp exists: by the time it is reached the document may have
   * changed underneath it.
   */
  at: number | null;
}

export function EntryEditor({
  initialHtml = "",
  name,
  onChange,
  label = "Entry body",
  describedBy,
  entries = NO_ENTRIES,
  initialHeadingIndex = null,
  variant = "body",
}: EntryEditorProps) {
  const bodyFieldRef = useRef<HTMLInputElement>(null);
  const { createExtensions, items, surfaceClass, multiline } =
    VARIANTS[variant];

  /**
   * Whether this editor takes pictures at all, read off the toolbar rather
   * than off the variant name.
   *
   * The hatnote has no image button *and* no image node — see
   * `createHatnoteExtensions` — so a drop handler there would upload a
   * photograph and then fail to insert it. Asking the toolbar keeps the two
   * facts from having to be remembered together: a variant that loses the
   * button loses the drop target in the same edit.
   */
  const acceptsPictures = items.some((item) => item.id === "image");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<UploadState>(null);

  // `useEditor` builds the editor once and does not rebuild it when props
  // change, so reading `onChange` directly inside `onUpdate` would pin the
  // first render's copy forever. The ref is the standard way round that.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Built once and kept. Tiptap compares extension arrays by reference, so a
  // fresh array on every render makes it re-apply options it already has.
  const [extensions] = useState(createExtensions);

  /**
   * The drop and paste handlers below are captured once, when the editor is
   * built — the same reason `onChangeRef` exists — and at that moment there is
   * no editor for them to insert into. So they call through a ref, which the
   * effect further down keeps pointed at the current uploader.
   */
  const addPicturesRef = useRef<(pictures: readonly QueuedPicture[]) => void>(
    () => {},
  );

  const editor = useEditor({
    ...EDITOR_INPUT_OPTIONS,
    extensions,
    content: initialHtml,
    // Required under the App Router: rendering the editor during the server
    // pass would produce markup the client immediately disagrees with.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: surfaceClass,
        "aria-label": label,
        "aria-multiline": String(multiline),
        // Spread rather than set to `undefined`: ProseMirror writes every key
        // of this record onto the DOM node, so an absent description has to be
        // an absent *key* or the surface grows `aria-describedby="undefined"`
        // and a screen reader announces a hint that is not there.
        ...(describedBy === undefined
          ? {}
          : { "aria-describedby": describedBy }),
      },
      /**
       * A one-line field stays one line (E11-T9, `YEO-79`).
       *
       * `hardBreak` is already off in `HATNOTE_STARTER_KIT_OPTIONS`, so
       * shift+Enter produces nothing; this stops plain Enter from splitting the
       * paragraph. Both halves are needed. Without this one a second paragraph
       * is perfectly typeable, survives until save, and is then flattened back
       * onto one line by `normaliseHatnote` — content the author watched
       * themselves write, silently rearranged afterwards. Refusing the
       * keystroke is the honest version of the same rule.
       *
       * `undefined` for the body, so nothing about pressing Enter in an
       * article changes.
       */
      handleKeyDown: multiline
        ? undefined
        : // `isComposing` is the guard that keeps this from breaking input
          // methods: confirming a candidate in a Japanese, Chinese or Korean
          // IME is an Enter keypress, and swallowing it would make the field
          // impossible to type a name into in exactly the scripts
          // `lib/entry-slug.ts` went out of its way to keep addressable.
          (_view, event) => event.key === "Enter" && !event.isComposing,

      /**
       * Dragging a photograph out of a folder and onto the entry (E5-T3,
       * `YEO-43`).
       *
       * `moved` is ProseMirror telling us this is a drag that started inside
       * this document — the author moving the picture they inserted a moment
       * ago — and handling it would upload a copy of nothing and lose the
       * move. Letting it through is what makes `draggable` on the image node
       * work.
       *
       * Returning `true` is what stops ProseMirror's own drop handling, which
       * for a file drop would paste the filename in as text. It is returned
       * only when there is actually a picture in the payload, so dragging in a
       * chunk of HTML or a `.ged` still does whatever it did before.
       */
      handleDrop: !acceptsPictures
        ? undefined
        : (view, event, _slice, moved) => {
            if (moved) return false;

            const files = picturesAmong([...(event.dataTransfer?.files ?? [])]);
            if (files.length === 0) return false;

            event.preventDefault();
            // Where the pointer actually was, so a picture lands where it was
            // aimed rather than wherever the cursor happened to be left. A
            // drop outside any text — the padding below the last paragraph —
            // gives no position, and `null` means "at the cursor".
            const at =
              view.posAtCoords({ left: event.clientX, top: event.clientY })
                ?.pos ?? null;

            addPicturesRef.current(
              files.map((file, index) => ({
                file,
                at: index === 0 ? at : null,
              })),
            );
            return true;
          },

      /**
       * Pasting one (⌘V from Preview, from a screenshot, from a chat window).
       *
       * `clipboardData.files` rather than `items`: a paste from a word
       * processor carries the picture *and* an `text/html` flavour of the
       * paragraph around it, and taking the files is what keeps this from
       * firing on ordinary formatted text. When there is no picture in the
       * payload this returns `false` and the Link extension's paste handler
       * and ProseMirror's own HTML parsing run exactly as before.
       */
      handlePaste: !acceptsPictures
        ? undefined
        : (_view, event) => {
            const files = picturesAmong([
              ...(event.clipboardData?.files ?? []),
            ]);
            if (files.length === 0) return false;

            event.preventDefault();
            addPicturesRef.current(files.map((file) => ({ file, at: null })));
            return true;
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

  /**
   * Open on the section the author pressed `[edit]` on (E11-T4, `YEO-74`).
   *
   * Two steps rather than one, and the split is the point:
   *
   *   - `focus(position, { scrollIntoView: false })` puts the cursor at the
   *     start of the heading — the author can retitle the section, or press
   *     Down and be in its first paragraph. ProseMirror's own scrolling is
   *     switched off here because it computes its margins itself and knows
   *     nothing about the sticky header, so it would land the heading
   *     underneath it.
   *   - `scrollIntoView` on the heading element is the browser's own, and it
   *     honours the `scroll-margin-top` that `.wiki-body h2, h3, h4` carries
   *     for exactly this (`app/globals.css`). The editing surface wears
   *     `wiki-body`, so a section reached in the editor stops in the same
   *     place a section reached from the contents panel does.
   *
   * Every way this can fail is a way it does nothing: no section asked for,
   * an index the document has no heading for, a node whose DOM is not an
   * element. The author gets an editor open at the top of the entry, which is
   * where the Edit tab would have put them anyway.
   *
   * The dependencies are the editor and the index, so this runs again if the
   * index changes under a mounted editor. That is deliberate rather than
   * overlooked: the only way it happens is a back or forward between two
   * `?section=` addresses for the same entry — `[edit]` links live on the
   * article, never inside the editor — and moving the cursor to the section
   * the author just navigated to is the right answer to that navigation.
   */
  useEffect(() => {
    if (!editor || initialHeadingIndex === null) return;

    const position = headingNodePosition(editor.state.doc, initialHeadingIndex);
    if (position === null) return;

    // Inside the heading rather than before it: a position between two blocks
    // is a gap selection, and typing there would start a new paragraph above
    // the section instead of editing it.
    editor.commands.focus(position + 1, { scrollIntoView: false });

    const heading = editor.view.nodeDOM(position);
    if (heading instanceof HTMLElement)
      heading.scrollIntoView({ block: "start" });
  }, [editor, initialHeadingIndex]);

  /**
   * The pictures waiting to be uploaded, and whether the loop that empties the
   * queue is already running (E5-T3, `YEO-43`).
   *
   * Refs rather than state, because nothing renders from them and a queue in
   * state would re-render the editor's container on every push — the same
   * argument `onUpdate` makes about writing the body straight to the hidden
   * input. What renders is {@link UploadState}, which is one line of status
   * rather than a list.
   *
   * The loop is what makes uploads **serial**. Four 4 MB posts at once on a
   * domestic uplink finish no sooner together than one after another, and they
   * turn a progress bar into a number that means nothing; one at a time is
   * also the only shape in which "picture 2 of 4" is true.
   */
  const queueRef = useRef<QueuedPicture[]>([]);
  const drainingRef = useRef(false);

  /**
   * Aborts every upload still in flight when the editor goes away.
   *
   * One controller for the editor's whole life rather than one per file: the
   * only thing that ever aborts is the unmount, and an author navigating away
   * mid-upload should leave nothing running behind them.
   */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);

  const drain = useCallback(async (): Promise<void> => {
    // Nothing to do is checked before the flag is taken, so that a call with
    // an empty queue cannot clear a refusal the author has not read yet — the
    // `setUpload(null)` at the end of the loop below would otherwise fire on
    // a run that uploaded nothing.
    if (queueRef.current.length === 0) return;
    if (drainingRef.current || !editor) return;
    drainingRef.current = true;

    let done = 0;
    /**
     * Where the *next* picture of this run goes, once the first has landed.
     *
     * Tracked rather than re-read from the selection, and tracked as a number
     * rather than left to the cursor, because inserting an atom leaves it
     * *selected* — so a second `insertContent` would replace the first
     * photograph with the second and look, in the document, exactly like only
     * one of them having uploaded.
     */
    let after: number | null = null;

    try {
      for (;;) {
        const next = queueRef.current.shift();
        if (next === undefined) break;

        const position = done + 1;
        /**
         * How many there are altogether, asked of the queue each time rather
         * than fixed when the batch started: a picture dropped while an
         * earlier one is still going up is counted into the "of 4" the author
         * is already reading, rather than restarting the count when the loop
         * reaches it.
         */
        const total = () => position + queueRef.current.length;

        setUpload({
          status: "uploading",
          percent: 0,
          position,
          total: total(),
        });

        const uploaded = await uploadImage(next.file, {
          signal: abortRef.current?.signal,
          onProgress: (percent) =>
            setUpload((current) =>
              current?.status === "uploading"
                ? { status: "uploading", percent, position, total: total() }
                : current,
            ),
        });

        const content = {
          type: IMAGE_NODE,
          attrs: {
            src: uploaded.path,
            alt: altTextFromFilename(next.file.name),
          },
        };

        // Clamped, because a dropped position was measured against the
        // document as it was when the file landed on it and an edit — or an
        // undo — may have shortened it since. An out-of-range position is a
        // throw, not a no-op.
        const at = Math.min(
          next.at ?? after ?? editor.state.selection.to,
          editor.state.doc.content.size,
        );

        const before = editor.state.doc.content.size;
        editor.chain().focus().insertContentAt(at, content).run();
        // Exactly past what was just inserted, however much that turned out
        // to be: dropping a block into the middle of a paragraph splits it,
        // so the picture's own size is not the whole of the difference.
        after = at + (editor.state.doc.content.size - before);

        done += 1;
      }

      setUpload(null);
    } catch (error) {
      // An abort is the editor unmounting, not a failure, and there is
      // nothing left to render it into.
      if (error instanceof DOMException && error.name === "AbortError") return;

      /**
       * One refusal ends the batch, and the rest of the queue is dropped.
       *
       * Every reason an upload is refused — too large, not one of the four
       * formats, a session that expired, the connection — is a reason the
       * next four will be refused too, so carrying on would show the same
       * sentence four times and put the author four failures away from
       * reading it. What is already inserted stays inserted.
       */
      queueRef.current = [];
      setUpload({
        status: "error",
        message:
          error instanceof ImageUploadError
            ? error.message
            : "That picture could not be added. Try again.",
      });
    } finally {
      drainingRef.current = false;
    }
  }, [editor]);

  const addPictures = useCallback(
    (pictures: readonly QueuedPicture[]) => {
      if (pictures.length === 0) return;
      /**
       * A new picture clears a previous *failure*: the author has answered the
       * message by trying again, and leaving it up would have it describing an
       * upload that is no longer the current one.
       *
       * Only a failure. Clearing unconditionally would blank the progress
       * strip of an upload already running — a second picture dropped
       * mid-batch — and the loop below only writes to it again when it reaches
       * the next file, so the bar would vanish for the rest of the current
       * one.
       */
      setUpload((current) => (current?.status === "error" ? null : current));
      queueRef.current.push(...pictures);
      void drain();
    },
    [drain],
  );

  useEffect(() => {
    addPicturesRef.current = addPictures;
  }, [addPictures]);

  return (
    <div className="rounded-panel border border-rule bg-paper">
      {editor ? (
        <EntryEditorToolbar
          editor={editor}
          entries={entries}
          items={items}
          busy={upload?.status === "uploading"}
          onPickPicture={() => fileInputRef.current?.click()}
        />
      ) : (
        // Same height as the real bar, so nothing jumps when the editor
        // finishes mounting.
        <div
          className="h-9 rounded-t-panel border-b border-rule bg-panel"
          aria-hidden="true"
        />
      )}

      {/*
        The file picker itself (E5-T3, `YEO-43`).

        There is no URL field anywhere in this component, which is the
        acceptance criterion stated as an absence: the author picks a file, the
        way they would in any other program. This input is the whole of that —
        `display: none`, opened by the toolbar button, and never focusable in
        its own right, because the button is the labelled control and a second
        tab stop that looks like nothing would be a trap.
      */}
      {!acceptsPictures ? null : (
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => {
            const files = picturesAmong([...(event.target.files ?? [])]);
            // Cleared before anything is queued, so that choosing the same
            // file twice in a row fires `change` the second time. Without it
            // the second attempt is silent, which reads as the button being
            // broken.
            event.target.value = "";
            addPictures(files.map((file) => ({ file, at: null })));
          }}
        />
      )}

      {upload === null ? null : (
        <UploadStrip state={upload} onDismiss={() => setUpload(null)} />
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
 * What is happening to a picture, between the toolbar and the writing surface
 * (E5-T3, `YEO-43`).
 *
 * ## Why there is a bar at all
 *
 * The acceptance criterion is "progress indication for large files on slow
 * connections", and the case it is written for is real: the cap is 4 MB, and
 * a scanned photograph going up a rural connection is most of a minute in
 * which nothing on screen has changed. That is indistinguishable from the
 * button not having worked, and what an author does about it is press the
 * button again.
 *
 * ## Where the percentage is, and where it is not
 *
 * The number lives in the `<progress>` element and the *words* live in a
 * `role="status"` region beside it. The split is the whole accessibility
 * design here: a live region whose text changed sixty times during one upload
 * would have a screen reader reading percentages over the top of whatever
 * else it was saying, so the text changes once per picture ("Adding picture 2
 * of 4…") and the bar — which announces nothing on its own — carries the rest.
 *
 * An indeterminate bar when `percent` is `null`, which is `<progress>` with no
 * `value`: the browser could not measure the request body, and a bar sitting
 * confidently at 0% would be a worse answer than one that says only that
 * something is happening.
 */
function UploadStrip({
  state,
  onDismiss,
}: {
  state: NonNullable<UploadState>;
  onDismiss: () => void;
}) {
  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="flex items-center gap-3 border-b border-rule bg-panel px-3 py-1.5 text-note text-ink"
      >
        <span>{state.message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="text-link hover:underline"
        >
          Dismiss
        </button>
      </p>
    );
  }

  const { percent, position, total } = state;
  const label =
    total === 1 ? "Adding picture…" : `Adding picture ${position} of ${total}…`;

  return (
    <p className="flex items-center gap-2 border-b border-rule bg-panel px-3 py-1.5 text-note text-ink-muted">
      {/*
        Hidden from assistive technology on purpose: the sentence next to it
        already says what is happening, and a labelled progress bar would have
        it said twice.
      */}
      <progress
        aria-hidden="true"
        className="h-1 w-24"
        max={100}
        {...(percent === null ? {} : { value: percent })}
      />
      <span role="status">{label}</span>
    </p>
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
  items,
  busy,
  onPickPicture,
}: {
  editor: Editor;
  entries: readonly TitledEntry[];
  /** The buttons this variant has. See `VARIANTS`. */
  items: readonly ToolbarItem[];
  /**
   * Whether a picture is being uploaded right now. The image button is the
   * only control it disables — an author should still be able to write, and
   * to bold what they have written, while a photograph goes up.
   */
  busy: boolean;
  /** Open the file picker. See the input in `EntryEditor`. */
  onPickPicture: () => void;
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

  /**
   * Which controls this toolbar has, as a set to ask.
   *
   * It guards the selector below rather than merely deciding what to render,
   * and that is not tidiness: `isActive("bold")` *throws* when no Bold
   * extension is registered — it resolves the name to a mark type and there is
   * none — so a hatnote editor asking the body's questions would take the page
   * down rather than render a smaller bar. Short-circuiting on this set is what
   * makes the selector describe the editor it is actually looking at.
   */
  const present = useMemo(
    () => new Set<ToolbarItemId>(items.map((item) => item.id)),
    [items],
  );

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: present.has("bold") && current.isActive("bold"),
      italic: present.has("italic") && current.isActive("italic"),
      bulletList: present.has("bulletList") && current.isActive("bulletList"),
      link: present.has("link") && current.isActive("link"),
      blockStyle: present.has("heading")
        ? (HEADING_LEVELS.find((level) =>
            current.isActive("heading", { level }),
          )?.toString() ?? "paragraph")
        : "paragraph",
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

  /**
   * Whether a toolbar control is currently on, or `undefined` when it is not
   * the kind of control that can be (E10-T5).
   *
   * The distinction is the whole point, and it used to be a `default: false`.
   * `aria-pressed` is what turns a `<button>` into a *toggle* button as far as
   * assistive technology is concerned, so putting it on every control
   * announced the image button as "Image, toggle button, not pressed" — a
   * promise that pressing it would turn something on and pressing it again
   * would turn it off, when what it does is open a file picker. A screen
   * reader user has no other way to tell the two kinds of button apart, which
   * makes a wrong `aria-pressed` worse than none: it is not a missing label,
   * it is a label that is not true.
   *
   * Exhaustive over `ToolbarItemId` rather than a `default`, so a control
   * added later has to say which kind it is instead of silently inheriting
   * the wrong answer — which is exactly how the image button acquired it.
   */
  function pressedState(id: ToolbarItemId): boolean | undefined {
    switch (id) {
      case "bold":
        return state.bold;
      case "italic":
        return state.italic;
      case "bulletList":
        return state.bulletList;
      case "link":
        return state.link || linkPanelOpen;
      // Neither of these toggles anything. `image` opens the file picker, and
      // `heading` is rendered as a `<select>` below and never reaches a
      // button at all.
      case "image":
      case "heading":
        return undefined;
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
      case "image":
        // The whole of the button's job. Everything that happens next — the
        // resize, the request, the insert — is `EntryEditor`'s, because it is
        // the half that has to survive a drop and a paste as well.
        onPickPicture();
        return;
      // Rendered as a `<select>` below, and never routed here.
      case "heading":
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
        {items.map((item) =>
          item.id === "heading" ? (
            <select
              key={item.id}
              aria-label={item.label}
              title={item.hint}
              value={state.blockStyle}
              onChange={(event) => selectBlockStyle(event.target.value)}
              className="rounded-panel border border-rule bg-paper px-1.5 py-1 text-note text-ink"
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
              // Only the image button, and only while one is going up: a
              // second file picker opened over a running upload would queue
              // work the strip beside it is already describing.
              disabled={item.id === "image" && busy}
              // Absent, not `false`, on the controls that are not toggles.
              // See `pressedState`.
              aria-pressed={pressedState(item.id)}
              onClick={() => activate(item.id)}
              className={toolbarButtonClass(
                item.id,
                pressedState(item.id) === true,
              )}
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
            className="block w-full rounded-panel border border-rule bg-paper px-2 py-1 text-note text-ink"
          />

          {/* Not debounced, and nothing to debounce against: the entries are
              already in the browser, so a keystroke costs one pass over an
              array. See `lib/entry-links.ts`. */}
          <ul
            aria-label="Matching entries"
            className="mt-1 max-h-40 overflow-y-auto rounded-panel border border-rule"
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
            className="min-w-0 flex-1 rounded-panel border border-rule bg-paper px-2 py-1 text-note text-ink"
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
