import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
  type ImportResponse,
  isImportDone,
  isImportPreview,
  writtenCounts,
} from "@/lib/import-endpoint";
import type { ImportPreview } from "@/lib/import-preview";

/**
 * The import contract (E6-T3, `YEO-48`).
 *
 * `lib/search-endpoint.test.ts` is the model, and the reason for both is the
 * same: the two ends of a network boundary can typecheck perfectly and still
 * disagree in the middle. What is pinned here is the vocabulary itself — the
 * URL, the two field names, and the narrowing — plus a tripwire that the two
 * ends really do read them from this module rather than from their own
 * copies.
 */

const ROUTE = "app/api/import/route.ts";
const SCREEN = "components/GedcomImport.tsx";

function source(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("the vocabulary", () => {
  it("names one endpoint and two fields", () => {
    // Asserted as literals, which is the point of a contract: changing one of
    // these is a deliberate edit to a shape two files depend on, not a rename
    // that happens to compile.
    expect(IMPORT_ENDPOINT).toBe("/api/import");
    expect(IMPORT_FILE_FIELD).toBe("file");
    expect(IMPORT_CONFIRM_FIELD).toBe("confirm");
  });

  it("keeps the two fields distinct", () => {
    // The one collision that would be catastrophic rather than annoying: if
    // consent travelled under the same name as the file, every preview would
    // be an import.
    expect(IMPORT_FILE_FIELD).not.toBe(IMPORT_CONFIRM_FIELD);
  });
});

describe("narrowing an answer", () => {
  const preview = {
    stage: "preview",
    digest: "abc",
    preview: {} as ImportPreview,
  } as const;

  const done = {
    stage: "imported",
    written: { people: 2, unions: 1, children: 1 },
  } as const;

  it("recognises a preview", () => {
    expect(isImportPreview(preview)).toBe(true);
  });

  it("recognises a finished import", () => {
    expect(isImportDone(done)).toBe(true);
  });

  it("keeps the two stages apart", () => {
    // The distinction the whole two-request shape rests on: one of these
    // wrote nothing and the other wrote everything, and a screen that
    // confused them would tell somebody their tree was untouched when it was
    // not.
    expect(isImportPreview(done)).toBe(false);
    expect(isImportDone(preview)).toBe(false);
  });

  it("does not mistake a refusal for either", () => {
    const refusals: ImportResponse[] = [
      { error: "That file is too large." },
      { error: "The import did not finish, and nothing was written." },
    ];

    for (const refusal of refusals) {
      expect(isImportPreview(refusal)).toBe(false);
      expect(isImportDone(refusal)).toBe(false);
    }
  });
});

describe("the two vocabularies for three numbers", () => {
  it("reads the tables' counts as the screen's", () => {
    // E6-T3 named these for the screen and E6-T4 for the tables, and the
    // translation is the seam between them. Asserted as literals because a
    // field that lands in the wrong slot — unions and children swapped — is
    // a report that typechecks and lies.
    expect(
      writtenCounts({ individuals: 148, unions: 62, unionChildren: 201 }),
    ).toEqual({ people: 148, unions: 62, children: 201 });
  });
});

describe("both ends read the contract rather than restating it", () => {
  // The failure this catches is the one a type system cannot: a URL or a field
  // name written out again in one of the two files, which typechecks on both
  // sides and is wrong in the middle. Same shape as
  // `lib/sanitize-html.call-sites.test.ts`.
  for (const file of [ROUTE, SCREEN]) {
    it(`${file} imports it`, () => {
      expect(source(file)).toContain('from "@/lib/import-endpoint"');
    });

    it(`${file} spells out no URL or field name of its own`, () => {
      const text = source(file);
      // Quoted, so the prose in the docblocks — which names these files by
      // path — is not mistaken for a call site.
      expect(text).not.toMatch(/["'`]\/api\/import["'`]/);
      expect(text).not.toMatch(/\bget\(["']confirm["']\)/);
      expect(text).not.toMatch(/\bset\(["']file["']/);
    });
  }
});
