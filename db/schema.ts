import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The data model follows GEDCOM's core insight: a *union* is a first-class
 * entity, not an edge between two people. Modelling parenthood as
 * `person.parent_id` collapses on real families — remarriage, half-siblings,
 * adoption, and unknown parents all stop being special cases once children
 * belong to a union rather than to individuals.
 *
 * See docs/architecture.md for the worked example this schema was designed
 * against.
 */

export const sex = pgEnum("sex", ["male", "female", "other", "unknown"]);

/**
 * How much to trust the `date` column sitting next to this one.
 *
 * Genealogical sources are rarely precise: a headstone gives a year, a parish
 * register says "about 1890", a will proves someone was already dead "before
 * 1920". Postgres `date` can only store a single exact day, so without this
 * the imprecision has nowhere to go but the `notes` field — where no query,
 * no formatter, and no GEDCOM export can see it.
 *
 * The four values are exactly GEDCOM 5.5.1's date modifiers (`ABT`, `BEF`,
 * `AFT`, plus the unmodified case), so import and export are lossless for the
 * overwhelming majority of real dates.
 *
 * `exact` is the default, which is what makes this migration safe: every
 * existing row keeps meaning precisely what it meant before. The columns are
 * `not null` rather than nullable for the same reason — a qualifier is only
 * ever read alongside its date, so "no date at all" is already expressed by
 * the `date` column being null and needs no second way of saying it.
 *
 * ## Ranges collapse onto `after`, deliberately (`YEO-88`)
 *
 * GEDCOM has two forms this list has no member for: `BET 1890 AND 1900` and
 * `FROM 1912 TO 1918`. A range is two points and every event here has one
 * date column, so something has to give, and what gives is the upper bound.
 * Such a date is stored as `after` the **lower** bound, at whatever precision
 * that bound itself carries, and the whole original text is named on the
 * import report at the line it came from.
 *
 * Not `about` at the midpoint, which was the obvious alternative. `after
 * 1890` is a statement the file actually makes; `about 1895` is arithmetic on
 * two of its numbers producing a third that appears nowhere in it — a guess
 * wearing the clothes of a record, which is the same failure the anchor
 * convention beside this column exists to prevent. The difference is
 * mechanical as well as moral: `dateRange` in `lib/field-input.ts` reads
 * `after` as a real one-sided interval and `about` as no constraint at all,
 * so the midpoint reading would have discarded the ordering check along with
 * the bound.
 *
 * What it costs is the upper bound, and the cost is real: `AFT 1890` and `BET
 * 1890 AND 1900` become the same three column values, nothing queried out of
 * this database can tell them apart afterwards, and a GEDCOM export writes
 * both back as `AFT 1890` — true of both files, weaker than one of them. A
 * fifth enum member or a second date column would each have held it; see
 * docs/architecture.md for why neither was worth the width, and note that
 * either remains available later without any existing row changing meaning.
 */
export const dateQualifier = pgEnum("date_qualifier", [
  "exact",
  "about",
  "before",
  "after",
]);

/**
 * How much of the `date` column sitting next to this one was actually known
 * (E4-T2, `YEO-39`).
 *
 * A second column rather than more members on `date_qualifier`, because the
 * two answer different questions and a record routinely needs both. The
 * qualifier says how far the source can be trusted — "about 1890" against a
 * flat "1890". This says how much of a date the source gave at all: a
 * headstone and a census give a year, a parish register gives a day.
 *
 * The gap it closes is the one a `date` column cannot: Postgres has to be
 * handed a real calendar day, so a year read off a headstone had nowhere to go
 * but 1 January, and every reader downstream — the tree label, the detail
 * panel, a GEDCOM export — then repeated that invented day as though somebody
 * had recorded it. With this column a year-only date is stored as the first of
 * January *with `year` beside it*, and the day is an anchor rather than an
 * assertion. Nothing formats, compares or exports it as a day: see
 * `DATE_PRECISIONS` and `isImpossibleOrder` in `lib/field-input.ts`, and
 * `formatQualifiedDate` in `lib/format-date.ts`.
 *
 * `day` is the default, which is what makes the migration safe: every existing
 * row came from an `<input type="date">` and therefore carries a full date, so
 * it keeps meaning precisely what it meant before. `not null` for the same
 * reason `date_qualifier` is — this is only ever read alongside its date, and
 * "no date at all" is already said by the `date` column being null.
 */
export const datePrecision = pgEnum("date_precision", ["day", "month", "year"]);

export const unionType = pgEnum("union_type", [
  "marriage",
  "partnership",
  "unknown",
]);

export const unionEndReason = pgEnum("union_end_reason", [
  "ongoing",
  "death",
  "divorce",
  "separation",
  "unknown",
]);

export const childRelation = pgEnum("child_relation", [
  "biological",
  "adopted",
  "step",
  "foster",
]);

