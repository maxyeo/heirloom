"use client";

import { useId, useRef, useState } from "react";

import { PersonPortrait } from "@/components/PersonPortrait";
import { ImageUploadError, uploadImage } from "@/components/image-upload";
import { DOWNSCALE_BACKGROUND, IMAGE_ACCEPT } from "@/lib/image-insert";
import { portraitSrc } from "@/lib/portrait";
import {
  PORTRAIT_THUMB_MAX_EDGE,
  PORTRAIT_THUMB_TYPE,
  thumbnailSize,
} from "@/lib/portrait-image";

/**
 * Choosing a person's portrait (E5-T4, `YEO-44`).
 *
 * ## What this posts
 *
 * The same shape `components/DateField.tsx` uses, and for the same reason:
 * **the visible control has no `name`**. A `File` is not a column, and the
 * database has no way to hold one. What posts is the two hidden inputs at the
 * bottom of this file, named exactly as the columns are — so
 * `individualInputFromFormData` reads `portraitKey` and `portraitThumbKey`
 * with no knowledge that a canvas was ever involved, and so the person form
 * around this stays one ordinary submission.
 *
 * ## Why the upload happens on pick and not on submit
 *
 * They are two writes with a decision in between. Uploading on submit would
 * fold a 4 MB transfer and its own failure modes into the save, so a
 * photograph the endpoint refused would take the rest of the form down with
 * it — and the author would find out about it after typing everything else.
 * Uploading on pick means a refusal is a message beside the picker, and the
 * form is still exactly as saveable as it was a moment earlier.
 *
 * It also means an abandoned form can leave an uploaded object behind that no
 * row ever references. That is a real cost and it is deliberately not paid
 * for here: it is precisely the case E5-T5's orphan sweep exists to collect,
 * and the alternative — holding the bytes in memory until submit — trades a
 * sweepable file for a form that can fail at the worst possible moment.
 *
 * ## Why the three browser calls are here
 *
 * `createImageBitmap`, `getContext("2d")` and `toBlob` are the whole of the
 * DOM in this feature, and they are in this one function on purpose. Every
 * *decision* around them — the box to draw into, whether the original needs
 * re-encoding at all, whether a thumbnail is worth making — is in
 * `lib/image-scale.ts` and `lib/portrait-image.ts`, which are pure and have
 * tests
 * beside them. jsdom has no canvas, so anything wrapped around those three
 * calls would be code with no test; what is left here has no branches worth
 * one. That is the same split `lib/parse-date.ts` and `DateField` already
 * make.
 */

/** The pair of keys a chosen photograph produces. */
export interface PortraitPair {
  /** The full-resolution image, as stored. */
  portraitKey: string;
  /**
   * Its downscaled copy for the canvas, or null when the original was already
   * small enough to be its own thumbnail. See `thumbnailSize`.
   */
  portraitThumbKey: string | null;
}

export type PreparePortraitResult =
  { ok: true; pair: PortraitPair } | { ok: false; message: string };

/**
 * Turn a chosen file into a stored pair of keys.
 *
 * A type rather than an inlined call so that `PortraitField` can be handed a
 * stub: `npm test` has neither a canvas nor a server, and this is the seam
 * where both live. docs/testing.md's rule — take it, do not import it.
 */
export type PreparePortrait = (file: File) => Promise<PreparePortraitResult>;

/** The quality a thumbnail is written at. */
const THUMB_QUALITY = 0.8;

/**
 * Draw `bitmap` into a canvas of `size` and encode it as a thumbnail.
 *
 * The canvas is filled first, and that is not cosmetic: if `toBlob` falls
 * back to a format with no alpha channel, a PNG portrait with a transparent
 * background would otherwise come out on black. {@link DOWNSCALE_BACKGROUND}
 * rather than a colour of this module's own, because
 * `components/image-upload.ts` is matting images for the same reason two
 * files away and one answer to "what is behind a photograph" is enough.
 *
 * `null` when the browser cannot give a 2D context or cannot encode — an
 * answer rather than a throw, because it is recoverable: the caller stores no
 * thumbnail, the canvas falls back to the full image, and nothing about the
 * photograph is lost.
 */
async function encodeThumbnail(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (context === null) return null;

  context.fillStyle = DOWNSCALE_BACKGROUND;
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);

  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), PORTRAIT_THUMB_TYPE, THUMB_QUALITY),
  );
}

