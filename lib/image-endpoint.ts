import { IMAGE_ROUTE } from "@/lib/storage-key";

/**
 * The contract between the editor's image button and the upload endpoint
 * (E5-T3, `YEO-43`): the URL, the field name, the shape of a success, and the
 * sentence an author reads when it fails.
 *
 * ## Why a module rather than two ends that happen to agree
 *
 * `lib/import-endpoint.ts` set this pattern for the import screen and quotes
 * `lib/search-endpoint.ts` for the reason, which carries over unchanged: a
 * disagreement between a route handler and the component that calls it "is not
 * a type error, it is a shape that typechecks on both sides and is wrong in
 * the middle". `app/api/images/route.ts` shipped in E5-T2 with `"file"` and
 * the response shape written out as literals because it had no caller; this is
 * that caller arriving, so the literals move here and the route imports them.
 *
 * Everything here is pure and free of `@/db`, `@/auth`, the storage SDK and
 * the DOM, so both ends can import it and `lib/image-endpoint.test.ts` can
 * assert the whole contract against literals in plain Node. It is deliberately
 * **not** `lib/image-upload.ts`: that module owns the endpoint's decisions and
 * reaches `lib/image-metadata.ts`, which is a few hundred lines of Exif
 * surgery that has no business in a browser bundle.
 */

/**
 * Where the image button posts. The same constant the resolving route is
 * mounted at, because `POST /api/images` and `GET /api/images/…` are two
 * halves of one endpoint and a second spelling of the path is a second thing
 * to move.
 */
export const IMAGE_UPLOAD_ENDPOINT = IMAGE_ROUTE;

/** The multipart field holding the picture. */
export const IMAGE_UPLOAD_FIELD = "file";

/**
 * The largest upload accepted, four mebibytes.
 *
 * Not a preference. **A Vercel-hosted function can receive a 4.5 MB request
 * body**, the platform enforces it before this application's code runs, and
 * the only documented way past it is a browser talking to the storage vendor
 * directly — which would put that vendor's SDK in a client bundle and need a
 * fourth function on the seam, both of which this repository fails the build
 * over. The cap sits *under* the ceiling rather than at it, because multipart
 * framing, the field name and the filename all travel in the same body as the
 * file; a cap set at 4.5 MB would be enforced first by the platform, as a
 * bare 413 from an edge that never says what the limit was.
 *
 * It lives in this module rather than in `lib/image-upload.ts`, where E5-T2
 * put it, because E5-T3 made it a number *both* ends need: the endpoint
 * refuses above it, and the browser resizes below it (`lib/image-insert.ts`).
 * A second copy in the client would be a second copy to move.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * What a `201` carries: the key, and the site-relative path that resolves to
 * it.
 *
 * No URL, and that absence is the whole of E5-T2's answer to "what is the
 * stable reference" — see docs/architecture.md#the-storage-seam. `path` is
 * what goes into an entry body; `key` is the durable handle E5-T5's sweep and
 * the full export reason about. The editor uses only `path`, and `key` is
 * here because the endpoint returns it and a contract that describes half a
 * response is a contract somebody will disagree with later.
 */
export interface UploadedImage {
  /** The storage key, `images/<shard>/<uuid>.<ext>`. */
  key: string;
  /** The site-relative path, `/api/images/<shard>/<uuid>.<ext>`. */
  path: string;
  /** The sniffed media type the store will serve the bytes as. */
  contentType: string;
}

/** A field of `value` if it is a non-empty string, otherwise `null`. */
function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read a `201` body, or `null` if it is not one.
 *
 * Parsed rather than cast. The response is JSON off the network, and `as
 * UploadedImage` on a value nobody checked is how a `path` of `undefined`
 * becomes `<img src="undefined">` in a revision that is append-only and can
 * never be edited back.
 */
export function uploadedImageFrom(body: unknown): UploadedImage | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;
  const key = text(record.key);
  const path = text(record.path);
  const contentType = text(record.contentType);
  if (key === null || path === null || contentType === null) return null;

  return { key, path, contentType };
}

/**
 * What to tell the author when an upload does not come back `201`.
 *
 * The endpoint's own refusals are already sentences written for a person —
 * "Images must be 4 MB or smaller.", "That image could not be read. It may be
 * damaged." — and `lib/image-upload.ts` is where they are decided and tested.
 * So the first thing this does is use one if there is one, rather than
 * mapping a status onto a second vocabulary that would drift from the first.
 *
 * The fallbacks are for the answers that carry no JSON at all, and there are
 * exactly two shapes of those:
 *
 * - **`401`**, whose body is the bare string `Unauthorized` from
 *   `requireSessionOr401`. A session that expired while an entry was open is
 *   the realistic cause, and the useful thing to say is what to do about it.
 * - **Anything else** — a `413` from the platform's own edge before this
 *   application's code runs (see `MAX_REQUEST_BYTES`), a `502`, an HTML error
 *   page from a proxy. One sentence that is true of all of them, because a
 *   status code is not something to show somebody writing about their
 *   grandmother.
 */
export function uploadErrorMessage(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const message = text((body as Record<string, unknown>).error);
    if (message !== null) return message;
  }

  if (status === 401) {
    return "Your session has expired. Sign in again, then add the picture.";
  }
  if (status === 413) {
    return "That file is too large.";
  }
  return "That picture could not be uploaded. Try again.";
}
