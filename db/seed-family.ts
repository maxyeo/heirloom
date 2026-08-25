import type {
  FamilyGraph,
  GraphChildLink,
  GraphPerson,
  GraphUnion,
} from "../lib/family-graph";

/**
 * The seeded family, as plain values.
 *
 * Kept separate from `db/seed.ts` for the same reason `db/seed-guard.ts` is:
 * nothing here needs a database, so a test can import it and `npm test` still
 * runs in the bare environment CI gives it. `db/seed.ts` writes exactly these
 * rows and decides nothing about them.
 *
 * The split is the point rather than tidiness. `docs/architecture.md` calls
 * this family the case the data model was designed against — *"if the tree
 * renders this correctly, the hard part works"* — and `docs/testing.md` names
 * `db/seed.ts` as one of the two fixtures carrying the awkward values
 * deliberately, "so most modules inherit the coverage rather than each
 * restating it". A test that restates the family in a literal of its own
 * inherits nothing. It is a second copy, free to agree with the seed on the
 * day it is written and to stop agreeing silently on any day after.
 *
 * That is not hypothetical. `lib/tree-layout.test.ts` carried a fixture whose
 * docblock called it "the seed fixture from docs/architecture.md, trimmed",
 * and none of its names, dates or child counts were the seed's — one child
 * where the seed has eight, `marriage`/`ongoing` where the seed's half-known
 * union carries `unknown`/`unknown`. Nothing was wrong with the test; it was
 * simply not testing what it said it was, and no run could report that.
 *
 * ## The shape
 *
 * ```
 *              [Agnes]══(u0)══[ ? ]
 *                         │
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │              │
 *          Edward     Clara, Arthur      8 Shaws
 * ```
 *
 * The shape is taken from a real family, because inventing test data produces
 * test data that only exercises the easy cases. Names are placeholders:
 *
 * - Thomas is a partner in two unions (widowed, remarried)
 * - Rose is a partner in two unions (widowed, remarried)
 * - u1's child and u3's children share **no** parent — they are not blood
 *   relations at all, and are connected only by the chain of remarriages
 * - u2's children are the only people related by blood to both ends
 * - u0 records Thomas's mother and leaves his father unknown, which is the
 *   case `db/schema.ts` calls extremely common and the reason both partner
 *   columns are nullable
 *
 * A naive `person.parent_id` model cannot represent this, and `d3-tree`
 * cannot draw it. `lib/tree-layout.seed.test.ts` is what checks that the
 * layout does.
 *
 * ## The values, which are as much the point as the shape (`YEO-85`)
 *
 * The paragraph above is true about structure and used to be quietly false
 * about everything else. Every date here was once stored at `day` precision
 * with an `exact` qualifier, every child was `biological`, every union a
 * `marriage`, and no individual had an entry — every one of those the *column
 * default*, and a fixture that only ever carries a column's default cannot
 * show anybody the branch that handles the other value.
 *
 * So the rows below carry, deliberately: a year-only birth on its 1 January
 * anchor with the precision that says so, a month-precision death, `about`
 * and `before` qualifiers, an adopted child, a union whose type and ending
 * are both `unknown`, a union with one partner unrecorded, and one individual
 * linked to an entry. See "Fixtures carry the awkward value" in
 * docs/testing.md.
 *
 * ## What this is not
 *
 * Not a transcript of what `getFamilyGraph` hands back. The rows are the same
 * rows, but that function orders unions by `sequence` then `start_date` and
 * does not order people at all — so the array order here is the order the
 * seed writes, not the order a reader receives. Nothing consuming a
 * `FamilyGraph` may depend on either, and `lib/tree-layout.seed.test.ts`
 * asserts only properties that hold whatever order the rows arrive in.
 */

/**
 * Stable ids, so that re-seeding does not renumber the world.
 *
 * `defaultRandom()` would do, and until now did. Fixing them buys two things.
 * This module can be a `FamilyGraph` at all — the partner and child columns
 * are foreign keys, and a value has to have its ids in hand before one row
 * can point at another. And a `?person=` link into a seeded tree survives the
 * next `npm run db:seed`, where before it silently addressed nobody.
 *
 * docs/testing.md asks database fixtures for "explicit, recognisable ids" so
 * that teardown can delete exactly what a file created. This is the same
 * argument one file over, and `5eed…` is what makes a row recognisable in a
 * SQL console as something the seed put there.
 */
