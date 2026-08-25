import { describe, expect, it } from "vitest";

import {
  compareRowCounts,
  missingTables,
  parseManifest,
  summariseDump,
} from "@/db/dump-manifest";

/**
 * A `pg_dump --format=plain` file, shortened to the parts this module reads.
 * The shape is copied from a real dump of this schema rather than invented,
 * including the `\restrict` line modern pg_dump emits and the fact that the
 * completion footer is not the last line of the file.
 */
function dump({
  rows = ["1\tRose\n2\tWalter"],
  complete = true,
}: { rows?: string[]; complete?: boolean } = {}) {
  return [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "",
    "SET statement_timeout = 0;",
    "",
    "CREATE SCHEMA drizzle;",
    "",
    "COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;",
    "1\tabc\t1700000000000",
    "\\.",
    "",
    "COPY public.individuals (id, given_name) FROM stdin;",
    ...rows,
    "\\.",
    "",
    "COPY public.pages (id, slug) FROM stdin;",
    "\\.",
    "",
    ...(complete
      ? [
          "--",
          "-- PostgreSQL database dump complete",
          "--",
          "",
          "\\unrestrict abc",
        ]
      : []),
  ].join("\n");
}

describe("summariseDump", () => {
  it("counts the rows in each COPY block, including empty ones", () => {
    expect(summariseDump(dump()).tables).toEqual({
      "drizzle.__drizzle_migrations": 1,
      "public.individuals": 2,
      // Present and empty is not the same as absent — `missingTables` relies
      // on this to tell a new install from a dump of the wrong database.
      "public.pages": 0,
    });
    expect(summariseDump(dump()).totalRows).toBe(3);
  });

  it("recognises the completion footer", () => {
    expect(summariseDump(dump()).complete).toBe(true);
    expect(summariseDump(dump()).truncated).toBe(false);
  });

  it("reports a dump with no footer as incomplete", () => {
    const summary = summariseDump(dump({ complete: false }));
    expect(summary.complete).toBe(false);
    // Every COPY block still closed, so it is not truncated mid-block — the
    // file was cut after the last one. Both are failures; they are different
    // failures.
    expect(summary.truncated).toBe(false);
  });

  it("reports a dump cut off inside a COPY block as truncated", () => {
    const cut = dump().split("\n").slice(0, 10).join("\n");
    const summary = summariseDump(cut);
    expect(summary.truncated).toBe(true);
    expect(summary.complete).toBe(false);
  });

  // The regression that matters most here. Row data is arbitrary text, so a
  // notes field can contain anything a person typed — including something
  // that looks exactly like the statements around it. Reading those as SQL
  // would move every following row into the wrong table's count, and the
  // count is the whole basis on which a restore is declared good.
  it("does not read table data as SQL", () => {
    const summary = summariseDump(
      dump({
        rows: [
          "1\tCOPY public.evil (id) FROM stdin;",
          "2\t-- PostgreSQL database dump complete",
          "3\tRose",
        ],
      }),
    );
    expect(summary.tables["public.individuals"]).toBe(3);
    expect(summary.tables).not.toHaveProperty("public.evil");
  });

  it("counts a COPY block with no column list", () => {
    const summary = summariseDump(
      ["COPY public.pages FROM stdin;", "1\tx", "\\."].join("\n"),
    );
    expect(summary.tables["public.pages"]).toBe(1);
  });
});

describe("missingTables", () => {
  it("reports only tables the dump does not contain at all", () => {
    const present = { "public.pages": 0, "public.individuals": 3 };
    expect(
      missingTables(
        ["public.pages", "public.individuals", "drizzle.__drizzle_migrations"],
        present,
      ),
    ).toEqual(["drizzle.__drizzle_migrations"]);
  });

  it("does not treat an empty table as missing", () => {
    expect(missingTables(["public.pages"], { "public.pages": 0 })).toEqual([]);
  });
});

describe("compareRowCounts", () => {
  it("says nothing when the counts agree", () => {
    expect(compareRowCounts({ a: 1, b: 0 }, { a: 1, b: 0 })).toEqual([]);
  });

  it("reports every disagreement rather than the first", () => {
    const differences = compareRowCounts(
      { "public.pages": 2, "public.unions": 4 },
      { "public.pages": 1, "public.unions": 0 },
    );
    expect(differences).toHaveLength(2);
    expect(differences[0]).toContain("public.pages");
    expect(differences[1]).toContain("public.unions");
  });

  it("reports a table the restore did not create", () => {
    const [difference] = compareRowCounts({ "public.pages": 2 }, {});
    expect(difference).toMatch(/no such table/);
  });

  // The direction that catches a restore into a database that was not empty:
  // every expected count can match while extra rows sit in a table the dump
  // never carried.
  it("reports a table the dump did not carry", () => {
    const [difference] = compareRowCounts({}, { "public.leftovers": 7 });
    expect(difference).toMatch(/did not carry/);
  });
});

describe("parseManifest", () => {
  const valid = {
    formatVersion: 1,
    takenAt: "2026-08-25T05:35:24.080Z",
    source: "DATABASE_URL",
    host: "localhost:5432",
    dumpFile: "heirloom-20260825T053524Z.sql.gz",
    bytes: 3335,
    sha256: "d9ec",
    tables: { "public.pages": 1 },
    totalRows: 1,
  };

  it("accepts a manifest this version wrote", () => {
    expect(parseManifest(valid, "m.json")).toEqual(valid);
  });

  it("refuses a future format version instead of guessing", () => {
    expect(() =>
      parseManifest({ ...valid, formatVersion: 2 }, "m.json"),
    ).toThrow(/formatVersion/);
  });

  // Without this, a restore would compare its row counts against `undefined`
  // and report success for a database it had checked nothing about.
  it("refuses a manifest with no tables", () => {
    const withoutTables: Record<string, unknown> = { ...valid };
    delete withoutTables.tables;
    expect(() => parseManifest(withoutTables, "m.json")).toThrow(/tables/);
  });

  it("refuses a row count that is not a count", () => {
    expect(() =>
      parseManifest({ ...valid, tables: { "public.pages": "1" } }, "m.json"),
    ).toThrow(/row count/);
  });

  it("names the file it could not read", () => {
    expect(() => parseManifest([], "backup.manifest.json")).toThrow(
      /backup\.manifest\.json/,
    );
  });
});
