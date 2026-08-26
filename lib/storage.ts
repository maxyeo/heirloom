import {
  BlobNotFoundError,
  del,
  head,
  issueSignedToken,
  list as blobList,
  presignUrl,
  put as blobPut,
  type IssuedSignedToken,
} from "@vercel/blob";

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
 * 2. Its runtime surface is exactly four functions: `put`, `get`, `delete`,
 *    `list`. Every object store in existence has those four; anything a
 *    fifth would add (`copy`, `rename`, `presign`, a multipart uploader)
 *    shrinks the set of hosts that can implement this to the ones that happen
 *    to agree with Vercel.
 *
 * The retrofit is what this ticket exists to prevent. Three call sites
 * reaching for `@vercel/blob` directly is not a refactor you do later; it is
 * the point at which the portability claim quietly stops being true.
 *
 * ## Why there are four and not three
 *
 * E5-T1 shipped three and said, in this docblock, that a fourth — naming
 * `list` first — would narrow the seam. E5-T5 (`YEO-45`) is the ticket that
 * tested that claim against a real requirement, and it did not survive
 * contact.
 *
 * An orphan is **by definition an object no row names**. The reference graph
 * can only ever confirm what *is* referenced, so no query over `pages`,
 * `revisions` and `individuals` can produce a candidate: the photograph an
 * author uploaded and never saved appears in no body, no revision and no
 * column, and enumeration is the one question only the store can answer. A
 * cleanup that cannot enumerate cannot find anything to clean.
 *
 * The alternative was a ledger table written by `POST /api/images`, which
 * keeps the count at three and is worse. It cannot see an object that was
 * already in the store when it shipped, and a single missed insert leaks that
 * object forever with nothing in the system able to find it again. The store
 * is the ground truth for what is taking up space; a table that shadows it is
 * a second copy that is wrong in the direction nobody checks.
 *
 * So the original reasoning was right in general and too broad about this one
 * function. `copy` and `presign` genuinely differ between hosts — that is why
 * signing stayed *inside* this file when `YEO-86` added it. Enumeration does
 * not: S3's `ListObjectsV2`, GCS, R2, Azure and `readdir` all take a prefix,
 * all paginate, and all report a size and a modification time. `list` was
 * always inside the intersection; it was excluded on a generalisation rather
 * than on an examination.
 *
 * The way to keep this honest is the way `lib/storage.call-sites.test.ts`
 * already prescribes: widen the exported functions deliberately, in this
 * file, and make the assertion in `lib/storage.test.ts` say four. What must
 * never happen is a second module importing the vendor because this one was
 * "missing something".
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
 *
 * ## The URL is short-lived, and that is the point
 *
 * Objects are stored **privately** and every URL this module hands back is a
 * signed one that stops working after {@link URL_TTL_MS}. E5-T1 shipped with
 * `access: "public"` and said so plainly; YEO-86 is the ticket that decided
 * the question it left open, and decided it the other way. The reasoning is
 * in `docs/architecture.md`; the consequence for callers is one sentence:
 *
 * > **`key` is the durable handle. `url` is not — never persist it.**
 *
 * An entry body that embedded one of these would render for fifteen minutes
 * and show a broken image for the rest of that revision's life, and revisions
 * are append-only, so the bad HTML would never be edited away. Store the key,
 * mint the URL at render time. E5-T2's "stable URL" is therefore a
 * site-relative path of this application's own, resolved through `get` per
 * request — the same shape entry-to-entry links already have, and for the
 * same reason: bodies outlive the host they were written on.
 */

