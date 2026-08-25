import { extensionFor, type ImageType } from "@/lib/image-type";

/**
 * The keys this application stores images under, and the check that no other
 * kind ever reaches the store (E5-T2, `YEO-42`).
 *
 * ## Two obligations `lib/storage.ts` deliberately does not take on
 *
 * That module's `put` says so in as many words: *"nothing here rejects a
 * leading slash or a `..` segment … E5-T2 owns the upload endpoint and should
 * constrain the keys it mints rather than passing a filename through from a
 * browser."* Both halves of that live here, and they are separate defences
 * rather than one restated twice:
 *
 * 1. **`newImageKey` mints the key.** Nothing about the upload contributes to
 *    it — not the filename, not a caption, not the type the client claimed.
 *    This is the defence that actually holds today, because a value with no
 *    input in it cannot be steered.
 * 2. **`assertSafeStorageKey` refuses a dangerous one.** Belt and braces for
 *    (1), and the half that survives someone later threading a
 *    user-influenced value into a key — a slug, an original filename kept
 *    "for tidiness", an id from an import.
 *
 * ## Why this matters when today it cannot
 *
 * Against Vercel Blob a key is an opaque object name, so `../../etc/passwd`
 * is a file with a strange name and nothing more. The check is worth having
 * anyway, and the reason is the whole point of `lib/storage.ts` existing:
 * that module is a seam kept narrow enough that *a directory on disk* can be
 * the backend one day. On that backend an unvalidated key is a path
 * traversal — read or write, depending on the function — and the code that
 * introduced it will have been written, reviewed and shipped years earlier
 * against a store where it was harmless.
 *
 * So the rule is that the *caller* validates, before the seam, which is what
 * "storage keys validated before they reach `lib/storage.ts`" means. Putting
 * the check inside the seam instead would be one line shorter and would make
 * every future implementation of it responsible for re-implementing a
 * security property; the seam's promise is that a host can be swapped by
 * rewriting one file, and a rewrite that quietly dropped this check would
 * look complete.
 *
 * ## Why the answer is a throw rather than a boolean
 *
 * An unsafe key here is never a user's mistake. Uploads carry no key — the
 * key is minted three lines earlier by `newImageKey` — so a failure means
 * this module's own output failed its own check, which is a bug in the
 * process rather than something to render as a 400. It throws for the same
 * reason an assertion does: there is no sensible way to continue, and the
 * only honest response is a 500 and a stack trace pointing at the mint.
 */

/**
 * The error `assertSafeStorageKey` throws.
 *
 * A named class rather than a bare `Error`, so a caller that ever does want
 * to distinguish this from "the store was unreachable" can, and so the route
 * handler's test asserts the rejection rather than that *something* threw —
 * a plain `Error` would let a typo in the assertion pass as a success.
 */
export class UnsafeStorageKeyError extends Error {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(`Unsafe storage key (${reason}): ${JSON.stringify(key)}`);
    this.name = "UnsafeStorageKeyError";
  }
}

/**
 * The prefix every image this endpoint stores lives under.
 *
 * A namespace rather than a bare object per image, so that a store shared
 * with anything else later — an export, a database dump, an avatar cache —
 * has somewhere to put it that is not the same flat space, and so that
 * E5-T5's orphan sweep has a prefix to reason about.
 */
export const IMAGE_KEY_PREFIX = "images/";

/**
 * The longest key that may be handed to the store.
 *
 * Nothing minted here comes close — an image key is 55 characters — so this
 * is a bound on what the *validator* will pass, not on what the mint
 * produces. It exists because several plausible backends have a path-length
 * ceiling that they enforce by failing halfway through a write, and because
 * an unbounded key is an unbounded thing to log.
 */
export const MAX_KEY_LENGTH = 512;

