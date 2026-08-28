import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { readEntryInfobox } from "@/lib/entry-infobox";
import { getEntryPerson } from "@/lib/entry-person";
import { addedByHand } from "@/test/people-fixtures";

/**
 * The article infobox's id-to-slug map, and what a retired entry does to it
 * (E1-T10, `YEO-122`).
 *
 * `lib/person-infobox.test.ts` owns everything the box *says* — it is pure and
 * runs under `npm test` where CI's `check` job can see it. What is left for a
 * real Postgres is the one query `lib/entry-infobox.ts` issues, and the only
 * interesting thing about it since `YEO-122` is which rows it declines to
 * return.
 *
 * ## Why absent rather than present-and-red
 *
 * The distinction is not cosmetic and it is why this is asserted rather than
 * assumed. Leaving the retired entry's slug in the map and letting
 * `findExistingSlugs` paint the link red reaches the same colour by a route
 * that is wrong twice over: the red link's `href` would be the retired entry's
 * address, so following the invitation to *write about Rose* would land on the
 * tombstone of the entry about Rose somebody has just retired; and it would
 * spend one of the slugs in the route's single `findExistingSlugs` call
 * re-asking a question this query has already answered.
 *
 * With the slug absent, the relative renders exactly like somebody nobody has
 * written about yet — a name, and a red link that starts a new entry.
 */

/** Explicit, recognisable ids. `122` is the ticket. */
const SUBJECT = "00000000-0000-4000-8000-0000012201a1";
const SPOUSE = "00000000-0000-4000-8000-0000012201a2";
const UNION = "00000000-0000-4000-8000-0000012201b1";
const SUBJECT_PAGE = "00000000-0000-4000-8000-0000012201c1";
const SPOUSE_PAGE = "00000000-0000-4000-8000-0000012201c2";

const PREFIX = "entry-infobox-fixture";
const SPOUSE_SLUG = `${PREFIX}-walter`;

const PEOPLE = [SUBJECT, SPOUSE];
const PAGES = [SUBJECT_PAGE, SPOUSE_PAGE];

async function removeFixture() {
  // The union goes with either partner (`on delete cascade`); the people have
  // to go before the pages only because `page_id` is `set null` rather than a
  // cascade, and a stale row would confuse the next run's assertions.
  await db
    .delete(schema.individuals)
    .where(inArray(schema.individuals.id, PEOPLE));
  await db.delete(schema.pages).where(inArray(schema.pages.id, PAGES));
}

beforeEach(async () => {
  await removeFixture();

  await db.insert(schema.pages).values([
    {
      id: SUBJECT_PAGE,
      slug: `${PREFIX}-rose`,
      title: `${PREFIX} Rose`,
    },
    { id: SPOUSE_PAGE, slug: SPOUSE_SLUG, title: `${PREFIX} Walter` },
  ]);

  await db.insert(schema.individuals).values(
    addedByHand([
      {
        id: SUBJECT,
        givenName: `${PREFIX} Rose`,
        surname: "Hale",
        pageId: SUBJECT_PAGE,
      },
      {
        id: SPOUSE,
        givenName: `${PREFIX} Walter`,
        surname: "Hale",
        pageId: SPOUSE_PAGE,
      },
    ]),
  );

  await db.insert(schema.unions).values({
    id: UNION,
    partnerAId: SUBJECT,
    partnerBId: SPOUSE,
  });
});

afterAll(removeFixture);

/** The box for the fixture's subject, through the route's own call shape. */
async function box() {
  const subject = await getEntryPerson(SUBJECT_PAGE);
  expect(subject).toBeDefined();
  return readEntryInfobox(subject);
}

describe("readEntryInfobox", () => {
  it("gives a relative's entry address when there is one", async () => {
    // The control. Without it, the assertion below would pass for a map that
    // had stopped returning anything at all.
    const infobox = await box();

    expect(infobox?.spouses[0]?.person).toMatchObject({ slug: SPOUSE_SLUG });
  });

  it("gives no address for a relative whose entry has been retired", async () => {
    await db
      .update(schema.pages)
      .set({ deletedAt: new Date(), deletedBy: "rose@example.com" })
      .where(eq(schema.pages.id, SPOUSE_PAGE));

    const infobox = await box();
    const spouse = infobox?.spouses[0]?.person;

    // Still named — the box does not hide a relative because somebody retired
    // the entry about them — and named with a null slug, which is byte for
    // byte how a relative nobody has written about arrives.
    expect(spouse?.name).toContain("Walter");
    expect(spouse?.slug).toBeNull();
  });
});
