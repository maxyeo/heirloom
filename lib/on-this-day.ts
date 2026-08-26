import { and, asc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { db, schema } from "@/db";
import type { DatePrecision, DateQualifier } from "@/lib/family-graph";
import {
  type Anniversary,
  type AnniversaryDate,
  type AnniversaryPerson,
  mergeAnniversaries,
  ON_THIS_DAY_LIMIT,
  todayAnniversary,
  yearOf,
} from "@/lib/on-this-day-feed";
import { formatPersonName } from "@/lib/person-format";

/**
 * The reads behind the home page's "On this day" section (E8-T5, `YEO-59`) —
 * three narrow selects, each against the table that owns its source, handed to
 * `lib/on-this-day-feed.ts` to be interleaved.
 *
 * The pairing is `lib/recent-changes.ts`/`lib/recent-changes-feed.ts`'s, one
 * section along the same page: this module is the one allowed to import
 * `@/db`, and it contains no decisions — the shape of a row, the ordering
 * across sources, the limit and the wording all live in the pure module, where
 * `npm test` can see them (docs/testing.md).
 *
 * What *is* decided here is the one thing only SQL can express: which stored
 * dates are allowed to count as falling on a day at all. That is
 * `fallsOnAnniversary` below, and it is the heart of the ticket.
 *
 * The three statements are issued together rather than in sequence. None
 * depends on another's result, so awaiting them one at a time would cost the
 * page three round trips where one round trip's latency will do.
 */

/**
 * The qualifier a date must carry to have a day in it, as a typed constant.
 *
 * Written as a `DateQualifier` rather than inlined into the SQL string so that
 * a typo is a compile error rather than a predicate that silently matches
 * nothing — which is the failure mode that would look exactly like a quiet
 * day, on every day, forever.
 */
const EXACT: DateQualifier = "exact";

/**
 * The precision a date must carry, on the same terms as `EXACT`.
 *
 * This is the half of the predicate the acceptance criterion does not mention
 * and cannot do without — see `lib/on-this-day-feed.ts`'s header. `year` and
 * `month` precision both store an anchor day the source never gave, so
 * without this line every year-precision birth in the archive would appear
 * here on 1 January.
 */
const DAY: DatePrecision = "day";

/**
 * Everything the section shows, oldest first.
 *
 * @param today which day to report, defaulting to the real one in UTC. A
 *   parameter so that `lib/on-this-day.db.test.ts` can ask for a fixed date
 *   rather than write fixtures against the day the suite happens to run —
 *   which would be a test that passes 364 days a year for the wrong reason.
 * @param limit how many rows the section should hold, defaulting to
 *   `ON_THIS_DAY_LIMIT`. Passed on to each source query as well as to the
 *   merge — see that constant for why the two numbers are the same one.
 * @returns at most `limit` anniversaries, oldest first
 */
export async function listOnThisDay(
  today: AnniversaryDate = todayAnniversary(),
  limit: number = ON_THIS_DAY_LIMIT,
): Promise<Anniversary[]> {
  const [births, deaths, unions] = await Promise.all([
    listBirthsOn(today, limit),
    listDeathsOn(today, limit),
    listUnionsStartedOn(today, limit),
  ]);

  return mergeAnniversaries([births, deaths, unions], limit);
}

/**
 * The predicate that decides whether a stored date falls on `today` — the
 * whole of this ticket's second acceptance criterion, written once and used
 * by all three queries.
 *
 * ## The four clauses, and why the criterion only names one
 *
 * A date in this schema is four columns (`db/schema.ts`), and three of them
 * can independently mean "this row does not have a day":
 *
 *   - **`qualifier = 'exact'`** — the criterion's own clause. "About 1890"
 *     does not claim its stored day, so it cannot be somebody's birthday.
 *   - **`precision = 'day'`** — the clause the criterion predates. E4-T2 made
 *     a year-only date storable as 1 January *with `year` beside it*, so the
 *     day is an anchor rather than an assertion. Without this line the
 *     section would put every such person on the home page on 1 January,
 *     under a heading that says they were born that day. That is exactly the
 *     invented fact `datePrecision`'s docblock and `formatQualifiedDate`'s
 *     both exist to prevent, and it is a *widening* of the criterion rather
 *     than a departure from it — everything the criterion excludes stays
 *     excluded.
 *   - **`upper is null`** — `YEO-88`'s ranges. `BET 1890 AND 1900` is two
 *     points, and an anniversary of neither. A stored range legally carries
 *     `exact` (there is no `between` member on the enum, by design), so the
 *     first clause does not catch it.
 *   - **`is not null`** — strictly redundant, because the two `extract`
 *     comparisons below already evaluate to null and therefore not-true for a
 *     null date. It is stated anyway because the predicate should read as the
 *     requirement it is rather than lean on three-valued logic to imply its
 *     first line, and it costs nothing to be explicit about.
 *
 * ## `extract` rather than a computed column or an index
 *
 * There is no index on any of these date columns and this ticket does not add
 * one, which is the judgement `listRecentlyAddedPeople` reaches about
 * `individuals.created_at` for the same table: `getFamilyGraph` already reads
 * `individuals` *whole* into the browser on every visit to `/tree`, at a few
 * hundred rows. A functional index on `extract(month …)`, `extract(day …)` to
 * save a sequential scan over a table small enough to send to a browser would
 * be a migration and a write cost bought for nothing measurable. If an archive
 * ever holds tens of thousands of people it is an additive migration, and this
 * query does not change shape to use it.
 *
 * ## 29 February
 *
 * Somebody born on a leap day appears here on 29 February and on no other
 * date. Shifting them to the 28th or the 1st in common years is the obvious
 * kindness and the wrong call: the record says the 29th, and this section's
 * entire discipline is not to move a date the archive actually holds. They
 * come round every four years, which is what a leap-day birthday does.
 *
 * Run rather than argued, since `YEO-109`: `lib/on-this-day.db.test.ts`'s
 * `29 February` block puts a leap-day birth, death and union through this
 * predicate on 29 February 2028 and on both of its neighbours in a common
 * year, and names the three tidy-ups it would not survive — a day-of-year, a
 * year interval, and the kindness itself. Two of the three are invisible to
 * every other test in the repository, which is the argument for the fixtures
 * existing rather than the paragraph above standing alone.
 *
 * @param date the `date` column
 * @param qualifier its `date_qualifier` sibling
 * @param precision its `date_precision` sibling
 * @param upper its range upper bound (`YEO-88`), null on a single point
 * @param today the day being reported
 */
function fallsOnAnniversary(
  date: AnyPgColumn,
  qualifier: AnyPgColumn,
  precision: AnyPgColumn,
  upper: AnyPgColumn,
  today: AnniversaryDate,
): SQL {
  return sql`${date} is not null
    and ${qualifier} = ${EXACT}
    and ${precision} = ${DAY}
    and ${upper} is null
    and extract(month from ${date}) = ${today.month}
    and extract(day from ${date}) = ${today.day}`;
}

/**
 * Everybody born on today's date, earliest year first.
 *
 * ## Why `id` is in the `ORDER BY`
 *
 * Because `birth_date` alone does not identify *which* ten rows this is, and
 * ties here are the ordinary case rather than a hypothetical one: every row
 * this query returns already shares a month and a day, so two people born in
 * the same year are a tie, and twins are the everyday example.
 * `db/seed-family.ts` writes a whole family in one statement, and `YEO-58`'s
 * review caught precisely this shape of bug — a `LIMIT` with no unique
 * tie-break cuts through the middle of a tie group and returns whichever rows
 * the plan happened to produce, so a different person is dropped after an
 * autovacuum reorders the heap with nothing on screen to suggest the list is
 * arbitrary.
 *
 * `mergeAnniversaries` cannot rescue it: by the time it sorts, the rows the
 * database declined to return are already gone. `id` is unique, so
 * `(birth_date asc, id asc)` is total and the same database always answers the
 * same way. It costs nothing here — there is no index on `birth_date`, so this
 * query was sorting already and the second key rides along in the sort that
 * was happening anyway.
 *
 * The select is narrow for the reason `lib/pages.ts` gives for all of its
 * own: this row renders a name, a year and a link, and `notes` in particular
 * is authored prose that has no business crossing the wire to be thrown away.
 * The name is joined here rather than in the component because
 * `formatPersonName` is the one place that knows a surname can be missing.
 */
async function listBirthsOn(
  today: AnniversaryDate,
  limit: number,
): Promise<Anniversary[]> {
  const rows = await db
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      birthDate: schema.individuals.birthDate,
    })
    .from(schema.individuals)
    .where(
      fallsOnAnniversary(
        schema.individuals.birthDate,
        schema.individuals.birthDateQualifier,
        schema.individuals.birthDatePrecision,
        schema.individuals.birthDateUpper,
        today,
      ),
    )
    .orderBy(asc(schema.individuals.birthDate), asc(schema.individuals.id))
    .limit(limit);

  /*
    `flatMap` rather than `map`, and rather than a non-null assertion on
    `birth_date`. The column is nullable and `fallsOnAnniversary` has already
    excluded every null, but that guarantee lives in a `WHERE` clause the
    compiler cannot read. Dropping a null row here is the one response that is
    true whether or not the predicate is: an assertion would put `NaN` on the
    page the day somebody widened the query, and `?? ""` would do the same
    thing more quietly. The other two source queries take the same shape.
  */
  return rows.flatMap((row) =>
    row.birthDate === null
      ? []
      : [
          {
            kind: "birth" as const,
            personId: row.id,
            name: formatPersonName(row.givenName, row.surname),
            year: yearOf(row.birthDate),
          },
        ],
  );
}

