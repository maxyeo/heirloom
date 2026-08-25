import { describe, expect, it } from "vitest";

import { scanEntryImages } from "@/lib/entry-images";
import { IMAGE_ROUTE } from "@/lib/storage-key";

/**
 * Finding the photographs an entry refers to (E7-T4, `YEO-54`).
 *
 * ## Why this is worth a suite of its own
 *
 * It decides which images end up in a family's backup. Everything else in the
 * export is read straight out of a table; this is the one member of the
 * archive whose *contents* are the result of parsing, and a scan that quietly
 * misses a tag is a photograph that quietly is not in the backup — the
 * failure nobody notices until the restore.
 *
 * `img` is not yet in `lib/sanitize-html.ts`'s allowlist (E5-T3, `YEO-43`),
 * so no stored body contains one today and these are the only bodies the
 * scanner has ever seen. That is a reason for more cases here rather than
 * fewer: the day the allowlist widens, this code goes from unexercised to
 * load-bearing without anyone editing it.
 */

const key = "images/ab/0e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";
const src = `${IMAGE_ROUTE}/ab/0e5b6c2f-1234-4a56-89ab-cdef01234567.jpg`;

describe("what counts as an image of ours", () => {
  it("finds one in a body", () => {
    expect(
      scanEntryImages(`<p>Before</p><img src="${src}"><p>After</p>`),
    ).toEqual([key]);
  });

  it("finds one however the attribute is quoted", () => {
    // The sanitiser emits double quotes, but a row written before it existed
    // — or by a hand-run `UPDATE` — is exactly the body that is nobody's
    // fault and still holds a family's photograph.
    expect(scanEntryImages(`<img src='${src}'>`)).toEqual([key]);
    expect(scanEntryImages(`<img src=${src}>`)).toEqual([key]);
  });

  it("finds one among other attributes", () => {
    expect(scanEntryImages(`<img alt="Rose, 1912" src="${src}" />`)).toEqual([
      key,
    ]);
  });

  it("returns them in document order", () => {
    const second = "images/cd/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg";
    const html = `<img src="${src}"><img src="${IMAGE_ROUTE}/cd/1e5b6c2f-1234-4a56-89ab-cdef01234567.jpg">`;

    expect(scanEntryImages(html)).toEqual([key, second]);
  });

  it("reports one image once, however many times it appears", () => {
    // A body that shows the same photograph twice is one file in the archive,
    // not two members with the same name — which a ZIP would happily hold and
    // an extractor would resolve by overwriting.
    expect(scanEntryImages(`<img src="${src}"><img src="${src}">`)).toEqual([
      key,
    ]);
  });
});

describe("what does not", () => {
  it.each([
    [
      '<img src="https://example.com/photo.jpg">',
      "an image on somebody else's host",
    ],
    ['<img src="data:image/png;base64,AAAA">', "an inline data URI"],
    ['<img src="/wiki/rose-hall">', "a path that is not the image route"],
    ['<img src="/api/images/">', "the route with nothing after it"],
    ["<img>", "an img with no src at all"],
    ['<img src="/api/images/../../etc/passwd">', "a path that climbs out"],
    ['<img src="/api/images/%">', "a broken percent-escape"],
    ["<p>No images here</p>", "a body with no images"],
    ["", "an empty body"],
  ])("ignores %s — %s", (html) => {
    expect(scanEntryImages(html)).toEqual([]);
  });

  it("ignores an image mentioned inside a comment", () => {
    expect(scanEntryImages(`<!-- <img src="${src}"> -->`)).toEqual([]);
  });

  it("ignores the word img in prose", () => {
    expect(
      scanEntryImages(`<p>The img tag src="${src}" is markup.</p>`),
    ).toEqual([]);
  });

  it("does not throw on a body that is not well formed", () => {
    /**
     * An export must not be the thing that discovers a malformed row. The
     * whole family's backup failing because one entry has an unclosed tag in
     * it would be a spectacularly bad trade, so the scan degrades to finding
     * nothing in the part it cannot read.
     */
    expect(() => scanEntryImages('<img src="unclosed')).not.toThrow();
    expect(() => scanEntryImages("<<>>")).not.toThrow();
  });
});
