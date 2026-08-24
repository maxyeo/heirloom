// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it } from "vitest";

import { ArticleTabs } from "@/components/ArticleTabs";
import { render, rerender } from "@/test/render";

/**
 * Only what needs a document.
 *
 * Which tab is current, where each one goes, and which paths get a row at all
 * is `lib/article-tabs.test.ts` — a plain module, no DOM. What is left here is
 * the part that could not have been a function: the overflow menu's two
 * dismissals, which exist because `<details>` provides neither, and the wiring
 * that turns a row of data into links a reader can press.
 */

function tabsFor(pathname: string): HTMLElement {
  return render(<ArticleTabs pathname={pathname} />);
}

/** The `<details>` the view tabs collapse into below the `sm` breakpoint. */
function menuIn(host: HTMLElement): HTMLDetailsElement {
  const menu = host.querySelector("details");
  if (!menu) throw new Error("no overflow menu rendered");
  return menu;
}

function summaryIn(host: HTMLElement): HTMLElement {
  const summary = menuIn(host).querySelector("summary");
  if (!summary) throw new Error("no overflow trigger rendered");
  return summary;
}

/** Open it the way a reader does, rather than by setting the property. */
function openMenu(host: HTMLElement): HTMLDetailsElement {
  const menu = menuIn(host);
  act(() => summaryIn(host).click());
  return menu;
}

describe("rendering", () => {
  it("renders nothing on a page that is not an article", () => {
    // The shell puts this above every route it wraps, `/tree` and the entry
    // index included, so "nothing here" has to mean nothing rather than an
    // empty ruled row.
    expect(tabsFor("/tree").innerHTML).toBe("");
    expect(tabsFor("/wiki").innerHTML).toBe("");
  });

  it("names the row, so it is not one more unlabelled nav", () => {
    // The sidebar is already a `<nav>` on the same page.
    const nav = tabsFor("/wiki/ada").querySelector("nav");

    expect(nav?.getAttribute("aria-label")).toBe("Article");
  });

  it("announces the tab you are on as the current page", () => {
    const host = tabsFor("/wiki/ada/edit");
    const current = [...host.querySelectorAll('a[aria-current="page"]')];

    // Once in the wide row and once in the overflow menu — the two are the
    // same tab at two widths, and only one of them is ever displayed.
    expect(current.map((link) => link.textContent)).toEqual(["Edit", "Edit"]);
  });

  it("leaves the namespace tab out of the tab order", () => {
    // It is a label rather than a control — with no Talk namespace the only
    // address it could point at is "Read", beside it. So it has to be present
    // and it must not be something a keyboard stops on and then cannot use.
    const host = tabsFor("/wiki/ada");
    const article = [...host.querySelectorAll("span")].find(
      (element) => element.textContent === "Article",
    );

    expect(article).toBeDefined();
    expect(article?.closest("a")).toBeNull();
    expect(
      [...host.querySelectorAll("a")].map((link) => link.textContent),
    ).not.toContain("Article");
  });

  it("links the editor and the history route", () => {
    const host = tabsFor("/wiki/ada");
    const hrefs = new Set(
      [...host.querySelectorAll("a")].map((link) => link.getAttribute("href")),
    );

    expect(hrefs).toEqual(
      new Set(["/wiki/ada", "/wiki/ada/edit", "/wiki/ada/history"]),
    );
  });
});

describe("the narrow-screen overflow menu", () => {
  it("is labelled with the view you are on", () => {
    // The row still has to answer "where am I" when it is one control wide.
    expect(summaryIn(tabsFor("/wiki/ada/history")).textContent).toContain(
      "View history",
    );
  });

  it("starts closed", () => {
    expect(menuIn(tabsFor("/wiki/ada")).open).toBe(false);
  });

  it("points the trigger at the menu it opens", () => {
    const host = tabsFor("/wiki/ada");
    const controls = summaryIn(host).getAttribute("aria-controls");

    expect(controls).toBeTruthy();
    expect(menuIn(host).querySelector(`#${controls}`)).not.toBeNull();
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    // The shell's reviewer found that current browsers do *not* do this for a
    // `<details>`, which is the whole reason the component listens.
    const host = tabsFor("/wiki/ada");
    const menu = openMenu(host);
    expect(menu.open).toBe(true);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(menu.open).toBe(false);
    // Escape from a menu that stranded focus on a hidden item would leave a
    // keyboard user with nowhere to Tab from.
    expect(document.activeElement).toBe(summaryIn(host));
  });

  it("ignores Escape when it is already closed", () => {
    // Otherwise it would steal focus from whatever a reader was doing
    // elsewhere on the page.
    tabsFor("/wiki/ada");
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(document.activeElement).toBe(elsewhere);
  });

  it("closes when something else is pressed", () => {
    const host = tabsFor("/wiki/ada");
    const menu = openMenu(host);

    act(() => {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(menu.open).toBe(false);
  });

  it("stays open when the press is inside it", () => {
    const host = tabsFor("/wiki/ada");
    const menu = openMenu(host);

    act(() => {
      menu.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(menu.open).toBe(true);
  });

  it("closes on arriving somewhere new", () => {
    // The row lives in the shell, which survives a navigation between views of
    // the same entry — so without this the menu would hang open over the page
    // it just opened.
    const host = tabsFor("/wiki/ada");
    const menu = openMenu(host);

    act(() => {
      rerender(host, <ArticleTabs pathname="/wiki/ada/edit" />);
    });

    expect(menu.open).toBe(false);
    expect(summaryIn(host).textContent).toContain("Edit");
  });

  it("takes the row away with it when the path stops being an article", () => {
    // Navigating from an entry to `/tree` leaves this component mounted with
    // nothing to render, and its document listeners still attached. They have
    // to cope with a menu that is no longer there rather than throwing on the
    // next Escape anyone presses.
    const host = tabsFor("/wiki/ada");
    openMenu(host);

    act(() => {
      rerender(host, <ArticleTabs pathname="/tree" />);
    });

    expect(host.innerHTML).toBe("");
    expect(() => {
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
    }).not.toThrow();
  });
});