/**
 * Everybody who died on today's date, earliest year first.
 *
 * The same query against the other pair of columns, and deliberately *not*
 * folded into `listBirthsOn` with a column-set parameter. The two differ by
 * four column references and by the `kind` of the row they build, so a shared
 * version would take those as arguments and be longer than both — and the
 * thing it would be hiding is exactly the thing a reader of this file needs to
 * see, which is which four columns each event reads. `fallsOnAnniversary` is
 * the part that genuinely repeats, and it is shared.
 */
async function listDeathsOn(
  today: AnniversaryDate,
  limit: number,
): Promise<Anniversary[]> {
  const rows = await db
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      deathDate: schema.individuals.deathDate,
    })
    .from(schema.individuals)
    .where(
      fallsOnAnniversary(
        schema.individuals.deathDate,
        schema.individuals.deathDateQualifier,
        schema.individuals.deathDatePrecision,
        schema.individuals.deathDateUpper,
        today,
      ),
    )
    .orderBy(asc(schema.individuals.deathDate), asc(schema.individuals.id))
    .limit(limit);

  return rows.flatMap((row) =>
    row.deathDate === null
      ? []
      : [
          {
            kind: "death" as const,
            personId: row.id,
            name: formatPersonName(row.givenName, row.surname),
            year: yearOf(row.deathDate),
          },
        ],
  );
}

