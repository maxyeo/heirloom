import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES } from "@/lib/image-endpoint";
import {
  DOWNSCALE_STEPS,
  DOWNSCALE_TYPE,
  IMAGE_ACCEPT,
  altTextFromFilename,
  isAllowedImageType,
  isPicture,
  needsDownscale,
  picturesAmong,
  scaleToFit,
  uploadPercent,
} from "@/lib/image-insert";
import { ALLOWED_IMAGE_TYPES } from "@/lib/image-type";

/**
 * The image button's decisions, with no browser anywhere (E5-T3, `YEO-43`).
 *
 * This is the split docs/testing.md asks for — "prefer no DOM" — applied to a
 * feature that is otherwise all DOM. A file picker, a drag event, a canvas and
 * an `XMLHttpRequest` cannot be checked here; *which files count as pictures*,
 * *what `alt` should say*, *when a photograph has to be shrunk and to what*
 * are values in and values out, and every one of them is somewhere this could
 * be quietly wrong for months.
 */

/** A file, as much of one as anything in `lib/image-insert.ts` looks at. */
const file = (name: string, type: string, size = 1024) => ({
  name,
  type,
  size,
});

describe("which files are pictures", () => {
  it("offers the picker exactly the types the endpoint accepts", () => {
    // Not a longer list "to be helpful": every extra entry is a file the
    // author can choose and the server will refuse with a 415.
    expect(IMAGE_ACCEPT.split(",")).toEqual([...ALLOWED_IMAGE_TYPES]);
  });

  it.each([...ALLOWED_IMAGE_TYPES])("accepts %s", (type) => {
    expect(isAllowedImageType(type)).toBe(true);
    expect(isPicture(file("photo", type))).toBe(true);
  });

  it.each([
    // The one that must never be accepted, for `lib/image-type.ts`'s reason:
    // it is a document format with script in it.
    "image/svg+xml",
    "image/heic",
    "image/tiff",
    "application/pdf",
    "text/html",
    "",
  ])("refuses %s", (type) => {
    expect(isAllowedImageType(type)).toBe(false);
    expect(isPicture(file("thing", type))).toBe(false);
  });

  it("keeps the pictures out of a mixed drop, in order", () => {
    // What a paste from a word processor actually carries: the picture, and
    // the document it came from.
    const dropped = [
      file("notes.docx", "application/vnd.openxmlformats-officedocument"),
      file("rose.jpg", "image/jpeg"),
      file("tree.ged", ""),
      file("walter.png", "image/png"),
    ];

    expect(picturesAmong(dropped).map((each) => each.name)).toEqual([
      "rose.jpg",
      "walter.png",
    ]);
  });

  it("answers nothing for a drop with no picture in it", () => {
    expect(picturesAmong([file("tree.ged", "")])).toEqual([]);
  });
});

describe("what alt text says", () => {
  it.each([
    [
      "Rose and Bill at Southwold, 1952.jpg",
      "Rose and Bill at Southwold, 1952",
    ],
    // Underscores are how a filesystem spells a space.
    ["rose_hall_wedding.png", "rose hall wedding"],
    // Hyphens separate words but are kept, because they are also how a
    // double-barrelled name is written.
    ["Hall-Whitmore family.webp", "Hall-Whitmore family"],
    // A digit beside real words is a year, and worth keeping.
    ["Walter 1918.jpeg", "Walter 1918"],
  ])("uses %s", (name, expected) => {
    expect(altTextFromFilename(name)).toBe(expected);
  });

  it.each([
    // The names an unedited photograph actually has. `alt="IMG 4021"` is
    // worse than no alt at all: it announces that the picture has been
    // described when it has not, and an absent attribute is a signal an
    // assistive technology can act on where a junk one is not.
    "IMG_4021.JPG",
    "DSC01234.jpg",
    "PXL_20240712_140233.jpg",
    "Screenshot 2026-08-25 at 14.02.09.png",
    "image.png",
    "photo(1).jpeg",
    "20240712.jpg",
    "_.png",
    "",
  ])("says nothing for %s", (name) => {
    expect(altTextFromFilename(name)).toBeNull();
  });

  it("does not mistake a word for an extension", () => {
    // The extension rule is anchored and short, so a name that ends in a word
    // after a dot keeps it.
    expect(altTextFromFilename("Rose. Southwold")).toBe("Rose. Southwold");
  });
});