/**
 * Postgres's `tsvector`, which Drizzle has no column type for.
 *
 * Only ever read by Postgres: nothing selects this column, and nothing can
 * write it (it is `generated always`). So `data: string` is a placeholder for
 * a shape no TypeScript ever holds — what the type is really for is telling
 * drizzle-kit which SQL type to emit, and giving `lib/pages.ts` a column
 * reference to hand to `@@` and `ts_rank` instead of spelling the column name
 * out as a string.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * The text search configuration every part of entry search agrees on (E8-T1,
 * `YEO-55`).
 *
 * Exported because it has to be said twice and must not drift: once in
 * `pages.search_vector` below, which is what the stored lexemes *are*, and
 * once in `lib/pages.ts`'s `websearch_to_tsquery` and `ts_headline`, which is
 * what a query is parsed and highlighted with. A query parsed under a
 * different configuration than the document was indexed under does not error
 * — it silently stems the term differently and finds nothing, which is the
 * worst possible failure for a search box.
 *
 * `english` rather than `simple` because stemming is the whole point: an
 * author who searches "marriages" should find an entry that says "married".
 * The cost is that it also drops English stop words, so a query of nothing
 * but "the" finds nothing — the right answer for a search over prose.
 *
 * Changing this value is a migration, not an edit: the stored column is
 * `generated always`, so Postgres only recomputes it when the column
 * definition changes.
 */
export const SEARCH_TEXT_CONFIG = "english";

/** A wiki entry. Content lives here, never in the repo. */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by"),
    /**
     * What full-text search over entries matches against (E8-T1, `YEO-55`).
     *
     * **A generated column, not a trigger.** The two are the options Postgres
     * offers for keeping a `tsvector` current, and a trigger is the one that
     * can be wrong: it is a second place that has to know how the vector is
     * built, it only fires for the statements it was attached to, and a bulk
     * `UPDATE` that forgets it leaves rows indexed as they used to read. This
     * column *is* the definition. There is no write path — `lib/save-page.ts`,
     * `lib/create-page.ts`, `db/seed.ts`, a GEDCOM import, a hand-typed
     * `UPDATE` in psql — that can produce a row whose vector disagrees with
     * its text, because Postgres computes it as part of the write rather than
     * after it.
     *
     * **Why the tags do not need stripping first.** `to_tsvector` runs the
     * default parser, which recognises `tag` as its own token type, and the
     * `english` configuration maps no dictionary to it — so `<p>`, `<em>`,
     * and `<a href="https://example.com/secret">` are read, classified, and
     * discarded, and what lands in the vector is the words between them. That
     * is the acceptance criterion ("indexes the text content, not the HTML
     * tags") met by the parser rather than by a `regexp_replace` this schema
     * would then have to keep in step with whatever `lib/sanitize-html.ts`
     * allows.
     * It also means a link's `href` is not searchable text, which is right:
     * an author looking for "example.com" is looking for it in prose.
     *
     * **The weights are the ranking.** `A` on the title and `B` on the body
     * are what make a title match beat a body match, and they do it by
     * arithmetic rather than by a tie-break: `ts_rank`'s default weights cap
     * a `B` lexeme's contribution at 0.4 however many times the word occurs,
     * while one `A` occurrence already scores about 0.61. So there is no
     * number of mentions in a body that can outrank a title — see
     * `lib/pages.ts` and the assertion in `lib/pages.db.test.ts`.
     *
     * Neither input needs `coalesce`: both columns are `not null` above, and
     * `||` on two non-null vectors is non-null, so this column cannot be
     * `NULL` and no row can silently fall out of every search. Making either
     * column nullable would have to change this expression with it.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      // `sql.raw` because a column's generation expression is DDL: this string
      // is what drizzle-kit writes into the migration, and a bound parameter
      // has no meaning in a `CREATE TABLE`. It is safe for the reason raw SQL
      // usually is not — `SEARCH_TEXT_CONFIG` is a constant declared just
      // above, not a value anything outside this file can reach. Every place
      // the *query* side names the configuration binds it instead, and casts
      // it to `regconfig`; see `searchEntries` in `lib/pages.ts`.
      sql`setweight(to_tsvector('${sql.raw(SEARCH_TEXT_CONFIG)}', "title"), 'A') || setweight(to_tsvector('${sql.raw(SEARCH_TEXT_CONFIG)}', "body_html"), 'B')`,
    ),
  },
  (t) => [
    index("pages_updated_at_idx").on(t.updatedAt),
    /**
     * GIN rather than GiST: GIN is the index Postgres's own documentation
     * recommends for `tsvector` search, and its trade — slower to update,
     * faster and exact to query — is the right way round for a wiki, which is
     * read far more often than it is written and has no lossy-recheck step to
     * pay for. There are a few hundred entries here, so on today's data the
     * planner may well still choose a sequential scan; the index is what keeps
     * that decision the planner's to make as the table grows.
     */
    index("pages_search_vector_idx").using("gin", t.searchVector),
  ],
);

/**
 * Append-only history. A row is written on every save, so "undo" is a copy
 * rather than a recovery job.
 */
