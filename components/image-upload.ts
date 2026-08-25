import {
  IMAGE_UPLOAD_ENDPOINT,
  IMAGE_UPLOAD_FIELD,
  MAX_UPLOAD_BYTES,
  uploadErrorMessage,
  uploadedImageFrom,
  type UploadedImage,
} from "@/lib/image-endpoint";
import {
  DOWNSCALE_BACKGROUND,
  DOWNSCALE_STEPS,
  DOWNSCALE_TYPE,
  needsDownscale,
  scaleToFit,
  uploadPercent,
} from "@/lib/image-insert";

/**
 * The two things putting a photograph in an entry needs a browser for
 * (E5-T3, `YEO-43`): a canvas, and a request whose progress can be watched.
 *
 * Everything that is a *decision* — which files are pictures, what `alt`
 * should say, whether a file has to be shrunk and to what size — is in
 * `lib/image-insert.ts` and is tested with no DOM at all. What is left here is
 * the part that could not be: `createImageBitmap`, a 2D context, and an
 * `XMLHttpRequest`. It is a module rather than lines inside `EntryEditor`
 * because the editor is already nine hundred lines and because a test can
 * replace `XMLHttpRequest` around it, which is the same act as
 * `components/SearchBox.test.tsx` replacing `fetch` — the seam is stubbed and
 * everything on this side of it is real.
 *
 * ## Why `XMLHttpRequest` and not `fetch`
 *
 * Because of the acceptance criterion "progress indication for large files on
 * slow connections", and there is no way to satisfy it with `fetch`.
 * `fetch` reports nothing about a request body as it goes out; the streaming
 * request bodies that would let it are Chromium-only and refuse to run over
 * HTTP/1.1. `XMLHttpRequest.upload` has fired `progress` events in every
 * browser for fifteen years. This is the one place in the repository that
 * reaches for it, and the reason is that specific.
 *
 * A progress bar is not decoration here. The cap is 4 MB and a family
 * uploading a scan on a rural connection is looking at the better part of a
 * minute with nothing happening on screen, which is indistinguishable from
 * the button not having worked.
 */

/**
 * An upload that failed for a reason worth showing the author.
 *
 * Its `message` is already a sentence written for a person — usually the
 * endpoint's own, since `lib/image-upload.ts` writes those and tests them.
 * A named class rather than a bare `Error` so the caller can tell it from a
 * programming mistake, and so an `AbortError` (which is a `DOMException`, and
 * is not a failure) never lands in the same branch.
 */
export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

export interface UploadImageOptions {
  /**
   * How far along the request body is, 0–100, or `null` when the browser
   * cannot measure it. Called at least once before anything is sent, so a
   * caller can render a bar rather than waiting for the first event.
   */
  onProgress?: (percent: number | null) => void;
  /** Abort in flight — an editor unmounting mid-upload. */
  signal?: AbortSignal;
}

/**
 * Put `file` in the store, shrinking it first if it is too large to send.
 *
 * @throws {ImageUploadError} with a sentence to show the author
 * @throws {DOMException} `AbortError` if `signal` aborts — not a failure, and
 *   the caller should render nothing for it
 */
export async function uploadImage(
  file: File,
  options: UploadImageOptions = {},
): Promise<UploadedImage> {
  options.signal?.throwIfAborted();

  // Reported before the resize as well as during the request, because the
  // resize is itself a wait — a 12 MB photograph decodes and re-encodes in a
  // second or two on a phone — and a bar that appears only afterwards leaves
  // that time looking like nothing happening.
  options.onProgress?.(0);

  const body = needsDownscale(file) ? await downscaleForUpload(file) : file;
  options.signal?.throwIfAborted();

  return post(body, file.name, options);
}

/**
 * `file` re-encoded small enough to post, or `file` itself if that could not
 * be done.
 *
 * Falling back to the original is deliberate. Every way this can fail — a
 * browser with no `createImageBitmap`, a file the decoder rejects, a canvas
 * the platform refuses to allocate for a very large image — ends with the
 * upload being attempted anyway, so the author gets the endpoint's own
 * sentence ("Images must be 4 MB or smaller.") rather than a message about
 * canvases. It is also what keeps a decode failure from swallowing a file
 * that was, say, 4.1 MB and would have been refused with an accurate reason.
 */
