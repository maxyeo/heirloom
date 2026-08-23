import { describe, expect, it } from "vitest";

import {
  formatRevisionAuthor,
  formatRevisionTimestamp,
  isRevisionId,
  revisionTimestampIso,
} from "@/lib/revision-format";

/**
 * Pure, database-free, and the only coverage of this ticket CI actually
 * executes — `lib/revisions.ts` and the two route files need Postgres or a
 * request scope to exercise, per docs/testing.md, so what is checkable here
 * is what has to carry the weight.
 */

describe("formatRevisionTimestamp", () => {
  const when = new Date("2024-03-05T23:15:00.000Z");

  it("renders in UTC regardless of the ambient timezone", () => {
    // The whole point of pinning `timeZone: "UTC"` in the implementation: the
    // same instant must read identically whichever timezone the process
    // happens to be running under, since the server's zone is not the
    // reader's. `process.env.TZ` is read by Node's ICU at the point a
    // `Date`/`Intl` call is made, so flipping it between assertions actually
    // exercises the pin rather than merely restating it.
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const inLA = formatRevisionTimestamp(when);

      process.env.TZ = "Pacific/Kiritimati";
      const inKiritimati = formatRevisionTimestamp(when);

      process.env.TZ = "UTC";
      const inUtc = formatRevisionTimestamp(when);

      expect(inLA).toBe(inKiritimati);
      expect(inLA).toBe(inUtc);
    } finally {
      process.env.TZ = original;
    }
  });

  it("states the timezone explicitly rather than leaving it implied", () => {
    expect(formatRevisionTimestamp(when)).toMatch(/UTC$/);
  });

  it("renders a specific, checkable date and time", () => {
    expect(formatRevisionTimestamp(when)).toBe("5 March 2024 at 23:15 UTC");
  });
});

describe("revisionTimestampIso", () => {
  it("round-trips through Date's own ISO representation", () => {
    const when = new Date("2024-03-05T23:15:00.000Z");
    expect(revisionTimestampIso(when)).toBe("2024-03-05T23:15:00.000Z");
  });
});

describe("formatRevisionAuthor", () => {
  it("returns the email when there is one", () => {
    expect(formatRevisionAuthor("rose@example.com")).toBe("rose@example.com");
  });

  it("falls back to a label when the row has no author", () => {
    // `revisions.created_by` is nullable — a row written outside the save
    // path (a seed, a manual SQL insert/backfill) has no signed-in author to
    // attribute, and an empty string would read as a bug rather than as the
    // true state of the data.
    expect(formatRevisionAuthor(null)).toBe("Unknown");
  });
});

describe("isRevisionId", () => {
  it.each([
    "00000000-0000-4000-8000-00000000e001",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "F47AC10B-58CC-4372-A567-0E02B2C3D479",
  ])("accepts %s", (value) => {
    expect(isRevisionId(value)).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["not a uuid at all", "hello"],
    ["one character short", "00000000-0000-4000-8000-00000000e00"],
    ["missing hyphens", "00000000000040008000000000000e001"],
    // The failure this guards against: a malformed id reaching Postgres's
    // `uuid` column raises `invalid input syntax for type uuid`, which
    // surfaces as a 500 rather than the 404 a bad link should produce.
    ["a SQL injection attempt", "' OR 1=1 --"],
    ["a uuid with trailing garbage", "00000000-0000-4000-8000-00000000e001x"],
  ])("refuses %s", (_label, value) => {
    expect(isRevisionId(value)).toBe(false);
  });
});
