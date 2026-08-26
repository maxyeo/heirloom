import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, schema } from "@/db";
import { exportTreeAsGedcom } from "@/lib/export-tree";

/**
 * What only Postgres can prove about `lib/export-tree.ts` (E7-T1, `YEO-51`).
 *
 * The module is three queries and one call. Everything the call decides —
 * which records are written, in what shape, in what order — belongs to
 * `lib/gedcom-export.ts`, which is pure and is asserted against literals in
 * `lib/gedcom-export.test.ts` with no database in sight. What is left here is
 * the part that is a claim about SQL, and every one of those claims is one a
 * mocked Drizzle chain would answer by agreeing with itself.
 *
 * ## The claim worth testing
 *
 * `exportTreeAsGedcom`'s docblock argues that its `orderBy` clauses are not
 * decoration: Postgres gives no order without one, so two exports of an
 * unchanged database could come back in different orders. That matters
 * because E7-T2 (`YEO-52`) round-trips export -> import -> export and compares
 * the two texts **byte for byte**. Each clause ends on a primary key, which is
 * what makes the query's order total rather than merely detailed — and that
 * was reasoned rather than checked. `YEO-94` is the ticket for checking it.
 *
 * ## Why one of these tests reads SQL rather than rows
 *
 * Because a missing `ORDER BY` does not misbehave on demand. Postgres is
 * entitled to return the rows in any order it likes and, for a table of this
 * size, what it likes is the order they are stored in — which is very often
 * the order the dropped clause asked for anyway. This file's first draft tried
 * to provoke it, by inserting each tied pair highest-id-first so that the
 * stored order contradicted the clause. Deleting `asc(individuals.id)` from
 * the module left the suite green: the fixture's rows had been written into
 * space freed by the previous run's teardown, and came back ascending.
 *
 * A test that cannot fail is worse than no test, so the guard is stated where
 * it is decidable — on the statement Drizzle compiles. `orderedColumns` reads
 * the `order by` out of each of the three selects and checks it against the
 * primary key `information_schema` reports for that table. Drop a tie-breaker
 * and it goes red immediately, for all three queries, including the one on
 * `union_children` that no fixture could reach at all.
 *
 * ## And why the others still read rows
 *
 * A clause can also be *wrong* rather than absent — `desc` where `asc` was
 * meant, or the wrong column — and that is a failure a real database reports
 * reliably. The three ordering tests below are those: each builds rows the
 * serialiser cannot tell apart, so that the query's own order decides their
 * place in the file, and then reads that place out of the text.
 *
 * They are limited to tie-breakers by the design rather than by the fixture.
 * `writeGedcom` re-sorts everything it is handed on values that survive a
 * round trip, so ordering individuals by `surname` in SQL changes nothing a
 * reader can see. What *is* visible is the serialiser's final tie-break — "the
 * order the caller gave me" — which two rows identical in every sorted field
 * fall through to, and nothing else does.
 *
 * See docs/testing.md for why this is a `.db.test.ts`, and which CI job runs
 * it.
 */

// Explicit, recognisable ids, so teardown deletes exactly what this file made.
// Within each pair the ids are adjacent, and the rows are inserted highest
// first — not as a guard (see above) but so that nothing here passes merely
// because the fixture was already in the order it is asserting.
const TWIN_LOWER_ID = "00000000-0000-4000-8000-0000000094a1";
const TWIN_HIGHER_ID = "00000000-0000-4000-8000-0000000094a2";

const PARTNER_A_ID = "00000000-0000-4000-8000-0000000094b1";
const PARTNER_B_ID = "00000000-0000-4000-8000-0000000094b2";

const CHILD_OF_LOWER_ID = "00000000-0000-4000-8000-0000000094c1";
const CHILD_OF_HIGHER_ID = "00000000-0000-4000-8000-0000000094c2";
const CHILD_OF_EARLIER_ID = "00000000-0000-4000-8000-0000000094c3";