/**
 * The thumbnail for `file`, already stored, or `null` if there is not one to
 * store.
 *
 * Every failure here returns `null` rather than throwing, and that is the
 * rule this function exists to enforce: **a thumbnail is a derived
 * convenience and must never cost the photograph.** A browser with no
 * `createImageBitmap`, a decoder that refuses the file, a canvas the platform
 * will not allocate, a `toBlob` that returns nothing, a second upload that
 * fails — each ends with a portrait stored and no thumbnail, which is a state
 * the schema allows and the canvas handles by loading the full image. Slower
 * for that one person, and correct.
 */
async function storeThumbnail(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  try {
    const box = thumbnailSize(
      { width: bitmap.width, height: bitmap.height },
      PORTRAIT_THUMB_MAX_EDGE,
    );
    // Already thumbnail-sized. Nothing to make, and nothing lost.
    if (box === null) return null;

    const blob = await encodeThumbnail(bitmap, box);
    if (blob === null) return null;

    const uploaded = await uploadImage(
      new File([blob], file.name, { type: blob.type }),
    );
    return uploaded.key;
  } catch {
    return null;
  } finally {
    // Decoded bitmaps hold memory outside the JavaScript heap, which the
    // garbage collector cannot see the size of. A family adding portraits to
    // twenty people in one sitting is twenty full-resolution decodes.
    bitmap.close();
  }
}

/**
 * The real implementation: store the photograph, then its thumbnail.
 *
 * The **portrait is uploaded first**, and the ordering is load-bearing: a
 * failure part-way through can then never leave a thumbnail key with no
 * portrait beside it, which is the one half-pair `validateIndividual`
 * normalises away — silently discarding the upload that did succeed.
 *
 * Shrinking the original when it is too large to send is not done here.
 * `components/image-upload.ts` already does it for the editor, with the
 * limitations that come with it written down in one place (an animated GIF is
 * refused rather than flattened; a forced resize re-encodes as JPEG), and a
 * second implementation of the same three canvas calls is how those two
 * answers start disagreeing. This module asks it for the same thing the
 * editor asks for, and adds only the thumbnail the tree needs.
 */
