import "../lib/load-env";

import { eq } from "drizzle-orm";

import { slugFromTitle } from "../lib/entry-slug";
import { db, schema } from "./index";
import { assertSeedTarget } from "./seed-guard";

/** Who the seeded entry and its first revision are attributed to. */
const SEED_AUTHOR = "seed@example.com";

/**
 * Seed fixture.
 *
 * The *shape* here is taken from a real family, because inventing test data
 * produces test data that only exercises the easy cases. Names are
 * placeholders; the structure is the point:
 *
 *              [Agnes]══(u0)══[ ? ]
 *                         │
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │              │
 *            1 child      2 children     8 children
 *
 *   - Thomas is a partner in two unions (widowed, remarried)
 *   - Rose is a partner in two unions (widowed, remarried)
 *   - u1's child and u3's children share NO parent — they are not blood
 *     relations at all, and are connected only by the chain of remarriages
 *   - u2's children are the only people related by blood to both ends
 *   - u0 records Thomas's mother and leaves his father unknown, which is the
 *     case `db/schema.ts` calls extremely common and the reason both partner
 *     columns are nullable
 *
 * If the tree renders this correctly, the hard part works. A naive
 * `person.parent_id` model cannot represent it, and `d3-tree` cannot draw it.
 *
 * ## The values, which are as much the point as the shape (`YEO-85`)
 *
 * The paragraph above was true about structure and quietly false about
 * everything else: every date here used to be stored at `day` precision with
 * an `exact` qualifier, every child was `biological`, every union was a
 * `marriage` that was `ongoing` or ended in `death`, and no individual had an
 * entry. Those are the *column defaults*, and a fixture that only ever carries
 * a column's default cannot show anybody the branch that handles the other
 * value — which is how three separate bugs shipped through a green CI in one
 * run. See "Fixtures carry the awkward value" in docs/testing.md.
 *
 * Two of those defaults were not merely uninformative here, they were wrong.
 * The eleven children were each stored on 1 January of their birth year — the
 * anchor a year-only date is written to — while still claiming `day`
 * precision, so the seeded tree stated eleven birthdays nobody ever recorded.
 * That is precisely the failure `date_precision` was added to prevent, sitting
 * in the fixture that demonstrates the application. And u3 carried a comment
 * saying the day of the wedding was not remembered, above a row that recorded
 * one. Both are fixed below.
 */

