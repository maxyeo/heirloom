import { describe, expect, it } from "vitest";

import {
  authorColumns,
  IMPORT_AUTHOR,
  INDIVIDUAL_AUTHOR_SOURCES,
  individualAuthorEmail,
  memberAuthor,
} from "@/lib/individual-author";

/**
 * The two columns `individuals` gained in `YEO-104`, checked as arithmetic
 * over plain values — which is the whole reason the module has no imports and
 * lives in `lib/` rather than beside the schema. `npm test` has no
 * `DATABASE_URL` (docs/testing.md), and the mapping from "who did this" to
 * "what is written" is the part of this ticket most worth having in the suite
 * that gates a merge.
 *
 * What a real Postgres has to answer instead — that the column is `not null`
 * with no default, and that each write path actually reaches these functions
 * — is `db/individual-author.db.test.ts`.
 */

describe("authorColumns", () => {
  it("writes a member's email beside the member source", () => {
    expect(authorColumns(memberAuthor("rose@example.com"))).toEqual({
      createdBySource: "member",
      createdBy: "rose@example.com",
    });
  });

  /**
   * The ticket's explicit question about the GEDCOM import, as an assertion
   * rather than as a paragraph: an imported row stores no email, because
   * `import_id` already points at a ledger row that records who ran the file.
   * A change that started copying the importer's address onto every imported
   * person would fail here — which is the point, since it would look like an
   * improvement.
   */
  it("stores no email for an import, whose author is derived", () => {
    expect(authorColumns(IMPORT_AUTHOR)).toEqual({
      createdBySource: "import",
      createdBy: null,
    });
  });

  it("never produces the legacy source, which only the migration writes", () => {
    // `legacy` means "this row predates the column", and the day this
    // function can produce one is the day that stops being true of it.
    const produced = [
      authorColumns(memberAuthor("rose@example.com")),
      authorColumns(IMPORT_AUTHOR),
    ].map((columns) => columns.createdBySource);

    expect(produced).not.toContain("legacy");
    // And `legacy` is still a value the column can hold, so the assertion
    // above is about this function rather than about a label nobody defined.
    expect(INDIVIDUAL_AUTHOR_SOURCES).toContain("legacy");
  });
});

describe("individualAuthorEmail", () => {
  it("names the member who added a person", () => {
    expect(
      individualAuthorEmail({
        createdBySource: "member",
        createdBy: "rose@example.com",
      }),
    ).toBe("rose@example.com");
  });

  /**
   * Three rows with nothing to say, and the assertion is `undefined` in all
   * three — never a string, and never `null`. A `null` here would be a value
   * a renderer could hand to `formatChangeAuthor` and get "Unknown" from,
   * which reads as a name that went missing rather than as a row from before
   * anybody was recorded.
   */
  it.each([
    ["a row from before the column existed", "legacy" as const, null],
    ["a row a GEDCOM import wrote", "import" as const, null],
    [
      "a row an import wrote that somehow carries an email",
      "import" as const,
      "walter@example.com",
    ],
    [
      "a member row whose email a hand-run UPDATE removed",
      "member" as const,
      null,
    ],
  ])("names nobody for %s", (_case, createdBySource, createdBy) => {
    expect(
      individualAuthorEmail({ createdBySource, createdBy }),
    ).toBeUndefined();
  });
});
