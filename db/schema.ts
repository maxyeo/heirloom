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
 * ## A range is stored whole, in two columns (`YEO-88`)
 *
 * GEDCOM has two forms this list has no member for: `BET 1890 AND 1900` and
 * `FROM 1912 TO 1918`. They are two points, and until this ticket every event
 * here had one date column, so one of the two had nowhere to go. The answer
 * taken is the widening one: every event gets a `_date_upper` column and a
 * `_date_upper_precision` beside it, and both bounds are stored.
 *
 * `null` in `_date_upper` means "this date is a single point", which is what
 * every row written before these columns existed is — so the migration
 * changes the meaning of nothing. The upper precision is `not null default
 * 'day'` for the same reason the other two precision columns are: it is only
 * ever read alongside a non-null upper date, and "not a range" is already
 * said once, by that date being null.
 *
 * Both endpoints carry their own precision, and they routinely differ. `BET
 * MAR 1890 AND 1900` is a baptism in March and a census in 1900 — two
 * sources, two precisions. One precision column for both would have to
 * coarsen the better-known bound or sharpen the looser one, and either is the
 * invented-fact failure the anchor convention beside this column exists to
 * prevent.
 *
 * **This list gains no fifth member, and that is the point.** A stored range
 * carries `exact`, because `exact` already means "the value is as given,
 * widened by its precision" and that reading extends to two bounds without
 * changing a word: `[1890-01-01, 1900-12-31]` instead of `[1890-01-01,
 * 1890-12-31]`. A `between` member was the alternative, and it would have let
 * the two columns contradict each other — `('between', null)` and `('exact',
 * 1900-01-01)` are both writable and one of them is nonsense. With no new
 * member there is exactly one representation of every state.
 *
 * What it costs is width: seventeen columns on `individuals`, sixteen on
 * `unions`, eight of them inert on almost every row. That was judged worth
 * paying, because the alternative — collapsing a range onto `after` its lower
 * bound — made `AFT 1890` and `BET 1890 AND 1900` the same three values, and
 * nothing queried out of this database could have told them apart afterwards.
 * See docs/architecture.md for the argument in full.
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

/**
 * The provenance ledger for GEDCOM imports (`YEO-89`).
 *
 * ## What this exists to stop
 *
 * `lib/gedcom-map.ts` mints a fresh id for every record on every parse, so
 * nothing about the rows a write produces says whether the bytes behind them
 * have gone in before. Before this table, uploading the same file twice was
 * silent: the second run wrote a second complete copy of every person, union
 * and child link, and nothing in the database or in a query against it could
 * tell the two runs apart — a doubled tree looked exactly like data. One row
 * here per file, keyed on its digest, is what turns that into a refusal.
 *
 * ## The unique index on `digest` is the guard, not a pre-check
 *
 * A `select` for a matching digest followed by an `insert` has a race in the
 * middle: two requests can both see no prior row and both proceed, and a
 * second browser tab, a retried request, or a back button landing on a
 * stale preview is exactly the shape of caller that finds that gap. The
 * unique constraint has none — whichever transaction's insert commits second
 * is refused by the index itself, inside the same transaction
 * `lib/gedcom-import.ts` already opens to write the three tables, so the
 * loser's entire write rolls back with it. `lib/gedcom-import.db.test.ts`
 * proves that against a real database rather than leaving it as a claim
 * about how Postgres behaves.
 *
 * `digest` is the lowercase-hex SHA-256 `gedcomDigest` in
 * `lib/import-preview.ts` already computes to pin a confirming request to
 * the file it previewed. This reuses that value rather than hashing the
 * bytes a second time — there is exactly one digest of a file anywhere in
 * this application.
 *
 * ## Global, not scoped per tree
 *
 * There is one tenant and no row-level security (see "No RLS" in
 * docs/architecture.md's known limitations), so there is no narrower scope
 * to key the digest by: the same file is refused a second time regardless of
 * who uploads it or when.
 *
 * ## Why refuse rather than merge or replace the prior import
 *
 * Both alternatives need something this table deliberately does not
 * attempt: a stable per-record identity to reconcile against. Most real
 * GEDCOM files carry none — no `_UID`, no `REFN` — and inventing one from a
 * name and a pair of dates is a guess that can silently weld two different
 * cousins into one person; a stable identity to match on is the honest fix,
 * and it is future work, not this table. Replacing is worse than doing
 * nothing at all: rows an import writes are exactly the rows somebody goes
 * on to edit by hand — that is the whole point of importing into a wiki
 * rather than merely displaying a file — so "replace" would mean deleting
 * somebody's edits to make room for bytes the tree already has. Refusing is
 * the only one of the three that needs no identity model and destroys
 * nothing it did not write itself.
 *
 * What is still true after this table exists, because it does not touch it:
 * a *different* file describing the same people still duplicates them. There
 * is still no identity to match a record in one file against a record in
 * another, only a file against its own past self.
 */
