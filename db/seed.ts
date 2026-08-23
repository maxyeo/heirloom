import "../lib/load-env";

import { db, schema } from "./index";

/**
 * Seed fixture.
 *
 * The *shape* here is taken from a real family, because inventing test data
 * produces test data that only exercises the easy cases. Names are
 * placeholders; the structure is the point:
 *
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │              │
 *            1 child      2 children     8 children
 *
 *   - Thomas is a partner in two unions (widowed, remarried)
 *   - Rose is a partner in two unions (widowed, remarried)
 *   - u1's child and u3's children share NO parent — they are not blood
 *     relations at all, and are connected only by the chain of remarriages
 *   - u2's children are the only people related by blood to both ends
 *
 * If the tree renders this correctly, the hard part works. A naive
 * `person.parent_id` model cannot represent it, and `d3-tree` cannot draw it.
 */

async function main() {
  console.log("Clearing existing data...");
  await db.delete(schema.unionChildren);
  await db.delete(schema.unions);
  await db.delete(schema.individuals);
  await db.delete(schema.revisions);
  await db.delete(schema.pages);

  console.log("Inserting individuals...");
  const [mary, thomas, rose, walter] = await db
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
        // Walter is the imprecise one. His birth is known only as "about
        // 1905" — a headstone age, not a register entry — and the qualifier
        // is what keeps that from being rounded up into a false certainty.
        // Every date rendering path should be exercised by at least one row
        // that is not `exact`.
        givenName: "Walter",
        surname: "Shaw",
        sex: "male",
        birthDate: "1905-09-08",
        birthDateQualifier: "about" as const,
        deathDate: "1978-04-25",
      },
    ])
    .returning();

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
  const [u1, u2, u3] = await db
    .insert(schema.unions)
    .values([
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
        // The year is remembered, the day is not — so the union carries a
        // qualifier too, not just the individuals.
        startDate: "1948-07-03",
        startDateQualifier: "about" as const,
        endReason: "ongoing" as const,
        sequence: 3,
      },
    ])
    .returning();

  console.log("Linking children to unions...");
  await db.insert(schema.unionChildren).values([
    { unionId: u1.id, childId: edward.id },
    ...halfHales.map((c) => ({ unionId: u2.id, childId: c.id })),
    ...shaws.map((c) => ({ unionId: u3.id, childId: c.id })),
  ]);

  console.log(
    `Done. 4 adults, 3 unions, ${1 + halfHales.length + shaws.length} children.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
