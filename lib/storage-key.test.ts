import { describe, expect, it } from "vitest";

import { ALLOWED_IMAGE_TYPES } from "@/lib/image-type";
import {
  assertSafeStorageKey,
  imageKeyFromPath,
  imagePath,
  IMAGE_KEY_PREFIX,
  MAX_KEY_LENGTH,
  newImageKey,
  UnsafeStorageKeyError,
} from "@/lib/storage-key";

/**
 * Minting keys, and refusing dangerous ones (E5-T2, `YEO-42`).
 *
 * `lib/storage.ts` deliberately validates nothing and says in its own `put`
 * docblock that this endpoint owns the check. Against Vercel Blob a key is an
 * opaque object name, so none of what is rejected below can do any harm
 * today — the harm arrives with the directory-on-disk backend the storage
 * seam exists to keep possible, years after this code was reviewed.
 */

describe("the mint", () => {
  it.each(ALLOWED_IMAGE_TYPES)("produces a key for %s", (type) => {
    // `images/ab/<uuid>.<ext>`: a namespace, a shard, and a name that owes
    // nothing whatever to the upload.
    expect(newImageKey(type)).toMatch(
      /^images\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z]+$/,
    );
  });

  it("shards on the first two characters of the name", () => {
    const key = newImageKey("image/jpeg");
    const [, shard, name] = key.split("/");
    expect(name.startsWith(shard)).toBe(true);
  });

  it("does not repeat itself", () => {
    const keys = new Set(
      Array.from({ length: 100 }, () => newImageKey("image/png")),
    );
    expect(keys.size).toBe(100);
  });

  it("takes its extension from the type, not from a filename", () => {
    expect(newImageKey("image/webp").endsWith(".webp")).toBe(true);
  });
});

describe("the check", () => {
  it("passes an ordinary key", () => {
    expect(() => assertSafeStorageKey("images/ab/photo-1.jpg")).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["a leading slash, which is an absolute path", "/images/a.jpg"],
    ["a trailing slash, which names a directory", "images/a.jpg/"],
    ["a relative segment", "images/../../etc/passwd"],
    ["a bare relative segment", "../secrets"],
    ["a current-directory segment", "images/./a.jpg"],
    ["an empty segment", "images//a.jpg"],
    ["a backslash, which separates on Windows", "images\\a.jpg"],
    ["a colon, which is a drive or a scheme", "c:/images/a.jpg"],
    ["a percent, which invites a second decoding", "images/%2e%2e/a.jpg"],
    ["a NUL, which truncates in C", "images/a\0.jpg"],
    ["a newline", "images/a\nb.jpg"],
    ["a space", "images/a b.jpg"],
    ["a hidden file", "images/.git/config"],
    ["a segment that reads as a command-line flag", "images/-rf/a.jpg"],
    ["something outside ASCII", "images/café.jpg"],
  ])("refuses %s", (_reason, key) => {
    expect(() => assertSafeStorageKey(key)).toThrow(UnsafeStorageKeyError);
  });

  it("refuses a key longer than the limit", () => {
    const long = `images/${"a".repeat(MAX_KEY_LENGTH)}.jpg`;
    expect(() => assertSafeStorageKey(long)).toThrow(UnsafeStorageKeyError);
  });

  it("says why, because a key that fails this is a bug to be found", () => {
    expect(() => assertSafeStorageKey("../x")).toThrow(/relative segment/);
  });

  it("agrees with the mint", () => {
    // The two would otherwise only ever be compared by inspection, and a mint
    // that drifted out of its own allowlist would fail at the store instead.
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(() => assertSafeStorageKey(newImageKey(type))).not.toThrow();
    }
  });
});

describe("the route's URL space", () => {
  it("differs from the key space by the image prefix", () => {
    expect(imagePath("images/ab/photo.jpg")).toBe("/api/images/ab/photo.jpg");
  });

  it("round-trips a minted key", () => {
    const key = newImageKey("image/jpeg");
    const path = imagePath(key);
    expect(imageKeyFromPath(path.split("/").slice(3))).toBe(key);
  });

  it("cannot address anything outside the image namespace", () => {
    // The containment property: whatever else ends up in this store — a
    // backup, an export — the image route cannot name it.
    expect(
      imageKeyFromPath(["ab", "photo.jpg"]).startsWith(IMAGE_KEY_PREFIX),
    ).toBe(true);
    expect(() => imagePath("backups/2026-01-01.sql")).toThrow(
      UnsafeStorageKeyError,
    );
  });

  it("refuses traversal in a path, which arrives already decoded", () => {
    // Next decodes dynamic segments before a handler sees them, so `%2e%2e`
    // is `..` by the time it gets here — which is why the check is on the
    // joined key and not on the URL.
    expect(() => imageKeyFromPath(["..", "..", "etc", "passwd"])).toThrow(
      UnsafeStorageKeyError,
    );
    expect(() => imageKeyFromPath([""])).toThrow(UnsafeStorageKeyError);
  });
});