const UNION_LOWER_ID = "00000000-0000-4000-8000-0000000094d1";
const UNION_HIGHER_ID = "00000000-0000-4000-8000-0000000094d2";
const UNION_EARLIER_ID = "00000000-0000-4000-8000-0000000094d3";

const ROLLED_BACK_ID = "00000000-0000-4000-8000-0000000094e1";

/** One surname for the whole fixture, so its records are easy to pick out. */
const SURNAME = "Zzexporttree";

/**
 * Two people the serialiser cannot separate: same surname, same given name,
 * same birth date, same death date — every field `orderIndividuals` sorts on.
 * All that tells them apart in the file is their birth place, which is written
 * and never sorted by.
 *
 * The places run *against* the id order alphabetically. If anything downstream
 * started sorting on the place, "Ashby" would come first and this fixture
 * would say so rather than agreeing by coincidence.
 */
const LOWER_TWIN_PLACE = "Zetland Cottage";
const HIGHER_TWIN_PLACE = "Ashby Cottage";

const TWIN = {
  givenName: "Perpetua",
  surname: SURNAME,
  birthDate: "1888-03-04",
  deathDate: "1950-06-07",
} as const;

/** A union between the fixture's two partners, dateless so that they tie. */
function unionOf(id: string, sequence: number) {
  return { id, partnerAId: PARTNER_A_ID, partnerBId: PARTNER_B_ID, sequence };
}

async function removeFixture() {
  // Deleting the people is enough for the rest: `unions.partner_a_id` and
  // `partner_b_id` are `ON DELETE CASCADE`, and `union_children` cascades from
  // both of its own foreign keys.
  await db
    .delete(schema.individuals)
    .where(
      inArray(schema.individuals.id, [
        TWIN_LOWER_ID,
        TWIN_HIGHER_ID,
        PARTNER_A_ID,
        PARTNER_B_ID,
        CHILD_OF_LOWER_ID,
        CHILD_OF_HIGHER_ID,
        CHILD_OF_EARLIER_ID,
        ROLLED_BACK_ID,
      ]),
    );
}

beforeAll(async () => {
  // Also before, not just after: an interrupted run skips `afterAll` and would
  // otherwise greet the next one with a duplicate key on these ids.
  await removeFixture();

  await db.insert(schema.individuals).values([
    { ...TWIN, id: TWIN_HIGHER_ID, birthPlace: HIGHER_TWIN_PLACE },
    { ...TWIN, id: TWIN_LOWER_ID, birthPlace: LOWER_TWIN_PLACE },
    { id: PARTNER_A_ID, givenName: "Ambrose", surname: SURNAME },
    { id: PARTNER_B_ID, givenName: "Beatrix", surname: SURNAME },
    // The children are named against the id order of the unions they belong
    // to, for the same reason the twins' places are: "Cuthbert" before
    // "Drusilla" is what a stray sort on the child would produce, and the
    // assertions below expect the opposite.
    { id: CHILD_OF_LOWER_ID, givenName: "Drusilla", surname: SURNAME },
    { id: CHILD_OF_HIGHER_ID, givenName: "Cuthbert", surname: SURNAME },
    { id: CHILD_OF_EARLIER_ID, givenName: "Eglantine", surname: SURNAME },
  ]);

  /**
   * Three unions between the same two people, which is a row shape the schema
   * allows and this fixture needs: identical partners and no dates means
   * `orderUnions` cannot separate them, so their place in the file is the
   * query's order and nothing else.
   *
   * The first two share a `sequence` and so fall through to `asc(unions.id)`.
   * The third has a lower `sequence` and the *highest* id of the three, so it
   * can only come first if the sequence is being read at all.
   */
  await db
    .insert(schema.unions)
    .values([
      unionOf(UNION_HIGHER_ID, 5),
      unionOf(UNION_LOWER_ID, 5),
      unionOf(UNION_EARLIER_ID, 1),
    ]);

  // One child each, which is how a `FAM` record in the file says which union
  // it is: the three families are otherwise identical.
  await db.insert(schema.unionChildren).values([
    { unionId: UNION_LOWER_ID, childId: CHILD_OF_LOWER_ID },
    { unionId: UNION_HIGHER_ID, childId: CHILD_OF_HIGHER_ID },
    { unionId: UNION_EARLIER_ID, childId: CHILD_OF_EARLIER_ID },
  ]);
});

