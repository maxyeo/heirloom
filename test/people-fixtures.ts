import type * as db from "@/db";
import {
  authorColumns,
  IMPORT_AUTHOR,
  type IndividualAuthor,
  type IndividualAuthorColumns,
  memberAuthor,
} from "@/lib/individual-author";

/**
 * The author columns a fixture row needs (`YEO-104`).
 *
 * `individuals.created_by_source` is `not null` with no default, so *every*
 * insert has to say who created the row — including the several dozen in
 * `*.db.test.ts` files that care about birth dates or portraits and nothing
 * whatsoever about authorship. That requirement is deliberate and is the
 * ticket's "a new path that forgets should fail a test": see `db/schema.ts`.
 * This is what keeps paying for it cheap.
 *
 * Two functions rather than one constant to spread, so a fixture reads as a
 * sentence about how those people got there — `addedByHand([…])` — and so the
 * two cases stay visibly different at the call site. A test that fabricates
 * an imported person needs `addedByImport` *and* an `importId`; one without
 * the other is a row this application cannot produce.
 *
 * ## Why they take the whole array rather than mapping over it
 *
 * `rows.map(addedByHand)` was the first shape and it does not survive
 * `strict`. An array literal handed to `.map` has no contextual type, so
 * `birthDateQualifier: "about"` widens to `string` before the helper ever
 * sees it and drizzle then refuses the enum column. Taking the array puts the
 * constraint below in contextual position, which is what keeps every literal
 * in a fixture narrow — including the ones this helper has no opinion about.
 *
 * The `import type` is load-bearing for the same suite-splitting reason
 * docs/testing.md gives for `FamilyGraph`: it erases completely, so a unit
 * test that reaches for this module does not drag `@/db` and postgres.js into
 * a run that has no `DATABASE_URL`.
 */

/** What `db.insert(schema.individuals).values(…)` will accept, one row of it. */
type IndividualRow = Partial<typeof db.schema.individuals.$inferInsert>;

/**
 * The member every hand-added fixture person is attributed to.
 *
 * A recognisable address rather than a plausible one: it shows up in feed
 * assertions, and `fixture@example.com` is unmistakably not somebody's real
 * account.
 */
export const FIXTURE_AUTHOR = "fixture@example.com";

/** People somebody typed in, attributed to {@link FIXTURE_AUTHOR}. */
export function addedByHand<Row extends IndividualRow>(
  rows: readonly Row[],
): (Row & IndividualAuthorColumns)[] {
  const author = authorColumns(memberAuthor(FIXTURE_AUTHOR));
  return rows.map((row) => ({ ...row, ...author }));
}

/**
 * People a GEDCOM file wrote — no email, because an imported row's author is
 * derived from `gedcom_imports.imported_by` through `import_id`. The caller
 * supplies that `importId`; this supplies only the two author columns.
 */
export function addedByImport<Row extends IndividualRow>(
  rows: readonly Row[],
): (Row & IndividualAuthorColumns)[] {
  const author = authorColumns(IMPORT_AUTHOR);
  return rows.map((row) => ({ ...row, ...author }));
}

/**
 * The member every write-path call in a fixture is made as.
 *
 * `createIndividual`, `addSpouse`, `addChild`, `attachChild` and `setParents`
 * all take an author now (`YEO-104`), and a test that is about a cycle check
 * or a sequence number has no opinion about who is signed in. This is the
 * "somebody is" that lets it say so in one word.
 */
export const FIXTURE_MEMBER: IndividualAuthor = memberAuthor(FIXTURE_AUTHOR);
