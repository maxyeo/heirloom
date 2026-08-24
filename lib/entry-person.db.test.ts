import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { getEntryPerson } from "@/lib/entry-person";

/**
 * Database tests for the entry→person lookup (E2-T3, `YEO-26`). Run with
 * `npm run test:db`; the `.db.test.ts` suffix is what keeps them out of
 * `npm test` and CI's bare environment. See docs/testing.md.
 *
 * What is asserted here lives in SQL rather than in TypeScript: a `where` on
 * `individuals.page_id` read from the entry's end, and the `order by` that
 * makes `limit(1)` deterministic when the column is claimed twice — which the
 * write path refuses but a manual `UPDATE` can still produce. Mocking Drizzle
 * would only assert that the mock returns what the mock was told to return.
 *
 * Fixed, recognisable ids so teardown deletes exactly what this file created.
 */

const PREFIX = "entry-person-fixture";

const ROSE = "00000000-0000-4000-8000-0000e2530001";
const THOMAS = "00000000-0000-4000-8000-0000e2530002";
const ALICE = "00000000-0000-4000-8000-0000e2530003";

const ROSE_PAGE = "00000000-0000-4000-8000-0000e253000a";
const LOOSE_PAGE = "00000000-0000-4000-8000-0000e253000b";
const CONTESTED_PAGE = "00000000-0000-4000-8000-0000e253000c";

const PEOPLE = [ROSE, THOMAS, ALICE];
const PAGES = [ROSE_PAGE, LOOSE_PAGE, CONTESTED_PAGE];

/** People first: `page_id` is `on delete set null`, not a cascade either way. */
async function removeFixture() {
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PEOPLE));
  await db.delete(schema.pages).where(inArray(schema.pages.id, PAGES));
}

beforeEach(async () => {
  await removeFixture();

  await db.insert(schema.pages).values([
    { id: ROSE_PAGE, slug: `${PREFIX}-rose`, title: `${PREFIX} Rose Hale` },
    { id: LOOSE_PAGE, slug: `${PREFIX}-loose`, title: `${PREFIX} A farmhouse` },
    {
      id: CONTESTED_PAGE,
      slug: `${PREFIX}-contested`,
      title: `${PREFIX} Claimed twice`,
    },
  ]);

  await db.insert(schema.individuals).values([
    {
      id: ROSE,
      pageId: ROSE_PAGE,
      givenName: `${PREFIX} Rose`,
      surname: "Hale",
      birthDate: "1890-01-01",
      birthDateQualifier: "about",
      birthDatePrecision: "year",
      birthPlace: "Kentish Town, London",
    },
    // Two people on one entry is not reachable through the application —
    // `setPersonEntry` locks the entry and refuses the second — so these rows
    // stand in for the manual `UPDATE` that can still produce it.
    {
      id: THOMAS,
      pageId: CONTESTED_PAGE,
      givenName: `${PREFIX} Thomas`,
      surname: "Hale",
      createdAt: new Date("2020-01-01T00:00:00Z"),
    },
    {
      id: ALICE,
      pageId: CONTESTED_PAGE,
      givenName: `${PREFIX} Alice`,
      surname: "Hale",
      createdAt: new Date("2021-01-01T00:00:00Z"),
    },
  ]);
});

afterAll(removeFixture);

describe("getEntryPerson", () => {
  it("reads the linked person back from the entry's end", async () => {
    const person = await getEntryPerson(ROSE_PAGE);

    expect(person?.id).toBe(ROSE);
    expect(person?.surname).toBe("Hale");
    expect(person?.birthPlace).toBe("Kentish Town, London");
  });

  it("carries the qualifier and precision beside the date", async () => {
    // The three columns are only meaningful together: dropping either sibling
    // here is what turns a year read off a headstone into "1 January 1890" on
    // the page. See `formatQualifiedDate`.
    const person = await getEntryPerson(ROSE_PAGE);

    expect(person?.birthDate).toBe("1890-01-01");
    expect(person?.birthDateQualifier).toBe("about");
    expect(person?.birthDatePrecision).toBe("year");
  });

  it("finds nobody for an entry no one is linked to", async () => {
    // The ordinary case: most entries are about a place or a story, and the
    // card is simply not rendered for them.
    expect(await getEntryPerson(LOOSE_PAGE)).toBeUndefined();
  });

  it("answers the same way every time an entry is claimed twice", async () => {
    // Oldest claim first, id as the tie-break — so a page that should never
    // have had two claimants does not flicker between two names as Postgres
    // changes its mind about scan order.
    const first = await getEntryPerson(CONTESTED_PAGE);
    const second = await getEntryPerson(CONTESTED_PAGE);

    expect(first?.id).toBe(THOMAS);
    expect(second?.id).toBe(THOMAS);
  });

  it("survives an entry that has been deleted out from under the link", async () => {
    // `page_id` is `on delete set null`, so deleting the entry unlinks the
    // person rather than orphaning them — and this lookup is keyed by an id
    // that no longer names a row.
    await db.delete(schema.pages).where(inArray(schema.pages.id, [ROSE_PAGE]));

    expect(await getEntryPerson(ROSE_PAGE)).toBeUndefined();
  });
});
