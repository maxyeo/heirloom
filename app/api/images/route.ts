import { MAX_REQUEST_BYTES, prepareUpload } from "@/lib/image-upload";
import { requireSessionOr401 } from "@/lib/session";
import * as storage from "@/lib/storage";
import { imagePath } from "@/lib/storage-key";

/**
 * The upload endpoint (E5-T2, `YEO-42`).
 *
 * Deliberately thin. Every decision an upload involves — the size cap, the
 * allowlist, reading the type off the bytes, taking the location out, minting
 * a key and refusing an unsafe one — is in `lib/image-upload.ts`, which is a
 * function from bytes to a verdict and is tested as one. What is left here is
 * the part that can only exist in a route: the session guard, the multipart
 * form, and the two lines that talk to the store.
 *
 * ## What comes back, and what does not
 *
 * A `key` and a site-relative `path`, and **never a storage URL**. The store
 * is private (`YEO-86`) and `lib/storage.ts` hands out signed URLs that stop
 * working fifteen minutes after they are minted, so a URL from this endpoint
 * would be a credential with a timer on it — fine in an `<img src>` being
 * rendered right now, catastrophic in an entry body, a `revisions` row or a
 * portrait column, all three of which outlive the afternoon and the last of
 * which is append-only and could never be edited back.
 *
 * `put` returns such a URL. This handler drops it on the floor, on purpose:
 * the caller that needs a URL is the one rendering the page, and it gets a
 * fresh one from `GET /api/images/…` at the moment it renders. See
 * `docs/architecture.md#the-storage-seam`.
 */
export async function POST(request: Request) {
  const { response } = await requireSessionOr401();
  if (response) return response;

  /**
   * Refused before the body is read, and only ever refused — `Content-Length`
   * is the client's own claim about a body it has not sent yet, so it can
   * decide to say no early and can never be allowed to say yes. The real cap
   * is enforced on the bytes.
   *
   * It is a courtesy, not a backstop. A chunked request carries no
   * `Content-Length` at all, and `formData()` below would buffer whatever
   * arrives before any cap of this application's could apply; what actually
   * bounds that is the host's own request limit, which on Vercel is the
   * 4.5 MB ceiling `MAX_UPLOAD_BYTES` already sits under. A host without one
   * would need this enforced while reading the stream instead.
   */
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return Response.json({ error: "That file is too large." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected a multipart form upload." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return Response.json(
      { error: "Expected a file in a field named 'file'." },
      { status: 400 },
    );
  }

  /**
   * `file.size` is not checked here, and its absence is deliberate rather
   * than an oversight: `formData()` above has already read and buffered the
   * whole body, so a check between the two would save nothing but a copy of
   * something already in memory. The cap that matters is applied to the bytes
   * that reach the store, where it can be tested without a `Request`.
   */
  const prepared = prepareUpload(new Uint8Array(await file.arrayBuffer()));
  if (!prepared.ok) {
    return Response.json(
      { error: prepared.message },
      { status: prepared.status },
    );
  }

  /**
   * The content type is the sniffed one, so the type the store serves the
   * object as is the type its bytes actually are. Passing the browser's claim
   * through would put a file the allowlist rejected one `Content-Type` header
   * away from being served as one it accepted.
   *
   * A `Blob` rather than the `Uint8Array`: `lib/storage.ts` takes the four
   * web-standard body shapes any host's SDK can accept, and a typed array is
   * not one of them.
   */
  const stored = await storage.put(prepared.key, new Blob([prepared.body]), {
    contentType: prepared.contentType,
  });

  return Response.json(
    {
      key: stored.key,
      path: imagePath(stored.key),
      contentType: prepared.contentType,
    },
    { status: 201 },
  );
}