afterAll(removeFixture);

/** GEDCOM is a line format, and every assertion here reasons about lines. */
function linesOf(gedcom: string): string[] {
  return gedcom.split("\r\n");
}

/** Where a line sits in the file, asserting that it is there at all. */
function lineIndex(gedcom: string, line: string): number {
  const at = linesOf(gedcom).indexOf(line);
  expect(at, `no \`${line}\` line in the export`).toBeGreaterThan(-1);
  return at;
}

/** `I12` — the xref of the individual written under this `NAME`. */
function xrefOfPerson(gedcom: string, given: string): string {
  const lines = linesOf(gedcom);
  const named = lineIndex(gedcom, `1 NAME ${given} /${SURNAME}/`);

  for (let index = named; index >= 0; index--) {
    const opened = /^0 @(I\d+)@ INDI$/.exec(lines[index]);
    if (opened !== null) return opened[1];
  }

  throw new Error(`\`${given}\` has a NAME line outside any INDI record`);
}

/** Where the `CHIL` line naming this person sits — so, where its family sits. */
function childLineOf(gedcom: string, given: string): number {
  return lineIndex(gedcom, `1 CHIL @${xrefOfPerson(gedcom, given)}@`);
}

describe("the rows it reads", () => {
  it("reads all three tables, not only the ones a family hangs off", async () => {
    const gedcom = await exportTreeAsGedcom();

    // The twins are in no union at all. They are in the file because
    // `individuals` is read on its own terms — an export that only walked
    // outwards from families would lose everyone who is not in one, which for
    // a wiki part-way through being filled in is most of it.
    expect(gedcom).toContain(`1 NAME Perpetua /${SURNAME}/`);
    expect(gedcom).toContain(`2 PLAC ${LOWER_TWIN_PLACE}`);
    expect(gedcom).toContain(`2 PLAC ${HIGHER_TWIN_PLACE}`);

    // The unions, read from `unions` and pointed at both partners.
    expect(gedcom).toContain(`1 HUSB @${xrefOfPerson(gedcom, "Ambrose")}@`);
    expect(gedcom).toContain(`1 WIFE @${xrefOfPerson(gedcom, "Beatrix")}@`);

    // And the links, read from `union_children`.
    for (const child of ["Cuthbert", "Drusilla", "Eglantine"]) {
      expect(gedcom).toContain(`1 CHIL @${xrefOfPerson(gedcom, child)}@`);
    }
  });

  it("writes a file a reader would accept, from end to end", async () => {
    // Not a second copy of `lib/gedcom-export.test.ts`, which owns the format
    // in full. It is the seam: real column values, real nulls, real dates out
    // of `date` columns, through the real writer.
    const gedcom = await exportTreeAsGedcom();

    expect(gedcom.startsWith("0 HEAD\r\n")).toBe(true);
    expect(gedcom).toContain("1 CHAR UTF-8");
    expect(gedcom.endsWith("0 TRLR\r\n")).toBe(true);
  });
});

/** Anything Drizzle can compile — a select, at any point in its chain. */
type Compilable = { toSQL(): { sql: string } };

function isCompilable(value: unknown): value is Compilable {
  return (
    typeof value === "object" &&
    value !== null &&
    "toSQL" in value &&
    typeof value.toSQL === "function"
  );
}