/**
 * The characters a key segment may be spelled with.
 *
 * An allowlist, and a small one. What it excludes is the interesting part:
 * backslash (a separator on Windows and inside several storage SDKs), colon
 * (a drive letter, an alternate data stream, a scheme), percent (a second
 * layer of decoding for somebody to disagree about), whitespace, quotes, and
 * everything outside ASCII. A key that reaches a filesystem should mean the
 * same thing to every layer that looks at it, and the way to get that is to
 * spell it with characters that no layer treats specially.
 *
 * The leading character is narrowed further to alphanumeric, which is one
 * rule doing three jobs: it rules out `.` and `..` as segments, hidden
 * `.dotfiles` in a directory backend, and a segment starting with `-`, which
 * every command-line tool that ever walks that directory would read as a
 * flag.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Throw unless `key` is safe to hand to `lib/storage.ts`.
 *
 * Every rule below is stated as its own check with its own reason, rather
 * than as one regular expression over the whole key. The regular expression
 * would be shorter and would be the thing nobody can review: the failures
 * this guards against are individually obvious and collectively invisible,
 * and a reader has to be able to see that `..` is refused without parsing a
 * character class in their head.
 */
export function assertSafeStorageKey(key: string): void {
  const fail = (reason: string): never => {
    throw new UnsafeStorageKeyError(key, reason);
  };

  if (key.length === 0) fail("empty");
  if (key.length > MAX_KEY_LENGTH) fail(`longer than ${MAX_KEY_LENGTH}`);

  // Checked before the segment split, because both of these produce an empty
  // segment and would otherwise be reported as one — and "empty segment" is
  // a much less useful thing to read in a log than "leading slash".
  if (key.startsWith("/")) fail("leading slash");
  if (key.endsWith("/")) fail("trailing slash");

  // Normalisation forms are a way to spell the same segment two ways, and a
  // store that normalises while a validator does not is how two keys become
  // one object. The character allowlist below already excludes every
  // non-ASCII code point, so this is belt and braces on that; it is here so
  // that widening the allowlist later cannot quietly reintroduce the problem.
  if (key !== key.normalize("NFC")) fail("not NFC-normalised");

  for (const segment of key.split("/")) {
    if (segment.length === 0) fail("empty segment");
    if (segment === "." || segment === "..") fail("relative segment");
    if (!SEGMENT.test(segment))
      fail(`illegal segment ${JSON.stringify(segment)}`);
  }
}

/**
 * A fresh key for an image of `type`, owing nothing to the upload.
 *
 * `images/<shard>/<uuid>.<ext>`, and each of the three parts is deliberate:
 *
 * - **The UUID is the whole of the name.** Version 4, from the platform's
 *   CSPRNG. The original filename does not appear, not even sanitised: a
 *   sanitised filename is still an attacker-chosen string that survived a
 *   function somebody has to keep correct, and it buys nothing here, because
 *   nothing renders a key to a person. `IMG_4021.JPG` also collides with the
 *   `IMG_4021.JPG` from the other phone in the family, and `put` overwrites.
 * - **The shard is the first two characters of that UUID.** It costs nothing
 *   on a blob store, where the key is flat text with slashes in it, and on
 *   the directory backend this seam exists to keep possible it is the
 *   difference between 256 directories and one directory with every
 *   photograph the family owns in it — which is where `ls` stops returning
 *   and some filesystems start degrading.
 * - **The extension is the sniffed type's**, never the uploaded name's. See
 *   `lib/image-type.ts`.
 *
 * The result is passed through `assertSafeStorageKey` before it is returned,
 * so the mint cannot drift away from the check it is supposed to satisfy —
 * the two would otherwise only ever be compared by a test.
 */
export function newImageKey(type: ImageType): string {
  const id = crypto.randomUUID();
  const key = `${IMAGE_KEY_PREFIX}${id.slice(0, 2)}/${id}.${extensionFor(type)}`;
  assertSafeStorageKey(key);
  return key;
}

/**
 * Where the image route lives.
 *
 * The durable reference an entry body carries is a site-relative path of this
 * application's own — `docs/architecture.md#the-storage-seam`, and the same
 * reasoning as `lib/entry-link.ts` gives for entry-to-entry links: bodies
 * outlive the domain they were written on, and a signed storage URL outlives
 * the afternoon it was minted on. The path is resolved to a fresh signed URL
 * per request.
 */
export const IMAGE_ROUTE = "/api/images";