/**
 * Every union that began on today's date, earliest year first.
 *
 * ## Why two left joins rather than a second query
 *
 * The row has to name the people, and `unions` holds only their ids. The
 * alternative is to select the unions and then fetch their partners by id,
 * which is two round trips that cannot be issued together — the second needs
 * the first's answer. Two left joins onto a table with a primary key index
 * answer it in one, on at most ten rows.
 *
 * **Left**, not inner, and that is the whole reason this is worth a
 * paragraph: both partner columns are nullable on purpose (`db/schema.ts`:
 * "we know the mother, the father is unknown" is extremely common in older
 * generations), so an inner join on either side would silently drop every
 * half-recorded couple — the ones whose anniversary is most likely to be the
 * only thing the archive still knows about them.
 *
 * ## Why a union with neither partner recorded is excluded
 *
 * `or(isNotNull(a), isNotNull(b))`. Such a row is legal — a union with
 * children and no recorded parents still holds the children together — but
 * there would be nobody to name and nowhere to link, so the section would show
 * a bare "Married 1912" that answers no question and follows nowhere. That is
 * the same judgement `listRecentImports` makes about an import that added
 * nobody.
 *
 * ## Why `type` is selected rather than filtered on
 *
 * The criterion says "marriages" and this returns partnerships and
 * unrecorded types as well, with the *word* differing instead — the argument
 * is in `Anniversary`'s `union-started` arm. Filtering here would mean a
 * couple recorded as a partnership never has an anniversary at all.
 *
 * `id` breaks ties on `start_date` for the reason `listBirthsOn` gives at
 * length, and at the same price, which is none: `unions` has no index on
 * `start_date`, so this sorts either way.
 */