export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"),
    /**
     * Provenance for a restore (E1-T7): which revision this row's content was
     * copied forward from, or null for an ordinary save.
     *
     * A column rather than a convention baked into the title or the body,
     * because restore is the one operation whose *meaning* is not recoverable
     * from the content it writes. A restored revision is byte-identical to the
     * revision it came from, so without this the history reads as though
     * somebody retyped an old version from memory — the two rows are
     * indistinguishable, and "restoring is itself undoable" becomes a fact
     * about the data that nothing in the data actually records.
     *
     * Nullable, and that is the common case: every row written before this
     * column existed, and every row an ordinary save writes, has no source
     * revision. Null therefore means "typed, not restored", which is a real
     * distinction rather than missing data.
     *
     * `onDelete: "set null"` on a self-reference that, in practice, only ever
     * fires as collateral: nothing deletes a revision on its own (that is the
     * append-only property this whole ticket rests on), and the only deletion
     * that reaches this table is the `pages` cascade above, which takes a
     * page's whole history — source rows and restored rows together — in one
     * statement.
     *
     * The type annotation is required by TypeScript, not by Drizzle: a table
     * whose column definition refers back to the same table is circular, and
     * without an explicit return type the inference has nowhere to bottom out.
     */
    restoredFromId: uuid("restored_from_id").references(
      (): AnyPgColumn => revisions.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [index("revisions_page_id_created_at_idx").on(t.pageId, t.createdAt)],
);

/** A person. Optionally linked to their wiki entry. */
export const individuals = pgTable(
  "individuals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id").references(() => pages.id, {
      onDelete: "set null",
    }),
    givenName: text("given_name").notNull(),
    surname: text("surname"),
    sex: sex("sex").notNull().default("unknown"),
    birthDate: date("birth_date"),
    birthDateQualifier: dateQualifier("birth_date_qualifier")
      .notNull()
      .default("exact"),
    birthDatePrecision: datePrecision("birth_date_precision")
      .notNull()
      .default("day"),
    birthPlace: text("birth_place"),
    deathDate: date("death_date"),
    deathDateQualifier: dateQualifier("death_date_qualifier")
      .notNull()
      .default("exact"),
    deathDatePrecision: datePrecision("death_date_precision")
      .notNull()
      .default("day"),
    deathPlace: text("death_place"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("individuals_surname_idx").on(t.surname, t.givenName)],
);

/**
 * A partnership. Both partners are nullable on purpose: "we know the mother,
 * the father is unknown" is extremely common in older generations, and a model
 * that cannot express it forces you to invent placeholder people.
 */
export const unions = pgTable("unions", {
  id: uuid("id").primaryKey().defaultRandom(),
  partnerAId: uuid("partner_a_id").references(() => individuals.id, {
    onDelete: "cascade",
  }),
  partnerBId: uuid("partner_b_id").references(() => individuals.id, {
    onDelete: "cascade",
  }),
  type: unionType("type").notNull().default("marriage"),
  startDate: date("start_date"),
  startDateQualifier: dateQualifier("start_date_qualifier")
    .notNull()
    .default("exact"),
  startDatePrecision: datePrecision("start_date_precision")
    .notNull()
    .default("day"),
  endDate: date("end_date"),
  endDateQualifier: dateQualifier("end_date_qualifier")
    .notNull()
    .default("exact"),
  endDatePrecision: datePrecision("end_date_precision")
    .notNull()
    .default("day"),
  endReason: unionEndReason("end_reason").notNull().default("ongoing"),
  /**
   * Display order when dates are unknown. Families often remember the sequence
   * ("she remarried after he died") long after the years are lost.
   */
  sequence: integer("sequence").notNull().default(0),
  notes: text("notes"),
});

/** Children belong to a union, which is what makes half-siblings fall out for free. */
export const unionChildren = pgTable(
  "union_children",
  {
    unionId: uuid("union_id")
      .notNull()
      .references(() => unions.id, { onDelete: "cascade" }),
    childId: uuid("child_id")
      .notNull()
      .references(() => individuals.id, { onDelete: "cascade" }),
    relation: childRelation("relation").notNull().default("biological"),
  },
  (t) => [
    primaryKey({ columns: [t.unionId, t.childId] }),
    index("union_children_child_id_idx").on(t.childId),
  ],
);

export const pagesRelations = relations(pages, ({ many, one }) => ({
  revisions: many(revisions),
  individual: one(individuals),
}));

export const revisionsRelations = relations(revisions, ({ one }) => ({
  page: one(pages, { fields: [revisions.pageId], references: [pages.id] }),
}));

export const individualsRelations = relations(individuals, ({ one, many }) => ({
  page: one(pages, { fields: [individuals.pageId], references: [pages.id] }),
  childOf: many(unionChildren),
}));

export const unionsRelations = relations(unions, ({ one, many }) => ({
  partnerA: one(individuals, {
    relationName: "partnerA",
    fields: [unions.partnerAId],
    references: [individuals.id],
  }),
  partnerB: one(individuals, {
    relationName: "partnerB",
    fields: [unions.partnerBId],
    references: [individuals.id],
  }),
  children: many(unionChildren),
}));

export const unionChildrenRelations = relations(unionChildren, ({ one }) => ({
  union: one(unions, {
    fields: [unionChildren.unionId],
    references: [unions.id],
  }),
  child: one(individuals, {
    fields: [unionChildren.childId],
    references: [individuals.id],
  }),
}));
