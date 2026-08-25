import { requireSessionOr401 } from "@/lib/session";
import * as storage from "@/lib/storage";
import { imageKeyFromPath, UnsafeStorageKeyError } from "@/lib/storage-key";

/**
 * The other half of the contract E5-T2 sets: resolving a stored key back to
 * something a browser can fetch (`YEO-42`).
 *
 * `docs/architecture.md#the-storage-seam` says the stable reference an entry
 * body carries is "a site-relative path of this application's own, resolved
 * through `storage.get` per request". This is that resolution. It exists in
 * the same ticket as the upload because the two halves are one decision:
 * returning a key instead of a URL is only a coherent answer if there is
 * somewhere for the key to be turned back into a URL, and because the key
 * validation this ticket owns has no attacker-controlled caller without it —
 * on the upload path the key is minted from a UUID and cannot be steered.
 *
 * ## A redirect, not a proxy
 *
 * The handler answers 302 to a freshly signed URL rather than streaming the
 * bytes back. Proxying would make this application a CDN for its own images:
 * every photograph on a page would become a function invocation holding a
 * connection open while it copies megabytes it has just downloaded. The
 * architecture doc makes the same call for the same reason — `storage.get`
 * returns a URL rather than bytes precisely so the browser can fetch from the
 * storage host directly.
 *
 * What the redirect costs is one extra round trip per image, and what it buys
 * is that the *authorisation* still happens here, in this application, behind
 * `requireSessionOr401()`, while the *bytes* never touch it.
 *
 * ## Why the response must not be cached
 *
 * The URL being redirected to expires fifteen minutes after it is minted. A
 * cached 302 would outlive its own target and serve a dead link out of the
 * browser cache long after a reload would have fixed it — the one failure
 * mode a signed URL introduces, arrived at by caching the thing that exists
 * to be re-signed. `no-store` is what keeps "reload and it works" true.
 */
export async function GET(
  _request: Request,
  /**
   * Typed by hand rather than with the `RouteContext<'/api/images/[...key]'>`
   * helper the Next docs recommend. That helper is a *generated* global,
   * written into `.next/types` by `next dev`/`next build`, and `npm run
   * typecheck` runs `tsc --noEmit` on a clean checkout where no `.next`
   * exists — so the recommended form typechecks locally, after a build, and
   * fails in CI.
   */
  context: { params: Promise<{ key: string[] }> },
) {
  const { response } = await requireSessionOr401();
  if (response) return response;

  const { key: segments } = await context.params;

  let key: string;
  try {
    key = imageKeyFromPath(segments);
  } catch (error) {
    /**
     * The check this ticket owes `lib/storage.ts`, on the one path where the
     * input is a stranger's. Catch-all segments arrive percent-decoded, so
     * `%2e%2e%2f` is already `../` here — which is the whole reason the
     * validation is on the joined key rather than on the URL.
     *
     * A 400 rather than a 404: the request is malformed regardless of what is
     * in the store, and there is nothing to disclose either way, since a key
     * that fails these rules cannot name an object this application ever
     * wrote.
     */
    if (error instanceof UnsafeStorageKeyError) {
      return new Response("Bad request", { status: 400 });
    }
    throw error;
  }

  const stored = await storage.get(key);
  // A missing object is an ordinary answer, not an exception: an entry body
  // outlives the image it references, and revisions are append-only, so a
  // body pointing at something E5-T5 has swept away is expected rather than
  // broken.
  if (!stored) return new Response("Not found", { status: 404 });

  return new Response(null, {
    status: 302,
    headers: { Location: stored.url, "Cache-Control": "private, no-store" },
  });
}