async function listUnionsStartedOn(
  today: AnniversaryDate,
  limit: number,
): Promise<Anniversary[]> {
  /*
    Aliased because the same table is joined twice — Postgres needs two names
    for `individuals` in one statement, and Drizzle's `alias` is what supplies
    them. The names are the ones a reader of the generated SQL would want to
    see.
  */
  const partnerA = alias(schema.individuals, "partner_a");
  const partnerB = alias(schema.individuals, "partner_b");

  const rows = await db
    .select({
      id: schema.unions.id,
      type: schema.unions.type,
      startDate: schema.unions.startDate,
      /*
        The ids come from `unions` rather than from the joined rows, so that
        "is this partner recorded?" is answered by the column that actually
        records it. A left join's own id is null for the same reason and would
        answer the same way today, but only because `partner_a_id` is
        `on delete cascade` — reading the foreign key does not depend on that.
      */
      partnerAId: schema.unions.partnerAId,
      partnerAGivenName: partnerA.givenName,
      partnerASurname: partnerA.surname,
      partnerBId: schema.unions.partnerBId,
      partnerBGivenName: partnerB.givenName,
      partnerBSurname: partnerB.surname,
    })
    .from(schema.unions)
    .leftJoin(partnerA, eq(schema.unions.partnerAId, partnerA.id))
    .leftJoin(partnerB, eq(schema.unions.partnerBId, partnerB.id))
    .where(
      and(
        fallsOnAnniversary(
          schema.unions.startDate,
          schema.unions.startDateQualifier,
          schema.unions.startDatePrecision,
          schema.unions.startDateUpper,
          today,
        ),
        or(
          isNotNull(schema.unions.partnerAId),
          isNotNull(schema.unions.partnerBId),
        ),
      ),
    )
    .orderBy(asc(schema.unions.startDate), asc(schema.unions.id))
    .limit(limit);

  return rows.flatMap((row) =>
    row.startDate === null
      ? []
      : [
          {
            kind: "union-started" as const,
            unionId: row.id,
            unionType: row.type,
            partners: [
              partnerOrNull(
                row.partnerAId,
                row.partnerAGivenName,
                row.partnerASurname,
              ),
              partnerOrNull(
                row.partnerBId,
                row.partnerBGivenName,
                row.partnerBSurname,
              ),
            ].filter((partner) => partner !== null),
            year: yearOf(row.startDate),
          },
        ],
  );
}

/**
 * One half of a union, or null when that half was never recorded.
 *
 * Keyed on the id rather than on the name, because the id is what the `WHERE`
 * clause tested and what the link needs — a partner with an id has a row, and
 * a partner without one has nothing at all. `givenName` is `not null` in the
 * schema, so it is null here only when the left join found no row, which is
 * the same condition; it is checked anyway because the compiler cannot see
 * that the two agree, and the alternative is a non-null assertion standing in
 * for a rule stated three columns away.
 */
function partnerOrNull(
  personId: string | null,
  givenName: string | null,
  surname: string | null,
): AnniversaryPerson | null {
  if (personId === null || givenName === null) return null;
  return { personId, name: formatPersonName(givenName, surname) };
}