/**
 * How long a URL handed out by `put` or `get` remains fetchable.
 *
 * Fifteen minutes, chosen against what the URL actually has to survive rather
 * than against a round number. Its real job is the gap between rendering a
 * page and the browser fetching the image off it — seconds — and everything
 * beyond that is slack for a slow connection, a tab left to load, or somebody
 * opening the picture in its own tab a moment later. A reload re-signs, so
 * nothing user-visible depends on this window being generous.
 *
 * What it deliberately does *not* survive is the leak. A URL sitting in a
 * browser history on a shared machine, pasted into a family chat, carried in
 * a referrer, or synced with a bookmark is the thing this expiry exists to
 * defuse, and every one of those is acted on later than fifteen minutes. The
 * trade is legible in both directions: shortening this costs broken images on
 * bad connections, lengthening it costs exactly the property the store was
 * made private for.
 */
const URL_TTL_MS = 15 * 60 * 1000;

/**
 * How long one delegation is reused before a fresh one is fetched.
 *
 * Signing is two steps and only the first touches the network:
 * `issueSignedToken` asks the Blob control API for delegation material, and
 * `presignUrl` is a local HMAC over it. Issuing per URL would put a round
 * trip in front of every image on a page — a tree of thirty portraits would
 * make thirty control-API calls to render — so the delegation is cached and
 * the per-image cost is the HMAC.
 *
 * An hour is the SDK's own default and well under its seven-day ceiling. It
 * is a cache lifetime rather than a security boundary: the delegation never
 * leaves the server, and what reaches a browser is a finished URL scoped to
 * one pathname and {@link URL_TTL_MS}.
 */
const DELEGATION_TTL_MS = 60 * 60 * 1000;

/**
 * How much delegation life must remain for it to still be worth reusing.
 *
 * A signed URL's expiry is capped to its delegation's, so a delegation with
 * four minutes left would silently hand out four-minute URLs. Retiring one
 * that can no longer cover a full-length URL keeps {@link URL_TTL_MS} meaning
 * what it says, and the extra minute absorbs clock skew and the latency of
 * the request the URL was signed for.
 */
const DELEGATION_FLOOR_MS = URL_TTL_MS + 60 * 1000;

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
  /**
   * The key it was stored under — the same string `put` was given.
   *
   * The durable half of this object, and the only half worth writing down.
   * Anything that needs to refer to this image later — a column, an entry
   * body, a cleanup job's worklist — refers to it by key and asks `get` for a
   * URL at the moment it needs one.
   */
  key: string;
  /**
   * Where a browser can fetch it, for the next {@link URL_TTL_MS} and no
   * longer.
   *
   * Returning a URL rather than bytes is the portable choice: every host can
   * produce one, and the alternative (streaming every image back through this
   * application) would make the app a proxy for its own static assets. A
   * signed URL is how that stays true for a *private* store — the browser
   * still fetches from the storage host directly, through its CDN, rather
   * than through a function.
   *
   * It is a credential with a timer on it, so it belongs in an `<img src>`
   * being rendered right now and in nothing that outlives the response.
   * `key` is the thing that gets stored.
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
 * The delegation in hand or in flight, and the credential it was issued
 * against.
 *
 * A promise rather than a resolved value, so a page rendering thirty images
 * on a cold function issues *one* delegation rather than thirty racing ones.
 * Keyed by the credential because `STORAGE_TOKEN` can change underneath a
 * running process — rotated in a deploy environment, stubbed per test — and a
 * delegation issued against the previous one would fail in a way that looked
 * like an outage rather than like a rotation.
 */
let cachedDelegation: {
  credential: string;
  issued: Promise<IssuedSignedToken>;
} | null = null;

/**
 * Delegation material for signing read URLs, reused while it has enough life
 * left to be worth reusing.
 *
 * Scoped to the whole store (`pathname: "*"`) and to reads
 * (`operations: ["get"]`). The wildcard is what lets one delegation cover
 * every image, and it costs nothing that a per-key delegation would save: the
 * signing key never leaves this process, and what a browser receives is a URL
 * already bound to one pathname and one expiry. Widening the delegation does
 * not widen anything a leaked URL can reach.
 *
 * Two callers arriving together at the moment one expires will both fail the
 * floor check and both issue, because each is awaiting the old delegation
 * while the other replaces it. That is a redundant control-API call about
 * once an hour under load, and it is left alone deliberately: both
 * delegations are valid, whichever lands second is the one that gets reused,
 * and no URL is ever signed with less life than {@link URL_TTL_MS} promises.
 * Closing it would mean re-reading the slot after the await and deciding
 * whose delegation wins — concurrency reasoning in the file whose whole job
 * is to be obvious, bought with one saved round trip an hour.
 */
