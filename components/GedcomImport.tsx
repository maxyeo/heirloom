"use client";

import { useRef, useState } from "react";

import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
  type ImportDoneResponse,
  type ImportRefusal,
  type ImportResponse,
  isImportDone,
  isImportPreview,
} from "@/lib/import-endpoint";
import type { ImportPreview, ImportWarning } from "@/lib/import-preview";

/**
 * Upload a `.ged`, read what it would do, then decide (E6-T3, `YEO-48`).
 *
 * ## The shape of the screen is the acceptance criterion
 *
 * Three stages, and the middle one is the ticket:
 *
 * 1. Choose a file and ask what is in it.
 * 2. Read the counts, a dozen names, and every warning. **Nothing has been
 *    written.**
 * 3. Import it, or cancel.
 *
 * *Cancel* is not an action that undoes anything — it is the second request
 * never being made. That is why it is safe to offer as a plain button beside
 * the import rather than as a confirmation of its own: there is nothing to
 * roll back, because nothing was started. `app/api/import/route.ts` and
 * `lib/gedcom.purity.test.ts` are the two halves of the proof.
 *
 * The sample of names is doing more work than it looks like. Counts tell a
 * reader the file parsed; names tell them *whose* file it is, which is the
 * question somebody who has just picked the wrong `.ged` out of a folder of
 * six actually needs answered.
 *
 * ## Why `fetch` rather than a form action
 *
 * Everything else in this application that writes is a `"use server"` action
 * behind a `<form>`, which works before JavaScript loads. This one cannot be:
 * a Server Action's request body is capped at 1 MB by default, and raising
 * `serverActions.bodySizeLimit` raises it for every action in the application
 * to accommodate one. A route handler gets the platform's whole 4.5 MB, and
 * `app/api/images/route.ts` already established the precedent for uploads.
 *
 * The cost is honest and small: a browser with no JavaScript posting this
 * form would navigate to a page of JSON. So the form has no `action`, and the
 * button is the only way in.
 *
 * ## Why the file is uploaded twice
 *
 * Once to preview, once to import, and the second carries the digest of the
 * first. See `lib/import-endpoint.ts` — a serverless function keeps nothing
 * between requests, and the alternative (stashing the parsed file server-side
 * under a token) needs somewhere to stash it and something to clean up after
 * every cancelled import.
 */