/** A link in a chain: `select()` has `from`, and everything after it compiles. */
function isBuilder(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    ("from" in value || "toSQL" in value)
  );
}

/**
 * Wrap a chain so that every select in it is kept, and let it run for real.
 *
 * A `Set` rather than a list because `orderBy` returns the same builder it was
 * called on: one entry per query, holding the builder in its finished state,
 * which is the state whose `toSQL()` includes the `order by`.
 */
function watch(value: unknown, queries: Set<Compilable>): unknown {
  if (!isBuilder(value)) return value;
  if (isCompilable(value)) queries.add(value);

  return new Proxy(value, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (typeof member !== "function") return member;

      return (...args: unknown[]) =>
        watch(Reflect.apply(member, target, args), queries);
    },
  });
}

/**
 * The SQL of every select `exportTreeAsGedcom` runs, through a reader that is
 * the real `db` with a note-taker in front of it.
 *
 * Not a mock: the queries execute against Postgres exactly as they otherwise
 * would, and the export comes back. All the proxy does is keep the builders so
 * that the statements can be read afterwards.
 */
async function compiledSelects(): Promise<string[]> {
  const queries = new Set<Compilable>();

  await exportTreeAsGedcom(
    new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "select") {
          return Reflect.get(target, property, receiver);
        }

        // `lib/export-tree.ts` selects whole rows, so there is no argument to
        // forward — and taking none is what would make a future one visible
        // here rather than silently dropped.
        return () => watch(target.select(), queries);
      },
    }),
  );

  return [...queries].map((query) => query.toSQL().sql);
}

/** The one of those statements that reads from this table. */
function selectFrom(statements: string[], table: string): string {
  const matches = statements.filter((statement) =>
    statement.includes(`from "${table}"`),
  );

  expect(matches, `expected exactly one select from "${table}"`).toHaveLength(
    1,
  );
  return matches[0];
}

