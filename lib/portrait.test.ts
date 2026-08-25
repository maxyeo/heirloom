import { describe, expect, it } from "vitest";

import {
  isPortraitKey,
  nodePortraitKey,
  type PortraitKeys,
  portraitSrc,
  readPortraitKey,
} from "@/lib/portrait";
import { imageKeyFromHref } from "@/lib/storage-key";

/**
 * What a portrait key *is*, checked with no database and no browser (E5-T4,
 * `YEO-44`). `lib/portrait.ts`'s own docblock is explicit that this module
 * depends on nothing but text handling and `lib/storage-key.ts`'s rules, so a
 * literal string is enough to exercise every branch.
 */

const GOOD_KEY = "images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";

describe("isPortraitKey", () => {
  it("is true for a real image key inside the images/ namespace", () => {
    expect(isPortraitKey(GOOD_KEY)).toBe(true);
  });

  it("is false for a key outside the images/ namespace", () => {
    expect(isPortraitKey("uploads/ab/1e5b6c2f.jpg")).toBe(false);
  });

  it("is false for a key with a relative segment", () => {
    expect(isPortraitKey("images/../etc/passwd")).toBe(false);
  });

  it("is false for a key with a leading slash", () => {
    expect(isPortraitKey("/images/ab/1e5b6c2f.jpg")).toBe(false);
  });

  it("is false for an empty key", () => {
    expect(isPortraitKey("")).toBe(false);
  });

  it("is false for a key that is not NFC-normalised", () => {
    // "café" spelled as "e" + a combining acute accent (NFD) rather than the
    // single precomposed character (NFC) — the two are visually identical and
    // not the same string, which is exactly the ambiguity a storage key must
    // not carry.
    const nfd = "images/ab/café.jpg";
    expect(nfd.normalize("NFC")).not.toBe(nfd);
    expect(isPortraitKey(nfd)).toBe(false);
  });
});

describe("readPortraitKey", () => {
  it.each([null, undefined, "", "   "])(
    "is null for %p — nothing submitted, or blank",
    (value) => {
      expect(readPortraitKey(value)).toBeNull();
    },
  );

  it("is undefined for a number", () => {
    expect(readPortraitKey(42)).toBeUndefined();
  });

  it("is undefined for a File-ish object", () => {
    expect(readPortraitKey(new File(["x"], "photo.jpg"))).toBeUndefined();
  });

  it("is undefined for a string that is not a valid image key", () => {
    expect(readPortraitKey("not an image key")).toBeUndefined();
    expect(readPortraitKey("uploads/ab/1e5b6c2f.jpg")).toBeUndefined();
  });

  it("is the key itself for a good one", () => {
    expect(readPortraitKey(GOOD_KEY)).toBe(GOOD_KEY);
  });
});

describe("portraitSrc", () => {
  it("drops the images/ prefix and routes through the image API", () => {
    expect(portraitSrc(GOOD_KEY)).toBe(
      "/api/images/ab/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg",
    );
  });

  it("round-trips through imageKeyFromHref", () => {
    const src = portraitSrc(GOOD_KEY);
    expect(src).not.toBeNull();
    expect(imageKeyFromHref(src ?? "")).toBe(GOOD_KEY);
  });

  it("is null for a null key", () => {
    expect(portraitSrc(null)).toBeNull();
  });

  /**
   * Total rather than throwing, and deliberately so: this runs once per
   * person while the tree lays itself out, over values read straight out of
   * the database — a hand-edited cell or a restore from somewhere else must
   * cost one placeholder, not blank the whole canvas. Same reasoning
   * `imageKeyFromHref` already applies to a key read back out of stored HTML.
   */
  it("is null, not a throw, for a key outside the images/ namespace", () => {
    expect(() => portraitSrc("not-in-the-namespace.jpg")).not.toThrow();
    expect(portraitSrc("not-in-the-namespace.jpg")).toBeNull();
  });

  it("is null, not a throw, for a key with a relative segment", () => {
    expect(() => portraitSrc("images/../etc/passwd")).not.toThrow();
    expect(portraitSrc("images/../etc/passwd")).toBeNull();
  });
});

describe("nodePortraitKey", () => {
  function keys(overrides: Partial<PortraitKeys>): PortraitKeys {
    return { portraitKey: null, portraitThumbKey: null, ...overrides };
  }

  it("prefers the thumbnail when both are present", () => {
    expect(
      nodePortraitKey(
        keys({
          portraitKey: GOOD_KEY,
          portraitThumbKey: "images/cd/thumb.webp",
        }),
      ),
    ).toBe("images/cd/thumb.webp");
  });

  it("falls back to the original when the thumbnail is null", () => {
    expect(
      nodePortraitKey(keys({ portraitKey: GOOD_KEY, portraitThumbKey: null })),
    ).toBe(GOOD_KEY);
  });

  it("is null when both are null", () => {
    expect(nodePortraitKey(keys({}))).toBeNull();
  });
});
