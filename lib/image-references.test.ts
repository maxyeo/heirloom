import { describe, expect, it } from "vitest";

import { collectImageReferences } from "@/lib/image-references";
import { IMAGE_ROUTE } from "@/lib/storage-key";

/**
 * What counts as a reference, asserted against literals.
 *
 * The database half of this module is in `lib/image-references.db.test.ts` —
 * this is the part that needs no Postgres, which is most of the judgement
 * (docs/testing.md).
 */

const KEY = "images/ab/0e5b6c2f-1234-4a56-89ab-cdef45000001.jpg";
const OTHER = "images/cd/0e5b6c2f-1234-4a56-89ab-cdef45000002.webp";
const src = (key: string) => `${IMAGE_ROUTE}/${key.slice("images/".length)}`;

describe("html sources", () => {
  it("finds the key an img tag refers to", () => {
    const keys = collectImageReferences({
      html: [`<p>Before</p><img src="${src(KEY)}"><p>After</p>`],
    });

    expect([...keys]).toEqual([KEY]);
  });

  it("unions every body it is given", () => {
    // The shape both callers use: a current body and its revisions arrive as
    // one list, and an image in any of them is referenced.
    const keys = collectImageReferences({
      html: [`<img src="${src(KEY)}">`, `<img src="${src(OTHER)}">`],
    });

    expect([...keys].sort()).toEqual([KEY, OTHER].sort());
  });

  it("ignores an src that is not one of ours", () => {
    // An absolute URL, a data: URI and a foreign path all contribute nothing
    // rather than erroring — `imageKeyFromHref` is the single judge of "one
    // of ours", shared with the sanitiser.
    const keys = collectImageReferences({
      html: [
        '<img src="https://example.com/cat.jpg">',
        '<img src="data:image/gif;base64,R0lGOD">',
        '<img src="/uploads/cat.jpg">',
      ],
    });

    expect([...keys]).toEqual([]);
  });

  it("tolerates null, undefined and empty bodies", () => {
    // A caller hands over nullable columns without filtering them first.
    const keys = collectImageReferences({
      html: [null, undefined, "", `<img src="${src(KEY)}">`],
    });

    expect([...keys]).toEqual([KEY]);
  });
});

describe("key sources", () => {
  it("takes a portrait column at face value", () => {
    expect([...collectImageReferences({ keys: [KEY] })]).toEqual([KEY]);
  });

  it("keeps a value it does not recognise", () => {
    // Deliberate, and the asymmetry the module is built on: the sweep
    // compares these against listed objects by exact string match, so a
    // value nothing recognises can only fail to match — while dropping it
    // here is the one change that could turn an unexpected column value into
    // a deleted photograph. The export filters at its own call site, where
    // the opposite is true.
    const keys = collectImageReferences({ keys: ["not-a-key", "images/.."] });

    expect([...keys].sort()).toEqual(["images/..", "not-a-key"]);
  });

  it("ignores nulls and blanks", () => {
    const keys = collectImageReferences({ keys: [null, undefined, "", KEY] });

    expect([...keys]).toEqual([KEY]);
  });
});

describe("both together", () => {
  it("deduplicates a key that is both a portrait and in a body", () => {
    // A person's portrait pasted into their own entry. One key, one
    // reference — the count in the report should not double.
    const keys = collectImageReferences({
      html: [`<img src="${src(KEY)}">`],
      keys: [KEY],
    });

    expect([...keys]).toEqual([KEY]);
  });

  it("returns nothing for no sources at all", () => {
    expect([...collectImageReferences({})]).toEqual([]);
  });
});
