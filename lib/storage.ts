import { BlobNotFoundError, del, head, put as blobPut } from "@vercel/blob";

/**
 * The one seam between this application and whoever stores its files.
 *
 * `docs/architecture.md` claims that image storage is the *only*
 * host-specific dependency and that swapping hosts is a one-file change.
 * That claim is worth exactly as much as its enforcement, so two things are
 * true of this file and nothing else in the repository:
 *
 * 1. It is the only module that imports a storage vendor's SDK. A tripwire
 *    (`lib/storage.call-sites.test.ts`) fails the build if a second one
 *    appears — which is how this decays in practice, one convenient
 *    `import { put } from "@vercel/blob"` in a route handler at a time.
 * 2. Its runtime surface is exactly three functions: `put`, `get`, `delete`.
 *    Every object store in existence has those three; the moment a fourth
 *    (`list`, `copy`, `presign`) is exported, the set of hosts that can
 *    implement this shrinks to the ones that happen to agree with Vercel.
 *
 * The retrofit is what this ticket exists to prevent. Three call sites
 * reaching for `@vercel/blob` directly is not a refactor you do later; it is
 * the point at which the portability claim quietly stops being true.
 *
 * ## Using it
 *
 * Import the namespace, not the individual functions:
 *
 * ```ts
 * import * as storage from "@/lib/storage";
 *
 * const image = await storage.put(key, file, { contentType: file.type });
 * await storage.delete(key);
 * ```
 *
 * `delete` is a reserved word, so it cannot be a *bare* imported binding —
 * `import { delete }` does not parse. (An alias, `import { delete as remove }`,
 * is legal; it just renames the seam at every call site, which is the opposite
 * of what this module is for.) As a property name it is unremarkable, which is
 * what `storage.delete(...)` reads as — the same shape `Map` and `Set` have
 * always had.
 *
 * The namespace import is the house style here for a second reason anyway: it
 * keeps the seam legible at the call site. `storage.put(...)` says where the
 * bytes went; a bare `put(...)` says nothing.
 *
 * ## Server only
 *
 * `STORAGE_TOKEN` is a write credential. Nothing here is safe to pull into a
 * client component, and nothing here needs to be: uploads go through a route
 * handler (E5-T2) and reads go through the URL `get` and `put` return.
 */

/**
 * What can be stored.
 *
 * Deliberately narrower than `@vercel/blob`'s own `PutBody`, and deliberately
 * declared here rather than re-exported from it: a vendor type in this
 * signature would leak into every call site's inference, and swapping hosts
 * would then be a one-file change plus however many files TypeScript decided
 * to disagree with. These four are web-standard shapes that any host's SDK —
 * or a local-filesystem implementation — can accept. `File` is a `Blob`, so
 * the multipart-form case is covered by the third.
 */
export type StorageBody =
  string | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

/**
 * A stored object, as both `put` and `get` describe it.
 *
 * Only fields *every* host can produce, which is why size and upload time are
 * absent: Vercel's `put` response does not carry them, so including them
 * would force `put` and `get` to return different shapes and push the
 * difference out to callers. A seam that promises less is a seam more hosts
 * can keep.
 */
export interface StoredObject {
  /** The key it was stored under — the same string `put` was given. */
  key: string;
  /**
   * Where a browser can fetch it.
   *
   * Returning a URL rather than bytes is the portable choice: every host can
   * produce one, and the alternative (streaming every image back through this
   * application) would make the app a proxy for its own static assets. It is
   * also what lets a later move to short-lived signed URLs stay inside this
   * file — see the note on `access` in `put`.
   */
  url: string;
  /** The media type the object will be served with. */
  contentType: string;
}

export interface PutOptions {
  /**
   * The media type to serve the object with.
   *
   * Optional because a key with an extension implies one, but callers holding
   * an upload should pass it explicitly *after* sniffing the bytes — never
   * the browser's claim. E5-T2 owns that check; this module stores what it is
   * told.
   */
  contentType?: string;
}

/**
 * The credential, resolved per call rather than at import time.
 *
 * `db/index.ts` connects lazily for the same reason: `npm run build` and
 * `npm test` both run in a deliberately empty environment (docs/testing.md),
 * and a module-level read that threw would fail the build for every route
 * that merely imports this file. Failing at the first actual `put` instead
 * keeps the error where it is legible.
 */
function token(): string {
  const value = process.env.STORAGE_TOKEN;
  if (!value) {
    throw new Error(
      "STORAGE_TOKEN is not set. Copy .env.example to .env.local.",
    );
  }
  return value;
}

/**
 * Store `body` at `key`, replacing whatever was there.
 *
 * Overwriting is deliberate. Vercel's SDK defaults to refusing a `put` onto
 * an existing pathname, but "PUT replaces" is what S3, GCS, R2 and a
 * filesystem all do, and a seam whose semantics are one host's opinion is not
 * a seam. Key uniqueness is the caller's business.
 *
 * So is key *shape*, and that is a sharper obligation than it sounds: nothing
 * here rejects a leading slash or a `..` segment. Against a blob store those
 * are merely odd pathnames, but this module exists so that a directory on
 * disk can be the backend one day, and on that day an unvalidated key is a
 * path traversal. E5-T2 owns the upload endpoint and should constrain the
 * keys it mints rather than passing a filename through from a browser.
 *
 * `addRandomSuffix` is pinned off for the property this whole module depends
 * on: the key you write is the key you read. A random suffix would make the
 * stored pathname something only the `put` response knew, and `get(key)`
 * would find nothing.
 *
 * `access: "public"` means the returned URL needs no credential — which is
 * what makes an `<img src>` in an entry body work at all. The URL is
 * unguessable (a random store id plus the key), but it is genuinely outside
 * the `ALLOWED_EMAILS` boundary that guards the rest of the application: a
 * leaked URL is a readable image. That is a stated trade, not an oversight,
 * and the reason it is only a trade is this file — moving to signed,
 * short-lived URLs means changing `put` and `get` here and nothing else.
 */
export async function put(
  key: string,
  body: StorageBody,
  options: PutOptions = {},
): Promise<StoredObject> {
  const result = await blobPut(key, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: options.contentType,
    token: token(),
  });

  return {
    key: result.pathname,
    url: result.url,
    contentType: result.contentType,
  };
}

/**
 * Look up what is stored at `key`, or `null` if nothing is.
 *
 * A missing object is an ordinary answer, not an exception — an entry body
 * can outlive the image it references (E5-T5 deletes orphans; append-only
 * revisions keep pointing at them), so callers will hit this legitimately and
 * should not have to catch a vendor's error class to find out. Every *other*
 * failure — a bad token, a store that is gone, the network — propagates,
 * because those are not "no such object" and must not be flattened into one.
 */
export async function get(key: string): Promise<StoredObject | null> {
  try {
    const result = await head(key, { token: token() });
    return {
      key: result.pathname,
      url: result.url,
      contentType: result.contentType,
    };
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return null;
    }
    throw error;
  }
}

/**
 * Remove whatever is stored at `key`.
 *
 * Idempotent: deleting a key that is not there succeeds. Cleanup jobs
 * (E5-T5) run against a list that was true a moment ago, and a delete that
 * threw on a second pass would turn "already tidy" into a failure.
 */
async function deleteObject(key: string): Promise<void> {
  await del(key, { token: token() });
}

export { deleteObject as delete };
