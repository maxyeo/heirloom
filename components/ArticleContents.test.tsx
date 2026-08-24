// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArticleContents } from "@/components/ArticleContents";
import {
  ARTICLE_CONTENTS_SLOT_ID,
  type OutlineHeading,
} from "@/lib/article-outline";
import { SIDEBAR_ATTRIBUTE } from "@/lib/sidebar-preference";
import { render } from "@/test/render";

/**
 * What the panel decides is tested where it is decided — the ids in
 * `lib/article-outline.test.ts`, the highlight in `lib/active-section.test.ts`.
 * What is left needs a document, because it is about the DOM: the panel lands
 * in the shell's sidebar rather than where it is written, it is absent
 * entirely for an entry with no headings, and the disclosure it grows on a
 * narrow screen is a real one.
 *
 * `matchMedia` is stubbed per test, the way `components/SidebarToggle.test.tsx`
 * stubs it, because jsdom does not implement it and because the width is the
 * input that changes the answer here too.
 */

function stubViewport(pinned: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: pinned,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

/** The empty element `components/AppShell.tsx` leaves in the sidebar. */
function mountSlot(): HTMLElement {
  const slot = document.createElement("div");
  slot.id = ARTICLE_CONTENTS_SLOT_ID;
  document.body.appendChild(slot);
  return slot;
}

function heading(level: 2 | 3 | 4, id: string, text = id): OutlineHeading {
  return { id, level, text };
}

const ARTICLE = [
  heading(2, "early-life", "Early life"),
  heading(3, "school", "School"),
  heading(2, "work", "Work"),
];

/** The headings as the article itself would have them, so ids resolve. */
function mountArticle(headings: readonly OutlineHeading[]) {
  const article = document.createElement("div");
  article.className = "wiki-body";
  for (const item of headings) {
    const element = document.createElement(`h${item.level}`);
    element.id = item.id;
    element.textContent = item.text;
    article.appendChild(element);
  }
  document.body.appendChild(article);
}

function linksIn(slot: HTMLElement): HTMLAnchorElement[] {
  return [...slot.querySelectorAll("a")];
}

function disclosureIn(slot: HTMLElement): HTMLButtonElement | null {
  return slot.querySelector("button");
}

beforeEach(() => {
  stubViewport(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(SIDEBAR_ATTRIBUTE);
});

describe("ArticleContents", () => {
  it("renders into the shell's sidebar, not where it is written", () => {
    const slot = mountSlot();

    const host = render(<ArticleContents headings={ARTICLE} />);

    expect(host.innerHTML).toBe("");
    expect(linksIn(slot).map((link) => link.textContent)).toEqual([
      "Early life",
      "School",
      "Work",
    ]);
  });

  it("shows no panel at all for an entry with no headings", () => {
    // The acceptance criterion: no empty "Contents" box, and nothing for the
    // article's column to work around.
    const slot = mountSlot();

    render(<ArticleContents headings={[]} />);

    expect(slot.innerHTML).toBe("");
  });

  it("shows no panel when every heading is untitled", () => {
    // Such a heading still has an id — E11-T4 needs one — but a row with no
    // label is worse than no row, and a panel of them is worse than no panel.
    const slot = mountSlot();

    render(<ArticleContents headings={[heading(2, "section", "")]} />);

    expect(slot.innerHTML).toBe("");
  });

  it("does nothing when the shell left no slot for it", () => {
    // Every route outside `/wiki` mounts a different shell, or none.
    const host = render(<ArticleContents headings={ARTICLE} />);

    expect(host.innerHTML).toBe("");
  });

  it("nests a subsection inside the section above it", () => {
    const slot = mountSlot();

    render(<ArticleContents headings={ARTICLE} />);

    const top = slot.querySelector("ul");
    if (!top) throw new Error("no contents list rendered");

    // Two sections at the top level, and "School" inside the first of them
    // rather than beside it.
    expect(top.children).toHaveLength(2);
    const nested = top.children[0].querySelector("ul");
    expect(nested?.textContent).toBe("School");
  });

  it("links to each heading by its fragment", () => {
    // A plain fragment link, so the browser does the scrolling — and honours
    // the `scroll-margin-top` that keeps the heading clear of the header.
    const slot = mountSlot();

    render(<ArticleContents headings={ARTICLE} />);

    expect(linksIn(slot).map((link) => link.getAttribute("href"))).toEqual([
      "#early-life",
      "#school",
      "#work",
    ]);
  });

  it("percent-encodes a heading id that is not Latin", () => {
    const slot = mountSlot();

    render(<ArticleContents headings={[heading(2, "北京", "北京")]} />);

    expect(linksIn(slot)[0].getAttribute("href")).toBe(
      `#${encodeURIComponent("北京")}`,
    );
  });

  it("marks exactly one entry as the one being read", () => {
    const slot = mountSlot();
    mountArticle(ARTICLE);

    render(<ArticleContents headings={ARTICLE} />);

    // *Which* one is `lib/active-section.ts`'s decision, tested on numbers
    // there; jsdom lays nothing out, so all this can honestly say is that the
    // wiring reaches the markup.
    const current = linksIn(slot).filter(
      (link) => link.getAttribute("aria-current") === "true",
    );
    expect(current).toHaveLength(1);
  });

  describe("on a wide screen", () => {
    it("is a pinned list with nothing to collapse", () => {
      const slot = mountSlot();

      render(<ArticleContents headings={ARTICLE} />);

      expect(disclosureIn(slot)).toBeNull();
      expect(slot.querySelector("ul")?.hasAttribute("hidden")).toBe(false);
    });
  });

  describe("on a narrow screen", () => {
    beforeEach(() => {
      stubViewport(false);
    });

    it("collapses into a dropdown that starts shut", () => {
      const slot = mountSlot();

      render(<ArticleContents headings={ARTICLE} />);

      const button = disclosureIn(slot);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      expect(slot.querySelector("ul")?.hasAttribute("hidden")).toBe(true);
    });

    it("names the list it controls", () => {
      const slot = mountSlot();

      render(<ArticleContents headings={ARTICLE} />);

      const controls = disclosureIn(slot)?.getAttribute("aria-controls");
      expect(controls).toBe(slot.querySelector("ul")?.id);
    });

    it("opens and shuts again", () => {
      const slot = mountSlot();

      render(<ArticleContents headings={ARTICLE} />);
      const button = disclosureIn(slot);
      if (!button) throw new Error("no disclosure rendered");

      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(slot.querySelector("ul")?.hasAttribute("hidden")).toBe(false);

      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(slot.querySelector("ul")?.hasAttribute("hidden")).toBe(true);
    });

    it("shuts the drawer behind a reader who follows a link", () => {
      // At this width the sidebar lies *over* the article, so a link followed
      // from inside it would otherwise leave the reader looking at the drawer
      // they tapped through.
      const slot = mountSlot();
      document.documentElement.setAttribute(SIDEBAR_ATTRIBUTE, "open");

      render(<ArticleContents headings={ARTICLE} />);
      act(() => {
        const button = disclosureIn(slot);
        button?.click();
      });
      act(() => {
        linksIn(slot)[0].click();
      });

      expect(document.documentElement.getAttribute(SIDEBAR_ATTRIBUTE)).toBe(
        "closed",
      );
    });
  });
});
