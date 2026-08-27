import { describe, expect, it } from "vitest";

import { summariseUnknownTags } from "@/lib/gedcom-report";

/**
 * `summariseUnknownTags`, exercised for the first time (E6-T1, `YEO-46`;
 * `YEO-116` for the tie-break). Nothing imported it before this file — grep
 * confirms it — so the tests below cover the function's stated behaviour as
 * well as the one thing this ticket touched.
 */
describe("summariseUnknownTags", () => {
  it("counts repeated sightings of the same path as one row", () => {
    const rows = summariseUnknownTags([
      { path: "INDI.SOUR", line: 10 },
      { path: "INDI.SOUR", line: 40 },
      { path: "INDI.SOUR", line: 90 },
    ]);

    expect(rows).toEqual([
      { path: "INDI.SOUR", tag: "SOUR", count: 3, firstLine: 10 },
    ]);
  });

  it("keeps the same four letters apart when they sit under different records", () => {
    // `NOTE` under `INDI` is a note about a person; `NOTE` under `FAM.MARR` is
    // a note about a wedding. Merging them on the bare tag would conflate two
    // different facts the report is supposed to tell apart.
    const rows = summariseUnknownTags([
      { path: "INDI.NOTE", line: 1 },
      { path: "FAM.MARR.NOTE", line: 2 },
    ]);

    expect(rows.map((row) => row.path)).toEqual(["FAM.MARR.NOTE", "INDI.NOTE"]);
    expect(rows.every((row) => row.tag === "NOTE")).toBe(true);
  });

  it("orders rows by count descending, most-common first", () => {
    const rows = summariseUnknownTags([
      { path: "INDI._RIN", line: 1 },
      { path: "INDI.SOUR", line: 2 },
      { path: "INDI.SOUR", line: 3 },
    ]);

    expect(rows.map((row) => row.path)).toEqual(["INDI.SOUR", "INDI._RIN"]);
  });

  it("keeps the earliest line a path was sighted at", () => {
    // The function's own comment explains why this is written as an explicit
    // `if` rather than a call to `Math.min`: the walk that produces the
    // sightings is always in file order in production, so in practice the
    // first sighting already is the smallest. The comparison still has to be
    // correct on its own terms regardless of the order the sightings arrive
    // in — this asserts that, rather than only the file-order case the
    // caller happens to provide.
    const rows = summariseUnknownTags([
      { path: "INDI.SOUR", line: 5 },
      { path: "INDI.SOUR", line: 2 },
    ]);

    expect(rows[0].firstLine).toBe(2);
  });

  it("returns nothing for a file with no unknown tags", () => {
    expect(summariseUnknownTags([])).toEqual([]);
  });

  /**
   * The tie-break (`YEO-116`). Two paths with the same count used to break
   * their tie with `a.path.localeCompare(b.path)`; a GEDCOM tag path is a
   * machine identifier `components/GedcomImport.tsx` renders inside `<code>`,
   * never text read as an alphabet, so the comparison only has to be the same
   * one twice — exactly what `compareIds` guarantees and collation does not.
   */
  describe("the path tie-break does not move with the runtime's locale", () => {
    /**
     * Same four locales the rest of the codebase's paired guards use: `en` is
     * the default most developers run under, `sv` reorders letters at the end
     * of its alphabet, `tr` has its own rules for dotted and dotless `i`, and
     * `de-DE-u-co-phonebk` is a non-default collation of a locale that also
     * has a default one.
     */
    const locales = ["en-US", "sv-SE", "tr-TR", "de-DE-u-co-phonebk"];

    it("uses paths that collation really does order the other way", () => {
      // Guards the fixture below: if ICU ever stopped disagreeing with code
      // units on these two paths, the pinning test would keep passing while
      // testing nothing.
      for (const locale of locales) {
        expect(
          new Intl.Collator(locale).compare("INDI._ZETA", "INDI._apple"),
        ).toBeGreaterThan(0);
      }
    });

    it("orders two equally-common paths by code unit, not by collation", () => {
      const rows = summariseUnknownTags([
        { path: "INDI._apple", line: 1 },
        { path: "INDI._ZETA", line: 2 },
      ]);

      // `INDI._ZETA` first is the code-unit answer — every locale above would
      // put `INDI._apple` first instead.
      expect(rows.map((row) => row.path)).toEqual([
        "INDI._ZETA",
        "INDI._apple",
      ]);
    });
  });
});