/** The columns a statement's `order by` names, in the order it names them. */
function orderedColumns(statement: string): string[] {
  const clause = /\border by\s+([\s\S]+)$/i.exec(statement);
  if (clause === null) throw new Error(`no \`order by\` in: ${statement}`);

  // Each term is `"table"."column" asc`; the column is the second identifier.
  return [...clause[1].matchAll(/"[^"]+"\."([^"]+)"/g)].map(
    (column) => column[1],
  );
}

/** What `information_schema` says the primary key of each table is. */
async function primaryKeyColumns(
  tables: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await db.execute<{
    table_name: string;
    column_name: string;
  }>(sql`
    select tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.table_schema = tc.table_schema
    where tc.constraint_type = 'PRIMARY KEY'
      and tc.table_schema = 'public'
      and tc.table_name in (${sql.join(
        tables.map((table) => sql`${table}`),
        sql`, `,
      )})
  `);

  const keys = new Map<string, string[]>();
  for (const row of rows) {
    keys.set(row.table_name, [
      ...(keys.get(row.table_name) ?? []),
      row.column_name,
    ]);
  }

  return keys;
}

describe("the order it reads them in", () => {
  const TABLES = ["individuals", "unions", "union_children"] as const;

  it("orders every read by columns that include the table's own key", async () => {
    /**
     * The guard. Ordering by a set of columns that contains a key is exactly
     * what makes the order *total*: no two rows can tie, so there is nothing
     * left for Postgres to choose, and two exports of an unchanged tree are
     * the same file.
     *
     * The key is read out of the catalogue rather than written down here, so
     * that this keeps meaning what it says if the schema changes — and so that
     * `union_children`, whose ordering columns *are* its key, is covered by
     * the same sentence as the other two rather than by a special case.
     *
     * The columns are compared as a set: which of a compound key's columns
     * comes first decides how the rows are grouped, not whether the order is
     * decided, and the export is entitled to choose.
     */
    const statements = await compiledSelects();
    expect(statements, "one select per table").toHaveLength(TABLES.length);

    const keys = await primaryKeyColumns(TABLES);

    for (const table of TABLES) {
      const ordered = orderedColumns(selectFrom(statements, table));
      const key = keys.get(table) ?? [];

      expect(key, `no primary key on "${table}"`).not.toHaveLength(0);

      for (const column of key) {
        expect(
          ordered,
          `the select from "${table}" does not order by "${column}", so two of its rows can tie`,
        ).toContain(column);
      }
    }
  });

  it("breaks a tie between two identical people on individuals.id", async () => {
    // The two `Perpetua` rows agree on every field `orderIndividuals` sorts
    // on, so the serialiser leaves them in the order the query returned them
    // and their birth places say which order that was.
    const gedcom = await exportTreeAsGedcom();

    expect(lineIndex(gedcom, `2 PLAC ${LOWER_TWIN_PLACE}`)).toBeLessThan(
      lineIndex(gedcom, `2 PLAC ${HIGHER_TWIN_PLACE}`),
    );
  });

  it("breaks a tie between two identical unions on unions.id", async () => {
    // Same shape, one table along: two families with the same partners, the
    // same (absent) dates and the same `sequence` fall through to
    // `asc(unions.id)`. Drusilla belongs to the lower id, Cuthbert to the
    // higher.
    const gedcom = await exportTreeAsGedcom();

    expect(childLineOf(gedcom, "Drusilla")).toBeLessThan(
      childLineOf(gedcom, "Cuthbert"),
    );
  });

  it("puts the union a family remembers as first, first", async () => {
    // `asc(unions.sequence)` ahead of the id, which is the column
    // `db/schema.ts` keeps for exactly this — "she remarried after he died",
    // remembered long after the years are lost. Eglantine's family has the
    // lowest `sequence` and the *highest* id of the three, so it can only be
    // written first if the sequence is what is being read.
    const gedcom = await exportTreeAsGedcom();

    expect(childLineOf(gedcom, "Eglantine")).toBeLessThan(
      childLineOf(gedcom, "Drusilla"),
    );
  });

  it("writes the same bytes twice from an unchanged tree", async () => {
    /**
     * The property E7-T2 (`YEO-52`) actually depends on, stated directly and
     * over the whole file rather than over the three rows an assertion picked
     * out.
     *
     * Two overlapping calls on two connections rather than one after the
     * other, because that is the situation the guarantee is about: two people
     * pressing Download at the same moment must get the same file.
     */
    const [first, second] = await Promise.all([
      exportTreeAsGedcom(),
      exportTreeAsGedcom(),
    ]);

    expect(first).toBe(second);
  });
});

describe("the reader it is given", () => {
  it("reads through a transaction when given one", async () => {
    // How E7-T4 (`YEO-54`) calls it, so that a backup's GEDCOM describes the
    // same instant as the JSON beside it.
    const gedcom = await db.transaction((tx) => exportTreeAsGedcom(tx));

    expect(gedcom).toContain(`1 NAME Ambrose /${SURNAME}/`);
  });

  it("sees what that transaction has written and not committed", async () => {
    /**
     * That the `reader` argument is *used* rather than merely accepted. A
     * version that took a transaction and then queried the pool anyway would
     * pass the test above and fail this one — and that is the defect E7-T4
     * needs ruled out, since a backup read outside its own transaction is a
     * backup that can disagree with itself.
     */
    class Rollback extends Error {}
    let inside = "";

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.individuals).values({
          id: ROLLED_BACK_ID,
          givenName: "Ephraim",
          surname: SURNAME,
        });

        inside = await exportTreeAsGedcom(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(inside).toContain(`1 NAME Ephraim /${SURNAME}/`);

    // And the pool never saw it, which is what makes this row's place in the
    // teardown list a belt-and-braces measure rather than a necessity.
    expect(await exportTreeAsGedcom()).not.toContain("Ephraim");
  });
});
