import { describe, expect, it } from "vitest";

import { compareIds } from "@/lib/compare-ids";

/**
 * `compareIds` itself (`YEO-111`, widened by `YEO-116`), moved out of
 * `lib/family-components.test.ts` when the function moved out of
 * `lib/family-components.ts` — `lib/gedcom-report.ts` needed a comparator
 * with a zero-import closure and `lib/family-components.ts` transitively
 * reaches `@/db` (see `lib/compare-ids.ts`'s own docblock).
 * `lib/family-components.test.ts` keeps the `connectedFamilies` tests, which
 * still exercise this function through that one.
 */
describe("compareIds", () => {
  it("orders by code unit, not by collation", () => {
    expect(compareIds("Zeta", "apple")).toBeLessThan(0);
    expect(compareIds("apple", "Zeta")).toBeGreaterThan(0);

    // Accents sit above `z` in code-unit order and below it in every
    // collation. Stated so that the file records what the comparator is,
    // rather than only that it is not `localeCompare`.
    expect(compareIds("élodie", "zoe")).toBeGreaterThan(0);
    expect(new Intl.Collator("en-US").compare("élodie", "zoe")).toBeLessThan(0);
  });

  it("returns 0 only for two strings that are identical", () => {
    /**
     * `Array.prototype.sort` is stable, so a comparator returning 0 keeps
     * input order — and every caller of this function reaches for it
     * precisely because it does not trust its input order (an unordered
     * `SELECT`, a `Map`'s iteration order, a file walked top to bottom). A 0
     * between two genuinely different values would quietly reintroduce
     * whichever of those the caller was written to escape.
     *
     * Collation could return one, which is the second reason this is not
     * `localeCompare`: a tailoring that ignores case or accents calls two
     * distinct strings equal. The pairs below are exactly those, and the
     * collators are shown doing it.
     */
    expect(compareIds("person-1", "person-1")).toBe(0);

    for (const [a, b] of [
      ["Ada", "ada"],
      ["resume", "résumé"],
      ["co-op", "coop"],
    ] as const) {
      expect(compareIds(a, b)).not.toBe(0);
      expect(compareIds(b, a)).not.toBe(0);
      expect(Math.sign(compareIds(a, b))).toBe(-Math.sign(compareIds(b, a)));
    }

    const blunt = new Intl.Collator("en-US", { sensitivity: "base" });
    expect(blunt.compare("Ada", "ada")).toBe(0);
    expect(blunt.compare("resume", "résumé")).toBe(0);
  });
});
