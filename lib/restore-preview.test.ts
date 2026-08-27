import { describe, expect, it } from "vitest";

import type { NamedCategory } from "@/lib/category-name";
import {
  filingOf,
  recordedFilingOf,
  restoreWouldChangeNothing,
  type RestorableContent,
} from "@/lib/restore-preview";

/**
 * The decision behind the restore confirmation's button (E1-T7, `YEO-21`;
 * `YEO-106` for the filing, `YEO-117` for comparing it by slug).
 *
 * This exists because the route that asks the question cannot be tested — an
 * `async` Server Component — and the version of it that used to live inline in
 * that route compared the title and the body and nothing else. That was
 * already wrong for a hatnote (E11-T9) and became wrong for a filing with
 * `YEO-106`: it answered "there is nothing to restore" and hid the form for a
 * restore the engine would have performed. Every assertion below is a case
 * that inline check got wrong, plus the two `YEO-117` closes.
 */

/**
 * `categories` holds *slugs* here, not names — that is what both sides are
 * canonicalised to before they meet. See {@link filingOf} for where the live
 * side's come from and {@link recordedFilingOf} for the recorded side's.
 */
const BASE: RestorableContent = {
  title: "Rose Hall",
  bodyHtml: "<p>One. Two.</p>",
  hatnote: "",
  categories: ["whitfield-family"],
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
        changed({ categories: ["whitfield-family", "emigrated-to-canada"] }),
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
        changed({ categories: ["emigrated-to-canada"] }),
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
    const entry = changed({ categories: ["ada", "zoe"] });
    const revision = changed({ categories: ["zoe", "ada"] });

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

  it("sees a re-filing between two categories that share a display name", () => {
    /**
     * The `YEO-117` case, and the one that separates comparing slugs from
     * comparing names. `categories.slug` is unique and `categories.name` is
     * deliberately not, so two rows *can* share a display name — not through
     * the picker, where a name determines a slug, but through a row inserted
     * by hand whose `slug` is not `categorySlug(name)`.
     *
     * The entry is filed under that hand-written row. Restoring the revision
     * resolves `categorySlug("Whitfield family")` and files the entry under
     * the ordinary row instead, which is a real re-filing and which
     * `setEntryCategories` reports as `changed`. Comparing the names called it
     * "there is nothing to restore" and hid the form — the same failure
     * `YEO-106` fixed, reached from the other side.
     */
    const entry = changed({
      categories: filingOf([
        { name: "Whitfield family", slug: "whitfield-family-by-hand" },
      ]),
    });
    const revision = changed({
      categories: recordedFilingOf(["Whitfield family"]),
    });

    expect(entry.categories).not.toEqual(revision.categories);
    expect(restoreWouldChangeNothing(entry, revision)).toBe(false);
  });

  it("is unmoved by a recorded spelling that resolves to the row already filed", () => {
    /**
     * The same divergence in the other direction. A revision recording
     * "Whitfield Family" resolves to the slug the entry is already filed
     * under, so `setEntryCategories` moves no row and `restoreRevision`
     * refuses with `unchanged`. Comparing names would have offered a button
     * that submits and comes back with a refusal.
     */
    const entry = changed({
      categories: filingOf([
        { name: "Whitfield family", slug: "whitfield-family" },
      ]),
    });
    const revision = changed({
      categories: recordedFilingOf(["Whitfield Family"]),
    });

    expect(restoreWouldChangeNothing(entry, revision)).toBe(true);
  });
});

describe("filingOf", () => {
  it("takes the slugs off the rows a live filing arrives as", () => {
    const rows: NamedCategory[] = [
      { name: "Emigrated to Canada", slug: "emigrated-to-canada" },
      { name: "Whitfield family", slug: "whitfield-family" },
    ];

    expect(filingOf(rows)).toEqual(["emigrated-to-canada", "whitfield-family"]);
  });

  it("keeps the row's stored slug rather than re-deriving one from its name", () => {
    /**
     * The entry is filed under the *row*, so the row's own address identifies
     * it — which is what makes this side agree with the ids
     * `setEntryCategories` compares even when a hand-written row's `slug` and
     * `name` disagree.
     */
    expect(
      filingOf([{ name: "Whitfield family", slug: "something-else" }]),
    ).toEqual(["something-else"]);
  });

  it("is empty for an entry filed under nothing", () => {
    expect(filingOf([])).toEqual([]);
  });
});

describe("recordedFilingOf", () => {
  it("resolves recorded names to the slugs a restore would file under", () => {
    expect(
      recordedFilingOf(["Whitfield family", "Emigrated to Canada"]),
    ).toEqual(["whitfield-family", "emigrated-to-canada"]);
  });

  it("collapses two spellings of one category, exactly as the write does", () => {
    // `normaliseEntryCategories` de-duplicates by slug, which is what lets
    // `sameFiling` compare sizes instead of sorting.
    expect(recordedFilingOf(["Whitfield family", "Whitfield  Family"])).toEqual(
      ["whitfield-family"],
    );
  });

  it("drops a name that has no slug, because the restore would drop it too", () => {
    // `categorySlug` refuses a name with no letter or digit in it, so
    // `setEntryCategories` files the entry under nothing for that name. A
    // preview that kept it would report a difference no restore can settle.
    expect(recordedFilingOf(["Whitfield family", "!!!"])).toEqual([
      "whitfield-family",
    ]);
  });

  it("is empty for a revision that recorded no filing", () => {
    expect(recordedFilingOf([])).toEqual([]);
  });
});
