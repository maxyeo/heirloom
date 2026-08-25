import { MAX_UPLOAD_BYTES } from "@/lib/image-endpoint";
import {
  stripLocation,
  UnreadableImageError,
  type ImageBytes,
} from "@/lib/image-metadata";
import {
  ALLOWED_IMAGE_TYPES,
  sniffImageType,
  type ImageType,
} from "@/lib/image-type";
import { newImageKey } from "@/lib/storage-key";

/**
 * Every decision the upload endpoint makes, taken away from the endpoint
 * (E5-T2, `YEO-42`).
 *
 * ## Why this is not just the body of the route handler
 *
 * A route handler is the hardest thing in this repository to test. It reaches
 * `@/lib/session`, which reaches `@/auth`, which calls `NextAuth()` at import
 * time and does not load outside the Next.js runtime — so a test of the
 * handler starts by mocking the module that holds the security boundary, and
 * everything it then asserts is asserted about a mocked-out world.
 *
 * `docs/testing.md` has the answer already and states it as a rule: a module
 * that takes a plain value and returns one needs no fixtures and no mocking.
 * So the endpoint's decisions — the cap, the allowlist, the scrub, the minted
 * key — live here, as a function from bytes to a verdict, and every
 * acceptance criterion except the session guard is tested against the real
 * implementation with nothing stubbed at all.
 *
 * What is left in `app/api/images/route.ts` is the wiring: require a session,
 * pull the file out of the form, call this, hand the result to the store.
 *
 * ## The cap, and the ceiling above it
 *
 * The size limit is not a preference. **A Vercel-hosted function can receive
 * a 4.5 MB request body**, and the platform enforces it before this
 * application's code runs — the storage vendor's own README says so, and
 * names client-side direct upload as the only way past it.
 *
 * That escape hatch is closed here by a decision made deliberately elsewhere:
 * client upload means a browser bundle importing the storage vendor's SDK,
 * which `lib/storage.call-sites.test.ts` fails the build over, and routing it
 * through the seam instead would need a fourth exported function, which
 * `lib/storage.test.ts` fails the build over. Both of those tripwires are
 * protecting the portability claim in `docs/architecture.md`, and neither is
 * wrong to. So: uploads come through this endpoint, and they are small.
 *
 * {@link MAX_UPLOAD_BYTES} is set *under* the platform ceiling rather than at
 * it, because multipart framing, the field name and the filename all travel
 * in the same body as the file. A cap set at 4.5 MB would be a cap the
 * platform enforced first, as a bare 413 from an edge this code never
 * reaches, with no message saying what the limit is.
 *
 * **What this means for a phone photograph**, said plainly because the next
 * ticket needed to know: a recent phone produces 3–12 MB images, so a
 * meaningful share of what a family actually wants to upload would be
 * refused. The fix is not a larger cap — there is no larger cap available —
 * it is for E5-T3's image button to downscale in a canvas before it posts,
 * which `lib/image-insert.ts` now does. That has a useful side effect worth
 * recording: a canvas re-encode bakes the rotation into the pixels and drops
 * every metadata block, so for that path the work below is belt and braces.
 * For everything else — a `curl`, a future import, a browser whose canvas
 * threw and fell back to posting the original — it is the only thing standing
 * between a home address and a storage host.
 *
 * {@link MAX_UPLOAD_BYTES} itself now lives in `lib/image-endpoint.ts`, with
 * the rest of what the two ends of this wire have to agree about: the browser
 * has to know the cap in order to resize under it, and it cannot import this
 * module to learn it — `lib/image-metadata.ts` is a few hundred lines of Exif
 * surgery with no business in a browser bundle.
 */

/**
 * The largest request body worth buffering.
 *
 * A courtesy check the route makes against `Content-Length` before it reads
 * anything, and the only check in this file that can refuse an upload without
 * holding it in memory first. It is set above {@link MAX_UPLOAD_BYTES}
 * because a multipart body carries the boundary, a field name and a filename
 * alongside the file, and a header that only ever *rejects* must never reject
 * something the real check would have accepted.
 *
 * It is not a defence. `Content-Length` is written by the client and is
 * absent entirely under chunked encoding, so it can be lied about or omitted;
 * what stops an unbounded body is the host's own request limit, which on
 * Vercel is the 4.5 MB ceiling this cap already sits under. This just turns
 * the obvious mistake — someone posting a video — into an immediate answer
 * rather than a wait.
 */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

/**
 * An upload that survived every check, ready for `lib/storage.ts`.
 *
 * `contentType` is the **sniffed** type, and the uploaded part's own
 * `Content-Type` appears nowhere in this module — not as a fallback, not as
 * a hint. A fallback is how this decays: it works for every honest client, so
 * nothing goes red, and the allowlist quietly becomes a check on a claim.
 */
export interface AcceptedUpload {
  ok: true;
  /** The minted storage key. Owes nothing to the upload; see `lib/storage-key.ts`. */
  key: string;
  /** What the bytes actually are, and what the store will serve them as. */
  contentType: ImageType;
  /** The bytes to store: the upload with its location metadata removed. */
  body: ImageBytes;
}

/**
 * An upload that did not, carrying the status the route should answer with.
 *
 * The status lives here rather than in the handler so that "too large is a
 * 413 and the wrong format is a 415" is a decision with a test on it, rather
 * than a `switch` in a file no test can load.
 */
export interface RejectedUpload {
  ok: false;
  status: 400 | 413 | 415;
  message: string;
}

/**
 * Decide what to do with `bytes`, in the order that reveals least.
 *
 * Size first: it is the cheapest check and the only one that can be made
 * without looking at the contents at all, and an oversized file should be
 * refused rather than parsed. Type next, so that nothing but a known image
 * format is ever handed to the scrubber. Then the scrub, then the key.
 */
export function prepareUpload(
  bytes: ImageBytes,
): AcceptedUpload | RejectedUpload {
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, message: "The file is empty." };
  }

  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `Images must be ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB or smaller.`,
    };
  }

  const contentType = sniffImageType(bytes);
  if (contentType === null) {
    return {
      ok: false,
      status: 415,
      message: `Images must be one of: ${ALLOWED_IMAGE_TYPES.join(", ")}.`,
    };
  }

  let body: ImageBytes;
  try {
    body = stripLocation(bytes, contentType);
  } catch (error) {
    // The signature matched and the structure did not, which means the file
    // is truncated or damaged. Refusing it is both the safe answer and the
    // true one — the alternative is storing an image whose metadata this
    // code could not account for.
    if (error instanceof UnreadableImageError) {
      return {
        ok: false,
        status: 400,
        message: "That image could not be read. It may be damaged.",
      };
    }
    throw error;
  }

  return { ok: true, key: newImageKey(contentType), contentType, body };
}
