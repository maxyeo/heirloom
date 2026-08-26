import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * That `lib/export-tree.ts` reads the database in three places and no more
 * (`YEO-101`).
 *
 * ## What this is protecting
 *
 * `lib/export-tree.db.test.ts` guards the property the export's docblock
 * argues — that each `orderBy` ends on a primary key, so the order is total —
 * by compiling the module's three named builders and reading their SQL. That
 * guard is only worth its length while those builders are the queries the
 * export actually runs. `YEO-94` got that for free: it wrapped `db` in a
 * `Proxy` and saw whatever `exportTreeAsGedcom` ran, whatever that was.
 * Naming the builders bought seventy lines back and gave the property up,
 * because nothing then stops a fourth query being written inline beside the
 * three the guard knows about — at which point the guard is decorative and
 * the refactor has made things worse than the proxy it removed.
 *
 * So: three `select` call sites. A fourth is either a query the guard cannot
 * see, or a second declaration of one it can, and both are the failure this
 * exists to name. The fix in either case is the same — give the new read a
 * name beside the others and add it to the guard's `TABLES`.
 *
 * ## Why it reads the text
 *
 * Because the claim is about the source rather than about a result: two
 * copies of the same query behave identically, which is exactly why the drift
 * they cause is quiet. The precedent is `app/auth-boundary.test.ts`, which
 * reads every route for the same kind of reason.
 *
 * It is in the unit suite because it needs no database — reading a file is
 * all it does. Importing the module would drag `@/db` and postgres.js into
 * `npm test`, which docs/testing.md forbids.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("./export-tree.ts", import.meta.url)),
  "utf8",
);

describe("the reads it declares", () => {
  it("has one select per table, and the SQL guard compiles all three", () => {
    expect(
      SOURCE.match(/\.select\(/g) ?? [],
      "lib/export-tree.ts should call `select` exactly three times, once in " +
        "each of `individualsQuery`, `unionsQuery` and `unionChildrenQuery`. " +
        "A fourth is a read `lib/export-tree.db.test.ts` does not compile, so " +
        "its `order by` is unguarded — name it beside the others and add its " +
        "table to that file's `TABLES`.",
    ).toHaveLength(3);
  });
});