describe("when a picture has to be shrunk", () => {
  it("leaves anything within the cap alone", () => {
    // Including a very large one by dimension: the browser scales it into the
    // column anyway, and the archive is better off with the original.
    expect(needsDownscale(file("rose.jpg", "image/jpeg", 100_000))).toBe(false);
    expect(
      needsDownscale(file("rose.jpg", "image/jpeg", MAX_UPLOAD_BYTES)),
    ).toBe(false);
  });

  it("shrinks a phone photograph", () => {
    // The case the whole path exists for: a recent phone produces 3–12 MB
    // images against a 4 MB cap that cannot be raised.
    expect(
      needsDownscale(file("IMG_4021.JPG", "image/jpeg", 11 * 1024 * 1024)),
    ).toBe(true);
  });

  it("never shrinks a GIF, however large", () => {
    // A canvas keeps one frame, so re-encoding an animation would silently
    // turn it into a still. Being refused with a sentence is the honest
    // answer.
    expect(
      needsDownscale(file("wave.gif", "image/gif", 40 * 1024 * 1024)),
    ).toBe(false);
  });

  it("re-encodes as the one format every canvas can produce", () => {
    // `image/webp` would be smaller and would keep alpha, and on a browser
    // that cannot encode it `toBlob` silently answers a PNG — larger than the
    // file that was already too large.
    expect(DOWNSCALE_TYPE).toBe("image/jpeg");
  });

  it("tries progressively smaller, and stops somewhere still worth looking at", () => {
    const edges = DOWNSCALE_STEPS.map((step) => step.longestEdge);
    expect(edges).toEqual([...edges].sort((a, b) => b - a));

    const qualities = DOWNSCALE_STEPS.map((step) => step.quality);
    expect(qualities).toEqual([...qualities].sort((a, b) => b - a));
    expect(Math.min(...qualities)).toBeGreaterThan(0.5);

    // The floor is comfortably wider than the 46em content column, so even a
    // photograph that needed every attempt is not soft in the article.
    expect(Math.min(...edges)).toBeGreaterThanOrEqual(1200);
  });
});

describe("scaling to fit", () => {
  it("leaves something already small enough exactly as it is", () => {
    expect(scaleToFit({ width: 800, height: 600 }, 2400)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("never upscales", () => {
    // A small file over the cap is over it for some other reason — a PNG of a
    // photograph, most likely — and stretching its pixels makes it larger.
    expect(scaleToFit({ width: 100, height: 100 }, 2400)).toEqual({
      width: 100,
      height: 100,
    });
  });

  it("keeps the aspect ratio, whichever side is longer", () => {
    expect(scaleToFit({ width: 4000, height: 3000 }, 2000)).toEqual({
      width: 2000,
      height: 1500,
    });
    expect(scaleToFit({ width: 3000, height: 4000 }, 2000)).toEqual({
      width: 1500,
      height: 2000,
    });
  });

  it("gives an extreme panorama at least one pixel of height", () => {
    // Not an error in any browser, just a blank picture — which is why it is
    // worth pinning rather than discovering.
    const scaled = scaleToFit({ width: 20_000, height: 3 }, 1200);
    expect(scaled.width).toBe(1200);
    expect(scaled.height).toBe(1);
  });
});

describe("how far along an upload is", () => {
  it("reports whole percentages", () => {
    expect(uploadPercent(0, 1000)).toBe(0);
    expect(uploadPercent(333, 1000)).toBe(33);
    expect(uploadPercent(1000, 1000)).toBe(100);
  });

  it("never exceeds 100", () => {
    // The request body is the file plus its multipart framing, so a browser
    // reporting `loaded` past the total it was given is ordinary.
    expect(uploadPercent(1100, 1000)).toBe(100);
  });

  it("answers null when the browser cannot measure the body", () => {
    // `lengthComputable: false` arrives here as a total of zero, and the
    // caller renders an indeterminate bar. A confident 0% would be worse.
    expect(uploadPercent(0, 0)).toBeNull();
    expect(uploadPercent(10, Number.NaN)).toBeNull();
    expect(uploadPercent(Number.NaN, 100)).toBeNull();
  });
});
