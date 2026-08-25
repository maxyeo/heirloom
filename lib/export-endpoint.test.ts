import { describe, expect, it } from "vitest";

import {
  FULL_EXPORT_ENDPOINT,
  FULL_EXPORT_MEDIA_TYPE,
  FULL_EXPORT_TITLE,
  fullExportDownloadHeaders,
  fullExportFilename,
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

/**
 * The full export's half of the contract (E7-T4, `YEO-54`).
 *
 * The same shape as the GEDCOM's above and for the same reason: the filename
 * is a function from a `Date` to a string, so "the name carries the date" is
 * checkable against a literal rather than by driving a route with a clock in
 * it.
 */
describe("the full export's filename", () => {
  it("carries the date, in sortable order", () => {
    expect(fullExportFilename(NOON)).toBe("family-export-2026-08-25.zip");
  });

  it("sits beside a GEDCOM in a folder without colliding with it", () => {
    // Two downloads on the same day are two files, and both say which they
    // are without anyone opening them.
    expect(fullExportFilename(NOON)).not.toBe(gedcomFilename(NOON));
  });

  it("needs no escaping, because nothing in it comes from a person", () => {
    expect(fullExportFilename(NOON)).toMatch(/^[a-z0-9-]+\.zip$/);
  });
});

describe("the full export's response headers", () => {
  const headers = fullExportDownloadHeaders(NOON);

  it("makes the response a download, under the dated name", () => {
    expect(headers["Content-Disposition"]).toBe(
      'attachment; filename="family-export-2026-08-25.zip"',
    );
  });

  it("declares a ZIP", () => {
    expect(headers["Content-Type"]).toBe(FULL_EXPORT_MEDIA_TYPE);
    expect(FULL_EXPORT_MEDIA_TYPE).toBe("application/zip");
  });

  it("keeps the family's names out of shared caches", () => {
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  it("states no length, because the archive is written as it is sent", () => {
    /**
     * The one header this download deliberately does not carry. A length
     * guessed before the archive exists and disagreed with by the body is a
     * truncated download that looks complete — the single failure a backup
     * must not have.
     */
    expect(headers["Content-Length"]).toBeUndefined();
  });
});

describe("the full export's name", () => {
  it("is an export and not a backup", () => {
    /**
     * E7-T3's reviewer raised it and `docs/backups.md` settles it: the
     * operator's nightly Postgres backup and the family's own export are
     * deliberately different things, and sharing a word for them on the one
     * page a non-technical reader meets either would say the second is the
     * first. Pinned here as well as in `lib/export-options.test.ts` because
     * this constant is where the word is chosen.
     */
    expect(FULL_EXPORT_TITLE).toBe("Full export");
    expect(FULL_EXPORT_ENDPOINT).not.toContain("backup");
  });

  it("is a site-relative path the settings page can point an anchor at", () => {
    expect(FULL_EXPORT_ENDPOINT).toBe("/api/export/full");
  });
});