async function main() {
  // Refuse before opening a connection, let alone deleting anything, unless
  // the resolved DATABASE_URL is a host this script was told it may destroy.
  // See db/seed-guard.ts.
  const guard = assertSeedTarget(process.env.DATABASE_URL, process.env);
  if (!guard.allowed) {
    console.error(guard.message);
    process.exit(1);
  }

  console.log("Clearing existing data...");
  await db.delete(schema.unionChildren);
  await db.delete(schema.unions);
  await db.delete(schema.individuals);
  await db.delete(schema.revisions);
  await db.delete(schema.pages);

  console.log("Inserting individuals...");
  const [mary, thomas, rose, walter, agnes] = await db
    .insert(schema.individuals)
    .values([
      {
        givenName: "Mary",
        surname: "Ellis",
        sex: "female",
        birthDate: "1901-03-14",
        deathDate: "1931-08-02",
      },
      {
        givenName: "Thomas",
        surname: "Hale",
        sex: "male",
        birthDate: "1898-11-20",
        deathDate: "1947-06-11",
      },
      {
        givenName: "Rose",
        surname: "Bennett",
        sex: "female",
        birthDate: "1908-05-30",
        deathDate: "1989-01-19",
      },
      {
        // Walter is the imprecise one, and both columns say so. His birth is
        // known only as "about 1905" — a headstone age, not a register entry
        // — so the date is stored on the year's anchor with `year` precision
        // beside it, and the qualifier keeps the year itself from being
        // rounded up into a false certainty. Storing 8 September and calling
        // it `day`, as this row used to, invented the very day the headstone
        // did not give.
        //
        // His death is the third precision: an April funeral notice, no day.
        // Between them the two rows put every `date_precision` and a second
        // `date_qualifier` in front of anyone who seeds this database.
        givenName: "Walter",
        surname: "Shaw",
        sex: "male",
        birthDate: "1905-01-01",
        birthDateQualifier: "about" as const,
        birthDatePrecision: "year" as const,
        deathDate: "1978-04-01",
        deathDatePrecision: "month" as const,
      },
      {
        // Thomas's mother, and the only thing recorded about his father is
        // that there was one. She exists so that the seeded tree contains the
        // half-known union `db/schema.ts` describes as extremely common —
        // without one, every null-partner branch in `lib/ancestry.ts` and
        // `lib/parent-options.ts` is unreachable from a seeded database.
        givenName: "Agnes",
        surname: "Hale",
        sex: "female",
        birthDate: "1875-01-01",
        birthDateQualifier: "before" as const,
        birthDatePrecision: "year" as const,
      },
    ])
    .returning();

  /**
   * A child, known by the year they were born and nothing finer.
   *
   * `birthDatePrecision: "year"` is not decoration: this helper only ever
   * receives a year, and writes it to the 1 January *anchor* the schema
   * reserves for exactly that. Without the precision column beside it the
   * anchor reads as a date somebody recorded, and every one of these eleven
   * children was shown a birthday of 1 January — see the note above about
   * this being the failure `date_precision` exists to prevent.
   */
  const child = (
    givenName: string,
    surname: string,
    sexValue: "male" | "female",
    birthYear: number,
  ) => ({
    givenName,
    surname,
    sex: sexValue,
    birthDate: `${birthYear}-01-01`,
    birthDatePrecision: "year" as const,
  });

  const [edward] = await db
    .insert(schema.individuals)
    .values([child("Edward", "Hale", "male", 1929)])
    .returning();

  const halfHales = await db
    .insert(schema.individuals)
    .values([
      child("Clara", "Hale", "female", 1934),
      child("Arthur", "Hale", "male", 1936),
    ])
    .returning();

  const shaws = await db
    .insert(schema.individuals)
    .values([
      child("Ruth", "Shaw", "female", 1949),
      child("Harold", "Shaw", "male", 1950),
      child("Doris", "Shaw", "female", 1952),
      child("Frank", "Shaw", "male", 1954),
      child("Vera", "Shaw", "female", 1955),
      child("Leonard", "Shaw", "male", 1957),
      child("Joyce", "Shaw", "female", 1959),
      child("Stanley", "Shaw", "male", 1961),
    ])
    .returning();

  console.log("Inserting unions...");
  const [u0, u1, u2, u3] = await db
    .insert(schema.unions)
    .values([
      {
        // One partner recorded, the other not — and nothing known about what
        // kind of partnership it was or how it ended, which is what `unknown`
        // is for in both enums. Every other union here is a `marriage` that
        // was `ongoing` or ended in `death`, so without this row `union_type`
        // and three of the five `union_end_reason` values never appear in a
        // seeded database at all.
        partnerAId: agnes.id,
        partnerBId: null,
        type: "unknown" as const,
        endReason: "unknown" as const,
        sequence: 1,
        notes: "Thomas's father is not recorded.",
      },
      {
        partnerAId: mary.id,
        partnerBId: thomas.id,
        type: "marriage" as const,
        startDate: "1927-04-16",
        endDate: "1931-08-02",
        endReason: "death" as const,
        sequence: 1,
        notes: "Ended with Mary's death.",
      },
      {
        partnerAId: rose.id,
        partnerBId: thomas.id,
        type: "marriage" as const,
        startDate: "1933-02-11",
        endDate: "1947-06-11",
        endReason: "death" as const,
        sequence: 2,
        notes: "Ended with Thomas's death.",
      },
      {
        partnerAId: rose.id,
        partnerBId: walter.id,
        type: "marriage" as const,
        // The year is remembered, the day is not — so the union carries both
        // date columns, not just the individuals. It used to carry only the
        // qualifier, above a row that recorded 3 July: a comment and its data
        // disagreeing, with the data winning on screen.
        startDate: "1948-01-01",
        startDateQualifier: "about" as const,
        startDatePrecision: "year" as const,
        endReason: "ongoing" as const,
        sequence: 3,
      },
    ])
    .returning();

  console.log("Linking children to unions...");
  const [clara, arthur] = halfHales;
  await db.insert(schema.unionChildren).values([
    { unionId: u0.id, childId: thomas.id },
    { unionId: u1.id, childId: edward.id },
    // Clara was adopted, which is the whole reason children belong to a
    // union rather than to a parent. `relation` defaults to `biological`,
    // so a seed that never sets it leaves the dashed edge in
    // `lib/tree-layout.ts` — and every other reader that distinguishes the
    // two — undrawn on a seeded database.
    { unionId: u2.id, childId: clara.id, relation: "adopted" as const },
    { unionId: u2.id, childId: arthur.id },
    ...shaws.map((c) => ({ unionId: u3.id, childId: c.id })),
  ]);

  console.log("Writing an entry, and linking it to the person it is about...");
  /**
   * One seeded entry, and one `individuals.page_id` that is not null.
   *
   * `page_id` is nullable and almost always null — most entries are about a
   * place or an heirloom, not a person. But a seed in which it is *always*
   * null leaves the entire linked half of the application unreachable without
   * clicking it into existence first: the infobox (`lib/entry-infobox.ts`),
   * the reverse lookup (`lib/entry-person.ts`) and the "view in tree" link all
   * render nothing, and the emptiest possible state is the only one anyone
   * developing against a seeded database ever sees.
   *
   * Written as a page and its first revision together, because that is the
   * invariant `lib/create-page.ts` holds: an entry's history starts at the
   * moment the entry does. The body is the stub an author would be dropped
   * into the editor to replace.
   */
  const title = `${thomas.givenName} ${thomas.surname}`;
  const [entry] = await db
    .insert(schema.pages)
    .values({
      slug: slugFromTitle(title),
      title,
      bodyHtml: "<p>Thomas Hale was born in 1898 and died in 1947.</p>",
      updatedBy: SEED_AUTHOR,
    })
    .returning();

  await db.insert(schema.revisions).values({
    pageId: entry.id,
    title: entry.title,
    bodyHtml: entry.bodyHtml,
    createdBy: SEED_AUTHOR,
  });

  await db
    .update(schema.individuals)
    .set({ pageId: entry.id })
    .where(eq(schema.individuals.id, thomas.id));

  console.log(
    `Done. 5 adults, 4 unions, ${1 + halfHales.length + shaws.length} children, 1 entry.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
