import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getPageBySlug } from "@/lib/pages";

/**
 * `getPageBySlug` is one `WHERE slug = $1`, so most of it is not worth a test.
 * What is worth a test is the part only Postgres can answer, and that is how
 * the comparison behaves on input taken straight from a URL:
 *
 *   - a miss comes back as `undefined`, which is what the read route turns
 *     into a 404;
 *   - the match is exact and case-sensitive, so `/wiki/Rose` is a different
 *     address from `/wiki/rose` rather than a second door onto one entry;
 *   - the slug is parameterised, not interpolated.
 *
 * Every one of those lives in SQL. Mocking the query would assert only that
 * the mock returned what the mock was told to return. See docs/testing.md.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made.
const ENTRY_ID = "00000000-0000-4000-8000-00000000e001";
const SLUG = "pages-fixture-rose-hale";
const BODY = "<p>Rose married Walter.</p>";

async function removeFixture() {
  await db.delete(schema.pages).where(inArray(schema.pages.id, [ENTRY_ID]));
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and would
  // otherwise greet the next one with a duplicate key on a unique slug.
  await removeFixture();

  await db.insert(schema.pages).values({
    id: ENTRY_ID,
    slug: SLUG,
    title: "Rose Hale",
    bodyHtml: BODY,
  });
});

afterAll(removeFixture);

describe("getPageBySlug", () => {
  it("returns the entry stored under the slug", async () => {
    await expect(getPageBySlug(SLUG)).resolves.toEqual({
      id: ENTRY_ID,
      slug: SLUG,
      title: "Rose Hale",
      bodyHtml: BODY,
    });
  });

  it("returns undefined when no row holds the slug", async () => {
    await expect(getPageBySlug(`${SLUG}-nonexistent`)).resolves.toBeUndefined();
  });

  it("matches the slug exactly, case included", async () => {
    // Postgres `=` on `text` is case-sensitive. Worth pinning because the
    // alternative — a case-insensitive lookup — is a decision to make on
    // purpose (with a functional index), not one to discover from a bug.
    await expect(getPageBySlug(SLUG.toUpperCase())).resolves.toBeUndefined();
  });

  it("parameterises the slug instead of interpolating it", async () => {
    // The slug is a URL segment, so this is reachable by anyone who can sign
    // in, against a database with no RLS and one role for the whole app.
    // Interpolated, this would return the fixture row; parameterised, it is
    // just a slug that happens to contain punctuation, and matches nothing.
    await expect(getPageBySlug("' OR 1=1 --")).resolves.toBeUndefined();
  });
});
