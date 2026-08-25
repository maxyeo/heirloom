"use client";

import { useId, useRef, useState } from "react";

import { PersonPortrait } from "@/components/PersonPortrait";
import { ALLOWED_IMAGE_TYPES } from "@/lib/image-type";
import { scaledTo } from "@/lib/image-scale";
import { PORTRAIT_THUMB_MAX_EDGE, portraitSrc } from "@/lib/portrait";
import {
  PORTRAIT_MAX_EDGE,
  PORTRAIT_THUMB_TYPE,
  portraitNeedsReencoding,
  thumbnailSize,
} from "@/lib/portrait-image";
import { uploadImage } from "@/lib/upload-image";

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

/**
 * The JPEG quality a re-encoded portrait is written at.
 *
 * High enough that a face does not visibly soften, low enough that a phone
 * photograph clears the upload cap with room to spare. It applies only when
 * `portraitNeedsReencoding` says the original cannot be sent as it stands —
 * a file already under both caps is uploaded byte for byte.
 */
const PORTRAIT_QUALITY = 0.85;

/** The quality a thumbnail is written at. */
const THUMB_QUALITY = 0.8;

/**
 * Draw `bitmap` into a canvas of `size` and encode it.
 *
 * The canvas is filled white first, and that is not cosmetic: JPEG has no
 * alpha channel, so a PNG portrait with a transparent background would
 * otherwise come out on black. White is what a photograph printed on paper
 * would have behind it, which is the right guess for a family archive.
 *
 * Deliberately the CSS keyword and **not** `--color-paper`, even though that
 * token is this application's word for white. A design token describes what
 * the interface looks like today; this colour is being baked into a stored
 * file that outlives every restyle, every export and any theme this
 * application might grow. Binding it to a token would mean a dark mode
 * shipped in two years quietly started matting photographs onto charcoal —
 * permanently, in the archive, with nothing to undo it.
 *
 * `null` when the browser cannot give a 2D context or cannot encode — an
 * answer rather than a throw, because both are recoverable: the caller falls
 * back to the original bytes for a portrait, and to no thumbnail at all for a
 * thumbnail, and neither loses the photograph.
 */
async function encode(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  type: string,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (context === null) return null;

  context.fillStyle = "white";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);

  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), type, quality),
  );
}

/**
 * The real implementation: decode, scale, encode, upload twice.
 *
 * The order matters in one place. The **portrait** is uploaded first, and the
 * thumbnail only afterwards, so a failure part-way through can never leave a
 * thumbnail key with no portrait beside it — the one half-pair
 * `validateIndividual` would normalise away, silently discarding the upload
 * that did succeed.
 *
 * A thumbnail that fails to encode or fails to upload is **not** an error.
 * The pair comes back with a null thumbnail, the row records a portrait and
 * no thumbnail, and the canvas falls back to the full image: slower for that
 * one person, and correct. Refusing the whole photograph because its small
 * copy could not be made would be losing the thing the author actually
 * wanted over the thing they never asked for.
 */
export const preparePortrait: PreparePortrait = async (file) => {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A file the browser cannot decode. The endpoint would refuse it too, on
    // its bytes rather than on its name, but saying so here saves the upload.
    return {
      ok: false,
      message: "That file could not be read as an image.",
    };
  }

  try {
    const source = { width: bitmap.width, height: bitmap.height };

    /**
     * The original, downscaled only if it has to be. `lib/image-upload.ts`
     * predicted this: "a recent phone produces 3–12 MB images, so a
     * meaningful share of what a family actually wants to upload will be
     * refused… the fix is to downscale in a canvas before it posts."
     */
    let body: Blob = file;
    if (portraitNeedsReencoding(source, file.size)) {
      const box = scaledTo(source, PORTRAIT_MAX_EDGE);
      const encoded =
        box === null
          ? null
          : await encode(bitmap, box, "image/jpeg", PORTRAIT_QUALITY);
      // A failed re-encode still tries the original: it may be over the
      // dimension cap and under the byte cap, in which case the endpoint
      // accepts it and the only thing lost is some bandwidth.
      if (encoded !== null) body = encoded;
    }

    const uploaded = await uploadImage(body, file.name);
    if (!uploaded.ok) return { ok: false, message: uploaded.message };

    const thumbBox = thumbnailSize(source, PORTRAIT_THUMB_MAX_EDGE);
    if (thumbBox === null) {
      // Already thumbnail-sized. Nothing to make, and nothing lost.
      return {
        ok: true,
        pair: { portraitKey: uploaded.image.key, portraitThumbKey: null },
      };
    }

    const thumb = await encode(
      bitmap,
      thumbBox,
      PORTRAIT_THUMB_TYPE,
      THUMB_QUALITY,
    );
    if (thumb === null) {
      return {
        ok: true,
        pair: { portraitKey: uploaded.image.key, portraitThumbKey: null },
      };
    }

    const uploadedThumb = await uploadImage(thumb, file.name);
    return {
      ok: true,
      pair: {
        portraitKey: uploaded.image.key,
        portraitThumbKey: uploadedThumb.ok ? uploadedThumb.image.key : null,
      },
    };
  } finally {
    // Decoded bitmaps hold memory outside the JavaScript heap, which the
    // garbage collector cannot see the size of. A family adding portraits to
    // twenty people in one sitting is twenty full-resolution decodes.
    bitmap.close();
  }
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
    onChange("portraitKey", "");
    onChange("portraitThumbKey", "");
    setFailure(null);
    // So choosing the same file again still fires a change event.
    if (fileInput.current !== null) fileInput.current.value = "";
  };

  const choose = async (file: File) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await prepare(file);
      if (!result.ok) {
        setFailure(result.message);
        /**
         * Both keys cleared on failure, never one. A half-pair is the state
         * `validateIndividual` normalises away, so leaving a stale portrait
         * beside a failed replacement would show the author their old
         * photograph and save it, which reads as the upload having worked.
         */
        onChange("portraitKey", "");
        onChange("portraitThumbKey", "");
        return;
      }
      onChange("portraitKey", result.pair.portraitKey);
      /**
       * An empty string, not the absence of a call. The caller holds these as
       * form values, so "no thumbnail" has to be *written* — leaving the
       * previous portrait's thumbnail in place would pair a new photograph
       * with an old face on the canvas.
       */
      onChange("portraitThumbKey", result.pair.portraitThumbKey ?? "");
    } finally {
      setBusy(false);
      if (fileInput.current !== null) fileInput.current.value = "";
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
            accept={ALLOWED_IMAGE_TYPES.join(",")}
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
