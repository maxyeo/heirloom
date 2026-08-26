import { describe, expect, it } from "vitest";

import {
  categorySlug,
  compareCategoriesByName,
  compareCategoriesBySlug,
  MAX_CATEGORIES_PER_ENTRY,
  MAX_CATEGORY_NAME_LENGTH,
  normaliseCategoryName,
  normaliseEntryCategories,
} from "@/lib/category-name";
import { FALLBACK_SLUG } from "@/lib/entry-slug";

/**
 * What a category name is (E11-T8, `YEO-78`) is a pure function of a string,
 * so it is tested the way `lib/entry-slug.ts` and `lib/tree-layout.ts` are: a
 * literal in, a value out, no fixtures and no database. That is the whole
 * reason these decisions live in a module of their own rather than inside
 * `lib/categories.ts`, which imports `@/db` — see docs/testing.md.
 */

describe("normaliseCategoryName", () => {
  it("trims and collapses whitespace", () => {
    expect(normaliseCategoryName("  Whitfield   family  ")).toBe(
      "Whitfield family",
    );
  });

  it("collapses the newlines a paste carries in", () => {
    expect(normaliseCategoryName("Emigrated\nto\tCanada")).toBe(
      "Emigrated to Canada",
    );
  });

  it("leaves an ordinary name alone", () => {
    expect(normaliseCategoryName("Born in Kilkenny")).toBe("Born in Kilkenny");
  });

  it("reads a name of nothing but whitespace as no name at all", () => {
    expect(normaliseCategoryName("   \n ")).toBe("");
  });

  it("caps a very long name", () => {
    const long = "a".repeat(MAX_CATEGORY_NAME_LENGTH + 40);
    expect([...normaliseCategoryName(long)]).toHaveLength(
      MAX_CATEGORY_NAME_LENGTH,
    );
  });

  it("caps by code point, so it cannot split a surrogate pair", () => {
    // Every astral character is two UTF-16 units, so a cap applied by index
    // would cut one in half and leave a lone surrogate in the stored name.
    const long = "🌍".repeat(MAX_CATEGORY_NAME_LENGTH + 10);

    // Whole characters, exactly as many as the cap allows — which is the same
    // statement as "no lone surrogate survived", said in a form that reads.
    expect(normaliseCategoryName(long)).toBe(
      "🌍".repeat(MAX_CATEGORY_NAME_LENGTH),
    );
  });
});

describe("categorySlug", () => {
  it("derives the address the same way an entry title does", () => {
    expect(categorySlug("Whitfield family")).toBe("whitfield-family");
    expect(categorySlug("Émigrés")).toBe("emigres");
    expect(categorySlug("Buried at St Mary's")).toBe("buried-at-st-marys");
  });

  it("reads two spellings of one heading as one category", () => {
    // The whole of de-duplication: the unique index is on the slug, so these
    // are one row and the picker must not offer to create a second.
    expect(categorySlug("Whitfield Family")).toBe(
      categorySlug("whitfield  family"),
    );
  });

  it("refuses a name with no letter or digit in it", () => {
    /**
     * The case `slugFromTitle` cannot answer for a category. It is *total* —
     * it returns `FALLBACK_SLUG` rather than failing, because an entry's
     * author is given no slug field and creation must succeed on whatever they
     * typed. A category's slug is a de-duplication key with no collision
     * handling behind it, so inheriting that fallback would silently file
     * every unnameable category under one row.
     */
    expect(categorySlug("🙂")).toBeNull();
    expect(categorySlug("…")).toBeNull();
    expect(categorySlug("!!! ???")).toBeNull();

    // Named rather than implied: this is the value being refused.
    expect(FALLBACK_SLUG).toBe("entry");
  });

  it("keeps a non-Latin name rather than emptying it", () => {
    // A family wiki is exactly the place where this is not a corner case; see
    // `lib/entry-slug.ts`.
    expect(categorySlug("北京")).toBe("北京");
  });
});

describe("compareCategoriesByName", () => {
  const sorted = (names: string[]) =>
    names
      .map((name) => ({ name, slug: categorySlug(name) ?? "" }))
      .sort(compareCategoriesByName)
      .map((category) => category.name);

  it("orders the way a reader expects, not the way a byte comparison would", () => {
    // `C` collation would put every capital ahead of every lowercase and every
    // accent behind both. This is why the order is decided here and not by an
    // `ORDER BY` — see the comparator's own docblock.
    expect(sorted(["Zoe", "alice", "Émile", "Ada"])).toEqual([
      "Ada",
      "alice",
      "Émile",
      "Zoe",
    ]);
  });

  it("reads a digit run as a number", () => {
    expect(sorted(["Farm 10", "Farm 2", "Farm 1"])).toEqual([
      "Farm 1",
      "Farm 2",
      "Farm 10",
    ]);
  });

  it("is total, so a list cannot reshuffle between two reads", () => {
    // `name` is not unique in the schema — only `slug` is — so two rows can
    // share a display name and the order still has to be decided.
    const a = { name: "Kin", slug: "kin-a" };
    const b = { name: "Kin", slug: "kin-b" };

    expect(compareCategoriesByName(a, b)).toBeLessThan(0);
    expect(compareCategoriesByName(b, a)).toBeGreaterThan(0);
    expect(compareCategoriesByName(a, a)).toBe(0);
  });
});

