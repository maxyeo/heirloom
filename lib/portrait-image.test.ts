import { describe, expect, it } from "vitest";

import { ALLOWED_IMAGE_TYPES } from "@/lib/image-type";
import { MAX_UPLOAD_BYTES } from "@/lib/image-endpoint";
import {
  PORTRAIT_MAX_EDGE,
  PORTRAIT_THUMB_TYPE,
  portraitNeedsReencoding,
  thumbnailSize,
} from "@/lib/portrait-image";
import { PORTRAIT_THUMB_MAX_EDGE } from "@/lib/portrait";

/**
 * How a chosen photograph becomes the two images that get stored, checked
 * with no canvas (E5-T4, `YEO-44`). See `lib/portrait-image.ts`'s own
 * docblock for why this is a separate module from `lib/portrait.ts` — the
 * split is what keeps the GEDCOM import's closure from growing
 * `lib/image-upload.ts`.
 */

describe("thumbnailSize", () => {
  it("is null when the source already fits inside the box", () => {
    // This is the case that makes nodePortraitKey's fallback to the original
    // reachable at all: a portrait already thumbnail-sized has no separate
    // thumbnail made for it, deliberately.
    expect(thumbnailSize({ width: 100, height: 100 })).toBeNull();
    expect(
      thumbnailSize({
        width: PORTRAIT_THUMB_MAX_EDGE,
        height: PORTRAIT_THUMB_MAX_EDGE,
      }),
    ).toBeNull();
  });

  it("scales down a source larger than the box", () => {
    const result = thumbnailSize({ width: 4000, height: 2000 });
    expect(result).toEqual({
      width: PORTRAIT_THUMB_MAX_EDGE,
      height: PORTRAIT_THUMB_MAX_EDGE / 2,
    });
  });

  it("respects an explicit maxEdge argument rather than always using the default", () => {
    expect(thumbnailSize({ width: 100, height: 100 }, 50)).toEqual({
      width: 50,
      height: 50,
    });
    // And the same source is "already fits" against a larger explicit cap.
    expect(thumbnailSize({ width: 100, height: 100 }, 200)).toBeNull();
  });
});

describe("portraitNeedsReencoding", () => {
  it("is false for a small file under both caps", () => {
    expect(portraitNeedsReencoding({ width: 800, height: 600 }, 1024)).toBe(
      false,
    );
  });

  it("is true for a 12 MB phone photo", () => {
    const twelveMB = 12 * 1024 * 1024;
    expect(
      portraitNeedsReencoding({ width: 3024, height: 4032 }, twelveMB),
    ).toBe(true);
    expect(twelveMB).toBeGreaterThan(MAX_UPLOAD_BYTES);
  });

  it("is true for an 8000px-wide image that is under the byte cap", () => {
    expect(portraitNeedsReencoding({ width: 8000, height: 100 }, 1024)).toBe(
      true,
    );
    expect(8000).toBeGreaterThan(PORTRAIT_MAX_EDGE);
  });
});

describe("the link to the upload endpoint's own caps", () => {
  it("PORTRAIT_THUMB_TYPE is one of the types the endpoint accepts", () => {
    // Load-bearing: a thumbnail encoded as a type the endpoint refuses would
    // fail every upload the moment a browser could not honour "image/webp"
    // and fell back to something off this list.
    expect(ALLOWED_IMAGE_TYPES).toContain(PORTRAIT_THUMB_TYPE);
  });
});