export const gedcomImports = pgTable("gedcom_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Lowercase-hex SHA-256 of the file's bytes. See the table docblock. */
  digest: text("digest").notNull().unique(),
  /**
   * The uploaded filename, when there was one to read.
   *
   * Nullable because `FormData.get()` only promises a `Blob`, and only a
   * `File` — what a browser's `<input type="file">` actually sends — carries
   * a `name`. Nothing this application writes produces a `Blob` that is not
   * a `File`, but the type is the honest one to store against.
   */
  fileName: text("file_name"),
  byteCount: integer("byte_count").notNull(),
  /** How many `individuals` rows this import wrote. */
  individualCount: integer("individual_count").notNull(),
  /** How many `unions` rows this import wrote. */
  unionCount: integer("union_count").notNull(),
  /** How many `union_children` rows this import wrote. */
  unionChildCount: integer("union_child_count").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * The signed-in email that ran the import, the way `pages.updated_by` and
   * `revisions.created_by` record who wrote an edit. Nullable for the same
   * reason those are: a session without an email is unreachable through
   * `requireSession` (`lib/session.ts`), but nothing here forces the column
   * to agree with that as a matter of type.
   */
  importedBy: text("imported_by"),
});

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
    birthDateUpper: date("birth_date_upper"),
    birthDateUpperPrecision: datePrecision("birth_date_upper_precision")
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
    deathDateUpper: date("death_date_upper"),
    deathDateUpperPrecision: datePrecision("death_date_upper_precision")
      .notNull()
      .default("day"),
    deathPlace: text("death_place"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Which GEDCOM import wrote this row, if one did (`YEO-89`).
     *
     * Null is the ordinary case, not an edge one: every row typed into the
     * app by hand is null, and so is every row that existed before this
     * column did — a migration that widens what a row can say without
     * changing what any existing row means, the same rule the qualifier and
     * precision columns above follow.
     *
     * `onDelete: "set null"` rather than `cascade`: deleting a ledger row
     * must never take the people it recorded with it. What it means is
     * narrower and safer — "forget that this particular file was imported",
     * which also re-opens that file's digest for a future import — and
     * `gedcomImports`' own docblock is where that trade is argued in full.
     *
     * No index. This column is read by an operator asking "what did that
     * import add", by hand, after the fact — never by a request this
     * application serves. A sequential scan over one family's rows costs
     * nothing at the sizes this schema targets, and an index kept for a
     * query nobody runs twice is only ever a write it has to pay for.
     */
    importId: uuid("import_id").references(() => gedcomImports.id, {
      onDelete: "set null",
    }),
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
  startDateUpper: date("start_date_upper"),
  startDateUpperPrecision: datePrecision("start_date_upper_precision")
    .notNull()
    .default("day"),
  endDate: date("end_date"),
  endDateQualifier: dateQualifier("end_date_qualifier")
    .notNull()
    .default("exact"),
  endDatePrecision: datePrecision("end_date_precision")
    .notNull()
    .default("day"),
  endDateUpper: date("end_date_upper"),
  endDateUpperPrecision: datePrecision("end_date_upper_precision")
    .notNull()
    .default("day"),
  endReason: unionEndReason("end_reason").notNull().default("ongoing"),
  /**
   * Display order when dates are unknown. Families often remember the sequence
   * ("she remarried after he died") long after the years are lost.
   */
  sequence: integer("sequence").notNull().default(0),
  notes: text("notes"),
  /** Which import wrote this row, if one did. See `individuals.importId`. */
  importId: uuid("import_id").references(() => gedcomImports.id, {
    onDelete: "set null",
  }),
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
    /**
     * Which import wrote this row, if one did. See `individuals.importId` —
     * and this table gets the same column as the other two deliberately: a
     * child link added by hand to an imported union is ordinary, and
     * provenance that stopped at the two parent tables would make "what did
     * that import add" a query with a join in it and an exception to
     * remember.
     */
    importId: uuid("import_id").references(() => gedcomImports.id, {
      onDelete: "set null",
    }),
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

export const gedcomImportsRelations = relations(gedcomImports, ({ many }) => ({
  individuals: many(individuals),
  unions: many(unions),
  unionChildren: many(unionChildren),
}));

export const individualsRelations = relations(individuals, ({ one, many }) => ({
  page: one(pages, { fields: [individuals.pageId], references: [pages.id] }),
  childOf: many(unionChildren),
  import: one(gedcomImports, {
    fields: [individuals.importId],
    references: [gedcomImports.id],
  }),
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
  import: one(gedcomImports, {
    fields: [unions.importId],
    references: [gedcomImports.id],
  }),
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
  import: one(gedcomImports, {
    fields: [unionChildren.importId],
    references: [gedcomImports.id],
  }),
}));
