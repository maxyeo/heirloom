import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { schemaAccess, schemaAccessOfSource } from "@/test/route-inventory";

/**
 * `schemaAccess`, against fixtures (`YEO-124`).
 *
 * `lib/pages.call-sites.test.ts` runs this checker over every source file in
 * the application and expects it to find nothing worth reporting, which is
 * the right answer and proves almost nothing about the checker. Every branch
 * that finds something is unreachable from this repository — deliberately, because
 * the guard next door is what keeps it that way — so the shapes below
 * are the only place those branches are ever executed.
 *
 * The split of labour is worth stating, because both files have fixtures. This
 * one is about *reporting*: what the checker says it saw. The rule about which
 * of those readings is a violation lives in `otherDoors` beside the assertion
 * that applies it, and is tested there. A reader wanting to know whether an
 * import is allowed should be reading that file, not this one.
 */

describe("what a module imports from the schema", () => {
  it("the spelling the whole application uses", () => {
    const source = `import { db, schema } from "@/db";`;
    expect(schemaAccessOfSource(source)).toEqual({
      imports: [
        { module: "@/db", exported: "db", local: "db", typeOnly: false },
        {
          module: "@/db",
          exported: "schema",
          local: "schema",
          typeOnly: false,
        },
      ],
      relational: [],
    });
  });

  it("a bare table import, which is the shape the guard exists for", () => {
    const source = `import { pages } from "@/db/schema";`;
    expect(schemaAccessOfSource(source).imports).toEqual([
      {
        module: "@/db/schema",
        exported: "pages",
        local: "pages",
        typeOnly: false,
      },
    ]);
  });

  it("an alias, reported under both names", () => {
    // The export's own name is what a rule can be written against; the local
    // name is what the module actually says. Collapsing them either way would
    // make one of the two rules in `otherDoors` unwritable.
    const source = `import { pages as entries } from "@/db/schema";`;
    expect(schemaAccessOfSource(source).imports).toEqual([
      {
        module: "@/db/schema",
        exported: "pages",
        local: "entries",
        typeOnly: false,
      },
    ]);
  });

  it("a namespace import, reported as `*`", () => {
    const source = `import * as tables from "@/db/schema";`;
    expect(schemaAccessOfSource(source).imports).toEqual([
      {
        module: "@/db/schema",
        exported: "*",
        local: "tables",
        typeOnly: false,
      },
    ]);
  });

  it("a default import, which neither schema module has to offer", () => {
    // No file in the tree can be written this way, which is why the branch is
    // tested here rather than trusted: nothing else executes it. What it
    // records is a door in `otherDoors` (`YEO-127`), so the two halves have
    // to agree on the spelling `"default"`.
    const source = `import database from "@/db";`;
    expect(schemaAccessOfSource(source).imports).toEqual([
      {
        module: "@/db",
        exported: "default",
        local: "database",
        typeOnly: false,
      },
    ]);
  });

  it("a default import alongside named ones, in source order", () => {
    // The clause has two halves and the checker reads them in the order they
    // are written, so a module using both is reported as one list rather than
    // as a default import that displaced the names beside it.
    const source = `import database, { schema } from "@/db";`;
    expect(schemaAccessOfSource(source).imports).toEqual([
      {
        module: "@/db",
        exported: "default",
        local: "database",
        typeOnly: false,
      },
      {
        module: "@/db",
        exported: "schema",
        local: "schema",
        typeOnly: false,
      },
    ]);
  });

  it("both kinds of type-only import", () => {
    // Two spellings, one meaning, and a checker that understood only the
    // statement form would report the inline one as a live way into the
    // table — a false failure against a line there is no reason not to write.
    const source = `
      import type { pages } from "@/db/schema";
      import { type revisions, SEARCH_TEXT_CONFIG } from "@/db/schema";
    `;
    expect(schemaAccessOfSource(source).imports).toEqual([
      {
        module: "@/db/schema",
        exported: "pages",
        local: "pages",
        typeOnly: true,
      },
      {
        module: "@/db/schema",
        exported: "revisions",
        local: "revisions",
        typeOnly: true,
      },
      {
        module: "@/db/schema",
        exported: "SEARCH_TEXT_CONFIG",
        local: "SEARCH_TEXT_CONFIG",
        typeOnly: false,
      },
    ]);
  });

  it("ignores every other module", () => {
    // `@/db` is a prefix of nothing else in this repository today, but a
    // checker matching by prefix would quietly take `@/db-utils` with it.
    const source = `
      import { eq } from "drizzle-orm";
      import { LIVE_PAGES } from "@/lib/live-pages";
      import * as schema from "./schema";
    `;
    expect(schemaAccessOfSource(source)).toEqual({
      imports: [],
      relational: [],
    });
  });
});

describe("Drizzle's relational query API", () => {
  it("is reported with the table it names", () => {
    const source = `
      import { db } from "@/db";
      export const all = () => db.query.pages.findMany();
    `;
    expect(schemaAccessOfSource(source).relational).toEqual(["db.query.pages"]);
  });

  it("is reported once, not once per link in the chain", () => {
    // `db.query.pages` contains `db.query`, and the walk meets the outer node
    // first. Without the bookkeeping in the checker, one query would be two
    // findings under two names, and the second would look like a second
    // offence to anybody reading the failure.
    const source = `
      import { db } from "@/db";
      export const one = () => db.query.pages.findFirst();
      export const many = () => db.query.revisions.findMany();
    `;
    expect(schemaAccessOfSource(source).relational).toEqual([
      "db.query.pages",
      "db.query.revisions",
    ]);
  });

  it("is reported when the table is chosen somewhere else", () => {
    // Handing `db.query` onward hides the table from this checker, which is
    // not an improvement on naming it — so the access itself is the finding.
    const source = `
      import { db } from "@/db";
      export const queries = db.query;
    `;
    expect(schemaAccessOfSource(source).relational).toEqual(["db.query"]);
  });

  it("follows the client's local name", () => {
    const source = `
      import { db as client } from "@/db";
      export const all = () => client.query.pages.findMany();
    `;
    expect(schemaAccessOfSource(source).relational).toEqual([
      "client.query.pages",
    ]);
  });

  it("is not confused by a `query` belonging to something else", () => {
    const source = `
      import { db } from "@/db";
      export const run = (client) => client.query("select 1");
    `;
    expect(schemaAccessOfSource(source).relational).toEqual([]);
  });
});

describe("against the tree rather than a fixture", () => {
  it("reads a real module the same way", () => {
    // The path half of the checker, which no fixture exercises. `lib/pages.ts`
    // is the module the guard next door names first, and the one that reaches
    // `@/db/schema` directly for a constant — so it covers both specifiers.
    expect(schemaAccess(join("lib", "pages.ts"))).toEqual({
      imports: [
        { module: "@/db", exported: "db", local: "db", typeOnly: false },
        {
          module: "@/db",
          exported: "schema",
          local: "schema",
          typeOnly: false,
        },
        {
          module: "@/db/schema",
          exported: "SEARCH_TEXT_CONFIG",
          local: "SEARCH_TEXT_CONFIG",
          typeOnly: false,
        },
      ],
      relational: [],
    });
  });
});