export function GedcomImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [imported, setImported] = useState<ImportDoneResponse | null>(null);
  const [refusal, setRefusal] = useState<ImportRefusal | null>(null);
  const [cancelled, setCancelled] = useState(false);

  /**
   * A new file makes every answer on the screen stale at once — the preview
   * describes the old bytes and so does the digest under the import button.
   * Clearing them together is what stops the reader from approving one file's
   * counts for another file's contents.
   */
  function chooseFile(chosen: File | null) {
    setFileName(chosen?.name ?? null);
    setPreviewed(null);
    setImported(null);
    setRefusal(null);
    setCancelled(false);
    // Whatever is in flight is about the old file and will be discarded when
    // it lands (see `stale`), so the screen should stop saying it is working.
    setBusy(null);
  }

  /**
   * Whether an answer that has just arrived is about a file the reader has
   * since moved on from.
   *
   * A request takes as long as it takes and a file input can be changed while
   * it is out. Without this, choosing a second file during a slow preview
   * leaves the *first* file's counts on screen under the second file's name —
   * which is the one confusion this whole screen exists to prevent. Nothing
   * unsafe could come of it, because the confirming request re-reads the live
   * input and the endpoint's digest check refuses a mismatch; but "nothing
   * unsafe" is not the bar for a screen whose job is to be believed.
   */
  function stale(chosen: File): boolean {
    return inputRef.current?.files?.[0] !== chosen;
  }

  async function post(body: FormData): Promise<ImportResponse> {
    let response: Response;
    try {
      response = await fetch(IMPORT_ENDPOINT, { method: "POST", body });
    } catch {
      return { error: UNREACHABLE };
    }

    try {
      return (await response.json()) as ImportResponse;
    } catch {
      // An answer with no JSON in it. The one that actually happens is the
      // guard's bare `401` body after a session has expired mid-visit, and
      // telling that reader to check their connection would send them looking
      // in the wrong place entirely.
      return { error: response.status === 401 ? SIGNED_OUT : UNREADABLE };
    }
  }

  async function preview() {
    const chosen = inputRef.current?.files?.[0];
    if (!chosen || busy) return;

    setBusy("reading");
    setImported(null);
    setRefusal(null);
    setCancelled(false);

    const body = new FormData();
    body.set(IMPORT_FILE_FIELD, chosen);
    const answer = await post(body);
    if (stale(chosen)) return;

    setBusy(null);
    if (isImportPreview(answer)) {
      return setPreviewed({
        name: chosen.name,
        digest: answer.digest,
        preview: answer.preview,
      });
    }

    // An import in answer to a request that carried no confirmation. Nothing
    // produces this and nothing should — the branch exists so that the day
    // something does, the reader is told their tree changed rather than shown
    // an empty screen.
    if (isImportDone(answer)) return setImported(answer);

    setRefusal(answer);
  }

  async function confirm() {
    const chosen = inputRef.current?.files?.[0];
    if (!chosen || !previewed || busy) return;

    setBusy("importing");
    setImported(null);
    setRefusal(null);

    const body = new FormData();
    body.set(IMPORT_FILE_FIELD, chosen);
    // The digest of the bytes that produced the preview above. The endpoint
    // recomputes it from the file in this very request and refuses if the two
    // disagree, so a confirmation can only ever confirm what was read.
    body.set(IMPORT_CONFIRM_FIELD, previewed.digest);
    const answer = await post(body);
    if (stale(chosen)) return;

    setBusy(null);
    // A preview here would mean the endpoint declined to treat this as a
    // confirmation. It does not today, and showing the newer reading rather
    // than casting it to a refusal is the honest thing to do if it ever does.
    if (isImportPreview(answer)) {
      return setPreviewed({
        name: chosen.name,
        digest: answer.digest,
        preview: answer.preview,
      });
    }

    if (isImportDone(answer)) {
      // The preview goes with it. It described a decision that has now been
      // made, and leaving "what this file would add" on screen beside what it
      // did add is two answers to one question.
      setPreviewed(null);
      return setImported(answer);
    }

    setRefusal(answer);
  }

  /**
   * Cancelling. No request is sent, and the input is emptied through the DOM
   * so that picking the same file again re-fires `onChange` — a file input
   * whose value is unchanged reports nothing, and the reader would be left
   * pressing a button that had already forgotten their file.
   */
  function cancel() {
    if (inputRef.current) inputRef.current.value = "";
    setFileName(null);
    setPreviewed(null);
    setImported(null);
    setRefusal(null);
    setCancelled(true);
  }

  return (
    <div className="mt-4">
      <div className="rounded-panel border border-rule bg-panel p-3">
        <label htmlFor="gedcom" className="block text-caption">
          Choose a GEDCOM file
        </label>
        <input
          ref={inputRef}
          id="gedcom"
          type="file"
          name={IMPORT_FILE_FIELD}
          accept=".ged,.gedcom"
          onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-caption file:mr-3 file:rounded-panel file:border file:border-rule file:bg-paper file:px-2 file:py-1 file:text-note"
        />
        <p className="mt-1 text-note text-ink-muted">
          Nothing is written until you have read what the file contains and said
          so.
        </p>

        <button
          type="button"
          onClick={preview}
          disabled={fileName === null || busy !== null}
          className="mt-3 rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash disabled:opacity-60"
        >
          {busy === "reading" ? "Reading…" : "Preview this file"}
        </button>
      </div>

      {/*
        One live region for every transient answer, so a reader using a screen
        reader hears the outcome of the button they just pressed without
        having to go looking for where it landed.
      */}
      <div aria-live="polite">
        {busy === "reading" ? (
          <p className="mt-3 text-caption text-ink-muted">
            Reading {fileName}. Nothing has been written.
          </p>
        ) : null}

        {busy === "importing" ? (
          <p className="mt-3 text-caption text-ink-muted">
            Importing {fileName}. It lands whole or not at all, so nothing is
            written until this finishes.
          </p>
        ) : null}

        {cancelled ? (
          <p className="mt-3 text-caption">
            Cancelled. Nothing was imported and the tree is unchanged.
          </p>
        ) : null}
      </div>

      {refusal ? <Refusal refusal={refusal} /> : null}

      {imported ? (
        <section className="mt-4">
          <h2>What was imported</h2>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
            <Count label="People" value={imported.written.people} />
            <Count label="Unions" value={imported.written.unions} />
            <Count label="Children" value={imported.written.children} />
          </dl>
        </section>
      ) : null}

      {previewed ? (
        <section className="mt-4">
          <h2>What this file would add</h2>
          <p className="text-caption text-ink-muted">{previewed.name}</p>

          <PreviewBody preview={previewed.preview} />

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
            <button
              type="button"
              onClick={confirm}
              disabled={busy !== null}
              className="rounded-panel border border-rule bg-wash px-3 py-1 text-note font-medium hover:bg-paper disabled:opacity-60"
            >
              {busy === "importing"
                ? "Importing…"
                : `Import ${countable(previewed.preview.counts.people, "person", "people")}`}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy !== null}
              className="rounded-panel border border-rule px-3 py-1 text-note hover:bg-wash disabled:opacity-60"
            >
              Cancel
            </button>
            <span className="text-note text-ink-muted">
              Cancelling sends nothing at all.
            </span>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** The file that was read, and the answer it produced. */
type Previewed = { name: string; digest: string; preview: ImportPreview };

type Busy = null | "reading" | "importing";

/** When `fetch` itself failed — the request never reached the application. */
const UNREACHABLE =
  "The file could not be sent. Check the connection and try again — nothing was written.";

/** When the answer was a `401`, which means the session ran out mid-visit. */
const SIGNED_OUT =
  "You have been signed out. Sign in again and try once more — nothing was written.";

/** Any other answer with no JSON in it, which nothing is expected to produce. */
const UNREADABLE =
  "The answer could not be read. Try again — nothing was written.";

/**
 * A refusal, including the one that is not the reader's fault.
 *
 * `role="alert"` because it appears after a button the reader is watching and
 * is the only thing on screen that changed — the convention
 * `components/PersonRemoval.tsx` set for its own failures.
 */
function Refusal({ refusal }: { refusal: ImportRefusal }) {
  return (
    <p
      role="alert"
      className="mt-3 rounded-panel border border-rule-soft bg-panel px-3 py-2 text-caption"
    >
      {refusal.error}
    </p>
  );
}

/** The preview itself: counts, names, warnings, and what is being left behind. */
function PreviewBody({ preview }: { preview: ImportPreview }) {
  const { counts, found, refused } = preview;

  return (
    <>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
        <Count label="People" value={counts.people} />
        <Count label="Unions" value={counts.unions} />
        <Count label="Children" value={counts.children} />
      </dl>

      {refused.people > 0 || refused.unions > 0 ? (
        <p className="mt-1 text-caption">
          {describeRefused(found, refused)} Every one of them is in the warnings
          below.
        </p>
      ) : null}

      {preview.misdeclaredEncoding ? (
        <p className="mt-1 text-caption">
          The file says it is {preview.misdeclaredEncoding} and its own bytes
          say it is {preview.encoding}. It was read as {preview.encoding} —
          check the accented names below.
        </p>
      ) : null}

      {preview.sample.length > 0 ? (
        <>
          <h3 className="mt-3 text-note text-ink-muted">
            {preview.sample.length < counts.people
              ? `The first ${preview.sample.length} names, in the order the file lists them`
              : "Everybody in the file"}
          </h3>
          <ul className="text-caption">
            {preview.sample.map((name, index) => (
              // The index is the key because a tree can genuinely hold two
              // people with the same name, and the sample is a fixed list
              // that is never reordered or filtered.
              <li key={index}>{name}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-caption">
          There is nobody in this file. If you expected a family tree, this is
          probably not the right file.
        </p>
      )}

      {preview.warnings.length > 0 ? (
        <>
          <h3 className="mt-4 text-note text-ink-muted">Warnings</h3>
          <ul className="space-y-2">
            {preview.warnings.map((warning) => (
              <WarningGroup key={warning.kind} warning={warning} />
            ))}
          </ul>
        </>
      ) : null}

      {preview.unknownTags.length > 0 ? (
        <>
          {/*
            Its own heading, well away from the warnings, because
            `lib/gedcom-report.ts` is right that these are two different
            things: an unknown tag is a scope statement rather than a fault.
            Somebody deciding whether to import wants to know they are leaving
            their source citations behind — and wants it not to look like
            1,842 errors.
          */}
          <h3 className="mt-4 text-note text-ink-muted">
            In the file, with nowhere to put it
          </h3>
          <p className="text-caption text-ink-muted">
            {countable(preview.unknownTagOccurrences, "tag", "tags")} this
            application does not read. Nothing is wrong with them; they are
            simply outside what it records.
          </p>
          <ul className="text-caption">
            {preview.unknownTags.map((tag) => (
              <li key={tag.path}>
                <code>{tag.path}</code> — {tag.count}
                {tag.count === 1 ? " time" : " times"}, first at line{" "}
                {tag.firstLine}
              </li>
            ))}
            {preview.unknownTagTotal > preview.unknownTags.length ? (
              <li className="text-ink-muted">
                and {preview.unknownTagTotal - preview.unknownTags.length} more
                kinds
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-note text-ink-muted">{label}</dt>
      <dd className="text-h2 font-serif">{value}</dd>
    </div>
  );
}

/**
 * One warning group: the count, then the first few of them.
 *
 * The examples carry the parser's and the mapper's own sentences, unchanged
 * and with their line numbers. Those were written for the person holding the
 * file — "12/03/1890 could mean March or December" — and rewriting them here
 * would give one problem two spellings on one screen.
 */
function WarningGroup({ warning }: { warning: ImportWarning }) {
  return (
    <li>
      <p className="text-caption">
        <strong className="font-medium">{warning.label}</strong> —{" "}
        {warning.count}
      </p>
      <ul className="text-note text-ink-muted">
        {warning.examples.map((example, index) => (
          <li key={index}>
            {example.line > 0 ? `Line ${example.line}: ` : null}
            {example.message}
          </li>
        ))}
        {warning.count > warning.examples.length ? (
          <li>and {warning.count - warning.examples.length} more</li>
        ) : null}
      </ul>
    </li>
  );
}

/** "148 of 152 people" — assembled from the halves that are actually true. */
function describeRefused(
  found: ImportPreview["found"],
  refused: ImportPreview["refused"],
): string {
  const parts: string[] = [];
  if (refused.people > 0) {
    parts.push(
      `${countable(refused.people, "person", "people")} of ${found.people}`,
    );
  }
  if (refused.unions > 0) {
    parts.push(
      `${countable(refused.unions, "union", "unions")} of ${found.unions}`,
    );
  }

  return `${parts.join(" and ")} cannot be imported and would be left out.`;
}

/** "1 person", "3 people". */
function countable(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}