async function downscaleForUpload(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    /**
     * `from-image` is what keeps a portrait photograph the right way up. A
     * phone writes its pixels the way the sensor delivered them plus an Exif
     * orientation tag, `lib/image-metadata.ts` deliberately preserves that
     * tag on upload, and `.wiki-body img { image-orientation: from-image }`
     * honours it at the other end (`app/globals.css`). A canvas re-encode is
     * the one point in that chain where the tag is *lost* rather than passed
     * on, because the output is raw pixels with no metadata — so the rotation
     * has to be applied here, or every portrait resized by this function
     * would arrive permanently on its side.
     */
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;
  }

  try {
    let smallest: Blob | null = null;

    for (const step of DOWNSCALE_STEPS) {
      const encoded = await encode(bitmap, step.longestEdge, step.quality);
      if (encoded === null) break;
      if (encoded.size <= MAX_UPLOAD_BYTES) return encoded;
      // Keep the best attempt so far. Every step is smaller than the one
      // before, so this is always the last one that succeeded — and posting
      // it gives a better chance than posting the original, which is larger
      // than everything here by construction.
      smallest = encoded;
    }

    return smallest ?? file;
  } finally {
    // Frees the decoded bitmap now rather than at the next collection. A
    // 48-megapixel photograph is nearly 200 MB of RGBA, and an author adding
    // four pictures in a row should not be holding all four.
    bitmap.close();
  }
}

/** One attempt: draw the bitmap at `longestEdge` and encode it. */
async function encode(
  bitmap: ImageBitmap,
  longestEdge: number,
  quality: number,
): Promise<Blob | null> {
  const target = scaleToFit(bitmap, longestEdge);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  const context = canvas.getContext("2d");
  if (context === null) return null;

  // Painted before the image, because JPEG has no alpha channel and an
  // unpainted canvas is transparent black — so a PNG with a transparent
  // background would arrive with a black one. See `DOWNSCALE_BACKGROUND`.
  context.fillStyle = DOWNSCALE_BACKGROUND;
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(bitmap, 0, 0, target.width, target.height);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, DOWNSCALE_TYPE, quality);
  });
}

/** The request itself. */
function post(
  body: Blob,
  filename: string,
  { onProgress, signal }: UploadImageOptions,
): Promise<UploadedImage> {
  return new Promise<UploadedImage>((resolve, reject) => {
    const form = new FormData();
    // The filename travels and is ignored: the endpoint mints its key from a
    // UUID and takes the extension from the sniffed bytes (`storage-key.ts`).
    // It is sent anyway because a multipart file part without one is unusual
    // enough for a proxy or a host to treat differently.
    form.append(IMAGE_UPLOAD_FIELD, body, filename);

    const request = new XMLHttpRequest();
    request.open("POST", IMAGE_UPLOAD_ENDPOINT);
    // Text rather than `json`, so that a body which is not JSON — the bare
    // `Unauthorized` of an expired session, an HTML error page from a proxy —
    // arrives as something to parse and fail on rather than as a silent
    // `null` indistinguishable from a valid one.
    request.responseType = "text";

    request.upload.addEventListener("progress", (event) => {
      onProgress?.(uploadPercent(event.loaded, event.total));
    });

    request.addEventListener("load", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.responseText) as unknown;
      } catch {
        parsed = undefined;
      }

      if (request.status !== 201) {
        reject(
          new ImageUploadError(uploadErrorMessage(request.status, parsed)),
        );
        return;
      }

      const uploaded = uploadedImageFrom(parsed);
      if (uploaded === null) {
        // A 201 whose body is not the shape the contract names. Something
        // between here and the handler rewrote it; the one thing not to do is
        // put a `src` of `undefined` into an append-only revision.
        reject(
          new ImageUploadError(uploadErrorMessage(request.status, parsed)),
        );
        return;
      }

      onProgress?.(100);
      resolve(uploaded);
    });

    request.addEventListener("error", () => {
      reject(
        new ImageUploadError(
          "The picture could not be sent. Check your connection and try again.",
        ),
      );
    });

    request.addEventListener("timeout", () => {
      reject(
        new ImageUploadError("Sending the picture took too long. Try again."),
      );
    });

    // An abort is not a failure and must not be rendered as one — the same
    // rule `components/SearchBox.test.tsx` exists to hold for the search box.
    // Rejecting with the platform's own `AbortError` is what lets the caller
    // recognise it without this module inventing a second convention.
    request.addEventListener("abort", () => {
      reject(new DOMException("The upload was cancelled.", "AbortError"));
    });

    if (signal) {
      if (signal.aborted) {
        request.abort();
        return;
      }
      signal.addEventListener("abort", () => request.abort(), { once: true });
    }

    request.send(form);
  });
}
