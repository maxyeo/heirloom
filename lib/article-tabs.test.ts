import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { articleTabsForPath, type ArticleTabRow } from "@/lib/article-tabs";
import { RESERVED_SLUGS } from "@/lib/entry-slug";

/**
 * The tab row is a function of the path, so this is where nearly all of E11-T7
 * is checked — no document, no router. `components/ArticleTabs.test.tsx` is
 * left with the two things that genuinely need a DOM: the overflow menu's
 * dismissals, and the fact that the row renders at all.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The row, or a readable failure rather than a `null` dereference. */
function rowFor(pathname: string): ArticleTabRow {
  const row = articleTabsForPath(pathname);
  if (!row) throw new Error(`expected tabs for ${pathname}`);
  return row;
}

function labels(pathname: string): string[] {
  return rowFor(pathname).tabs.map((tab) => tab.label);
}

function currentLabels(pathname: string): string[] {
  return rowFor(pathname)
    .tabs.filter((tab) => tab.current)
    .map((tab) => tab.label);
}

describe("which pages get tabs", () => {
  it.each([
    "/wiki/ada-lovelace",
    "/wiki/ada-lovelace/edit",
    "/wiki/ada-lovelace/history",
  ])("puts them on %s", (pathname) => {
    expect(articleTabsForPath(pathname)).not.toBeNull();
  });

  it.each([
    // The shell wraps these too, and none of them is an article.
    ["/", "the front page"],
    ["/tree", "the canvas"],
    ["/wiki", "the entry index"],
    ["/signin", "a page outside the shell entirely"],
  ])("puts none on %s (%s)", (pathname) => {
    expect(articleTabsForPath(pathname)).toBeNull();
  });

  it("puts none on the create form, whose entry does not exist yet", () => {
    // Tabs there would offer to show the history of something that has never
    // been saved. The set is shared with `lib/entry-slug.ts` rather than
    // restated here, so the two cannot drift.
    for (const reserved of RESERVED_SLUGS) {
      expect(articleTabsForPath(`/wiki/${reserved}`)).toBeNull();
    }
    expect(RESERVED_SLUGS.has("new")).toBe(true);
  });

  it("puts none on a sub-route it does not recognise", () => {
    // Better a missing row than one that renders with nothing marked current,
    // or with "Read" wrongly marked current. See the header of the module.
    expect(articleTabsForPath("/wiki/ada-lovelace/talk")).toBeNull();
    expect(articleTabsForPath("/wiki/ada-lovelace/edit/preview")).toBeNull();
  });

  it("reads a trailing slash as the same path", () => {
    expect(articleTabsForPath("/wiki/ada-lovelace/")).toEqual(
      articleTabsForPath("/wiki/ada-lovelace"),
    );
  });
});

describe("the tabs themselves", () => {
  it("is the ticket's four, in the ticket's order", () => {
    expect(labels("/wiki/ada-lovelace")).toEqual([
      "Article",
      "Read",
      "Edit",
      "View history",
    ]);
  });

  it("has no Talk tab", () => {
    // The ticket rules one out and says why: with a handful of named family
    // members and collaborative editing a stated non-goal, a Talk page would
    // be a permanently empty room.
    expect(labels("/wiki/ada-lovelace")).not.toContain("Talk");
  });

  it("leaves the namespace tab as a label rather than a link", () => {
    // With no second namespace, the only address it could point at is "Read",
    // immediately to its right.
    const article = rowFor("/wiki/ada-lovelace").tabs[0];

    expect(article.id).toBe("article");
    expect(article.group).toBe("namespace");
    expect(article.href).toBeNull();
  });

  it("gives every view tab a destination", () => {
    for (const tab of rowFor("/wiki/ada-lovelace").tabs) {
      if (tab.group === "view") expect(tab.href).not.toBeNull();
    }
  });
});

describe("which tab is current", () => {
  it("marks Read on the entry itself", () => {
    expect(currentLabels("/wiki/ada-lovelace")).toEqual(["Article", "Read"]);
  });

  it("marks Edit in the editor", () => {
    expect(currentLabels("/wiki/ada-lovelace/edit")).toEqual([
      "Article",
      "Edit",
    ]);
  });

  it.each([
    ["/wiki/ada-lovelace/history", "the revision list (E1-T5)"],
    ["/wiki/ada-lovelace/history/abc123", "a single revision"],
    ["/wiki/ada-lovelace/history/compare", "the compare view (E1-T6)"],
    ["/wiki/ada-lovelace/history/abc123/restore", "the restore step (E1-T7)"],
  ])("marks View history on %s — %s", (pathname) => {
    // All four are "you are reading this entry's history", so all four light
    // the same tab rather than dropping the row on three of them.
    expect(currentLabels(pathname)).toEqual(["Article", "View history"]);
  });

  it("marks exactly one view tab, whatever the path", () => {
    for (const pathname of [
      "/wiki/ada-lovelace",
      "/wiki/ada-lovelace/edit",
      "/wiki/ada-lovelace/history/compare",
    ]) {
      const row = rowFor(pathname);
      const current = row.tabs.filter(
        (tab) => tab.group === "view" && tab.current,
      );

      expect(current).toHaveLength(1);
      // The overflow trigger is labelled with this, so it has to be the same
      // object the row is reporting as current rather than a second guess.
      expect(row.currentView).toBe(current[0]);
    }
  });
});

describe("where the tabs go", () => {
  it("points at the routes E1-T5 and E1-T8 actually built", () => {
    expect(
      Object.fromEntries(
        rowFor("/wiki/ada-lovelace")
          .tabs.filter((tab) => tab.href !== null)
          .map((tab) => [tab.label, tab.href]),
      ),
    ).toEqual({
      Read: "/wiki/ada-lovelace",
      Edit: "/wiki/ada-lovelace/edit",
      "View history": "/wiki/ada-lovelace/history",
    });
  });

  it("points at routes that exist on disk", () => {
    // The ticket is explicit that these addresses are to be found rather than
    // guessed. `lib/entry-slug.test.ts` checks its reserved set against the
    // filesystem for the same reason: a route that moves should fail a test
    // here rather than produce a tab that leads to a 404.
    for (const segment of ["edit", "history"]) {
      expect(
        existsSync(join(repoRoot, "app/wiki/[slug]", segment, "page.tsx")),
      ).toBe(true);
    }
  });

  it("keeps a percent-encoded slug exactly as it arrived", () => {
    // `lib/entry-slug.ts` keeps non-Latin titles in the address, so the slug
    // reaching `usePathname` may be encoded. Re-encoding an already-encoded
    // segment would turn `%E5%8C%97` into `%25E5%258C%2597` and 404.
    const row = rowFor("/wiki/%E5%8C%97%E4%BA%AC/history");

    expect(row.slug).toBe("%E5%8C%97%E4%BA%AC");
    expect(row.tabs.find((tab) => tab.id === "edit")?.href).toBe(
      "/wiki/%E5%8C%97%E4%BA%AC/edit",
    );
  });

  it("survives a slug that is not valid percent-encoding", () => {
    // A hand-typed `%` in the address bar makes `decodeURIComponent` throw,
    // and a tab row is not the place for that to become a 500.
    expect(() => articleTabsForPath("/wiki/100%")).not.toThrow();
    expect(rowFor("/wiki/100%").slug).toBe("100%");
  });
});
