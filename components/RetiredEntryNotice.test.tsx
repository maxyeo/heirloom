// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { RetiredEntryNotice } from "@/components/RetiredEntryNotice";
import { render } from "@/test/render";

/**
 * The retirement notice the three surviving pages under `/wiki/<slug>` share
 * (E1-T10, `YEO-122`; `YEO-123`).
 *
 * Mounted rather than asserted as a value, which docs/testing.md's "prefer no
 * DOM" rule permits only when the question is about a document — and both
 * questions here are. The first is the address the way out points at, which is
 * an `href` and nothing else; the second is that the page-specific half of the
 * message is actually rendered rather than dropped, which is the failure that
 * would put the general sentence on all three pages and the specific one on
 * none.
 *
 * The wording itself is not pinned here beyond the opening claim. It is prose
 * that will be edited, and a test asserting every word of it would fail on
 * every improvement without ever failing on a lie.
 */

describe("the retirement notice", () => {
  it("says the entry is retired before it says anything else", () => {
    const host = render(
      <RetiredEntryNotice slug="rose-hall">
        Its history is kept in full.
      </RetiredEntryNotice>,
    );

    // The claim every page carrying this panel is making. A reader arriving
    // from a bookmark has nothing else on the page to tell them, which is the
    // whole argument for the panel.
    expect(host.textContent).toContain("This entry has been retired.");
  });

  it("renders the sentence about the page it is on", () => {
    const host = render(
      <RetiredEntryNotice slug="rose-hall">
        Both versions below are kept in full.
      </RetiredEntryNotice>,
    );

    expect(host.textContent).toContain("Both versions below are kept in full.");
  });

  it("offers the entry itself as the way out", () => {
    const host = render(
      <RetiredEntryNotice slug="rose-hall">
        Its history is kept in full.
      </RetiredEntryNotice>,
    );
    const links = [...host.querySelectorAll("a")];

    // One link, to the tombstone, which is where the restore button lives. A
    // second control here would be a second copy of that decision on a page
    // about the history rather than about the entry.
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/wiki/rose-hall");
  });

  it("encodes the slug, so the way out is not a broken address", () => {
    // Slugs are lowercased and hyphenated on the way in (`lib/entry-slug.ts`)
    // but they are not ASCII-only, and a percent-encoding done in three routes
    // is a percent-encoding two of them will eventually skip. It is done here
    // instead, so this is the assertion that it is done at all.
    const host = render(
      <RetiredEntryNotice slug="cnoc-an-óir">
        Its history is kept in full.
      </RetiredEntryNotice>,
    );

    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      `/wiki/${encodeURIComponent("cnoc-an-óir")}`,
    );
  });
});
