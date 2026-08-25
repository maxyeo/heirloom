import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_ENDPOINT,
  IMPORT_FILE_FIELD,
  IMPORT_PENDING_MESSAGE,
  IMPORT_PENDING_TICKET,
  type ImportResponse,
  isImportPreview,
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

  it("recognises a preview", () => {
    expect(isImportPreview(preview)).toBe(true);
  });

  it("does not mistake a refusal for one", () => {
    const refusals: ImportResponse[] = [
      { error: "That file is too large." },
      { error: IMPORT_PENDING_MESSAGE, pendingTicket: IMPORT_PENDING_TICKET },
    ];

    for (const refusal of refusals)
      expect(isImportPreview(refusal)).toBe(false);
  });
});

describe("the seam E6-T4 fills", () => {
  it("names the ticket and says plainly that nothing was written", () => {
    // `lib/site-nav.ts` set this convention for the sidebar's one unbuilt
    // destination: something that looks live and is not is worse than
    // something that plainly says "later". The property that matters is not
    // which ticket is named but that the refusal says what happened to the
    // data, which is nothing.
    expect(IMPORT_PENDING_TICKET).toMatch(/^E\d+-T\d+$/);
    expect(IMPORT_PENDING_MESSAGE).toContain("Nothing was written");
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
