import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SIDEBAR_PINNED_QUERY,
  resolveSidebarState,
} from "@/lib/sidebar-preference";

describe("resolveSidebarState", () => {
  it("opens by default on a wide screen", () => {
    // A sidebar a first-time viewer can see is one they can collapse. A
    // hamburger with nothing behind it is one they have to guess at.
    expect(resolveSidebarState(null, true)).toBe("open");
  });

  it("remembers a collapse", () => {
    expect(resolveSidebarState("closed", true)).toBe("closed");
  });

  it("remembers re-opening after a collapse", () => {
    expect(resolveSidebarState("open", true)).toBe("open");
  });

  it("ignores anything it did not write", () => {
    // Some other version of this app, or another tab's key collision. Only an
    // explicit "closed" collapses the sidebar.
    expect(resolveSidebarState("maybe", true)).toBe("open");
  });

  it.each([[null], ["open"], ["closed"]])(
    "starts closed on a narrow screen whatever is stored (%s)",
    (stored) => {
      // Narrow, the sidebar is a drawer lying over the article. A drawer that
      // opens itself on load is not a preference being honoured, it is
      // something to dismiss before reading.
      expect(resolveSidebarState(stored, false)).toBe("closed");
    },
  );
});

describe("the breakpoint", () => {
  it("is the same width the stylesheet switches at", () => {
    // 55rem is 880px, the width the E11 reference mockup collapses its own
    // two-column grid at. CSS cannot read a JavaScript constant, so the number
    // is written twice — and the two disagreeing would show up as a sidebar
    // that is open according to the button and invisible according to the
    // page, which is not a failure any other test would catch.
    const css = readFileSync(
      join(fileURLToPath(new URL("..", import.meta.url)), "app/globals.css"),
      "utf8",
    );

    const width = /^\(min-width: ([\d.]+rem)\)$/.exec(
      SIDEBAR_PINNED_QUERY,
    )?.[1];

    expect(width).toBeDefined();
    expect(css).toContain(`@media (width >= ${width})`);
  });
});
