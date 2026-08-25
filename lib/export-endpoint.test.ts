import { describe, expect, it } from "vitest";

import {
  GEDCOM_EXPORT_ENDPOINT,
  GEDCOM_MEDIA_TYPE,
  gedcomDownloadHeaders,
  gedcomFilename,
} from "@/lib/export-endpoint";

/**
 * The download's contract (E7-T3, `YEO-53`).
 *
 * "Filename includes the date" is an acceptance criterion, and this is where
 * it is checkable: `lib/export-endpoint.ts` takes the moment as an argument
 * rather than reading a clock, so the assertions below are literals rather
 * than a rendered `new Date()` compared against a second `new Date()`.
 *
 * The route that uses these is driven separately in
 * `app/api/export/gedcom/route.test.ts`; what is here is everything that has
 * nothing to do with a request.
 */

/** A moment with two digits in every field, so a mis-slice cannot pass. */
const NOON = new Date("2026-08-25T12:00:00.000Z");

describe("the filename", () => {
  it("carries the date, in sortable order", () => {
    expect(gedcomFilename(NOON)).toBe("family-tree-2026-08-25.ged");
  });

  it("changes with the day and not with the time of day", () => {
    const morning = gedcomFilename(new Date("2026-08-25T00:00:01.000Z"));
    const night = gedcomFilename(new Date("2026-08-25T23:59:59.000Z"));
    const tomorrow = gedcomFilename(new Date("2026-08-26T00:00:00.000Z"));

    expect(morning).toBe(night);
    expect(tomorrow).not.toBe(night);
  });

  it("sorts chronologically as text, which is why the date is ISO", () => {
    const days = [
      new Date("2026-01-02T00:00:00.000Z"),
      new Date("2025-12-31T00:00:00.000Z"),
      new Date("2026-10-01T00:00:00.000Z"),
    ].map(gedcomFilename);

    expect([...days].sort()).toEqual([
      "family-tree-2025-12-31.ged",
      "family-tree-2026-01-02.ged",
      "family-tree-2026-10-01.ged",
    ]);
  });

  it("needs no escaping, because nothing in it comes from a person", () => {
    // The header below quotes this value. A name that could contain a quote,
    // a semicolon or a newline would need RFC 5987 rather than quoting — so
    // the property worth pinning is that it never can.
    expect(gedcomFilename(NOON)).toMatch(/^[a-z0-9-]+\.ged$/);
  });
});

describe("the response headers", () => {
  const headers = gedcomDownloadHeaders(NOON);

  it("makes the response a download, under the dated name", () => {
    expect(headers["Content-Disposition"]).toBe(
      'attachment; filename="family-tree-2026-08-25.ged"',
    );
  });

  it("declares GEDCOM, in the character set the exporter writes", () => {
    // `lib/gedcom-export.ts` emits `1 CHAR UTF-8`; a file whose transfer
    // encoding disagrees with its own declaration is the failure
    // `lib/gedcom-encoding.ts` exists to clean up after.
    expect(headers["Content-Type"]).toBe(GEDCOM_MEDIA_TYPE);
    expect(GEDCOM_MEDIA_TYPE).toContain("charset=utf-8");
  });

  it("keeps the family's names out of shared caches", () => {
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  it("tells nothing downstream to guess at the body", () => {
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("the endpoint", () => {
  it("is a site-relative path the settings page can point an anchor at", () => {
    expect(GEDCOM_EXPORT_ENDPOINT).toBe("/api/export/gedcom");
  });
});