describe("compareCategoriesBySlug", () => {
  const sorted = (names: string[]) =>
    names
      .map((name) => ({ name, slug: categorySlug(name) ?? "" }))
      .sort(compareCategoriesBySlug)
      .map((category) => category.name);

  it("consults no locale, so the same names sort the same way anywhere", () => {
    /**
     * The same four names the block above sorts, and the same answer — but
     * reached without asking anything about English. The slug has already
     * folded the case and the accent (`categorySlug`), so by the time this
     * comparator runs there is nothing left for a collator to have an opinion
     * about, and `<` on the result is defined by the language rather than by
     * the host's ICU data. That is the property `revisions.categories` needs
     * (`YEO-106`): two snapshots are compared by equality, so the same set of
     * categories has to serialise identically on a laptop and in a serverless
     * function.
     */
    expect(sorted(["Zoe", "alice", "Émile", "Ada"])).toEqual([
      "Ada",
      "alice",
      "Émile",
      "Zoe",
    ]);
  });

  it("does not read a digit run as a number, where the reader's order does", () => {
    // The visible divergence between the two comparators, and the reason both
    // exist. `compareCategoriesByName` puts "Farm 2" before "Farm 10" because
    // a reader expects it to; this one does not, because a canonical order has
    // nothing to gain from being clever and everything to lose from depending
    // on a collator option.
    expect(sorted(["Farm 10", "Farm 2", "Farm 1"])).toEqual([
      "Farm 1",
      "Farm 10",
      "Farm 2",
    ]);
  });

  it("is total, with no tie-break needed", () => {
    // The slug is the identity, so two categories cannot share one — there is
    // no tie for a second key to break. Consistency matters anyway:
    // `resolveCategories` sorts with this to take its locks in one order, and
    // an inconsistent comparator is a poor foundation for that.
    const a = { name: "Kin", slug: "kin-a" };
    const b = { name: "Kin", slug: "kin-b" };

    expect(compareCategoriesBySlug(a, b)).toBeLessThan(0);
    expect(compareCategoriesBySlug(b, a)).toBeGreaterThan(0);
    expect(compareCategoriesBySlug(a, a)).toBe(0);
  });
});

describe("normaliseEntryCategories", () => {
  it("normalises each name and keeps the author's order", () => {
    expect(
      normaliseEntryCategories(["  Emigrated to Canada ", "Whitfield family"]),
    ).toEqual([
      { name: "Emigrated to Canada", slug: "emigrated-to-canada" },
      { name: "Whitfield family", slug: "whitfield-family" },
    ]);
  });

  it("collapses duplicates by slug, keeping the first spelling", () => {
    // Not by name: these two would resolve to one `categories` row, and a list
    // that let both through would try to insert the same join row twice.
    expect(
      normaliseEntryCategories(["Whitfield family", "whitfield  FAMILY"]),
    ).toEqual([{ name: "Whitfield family", slug: "whitfield-family" }]);
  });

  it("drops a name that is only whitespace", () => {
    expect(normaliseEntryCategories(["  ", "Kin"])).toEqual([
      { name: "Kin", slug: "kin" },
    ]);
  });

  it("drops a name that can have no address", () => {
    expect(normaliseEntryCategories(["🙂", "Kin"])).toEqual([
      { name: "Kin", slug: "kin" },
    ]);
  });

  it("caps how many one entry may carry", () => {
    // The picker cannot produce more; a direct POST can, and an unbounded list
    // is an unbounded write inside the save transaction.
    const many = Array.from(
      { length: MAX_CATEGORIES_PER_ENTRY + 25 },
      (_, index) => `Category ${index}`,
    );

    const kept = normaliseEntryCategories(many);
    expect(kept).toHaveLength(MAX_CATEGORIES_PER_ENTRY);
    // The first N, so which ones survive is the author's order rather than an
    // accident of iteration.
    expect(kept[0].name).toBe("Category 0");
  });

  it("reads no categories as no categories, not as an error", () => {
    expect(normaliseEntryCategories([])).toEqual([]);
  });
});
