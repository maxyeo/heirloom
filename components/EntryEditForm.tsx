"use client";

import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, useTransition } from "react";

import { EntryEditor } from "@/components/EntryEditor";
import type { TitledEntry } from "@/lib/page-index";
import { savePageAction } from "@/app/wiki/actions";

/**
 * The editor page's form: a title field, the E1-T2 editor, and a save.
 *
 * ## Why this exists in E1-T8's ticket
 *
 * E1-T8's last acceptance criterion is "redirects to the editor on the new
 * entry", and until this landed there was no editor to redirect to —
 * `EntryEditor` (E1-T2) was mounted in no route and `savePageAction` (E1-T3)
 * was called by nothing. Both halves existed and nothing joined them.
 *
 * So this is deliberately the smallest join that makes the criterion true,
 * and it stops there. No tabs, no history or diff links: those are E11-T7 and
 * E1-T5/T6, and guessing at their chrome here would only mean deleting it
 * when they arrive. The one thing that has since arrived is
 * `initialHeadingIndex` — E11-T4's section `[edit]` links land here, and this
 * component passes the section straight through to the editor without holding
 * an opinion about it, the same way it passes `entries`.
 *
 * ## Why it is not a plain `<form action={…}>`
 *
 * `savePageAction` takes a typed `{ slug, title, bodyHtml }` rather than
 * `FormData`, which is the door E1-T2's `onChange` was built for. Holding the
 * body in a ref rather than in state is the other half of that decision: the
 * editor calls `onChange` on every keystroke, and re-rendering this component
 * each time would re-render the editor's own container, which is the classic
 * way to make a Tiptap editor feel slow.
 */
export interface EntryEditFormProps {
  /** Which entry is being edited. Not shown; sent to the save action. */
  slug: string;
  /** The stored title, as the field's starting value. */
  title: string;
  /** The stored body, already sanitised on the way out of the database. */
  initialHtml: string;
  /**
   * The stored hatnote (E11-T9, `YEO-79`), already through
   * `normaliseHatnote` on the way out of the database — so text and links,
   * and `""` for an entry that has none, which is most of them.
   */
  initialHatnote: string;
  /**
   * Every entry that exists, for the editor's link button (E2-T5, `YEO-28`).
   *
   * Passed straight through. This form holds no opinion about linking; it is
   * here because the route that reads the database is on the other side of
   * it and the editor is a Client Component that must not reach for `@/db`
   * itself.
   */
  entries?: readonly TitledEntry[];
  /**
   * Which heading to open the editor on, in document order, or `null` for the
   * top (E11-T4, `YEO-74`).
   *
   * Resolved on the server by `app/wiki/[slug]/edit/page.tsx` from the
   * `?section=` a `[edit]` link carries, so what arrives here is already known
   * to be a heading this document has — or `null`, which is what a link to a
   * section that has since been renamed degrades to.
   */
  initialHeadingIndex?: number | null;
}

export function EntryEditForm({
  slug,
  title: storedTitle,
  initialHtml,
  initialHatnote,
  entries,
  initialHeadingIndex,
}: EntryEditFormProps) {
  const router = useRouter();
  const titleId = useId();
  const hatnoteHintId = useId();
  const errorId = useId();

  const [title, setTitle] = useState(storedTitle);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // The body, kept out of React state on purpose — see the note above.
  const bodyHtml = useRef(initialHtml);
  const onBodyChange = useCallback((html: string) => {
    bodyHtml.current = html;
  }, []);

  // And the hatnote, held the same way and for the same reason: it is a second
  // editor, and putting its HTML in state would re-render the *body* editor's
  // container on every keystroke in the line above it.
  const hatnote = useRef(initialHatnote);
  const onHatnoteChange = useCallback((html: string) => {
    hatnote.current = html;
  }, []);

  function save(): void {
    setError(null);

    startSaving(async () => {
      const result = await savePageAction({
        slug,
        title,
        bodyHtml: bodyHtml.current,
        hatnote: hatnote.current,
      });

      switch (result.status) {
        case "saved":
        case "unchanged":
          // `unchanged` is not a failure: the author pressed save on something
          // they had not altered, and the right response is the same as a
          // successful save — show them the entry.
          router.push(`/wiki/${encodeURIComponent(slug)}`);
          return;
        case "empty-title":
          setError("An entry needs a title. Add one and save again.");
          return;
        case "not-found":
          // The row was deleted while this tab had it open.
          setError(
            "This entry no longer exists. It may have been deleted in another tab.",
          );
          return;
      }
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={titleId} className="block text-caption text-ink-muted">
        Title
      </label>
      <input
        id={titleId}
        type="text"
        value={title}
        required
        onChange={(event) => setTitle(event.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error === null ? undefined : errorId}
        className="mt-1 mb-4 block w-full rounded-panel border border-rule-soft bg-paper px-2 py-1.5 font-serif text-h2 text-ink"
      />

      {/*
        The hatnote (E11-T9), above the body because that is where it renders.

        Labelled in the author's words rather than in Wikipedia's: "hatnote" is
        a term this project borrows in its class names and its docs, and
        docs/product.md is explicit that the primary author is not a developer.
        The hint says what the line does and — the part nobody would guess —
        that the same line appears by itself when two people share a name, so
        an author does not write one by hand for a job already done.
      */}
      <label className="block text-caption text-ink-muted">
        Note above the entry (optional)
      </label>
      <p id={hatnoteHintId} className="mt-0.5 mb-1 text-note text-ink-muted">
        One line, shown in italics above the first paragraph, for pointing a
        reader somewhere else. Entries about people who share a name already get
        one of these on their own.
      </p>
      <div className="mb-4">
        <EntryEditor
          variant="hatnote"
          label="Note above the entry"
          describedBy={hatnoteHintId}
          initialHtml={initialHatnote}
          onChange={onHatnoteChange}
          entries={entries}
        />
      </div>

      <EntryEditor
        initialHtml={initialHtml}
        onChange={onBodyChange}
        entries={entries}
        initialHeadingIndex={initialHeadingIndex}
      />

      {error === null ? null : (
        <p id={errorId} role="alert" className="mt-3 text-note text-ink">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-4">
        <button
          type="submit"
          disabled={saving}
          className="rounded-panel border border-rule px-4 py-1.5 font-medium transition enabled:hover:bg-panel disabled:cursor-not-allowed disabled:text-ink-muted disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>

        {/*
          A button rather than a link, because leaving is a decision about
          unsaved work and belongs next to the one that keeps it. `replace`
          rather than `push`: the editor should not sit in the history behind
          the entry, waiting for a back button to reopen it.
        */}
        <button
          type="button"
          disabled={saving}
          onClick={() => router.replace(`/wiki/${encodeURIComponent(slug)}`)}
          className="text-note text-link hover:underline disabled:text-ink-muted disabled:no-underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
