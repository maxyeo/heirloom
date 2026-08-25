/**
 * The browser's half of `POST /api/images` (E5-T4, `YEO-44`).
 *
 * ## Why a `fetch` and not a form action
 *
 * The same answer `components/GedcomImport.tsx` gives for its own upload: a
 * server action would have to carry the file through React's action
 * serialisation, and what comes back here is not a page transition but a
 * *value* — a storage key that a hidden input then holds until the person
 * form around it is submitted. The upload and the save are two separate
 * writes with an author's decision in between, and pretending they are one
 * would mean uploading on submit, where a rejected photograph would take the
 * rest of the form's error handling with it.
 *
 * ## Why the endpoint's own words are passed through
 *
 * `app/api/images/route.ts` already writes its refusals as sentences for a
 * person to read — "That file is too large.", "Images must be one of: …" —
 * and it is the half that knows *why* a file was refused. Restating them here
 * would be a second copy free to drift, and a worse one, since this side does
 * not sniff the bytes. So a 4xx body's `error` is the message, and the only
 * sentences written here are for the cases the endpoint cannot answer at all:
 * it was unreachable, or it said something that was not JSON.
 *
 * ## Why `fetch` is a parameter
 *
 * So the tests are tests. `npm test` has no server, and a suite that mocked
 * the global would be asserting against its own mock — a stub passed in is
 * the same thing said honestly, and it is the shape docs/testing.md keeps
 * recommending: take it, do not import it.
 *
 * This module names no storage vendor and no host. It posts to a path of this
 * application's own (`IMAGE_ROUTE`), which is the only address a browser is
 * ever given for an image — see `docs/architecture.md#the-storage-seam`.
 */

import { IMAGE_ROUTE } from "./storage-key";

/** What the endpoint answers with on success. */
export interface UploadedImage {
  /** The durable handle. Persist this. */
  key: string;
  /** The site-relative path that resolves it, for an `<img src>`. */
  path: string;
  /** The type the bytes actually are, as the endpoint sniffed them. */
  contentType: string;
}

export type UploadImageResult =
  { ok: true; image: UploadedImage } | { ok: false; message: string };

/**
 * The field name the endpoint reads the file out of.
 *
 * `app/api/images/route.ts` refuses anything else by name — "Expected a file
 * in a field named 'file'." — so the two halves agree here or the upload
 * fails on every attempt.
 */
const FILE_FIELD = "file";

/**
 * Whether a value read out of a JSON body is a string.
 *
 * The response is parsed, not trusted. A body that is JSON but not the shape
 * this expects is the same class of problem as a body that is not JSON, and
 * both have to end as a message rather than as an `undefined` written into a
 * column.
 */
function stringField(body: unknown, name: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

/**
 * Upload one image and get back the key it was stored under.
 *
 * @param blob the bytes to store — the file the author chose, or a downscaled
 *   copy of it (`lib/image-scale.ts`)
 * @param filename what to call it in the multipart body. The endpoint does
 *   not use it: the stored key is minted from a UUID and the extension comes
 *   from the sniffed type, precisely so that nothing an author's filesystem
 *   says reaches the store (`lib/storage-key.ts`). It is here because a
 *   `FormData` file part is required to have one.
 * @param fetchImpl the `fetch` to use; the global one by default
 */
export async function uploadImage(
  blob: Blob,
  filename = "upload",
  fetchImpl: typeof fetch = fetch,
): Promise<UploadImageResult> {
  const form = new FormData();
  form.append(FILE_FIELD, blob, filename);

  let response: Response;
  try {
    response = await fetchImpl(IMAGE_ROUTE, { method: "POST", body: form });
  } catch {
    // A dropped connection, an offline tab, a request the browser aborted.
    // None of them says anything about the photograph.
    return {
      ok: false,
      message: "That photograph could not be uploaded. Check your connection.",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      message:
        stringField(body, "error") ??
        "That photograph could not be uploaded. Try again.",
    };
  }

  const key = stringField(body, "key");
  const path = stringField(body, "path");
  const contentType = stringField(body, "contentType");
  if (key === null || path === null || contentType === null) {
    /**
     * A 2xx whose body is not the contract. Reported as a failure rather than
     * written through, because the value this function exists to produce is a
     * key that will be persisted — and a half-read success would put
     * `undefined` in a column that something later renders as a URL.
     */
    return {
      ok: false,
      message: "That photograph could not be uploaded. Try again.",
    };
  }

  return { ok: true, image: { key, path, contentType } };
}