function seedId(n: number): string {
  return `5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/**
 * The one entry `db/seed.ts` writes, and the one `individuals.page_id` that
 * is not null.
 *
 * `page_id` is nullable and almost always null — most entries are about a
 * place or an heirloom, not a person. But a seed in which it is *always* null
 * leaves the entire linked half of the application unreachable without
 * clicking it into existence first: the infobox (`lib/entry-infobox.ts`), the
 * reverse lookup (`lib/entry-person.ts`) and the "view in tree" link all
 * render nothing.
 *
 * It is fixed here rather than in `db/seed.ts` because it is the value of a
 * column on Thomas, and Thomas lives here.
 */
export const THOMAS_ENTRY_ID = seedId(900);

/**
 * A union row as the seed writes it.
 *
 * `GraphUnion` is every column `getFamilyGraph` reads, which is every column
 * but `notes` — the canvas has no room for a sentence and the detail panel
 * reads the row itself. The seed does write notes, so the fixture is the
 * wider type and stays assignable to the narrower one.
 */
export type SeedUnion = GraphUnion & { notes: string | null };

function person(
  n: number,
  givenName: string,
  surname: string,
  sex: GraphPerson["sex"],
  overrides: Partial<GraphPerson> = {},
): GraphPerson {
  return {
    id: seedId(n),
    givenName,
    surname,
    sex,
    birthDate: null,
    birthDateQualifier: "exact",
    birthDatePrecision: "day",
    birthDateUpper: null,
    birthDateUpperPrecision: "day",
    birthPlace: null,
    deathDate: null,
    deathDateQualifier: "exact",
    deathDatePrecision: "day",
    deathDateUpper: null,
    deathDateUpperPrecision: "day",
    deathPlace: null,
    notes: null,
    pageId: null,
    ...overrides,
  };
}

/**
 * A child, known by the year they were born and nothing finer.
 *
 * `birthDatePrecision: "year"` is not decoration. This helper only ever
 * receives a year and writes it to the 1 January *anchor* the schema reserves
 * for exactly that, so without the precision column beside it the anchor
 * reads as a date somebody recorded — and all eleven children would be shown
 * a birthday of 1 January, which is the failure `date_precision` exists to
 * prevent.
 */
function bornIn(
  n: number,
  givenName: string,
  surname: string,
  sex: GraphPerson["sex"],
  birthYear: number,
): GraphPerson {
  return person(n, givenName, surname, sex, {
    birthDate: `${birthYear}-01-01`,
    birthDatePrecision: "year",
  });
}

function union(
  n: number,
  partnerAId: string | null,
  partnerBId: string | null,
  overrides: Partial<SeedUnion> = {},
): SeedUnion {
  return {
    id: seedId(n),
    partnerAId,
    partnerBId,
    type: "marriage",
    endReason: "ongoing",
    sequence: 0,
    startDate: null,
    startDateQualifier: "exact",
    startDatePrecision: "day",
    startDateUpper: null,
    startDateUpperPrecision: "day",
    endDate: null,
    endDateQualifier: "exact",
    endDatePrecision: "day",
    endDateUpper: null,
    endDateUpperPrecision: "day",
    notes: null,
    ...overrides,
  };
}

function childOf(
  union: SeedUnion,
  child: GraphPerson,
  relation: GraphChildLink["relation"] = "biological",
): GraphChildLink {
  return { unionId: union.id, childId: child.id, relation };
}

/**
 * Thomas's mother, and the only thing recorded about his father is that there
 * was one. She exists so that the seeded tree contains the half-known union
 * `db/schema.ts` describes as extremely common — without one, every
 * null-partner branch in `lib/ancestry.ts` and `lib/parent-options.ts` is
 * unreachable from a seeded database.
 */
const agnes = person(1, "Agnes", "Hale", "female", {
  birthDate: "1875-01-01",
  birthDateQualifier: "before",
  birthDatePrecision: "year",
});

const mary = person(2, "Mary", "Ellis", "female", {
  birthDate: "1901-03-14",
  deathDate: "1931-08-02",
});

const thomas = person(3, "Thomas", "Hale", "male", {
  birthDate: "1898-11-20",
  deathDate: "1947-06-11",
  pageId: THOMAS_ENTRY_ID,
});

const rose = person(4, "Rose", "Bennett", "female", {
  birthDate: "1908-05-30",
  deathDate: "1989-01-19",
});

/**
 * Walter is the imprecise one, and both of his date columns say so.
 *
 * His birth is known only as "about 1905" — a headstone age, not a register
 * entry — so the date sits on the year's anchor with `year` precision beside
 * it, and the qualifier keeps the year itself from hardening into a false
 * certainty. His death is the third precision: an April funeral notice, no
 * day. Between them the two columns put every `date_precision` and a second
 * `date_qualifier` in front of anyone who seeds this database.
 */
const walter = person(5, "Walter", "Shaw", "male", {
  birthDate: "1905-01-01",
  birthDateQualifier: "about",
  birthDatePrecision: "year",
  deathDate: "1978-04-01",
  deathDatePrecision: "month",
});

const edward = bornIn(10, "Edward", "Hale", "male", 1929);
const clara = bornIn(11, "Clara", "Hale", "female", 1934);
const arthur = bornIn(12, "Arthur", "Hale", "male", 1936);

const shaws = [
  bornIn(20, "Ruth", "Shaw", "female", 1949),
  bornIn(21, "Harold", "Shaw", "male", 1950),
  bornIn(22, "Doris", "Shaw", "female", 1952),
  bornIn(23, "Frank", "Shaw", "male", 1954),
  bornIn(24, "Vera", "Shaw", "female", 1955),
  bornIn(25, "Leonard", "Shaw", "male", 1957),
  bornIn(26, "Joyce", "Shaw", "female", 1959),
  bornIn(27, "Stanley", "Shaw", "male", 1961),
];

/**
 * One partner recorded, the other not — and nothing known about what kind of
 * partnership it was or how it ended, which is what `unknown` is for in both
 * enums. Every other union here is a `marriage` that was `ongoing` or ended
 * in `death`, so without this row `union_type` and three of the five
 * `union_end_reason` values never appear in a seeded database at all.
 */
const u0 = union(100, agnes.id, null, {
  type: "unknown",
  endReason: "unknown",
  sequence: 1,
  notes: "Thomas's father is not recorded.",
});

const u1 = union(101, mary.id, thomas.id, {
  startDate: "1927-04-16",
  endDate: "1931-08-02",
  endReason: "death",
  sequence: 1,
  notes: "Ended with Mary's death.",
});

const u2 = union(102, rose.id, thomas.id, {
  startDate: "1933-02-11",
  endDate: "1947-06-11",
  endReason: "death",
  sequence: 2,
  notes: "Ended with Thomas's death.",
});

/**
 * The year of the wedding is remembered and the day is not, so the union
 * carries the qualifier and precision columns exactly as the individuals do.
 * A row recording 3 July under a comment saying nobody remembers the day is a
 * comment and its data disagreeing, with the data winning on screen.
 */
const u3 = union(103, rose.id, walter.id, {
  startDate: "1948-01-01",
  startDateQualifier: "about",
  startDatePrecision: "year",
  sequence: 3,
});

/** Every person in the seeded family, by the name the documentation uses. */
export const seedPerson = {
  agnes,
  mary,
  thomas,
  rose,
  walter,
  edward,
  clara,
  arthur,
  ruth: shaws[0],
  harold: shaws[1],
  doris: shaws[2],
  frank: shaws[3],
  vera: shaws[4],
  leonard: shaws[5],
  joyce: shaws[6],
  stanley: shaws[7],
} as const;

/** Every union in the seeded family, by the name the diagram above uses. */
export const seedUnion = { u0, u1, u2, u3 } as const;

/**
 * The seeded family as one value: what `db/seed.ts` writes, and what a test
 * of anything taking a `FamilyGraph` can be handed directly.
 *
 * Clara was adopted, which is the whole reason children belong to a union
 * rather than to a parent. `relation` defaults to `biological`, so a seed
 * that never sets it leaves the dashed edge in `lib/tree-layout.ts` — and
 * every other reader that distinguishes the two — undrawn.
 */
export const seedFamily = {
  people: Object.values(seedPerson),
  unions: Object.values(seedUnion),
  childLinks: [
    childOf(u0, thomas),
    childOf(u1, edward),
    childOf(u2, clara, "adopted"),
    childOf(u2, arthur),
    ...shaws.map((shaw) => childOf(u3, shaw)),
  ],
} satisfies FamilyGraph;
