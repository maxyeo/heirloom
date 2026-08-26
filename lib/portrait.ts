/**
 * A person's portrait: which key the canvas asks for, what a thumbnail is,
 * and what counts as a portrait key at all (E5-T4, `YEO-44`).
 *
 * ## Why there is a thumbnail at all
 *
 * The tree loads the whole family at once — `getFamilyGraph` selects every
 * row and the layout runs in the browser, because "a family tree is small"
 * (docs/architecture.md). Small is a few hundred people, and a few hundred
 * people with photographs is a few hundred images on one canvas, each drawn
 * into a box forty pixels wide. Serving the originals there would download
 * several hundred megapixels to paint a contact sheet.
 *
 * ## Why the downscale happens in the browser, once, on the way in
 *
 * Three other places it could have happened, and why none of them works here:
 *
 * - **In `GET /api/images/…` on the way out.** That route is a redirect: it
 *   checks the session, signs a URL and gets out of the way, and
 *   `docs/architecture.md#the-storage-seam` is explicit that "proxying the
 *   bytes would make this application a CDN for its own images". Resizing is
 *   proxying with arithmetic in it.
 * - **In an image processor on the server.** There is none, and adding one
 *   (`sharp`) puts a platform-specific native binary into a deployment whose
 *   whole portability claim is that it is a plain Node server.
 * - **In `next/image`.** Its optimiser would have to fetch the image back out
 *   of this application, which requires a session it does not have, and then
 *   follow a redirect to the storage host, which would have to be named in
 *   `next.config.ts` — writing the vendor into the build config, from the one
 *   direction `lib/storage.ts`'s tripwire does not watch.
 *
 * What is left is the browser that already has the file open, before it is
 * uploaded. It costs one `<canvas>` draw, it happens once per photograph
 * rather than once per page view, and it needs no new dependency and no new
 * endpoint: the thumbnail is uploaded through the same `POST /api/images`
 * (E5-T2) as the original, and both keys are stored.
 *
 * ## The rule about keys
 *
 * A key, never a URL. `lib/storage.ts` mints URLs that expire after fifteen
 * minutes (`YEO-86`), so a URL persisted on a row would render for one
 * afternoon and be a broken image for the rest of that row's life. Everything
 * here therefore deals in keys, and {@link portraitSrc} is the single place
 * one becomes something an `<img src>` can hold — a site-relative path of
 * this application's own, resolved per request.
 */

import { readText } from "./field-input";
import { imagePath, isStoredImageKey } from "./storage-key";

/**
 * How wide the portrait is drawn on a tree node, in CSS pixels.
 *
 * Exported so `lib/tree-layout.ts` can add it to `PERSON_WIDTH` and
 * `components/FamilyTree.tsx` can size the box, rather than the two agreeing
 * by coincidence — a node whose reserved width and rendered width disagree is
 * a layout that drifts as soon as anybody changes one of them.
 */
export const PORTRAIT_NODE_SIZE = 48;

/**
 * Whether `key` is something this application stored as an image.
 *
 * Two checks, not one: inside the `images/` namespace, and safe as a storage
 * key. The namespace half is what stops a portrait column becoming a way to
 * address anything else that ever shares the store, and the safety half is
 * `lib/storage-key.ts`'s own rules — refused here rather than at the seam,
 * because "the caller validates, before the seam" is the property that file
 * exists to keep true.
 *
 * A predicate rather than a throw, unlike `assertSafeStorageKey` itself, and
 * the difference is who is asking. That function is checking a key this
 * application just minted, where a failure is a bug. This one is checking a
 * value that arrived in a form submission, where a failure is a submission to
 * refuse.
 */
export function isPortraitKey(key: string): boolean {
  // A portrait key is a stored image key and nothing more — the column
  // constrains who points at the image, not what the key may look like. The
  // rule lives in `lib/storage-key.ts` beside the mint and the validator it
  // is made of, so that this predicate and E5-T5's orphan sweep cannot come
  // to disagree about which keys are this application's.
  return isStoredImageKey(key);
}

/**
 * Read a portrait key out of an untrusted value, the way `readText` reads a
 * name.
 *
 * The three-way answer is `lib/field-input.ts`'s convention and is kept here
 * so a caller can tell the cases apart:
 *
 * - `null` — nothing was submitted, or the field was blank. This person has
 *   no portrait, which is the ordinary case.
 * - `undefined` — something was submitted that is not a portrait key: a
 *   `File`, a number, or a string naming an object outside the image
 *   namespace. The caller reports a validation issue.
 * - a string — the key.
 */
export function readPortraitKey(value: unknown): string | null | undefined {
  const text = readText(value);
  if (text === undefined || text === null) return text;
  return isPortraitKey(text) ? text : undefined;
}

/**
 * The `src` an `<img>` should carry for the portrait stored under `key`, or
 * `null` when there is no portrait to show.
 *
 * It exists so that every portrait in the application names one function
 * rather than three components each remembering that the route drops the
 * `images/` prefix. The path it returns is durable; the signed URL it
 * redirects to is minted per request and expires.
 *
 * **Total, and that is the point.** `imagePath` throws for a key outside the
 * image namespace, which is right for a caller that just minted one — a
 * failure there is a bug and deserves a stack trace. It is wrong here. This
 * function is called once per person while the tree lays itself out, on
 * values read straight out of the database, so a single row holding a key
 * that never went through `newImageKey` — a hand-edited cell, a restore from
 * somewhere else, an import written by a future path — would throw during
 * layout and blank the entire canvas. One bad row must cost one placeholder,
 * not the family.
 *
 * That is the same reasoning, and the same answer, that `imageKeyFromHref`
 * gives for reading a key back out of stored HTML.
 *
 * Taking a nullable key rather than a bare one is what keeps that honest at
 * the call sites: "this person has no portrait" and "this person's portrait
 * key is not usable" are the same thing to a component, and both callers
 * already had a null branch to put it in.
 */
export function portraitSrc(key: string | null): string | null {
  if (key === null || !isPortraitKey(key)) return null;
  return imagePath(key);
}

/** A person, as far as anything choosing between their two portrait keys cares. */
export interface PortraitKeys {
  portraitKey: string | null;
  portraitThumbKey: string | null;
}

/**
 * Which key a tree node should load: the thumbnail, or the original as a
 * fallback.
 *
 * The fallback is not decoration. A row can hold a portrait and no thumbnail
 * — a browser whose `toBlob` handed back nothing, or a portrait written by
 * some future path that does not make one — and the two honest answers are
 * "draw the big one" and "draw nothing". Drawing nothing would report a
 * person with a photograph as a person without one, which is a lie the
 * placeholder would tell convincingly. Drawing the big one is slow on exactly
 * the rows that have this problem and correct on all of them.
 *
 * `null` when there is no portrait at all, which is what the placeholder is
 * for.
 */
export function nodePortraitKey(person: PortraitKeys): string | null {
  return person.portraitThumbKey ?? person.portraitKey;
}