export const preparePortrait: PreparePortrait = async (file) => {
  let portrait;
  try {
    portrait = await uploadImage(file);
  } catch (error) {
    /**
     * `ImageUploadError` carries a sentence written for a person — usually
     * the endpoint's own. Anything else is a programming fault and is
     * rethrown rather than rendered as advice about a photograph.
     */
    if (error instanceof ImageUploadError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  return {
    ok: true,
    pair: {
      portraitKey: portrait.key,
      portraitThumbKey: await storeThumbnail(file),
    },
  };
};

export interface PortraitFieldProps {
  /** The stored portrait key, or "" for none. Held by the caller. */
  portraitKey: string;
  /** The stored thumbnail key, or "" for none. Held by the caller. */
  portraitThumbKey: string;
  /**
   * A key changed. Called once per key, so the caller's own per-field merge
   * works unchanged — both callers use a functional `setValues`, so two calls
   * in a row compose.
   */
  onChange: (field: "portraitKey" | "portraitThumbKey", value: string) => void;
  /** Whose portrait this is, for the preview's alt text. */
  personName: string;
  /** Prepended to the hidden inputs' names, as everywhere else in the form. */
  namePrefix?: string;
  /** What the server said about these fields, if anything. */
  error?: string;
  disabled?: boolean;
  /** The upload pipeline. Injected by tests; the real one by default. */
  prepare?: PreparePortrait;
}

export function PortraitField({
  portraitKey,
  portraitThumbKey,
  onChange,
  personName,
  namePrefix = "",
  error,
  disabled = false,
  prepare = preparePortrait,
}: PortraitFieldProps) {
  const base = useId();
  const inputId = `${base}-file`;
  const errorId = `${base}-error`;

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Which pick is the current one.
   *
   * Incremented by every pick and by "Remove photograph", and checked again
   * after each `await` — so an upload that is still in flight when the author
   * moves on cannot land on top of what they did next. Without it the winner
   * is whichever `prepare` *settles* last, which is not necessarily the one
   * they chose last: a large photograph picked first can easily finish after
   * a small one picked second, and the form would then hold the abandoned
   * image.
   *
   * The file input is `disabled` while `busy`, and that is what makes this
   * hard to reach through a mouse and a keyboard. It is not the guarantee,
   * though, and `components/GedcomImport.tsx` makes the same distinction in
   * as many words: disabling a control is "a convenience for the ordinary
   * path, not the guard". A counter costs one ref and makes the answer
   * independent of when React happens to commit an attribute.
   */
  const pick = useRef(0);

  /**
   * The preview's `src`.
   *
   * Built from the key by the same function every other portrait in the
   * application uses, so what the author sees before saving is fetched
   * exactly the way the tree will fetch it afterwards — including the session
   * check and the freshly signed URL. A `URL.createObjectURL` of the chosen
   * file would look right and prove nothing.
   */
  const previewSrc = portraitSrc(portraitKey === "" ? null : portraitKey);

  const clear = () => {
    // Supersede anything in flight, so an upload the author has just removed
    // cannot reappear a second later.
    pick.current += 1;
    onChange("portraitKey", "");
    onChange("portraitThumbKey", "");
    setFailure(null);
    setBusy(false);
    // So choosing the same file again still fires a change event.
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  const choose = async (file: File) => {
    const token = (pick.current += 1);
    setBusy(true);
    setFailure(null);
    try {
      const result = await prepare(file);

      // Superseded while this was in flight — by a later pick, or by Remove.
      // Say nothing and change nothing: whatever replaced it is the author's
      // more recent intention.
      if (token !== pick.current) return;

      if (!result.ok) {
        /**
         * A refused pick leaves the record **exactly as it was**, and this is
         * the important line in this component.
         *
         * Clearing both keys here looks like the tidy thing to do and is
         * data loss. The failure happens inside `prepare`, before a single
         * `onChange` has run, so the two keys still hold whatever they held
         * when the form opened — for an edit, a complete and already-saved
         * pair. Emptying them would mean that picking a file that the
         * endpoint refuses, or picking one while the connection is down,
         * silently deletes the photograph the family already had: nothing
         * gates Save on this message, and "that file did not work" does not
         * read as "and your old picture is gone now", so the next thing the
         * author does is save.
         *
         * There is no half-pair to guard against on this path — that is the
         * *success* path's problem, handled below — so leaving the keys
         * alone is both the safe answer and the honest one. The old portrait
         * really is still what is on file, and the preview keeps showing it.
         */
        setFailure(result.message);
        return;
      }

      onChange("portraitKey", result.pair.portraitKey);
      /**
       * An empty string, not the absence of a call. The caller holds these as
       * form values, so "no thumbnail" has to be *written* — leaving the
       * previous portrait's thumbnail in place would pair a new photograph
       * with an old face on the canvas. This is the half-pair that is
       * genuinely reachable, and it is reachable only after a *successful*
       * upload.
       */
      onChange("portraitThumbKey", result.pair.portraitThumbKey ?? "");
    } finally {
      if (token === pick.current) {
        setBusy(false);
        if (fileInput.current !== null) fileInput.current.value = "";
      }
    }
  };

  return (
    <div>
      <span className="block text-h4">Photograph</span>
      <div className="mt-1 flex items-start gap-3">
        <PersonPortrait src={previewSrc} name={personName} size="panel" />
        <div className="min-w-0 flex-1 space-y-2">
          <input
            ref={fileInput}
            id={inputId}
            type="file"
            /**
             * No `name`. The file itself is not a column — what posts is the
             * two hidden inputs below. Same rule as `DateField`'s visible box.
             */
            accept={IMAGE_ACCEPT}
            disabled={disabled || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void choose(file);
            }}
            aria-describedby={(failure ?? error) ? errorId : undefined}
            className="block w-full text-note file:mr-2 file:rounded-panel file:border file:border-rule-soft file:bg-wash file:px-2 file:py-1 file:text-note disabled:cursor-not-allowed disabled:opacity-60"
          />
          {portraitKey === "" ? null : (
            <button
              type="button"
              onClick={clear}
              disabled={disabled || busy}
              className="rounded-panel border border-rule px-2 py-1 text-note hover:bg-wash disabled:cursor-not-allowed disabled:opacity-60"
            >
              Remove photograph
            </button>
          )}
          {busy ? (
            <p className="text-note text-ink-muted" role="status">
              Uploading…
            </p>
          ) : null}
        </div>
      </div>

      {(failure ?? error) ? (
        <p id={errorId} className="mt-1 text-note text-link-new">
          {failure ?? error}
        </p>
      ) : null}

      {/*
        What actually posts. Named exactly as the columns are, so
        `individualInputFromFormData` reads them without knowing this control
        exists — and so the form still submits correctly if JavaScript is
        mid-flight.
      */}
      <input
        type="hidden"
        name={`${namePrefix}portraitKey`}
        value={portraitKey}
      />
      <input
        type="hidden"
        name={`${namePrefix}portraitThumbKey`}
        value={portraitThumbKey}
      />
    </div>
  );
}