/**
 * The site-relative path that resolves to `key`.
 *
 * The route's URL space and the store's key space differ by exactly the
 * `images/` prefix, and the *route* owns it rather than the URL. That buys
 * two things for the price of one `slice`:
 *
 * - The path reads as an address (`/api/images/ab/<uuid>.jpg`) rather than
 *   as `/api/images/images/ab/<uuid>.jpg`, which is what an identity mapping
 *   would produce and what somebody would eventually "fix" by renaming the
 *   prefix out of the keys.
 * - The route can only ever address objects inside the image namespace. It
 *   is a containment property on top of `assertSafeStorageKey`, and it holds
 *   even for a key that passes every rule that function has — which matters
 *   the moment anything else shares the store. Nothing does today: the
 *   nightly database dump goes to a CI artifact rather than here (`E9-T3`).
 *   The namespace costs one `slice` and means the question never has to be
 *   reopened.
 */
export function imagePath(key: string): string {
  if (!key.startsWith(IMAGE_KEY_PREFIX)) {
    throw new UnsafeStorageKeyError(key, "outside the image namespace");
  }
  return `${IMAGE_ROUTE}/${key.slice(IMAGE_KEY_PREFIX.length)}`;
}

/**
 * The key addressed by a request to the image route, or a throw.
 *
 * `segments` is the catch-all route parameter, and it arrives **already
 * percent-decoded** — Next decodes dynamic segments before a handler sees
 * them. So `%2e%2e%2f` is `../` by the time it reaches this function, which
 * is why validation happens here on the joined result and not on the raw URL:
 * a check against the encoded form would be a check against the wrong string,
 * and a `decodeURIComponent` applied afterwards would decode it a second
 * time.
 */
export function imageKeyFromPath(segments: readonly string[]): string {
  const key = `${IMAGE_KEY_PREFIX}${segments.join("/")}`;
  assertSafeStorageKey(key);
  return key;
}

/**
 * The reverse of {@link imagePath}: which stored image, if any, an `<img
 * src>` in an entry body refers to (E7-T4, `YEO-54`).
 *
 * The full export has to put the family's photographs in the archive, and
 * `lib/storage.ts` deliberately has no `list` — the seam is exactly
 * `put`/`get`/`delete`, and widening it to enumerate a store would narrow the
 * set of hosts that can implement it (docs/architecture.md#the-storage-seam).
 * So the set of images an archive should carry is read off the *references*:
 * every `src` in every entry body and every revision of one. That is also the
 * question E5-T5's orphan sweep asks in reverse — "referenced by no revision"
 * — so the two agree about what "referenced" means by sharing this function.
 *
 * Deliberately strict, and strict in the same directions
 * `entrySlugFromHref` is:
 *
 * - **An absolute URL is not one of ours**, even when it names this host.
 *   Bodies are site-relative by construction (docs/architecture.md#links-
 *   between-entries), so an absolute `src` is something pasted in from
 *   somewhere else and its bytes are not ours to include.
 * - **A malformed percent-escape yields `null` rather than throwing.**
 *   `decodeURIComponent` raises `URIError` on a lone `%`, and a stray
 *   character in a stored body must not take an export down with it — a
 *   backup that refuses to run because of one bad `src` is the failure this
 *   ticket exists to avoid.
 * - **A key that fails `assertSafeStorageKey` yields `null`.** The path is
 *   read out of stored HTML, which is the one place a value that never went
 *   through `newImageKey` could appear, so the same check the route makes is
 *   made here.
 *
 * A query or fragment is stripped first: `?v=2` on an image URL is a
 * cache-buster, not part of the key.
 *
 * @param src the `src` as it appears on the `img`, percent-encoded and with
 *   HTML escapes already decoded
 * @returns the storage key, or `null` if this is not an image this
 *   application stores
 */
export function imageKeyFromHref(src: string): string | null {
  const prefix = `${IMAGE_ROUTE}/`;
  if (!src.startsWith(prefix)) return null;

  const path = src.slice(prefix.length).split(/[#?]/, 1)[0];
  if (path === "") return null;

  let segments: string[];
  try {
    segments = path.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }

  try {
    return imageKeyFromPath(segments);
  } catch (error) {
    if (error instanceof UnsafeStorageKeyError) return null;
    throw error;
  }
}