async function delegation(credential: string): Promise<IssuedSignedToken> {
  const cached = cachedDelegation;
  if (cached?.credential === credential) {
    const existing = await cached.issued;
    if (existing.validUntil - Date.now() > DELEGATION_FLOOR_MS) {
      return existing;
    }
  }

  const issued = issueSignedToken({
    pathname: "*",
    operations: ["get"],
    validUntil: Date.now() + DELEGATION_TTL_MS,
    token: credential,
  });
  cachedDelegation = { credential, issued };

  // A failed issuance must not become what every later call awaits. Dropping
  // it from the cache lets the next caller try again; this call still
  // rejects, which is the right answer for whoever was waiting on it.
  issued.catch(() => {
    if (cachedDelegation?.issued === issued) {
      cachedDelegation = null;
    }
  });

  return issued;
}

/** A read URL for `key`, good for {@link URL_TTL_MS}. */
async function readUrl(key: string, credential: string): Promise<string> {
  const { presignedUrl } = await presignUrl(await delegation(credential), {
    operation: "get",
    pathname: key,
    access: "private",
    validUntil: Date.now() + URL_TTL_MS,
  });
  return presignedUrl;
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
 * `access: "private"` is the posture decided in YEO-86, and on Vercel it is a
 * property of the *store* rather than of this call — stores are created
 * private or public, and an `access` here that disagrees with the store is an
 * error rather than an override. That is why `docs/deploying.md` has a step
 * saying to create it private: a public store fails loudly at the first
 * upload instead of quietly publishing what it is given.
 */
export async function put(
  key: string,
  body: StorageBody,
  options: PutOptions = {},
): Promise<StoredObject> {
  const credential = token();
  const result = await blobPut(key, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: options.contentType,
    token: credential,
  });

  return {
    key: result.pathname,
    url: await readUrl(result.pathname, credential),
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
 *
 * The existence check comes first and the URL is signed second, which is the
 * order that matters now that signing exists: a signature is arithmetic over
 * a pathname, and it would happily produce a valid-looking URL for a key that
 * was deleted last week. A caller asking `get` whether an image is there
 * deserves an answer about the object rather than about the string.
 *
 * It narrows the window rather than closing it — a key deleted between the
 * check and the signature still gets a URL minted for it, and there is no
 * transactional API that would prevent that. The point is the stale key, not
 * the racing one: E5-T5 deletes orphans on its own schedule, so `get` being
 * wrong about an image removed months ago is the case that would actually
 * happen.
 */
export async function get(key: string): Promise<StoredObject | null> {
  const credential = token();
  try {
    const result = await head(key, { token: credential });
    return {
      key: result.pathname,
      url: await readUrl(result.pathname, credential),
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

/**
 * The most objects `list` will gather before it gives up.
 *
 * A bound on a loop that is otherwise driven by somebody else's cursor. A
 * family wiki's store holds photographs of a family; a hundred thousand of
 * them is far past anything this application produces, so reaching this
 * number means something is wrong — the wrong store, a prefix that did not
 * apply, or a host whose cursor never terminates — and continuing would turn
 * that into an out-of-memory kill instead of a sentence.
 *
 * Refusing is the safe direction for the one caller. A truncated listing
 * cannot invent an orphan (an object missing from the list is simply never
 * considered), but it also cannot be told apart from a complete one, and a
 * cleanup that silently ran on half a store is exactly the kind of quiet
 * wrongness E5-T5 is about. Better a failure that names the number.
 */
const MAX_LISTED_OBJECTS = 100_000;

/**
 * One object as `list` describes it.
 *
 * Wider than {@link StoredObject}, and the difference is not an
 * inconsistency. `StoredObject` omits size and upload time because *Vercel's
 * `put` response does not carry them*, and a `put` that promised them would
 * have to fetch them back — so the field would exist on the type and be a lie
 * on the host. Every store's **listing** is the opposite case: S3's `Size`
 * and `LastModified`, GCS's `size` and `updated`, R2's, Azure's, and
 * `fs.stat` all come back with the entry, unasked. Promising them here costs
 * no host anything, and both are load-bearing for the caller — see `size` and
 * `uploadedAt` below.
 *
 * There is deliberately no `url`. A listing is a worklist, and the rule this
 * module is built on is that `key` is the durable handle and a URL is a
 * credential with a timer on it. Minting one per listed object would sign a
 * URL for every photograph in the wiki in order to delete forty of them.
 */
export interface ListedObject {
  /** The key it is stored under — the same string `put` was given. */
  key: string;
  /**
   * How many bytes it occupies.
   *
   * The point of the sweep is reclaiming storage, so a report that cannot say
   * *how much* is a materially weaker answer to "should I run this with
   * `--delete`" than the one the operator is entitled to.
   */
  size: number;
  /**
   * When it was written.
   *
   * Load-bearing rather than informational, and the reason is a race the
   * cleanup would otherwise lose. `components/EntryEditor.tsx` and
   * `components/PortraitField.tsx` upload the moment an author picks a file,
   * *before* the entry or the person is saved — so a just-uploaded image is
   * legitimately referenced by nothing for as long as the author keeps
   * typing. Without an age, a sweep running in that window deletes the
   * photograph out from under a live editor and the save writes a body
   * pointing at a file that is already gone.
   */
  uploadedAt: Date;
}

export interface ListOptions {
  /**
   * Only objects whose key starts with this.
   *
   * Every host takes one, and the caller is expected to pass
   * `IMAGE_KEY_PREFIX` rather than enumerate the whole store: the namespace
   * exists precisely so that a store shared with something else one day has a
   * boundary the sweep cannot reach across (`lib/storage-key.ts`).
   */
  prefix?: string;
}

/**
 * Every object under `prefix`, in one array.
 *
 * Pagination is handled in here and the cursor is never exported. That is the
 * same judgement the rest of this module makes about signing: a cursor is the
 * shape of one host's paging, and a seam that handed one out would make every
 * future caller re-implement a loop against whatever the next host's cursor
 * happens to be. What every store agrees on is "give me everything under this
 * prefix"; what they disagree about is how the pages are stitched, so the
 * stitching stays on this side of the seam.
 *
 * The whole listing in memory is the deliberate trade, and it is the same
 * "a family wiki is small" assumption `getFamilyGraph` makes when it loads
 * every person at once. {@link MAX_LISTED_OBJECTS} is where that assumption
 * stops being made silently.
 *
 * Order is not promised. Hosts differ, and the one caller sorts its report
 * for itself.
 */
export async function list(options: ListOptions = {}): Promise<ListedObject[]> {
  const credential = token();
  const objects: ListedObject[] = [];
  let cursor: string | undefined;

  do {
    const page = await blobList({
      prefix: options.prefix,
      cursor,
      token: credential,
    });

    for (const blob of page.blobs) {
      objects.push({
        key: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt,
      });
    }

    if (objects.length > MAX_LISTED_OBJECTS) {
      throw new Error(
        `Refusing to list more than ${MAX_LISTED_OBJECTS} objects` +
          (options.prefix ? ` under ${JSON.stringify(options.prefix)}` : "") +
          ". A store this size is not one this application produced; check " +
          "STORAGE_TOKEN points at the right store before going further.",
      );
    }

    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return objects;
}
