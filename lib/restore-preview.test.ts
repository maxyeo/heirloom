import { describe, expect, it } from "vitest";

import type { NamedCategory } from "@/lib/category-name";
import {
  filingOf,
  restoreWouldChangeNothing,
  type RestorableContent,
} from "@/lib/restore-preview";

/**
 * The decision behind the restore confirmation's button (E1-T7, `YEO-21`;
 * `YEO-106` for the filing).
 *
 * This exists because the route that asks the question cannot be tested — an
 * `async` Server Component — and the version of it that used to live inline in
 * that route compared the title and the body and nothing else. That was
 * already wrong for a hatnote (E11-T9) and became wrong for a filing with
 * `YEO-106`: it answered "there is nothing to restore" and hid the form for a
 * restore the engine would have performed. Every assertion below is a case
 * that inline check got wrong.
 */

const BASE: RestorableContent = {
  title: "Rose Hall",
  bodyHtml: "<p>One. Two.</p>",
  hatnote: "",
  categories: ["Whitfield family"],
};

/** `BASE` with one field moved. */
const changed = (patch: Partial<RestorableContent>): RestorableContent => ({
  ...BASE,
  ...patch,
});

describe("restoreWouldChangeNothing", () => {
  it("is true when all four fields already agree", () => {
    expect(restoreWouldChangeNothing(BASE, { ...BASE })).toBe(true);
  });

  it("sees a title that differs", () => {
    expect(
      restoreWouldChangeNothing(BASE, changed({ title: "Rose Hale" })),
    ).toBe(false);
  });

  it("sees a body that differs", () => {
    expect(
      restoreWouldChangeNothing(BASE, changed({ bodyHtml: "<p>One.</p>" })),
    ).toBe(false);
  });

  it("sees a hatnote that differs", () => {
    // Wrong in the route from E11-T9 until now: a hatnote-only restore was
    // offered no button at all.
    expect(
      restoreWouldChangeNothing(BASE, changed({ hatnote: "Not the ship." })),
    ).toBe(false);
  });

  it("sees a filing that gained a category", () => {
    // The blocker `YEO-106` introduced and this function closes.
    expect(
      restoreWouldChangeNothing(
        BASE,
        changed({ categories: ["Whitfield family", "Emigrated to Canada"] }),
      ),
    ).toBe(false);
  });

  it("sees a filing that lost a category", () => {
    expect(restoreWouldChangeNothing(BASE, changed({ categories: [] }))).toBe(
      false,
    );
  });

  it("sees a filing that swapped one category for another", () => {
    // Same size, different members — the case a length comparison alone would
    // call unchanged.
    expect(
      restoreWouldChangeNothing(
        BASE,
        changed({ categories: ["Emigrated to Canada"] }),
      ),
    ).toBe(false);
  });

  it("ignores the order of a filing", () => {
    /**
     * The two sides genuinely arrive ordered differently: a revision holds its
     * filing in canonical slug order, while the entry side comes from
     * `readEntryCategories`, which sorts for a reader by name. Comparing as
     * arrays would offer a restore that changes nothing.
     */
    const entry = changed({ categories: ["Ada", "Zoe"] });
    const revision = changed({ categories: ["Zoe", "Ada"] });

    expect(restoreWouldChangeNothing(entry, revision)).toBe(true);
  });

  it("does not trim or sanitise, so it errs towards offering the restore", () => {
    /**
     * `restoreRevision` compares the values it would actually write, after
     * `trim` and `sanitizeHtml`. This compares what is stored. For a row that
     * predates the sanitiser the two disagree, and this is the harmless
     * direction: the button is offered, the write turns out to rewrite only
     * the stored markup, and that is a real change which does get recorded.
     */
    const entry = changed({ bodyHtml: "<p>One. Two.</p>" });
    const revision = changed({ bodyHtml: "<p>One. Two.</p> " });

    expect(restoreWouldChangeNothing(entry, revision)).toBe(false);
  });
});

describe("filingOf", () => {
  it("takes the names off the rows a live filing arrives as", () => {
    const rows: NamedCategory[] = [
      { name: "Emigrated to Canada", slug: "emigrated-to-canada" },
      { name: "Whitfield family", slug: "whitfield-family" },
    ];

    expect(filingOf(rows)).toEqual(["Emigrated to Canada", "Whitfield family"]);
  });

  it("is empty for an entry filed under nothing", () => {
    expect(filingOf([])).toEqual([]);
  });
});
