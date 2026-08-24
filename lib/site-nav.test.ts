import { describe, expect, it } from "vitest";

import { siteNavItems } from "@/lib/site-nav";

/**
 * The sidebar's contents are read off the E11 reference mockup, and their
 * order is part of what makes the shell recognisable. Nothing else in the app
 * would notice if a link went to the wrong place or if the list got
 * rearranged, so the list itself is what gets asserted.
 */
describe("site navigation", () => {
  it("is the mockup's four entries, in the mockup's order", () => {
    expect(siteNavItems.map((item) => item.label)).toEqual([
      "Main page",
      "All entries",
      "Family tree",
      "Recent changes",
    ]);
  });

  it("points the live entries at the routes that exist", () => {
    expect(
      Object.fromEntries(
        siteNavItems
          .filter((item) => item.href !== null)
          .map((item) => [item.label, item.href]),
      ),
    ).toEqual({
      "Main page": "/",
      // E1-T9.
      "All entries": "/wiki",
      // The E3 canvas.
      "Family tree": "/tree",
    });
  });

  it("leaves recent changes inert until E8-T4 builds it", () => {
    // The property that matters is not which ticket is named but that the one
    // unbuilt destination is a `null` href rather than a link to a 404 — and
    // that the other three are not accidentally inert.
    const pending = siteNavItems.filter((item) => item.href === null);

    expect(pending.map((item) => item.label)).toEqual(["Recent changes"]);
    expect(pending[0].pendingTicket).toBe("E8-T4");
  });

  it("names a ticket for every entry that has no destination, and only those", () => {
    for (const item of siteNavItems) {
      expect(Boolean(item.pendingTicket)).toBe(item.href === null);
    }
  });
});
