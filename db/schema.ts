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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { INDIVIDUAL_AUTHOR_SOURCES } from "../lib/individual-author";

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
 * How to read `individuals.created_by` sitting next to it (`YEO-104`).
 *
 * The same arrangement as `date` and {@link dateQualifier} one table down: a
 * nullable value, and a not-null companion that says what its absence means.
 * A lone nullable `created_by` would have to answer three different questions
 * with one null — a row a file wrote, a row that predates the column, and a
 * row somebody typed in while signed out — and a reader cannot tell those
 * apart, which is exactly the collapse the feed's own `RecentChange` union
 * exists to refuse.
 *
 * **The labels are imported rather than written here**, from
 * `lib/individual-author.ts`, which is also where each one is defined and
 * argued. Repeating them would be two lists nothing obliges to stay equal —
 * the drift `test/route-inventory.ts` names — and the one that matters is the
 * `legacy` label, which no TypeScript value can produce and which therefore
 * has to mean the same thing here as it does there.
 */
export const createdBySource = pgEnum(
  "created_by_source",
  INDIVIDUAL_AUTHOR_SOURCES,
);

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
    /**
     * The indented italic line above the lead paragraph (E11-T9, `YEO-79`).
     *
     * ## Why it is a column and not the first paragraph of the body
     *
     * Because it is not part of the article. A hatnote answers "am I reading
     * about the right person" — it points *away* from the entry, and the
     * reader who needs it has not started reading yet. Stored in `body_html`
     * it would be indistinguishable from prose: the outline would treat it as
     * content, `ts_headline` would offer it as the snippet that answers a
     * search, and an author editing the lead could not move a paragraph
     * without stepping over it. A column keeps "this is apparatus" a fact
     * about the data rather than a convention about where in a string
     * something sits.
     *
     * ## What is in it
     *
     * Text and `<a href>` anchors, and nothing else — the shape
     * `normaliseHatnote` in `lib/hatnote.ts` produces and re-produces on
     * every read. It is *not* a second HTML dialect: the value is output of
     * `sanitizeHtml`, the same allowlist entry bodies go through, narrowed by
     * a structural flatten between two passes of it rather than by a second
     * allowlist. See that module for why the narrowing is a transform and not
     * a policy.
     *
     * `not null default ''` rather than nullable, matching `body_html` above:
     * "no hatnote" and "an empty hatnote" are the same state and deserve one
     * representation, and every row written before this column existed
     * already means the first of them.
     *
     * ## Why it is not in `search_vector`
     *
     * The generated column below indexes the title at weight `A` and the body
     * at `B`, and it deliberately does not index this. A hatnote names *other*
     * entries — "For other people named Rose Whitfield, see…" — so indexing it
     * would make every same-named person's entry a match for every other's,
     * ranked by text nobody wrote about the subject. The automatic half of the
     * feature is derived from `individuals` at render time and is not stored
     * here at all, so it could not be indexed even in principle.
     */
    hatnote: text("hatnote").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by"),
    /**
     * When this entry was retired (E1-T10, `YEO-122`), or null for as long as
     * it is a live entry.
     *
     * ## Why a column and not a `DELETE`
     *
     * `revisions.page_id` is `on delete cascade`, so `delete from pages` takes
     * the entry's whole history with it — the one thing the append-only model
     * exists to keep. And it is quietly a photograph deletion too:
     * `lib/image-references.ts` counts an image as referenced if any body *or
     * revision* mentions it, so dropping both makes every picture that entry
     * ever held unreferenced, and the next `npm run db:images-sweep --delete`
     * reclaims files the nightly backup does not carry (docs/backups.md).
     * Nothing on screen would say so, and there is nothing to restore them
     * from — the dump carries the rows that point at images and never the
     * images themselves.
     *
     * So an entry is *retired*, never deleted — the same shape, and the same
     * argument, as {@link gedcomImports.releasedAt} (`YEO-95`). The row stays,
     * the revisions stay, `individuals.page_id` goes on pointing at it, every
     * image stays referenced, and the operation is undone by an `UPDATE`
     * rather than by a restore from a backup.
     *
     * ## Why a timestamp rather than a boolean
     *
     * The same reason `released_at` is one: *whether* an entry was retired is
     * half of what somebody looking at a tombstone needs, and the other half —
     * when, and by whom — is the difference between "retired this morning by
     * mistake" and a decision taken years ago that nobody remembers. `null` is
     * not a missing timestamp here; it is the live state, and it is the value
     * every reader's predicate and the partial index below are keyed on.
     *
     * ## What reads it, and the two things that must not
     *
     * A dozen modules issue SQL against this table, and getting one of them
     * wrong is silent — a retired entry that goes on appearing in search, or a
     * photograph the sweep reclaims. `LIVE_PAGES` in `lib/live-pages.ts` is the
     * one predicate they share, and `lib/pages.call-sites.test.ts` is the
     * tripwire that no module names this table without it. Two are exempt on
     * purpose and say so there: `lib/image-references.ts`, which must keep
     * scanning a retired entry's body so its photographs stay referenced, and
     * `lib/export-full.ts`, which must carry retired rows *and this column* or
     * a restore from the archive resurrects every entry anybody retired.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * Who retired it, alongside {@link pages.deletedAt} — the same shape and
     * the same nullability as `updatedBy` above, and null for the same two
     * reasons: an entry nobody has retired has nobody to name, and a row
     * retired by a hand-run `UPDATE` has no session to read one from.
     *
     * Recorded because the tombstone says it out loud. `/wiki/[slug]` on a
     * retired entry renders who retired it and when rather than a 404, on the
     * grounds that everybody who can reach this wiki is already a full editor
     * (`lib/allowed-emails.ts`), and an accidental retirement that looks like
     * data loss is worse than one that names its author and offers a button.
     */
    deletedBy: text("deleted_by"),
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
    /**
     * The recently-changed feed's access path (E8-T4), and since `YEO-122` a
     * **partial** one — the same change, made for the same reason, that
     * `gedcom_imports_live_digest_idx` makes over there.
     *
     * `listRecentlyChangedEntries` now asks for the *live* entries in
     * `updated_at` order, and a plain index on `updated_at` alone can only
     * answer that by walking rows it then throws away. Keyed on the predicate
     * as well, the index holds exactly the rows the feed can return, so the
     * filter is free and a wiki whose retired entries come to outnumber its
     * live ones does not slow its own front page down. It is also what keeps
     * that query answerable from an index at all — the criterion
     * `lib/recent-changes.db.test.ts` checks as a query plan rather than as a
     * claim in a comment, and which a `WHERE` on an unindexed column is
     * exactly what its own note warned would break.
     */
    index("pages_updated_at_idx")
      .on(t.updatedAt)
      .where(sql`${t.deletedAt} is null`),
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
    /**
     * The entry's hatnote at this revision (E11-T9, `YEO-79`).
     *
     * Here for the reason the table exists at all: docs/product.md's "Nothing
     * is ever destroyed" is a promise about *authored* text, and a hatnote is
     * authored. A version of this feature that stored the hatnote only on
     * `pages` would have made one sentence of an entry the one thing a
     * restore could not bring back, silently — the restore would succeed, the
     * paragraphs would return, and the line above them would still be
     * whatever the last save left.
     *
     * `not null default ''` so that every revision written before this column
     * existed reads as the entry having had no hatnote then, which is exactly
     * what was true.
     */
    hatnote: text("hatnote").notNull().default(""),
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
    /**
     * What the entry was filed under at this revision (`YEO-106`), as category
     * *names*, in slug order.
     *
     * ## Why the filing is in here at all
     *
     * E11-T8 (`YEO-78`) put categories in `page_categories` and nowhere else,
     * which meant re-filing an entry moved `pages.updated_at` and appended no
     * history — so the archive recorded that something had changed and could
     * not say what. `YEO-106` is the decision that reversed it: a revision is
     * the entry's whole state, filing included, and *every* save writes one.
     * See docs/architecture.md for the argument, and for the two answers that
     * were rejected.
     *
     * ## Why names, and not a `revision_categories` join table
     *
     * Because a join table would let history be rewritten by a delete. Both of
     * `page_categories`'s foreign keys are `on delete cascade`, and the
     * docblock below argues at length that this is right: retiring a category
     * *detaches* it from the entries filed under it. Point that same cascade at
     * a revision and retiring a category silently edits every past revision
     * that mentioned it — the entry's history would then say it had never been
     * filed there, which is the one thing an append-only table exists to make
     * impossible. `restrict` is no better: it would make retiring a category
     * conditional on nobody in the wiki's entire history having used it, which
     * is to say never.
     *
     * The rest of this row is already values rather than references. `title`,
     * `body_html` and `hatnote` are copies of what the entry said at that
     * moment, not pointers to something that can move underneath them. A name
     * is the same kind of thing, and it is the *only* part of a category that
     * outlives the category's own row: the slug is derivable from it
     * (`categorySlug`, `lib/category-name.ts`) and the id is not. So a restore
     * can re-create a retired category out of a revision alone, which is what
     * makes restore total rather than total-unless-somebody-tidied-up.
     *
     * ## Which names
     *
     * The names of the rows the entry was actually filed under —
     * `categories.name` — rather than whatever the author typed into the
     * picker. The two differ: typing "Whitfield Family" when "Whitfield family"
     * already exists files under the existing row and deliberately does not
     * rename it (see `setEntryCategories`), so the typed spelling was never the
     * entry's filing, and storing it would make the very next save look like a
     * change.
     *
     * ## Why slug order
     *
     * Because two snapshots have to be comparable as arrays, and the display
     * order cannot do that job: alphabetical here means `Intl.Collator`
     * (`compareCategoriesByName`), whose answers are a property of whichever
     * ICU build the process happens to have. Code-point order on the slug is
     * the same order on every machine for ever, which is what lets `savePage`'s
     * no-op rule and the diff compare two filings by equality. Every surface
     * that *renders* a filing still sorts it by name, exactly as before.
     *
     * `not null default '{}'` rather than nullable, on the same terms as
     * `hatnote` above: "filed under nothing" and "no filing recorded" are the
     * same state and deserve one representation. The default is what every row
     * written before this column existed would otherwise read as, and for most
     * of them that is true — but not for an entry filed in the `YEO-78` era, so
     * the migration backfills the newest revision of each entry from
     * `page_categories` rather than leaving the current filing invisible to
     * history. See `drizzle/0012_revision_categories.sql`.
     */
    categories: text("categories")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [index("revisions_page_id_created_at_idx").on(t.pageId, t.createdAt)],
);

/**
 * A heading an entry can be filed under (E11-T8, `YEO-78`).
 *
 * ## What a category is for
 *
 * The tree answers "who is related to whom" and search answers "where does
 * this word appear". Neither answers "everyone who emigrated" or "everyone
 * buried at St Mary's" — a second axis of navigation that is neither blood
 * nor text, and that only a person deciding this entry belongs with those
 * entries can supply. That decision is what a row here holds.
 *
 * ## Why a table and not `[[Category:…]]` in the body
 *
 * MediaWiki puts categories in the wikitext, which is why a MediaWiki page's
 * categories are revisioned for free. This wiki has no wikitext: the body is
 * sanitised HTML produced by a WYSIWYG editor, and docs/product.md is explicit
 * that the primary author does not write markup. A syntax nobody types is a
 * syntax nobody can use, and one that would have to survive `sanitizeHtml`,
 * `readArticleOutline`, `ts_headline` and the diff view intact — four places
 * that would each need to know that some text in the body is not prose.
 *
 * A table is also the only shape in which the listing page (`/wiki/category/
 * [slug]`) is one indexed query rather than a scan of every body looking for a
 * marker.
 *
 * ## `slug` is the identity, `name` is the label
 *
 * The slug is derived from the name by `slugFromTitle` (`lib/entry-slug.ts`) —
 * the same derivation entry addresses use, so accents fold, apostrophes
 * vanish, and every Unicode script survives. It is unique, and that uniqueness
 * is the whole of de-duplication: an author who types "Whitfield Family" into
 * the picker when "Whitfield family" already exists is filing under the
 * existing category rather than creating a near-twin nobody would notice until
 * the two lists disagreed.
 *
 * The constraint is what does that, not a check-then-insert in TypeScript.
 * Two authors saving two entries under a brand-new category name at the same
 * instant both find nothing and both insert; the index refuses the second, and
 * `lib/categories.ts` handles the refusal by reading the winner's row. See
 * the same argument at greater length on {@link gedcomImports}.
 *
 * `name` is not unique and deliberately so: it is display text, and making it
 * unique would add a second way for the same category to be rejected — one
 * that speaks about capitalisation, which is not a difference this feature
 * believes in.
 */
export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The address at `/wiki/category/[slug]`, and the de-duplication key. */
  slug: text("slug").notNull().unique(),
  /** The name as the author who created it typed it, whitespace normalised. */
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Which entries are filed under which category (E11-T8, `YEO-78`).
 *
 * A row here is a *statement about a relationship* and holds nothing else —
 * no ordering column, no note, no author. Wikipedia's category bar lists in
 * alphabetical order and so does this, so there is no sequence to remember;
 * and an entry is either in a category or it is not, so there is no third
 * state a column could record.
 *
 * ## The `on delete` decision, which is the ticket's last acceptance criterion
 *
 * **"Deleting a category detaches it from entries rather than deleting them."**
 * That is `cascade` on *this* table's two foreign keys, and nothing on
 * `pages`. Deleting a category removes the rows that say "these entries are
 * filed here" and stops; the entries themselves are untouched, because no
 * foreign key runs in that direction. The same holds the other way: deleting
 * an entry removes its filings and leaves every category standing, possibly
 * empty, which is the right outcome for a category three other entries are
 * still using.
 *
 * It is worth stating why `cascade` and not `restrict` here, since `restrict`
 * is the reflex when a deletion sounds dangerous. `restrict` would make
 * deleting a category impossible while any entry used it — the author would
 * have to unfile every entry by hand first, and the failure would surface as a
 * constraint violation rather than as a sentence. And it would not be safer:
 * the row being deleted either way is the filing, and a filing is exactly what
 * "detach" means. `set null` is not available at all — both columns are part
 * of the primary key.
 *
 * `lib/categories.db.test.ts` asserts the criterion directly rather than
 * trusting this docblock: it files two entries under a category, deletes the
 * category, and checks that both `pages` rows are still there.
 *
 * ## Why the second index
 *
 * The primary key is `(page_id, category_id)`, which is the order the article
 * page asks in — "what is this entry filed under". The listing page asks the
 * opposite question, "what is filed under this category", and a composite
 * index leading on `page_id` cannot serve it. `page_categories_category_id_idx`
 * is that access path.
 */
export const pageCategories = pgTable(
  "page_categories",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.categoryId] }),
    index("page_categories_category_id_idx").on(t.categoryId),
  ],
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
 *
 * ## The way back out: a row is *retired*, never deleted (`YEO-95`)
 *
 * The refusal above is the correct default precisely because it fires on the
 * accidental second import — but the same condition fires on the deliberate
 * one, and a guard with no override is only correct while nobody legitimately
 * needs the thing it forbids. Somebody who imports a file, decides the result
 * is wrong, and deletes the rows is left with a digest no part of the product
 * can release: the tree is empty, the file is the one they want, and the only
 * exit is `DELETE FROM gedcom_imports` by hand.
 *
 * The obvious manual fix is also the destructive one. `import_id` on
 * `individuals`, `unions` and `union_children` is `ON DELETE set null`, so
 * deleting a ledger row strips the provenance from every row of that import
 * that *survived* — which is the column `YEO-89` added the ledger for. So the
 * escape hatch deletes nothing. It sets {@link gedcomImports.releasedAt} on
 * the row instead, and the guard is a **partial** unique index over the rows
 * that have not been released:
 *
 * ```sql
 * create unique index on gedcom_imports (digest) where released_at is null;
 * ```
 *
 * Everything the unique constraint bought survives that change, because it is
 * still an index and Postgres still enforces it inside the writing
 * transaction: at most one *live* claim on a digest at a time, no
 * check-then-insert race, and a loser whose whole write rolls back. What it
 * adds is that giving up a claim is an ordinary row update rather than a
 * deletion — the retired row keeps its id, its counts, its date and every
 * `import_id` pointing at it, and the re-import becomes a **new** ledger entry
 * beside it rather than a rewrite of the old one. The history of a file that
 * has been imported, released and imported again is legible as two rows,
 * which is what actually happened.
 *
 * Releasing is deliberately *only* about the claim. It removes nothing the
 * earlier import wrote — see `lib/gedcom-import.ts` for why that is the honest
 * behaviour rather than a missing feature, and `components/GedcomImport.tsx`
 * for the sentence that tells a reader so before they ask for it.
 */
export const gedcomImports = pgTable(
  "gedcom_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Lowercase-hex SHA-256 of the file's bytes. See the table docblock.
     *
     * Not `.unique()` since `YEO-95`: uniqueness is the partial index below,
     * which holds only over rows that still hold their claim. A plain unique
     * constraint here would make a released row go on blocking the very
     * import releasing it was for.
     */
    digest: text("digest").notNull(),
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
    /**
     * When this import gave up its claim on {@link gedcomImports.digest}
     * (`YEO-95`), or null for as long as it still holds it.
     *
     * The one column the guard reads, and the reason it is a timestamp rather
     * than a boolean: *whether* a claim was released is only half of what
     * somebody looking at two rows for the same digest needs, and the other
     * half — when — is the difference between "released this morning, before
     * the re-import beside it" and a row released years ago for reasons
     * nobody remembers. `null` is not a missing timestamp: it is the live
     * state, and it is the value the partial index below is keyed on.
     */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    /**
     * Who released it, alongside {@link gedcomImports.releasedAt} — the same
     * shape and the same nullability as `importedBy`, and recorded for a
     * sharper reason. An import is an ordinary act; releasing a digest is the
     * deliberate override of a guard, and the one question asked afterwards
     * about an override is who used it.
     */
    releasedBy: text("released_by"),
  },
  (t) => [
    /**
     * The guard, and since `YEO-95` a **partial** one: at most one live claim
     * per digest, with released rows exempt so that the row a release retires
     * cannot go on refusing the import that release was for. See the table
     * docblock. `lib/gedcom-import.ts` names this predicate again in its
     * `on conflict` clause, because Postgres will only infer a partial index
     * from a statement that repeats the predicate.
     */
    uniqueIndex("gedcom_imports_live_digest_idx")
      .on(t.digest)
      .where(sql`${t.releasedAt} is null`),
  ],
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
    /**
     * The person's portrait, as a **storage key** (E5-T4, `YEO-44`).
     *
     * A key and never a URL, and that is the one thing about this column
     * worth being emphatic about. `lib/storage.ts` hands out signed URLs that
     * stop working fifteen minutes after they are minted (`YEO-86`), so a URL
     * stored here would render for one afternoon and be a broken image for
     * the rest of this row's life. The key is the durable handle; the URL is
     * minted per request by `GET /api/images/…`. That is the same contract
     * `docs/architecture.md#the-storage-seam` sets for entry bodies, and the
     * upload endpoint already refuses to hand a caller anything else — it
     * names this column while doing so.
     *
     * Null is the ordinary case rather than an edge one: most people in a
     * family tree have no photograph, and every row that existed before this
     * column did has none either. So nothing downstream may treat null as
     * missing data to be chased — the canvas draws a placeholder and says
     * nothing about it.
     *
     * No foreign key, because there is no table of images to point at. What
     * makes a key valid is `assertSafeStorageKey` plus the image-namespace
     * check (`lib/storage-key.ts`), applied by `validateIndividual` before
     * this column ever sees a value.
     */
    portraitKey: text("portrait_key"),
    /**
     * A downscaled copy of {@link individuals.portraitKey}, for the canvas.
     *
     * A **second column rather than a size parameter on the first**, and the
     * reason is that this application has no image processor. There is no
     * `sharp`, and adding one would put a native binary in the deploy for the
     * sake of one feature. More to the point, resizing on read would make
     * this application a transformation proxy for its own images, which is
     * exactly what `GET /api/images/…` deliberately is not: it redirects, and
     * the bytes never touch this code. So the downscale happens once, in the
     * browser, at the moment somebody chooses the photograph, and both
     * results are stored.
     *
     * The tree loads every person at once — a few hundred nodes on one canvas
     * — so what a node renders has to be the small one. Serving the original
     * there would be a few hundred multi-megapixel fetches to paint a strip
     * forty pixels wide.
     *
     * Separately nullable from `portraitKey` rather than derived from it,
     * because the two can genuinely disagree: a row written by a browser that
     * could not produce a thumbnail has a portrait and no thumbnail. Readers
     * must handle that, and the canvas does — it falls back to the full
     * image, which is slow and correct, rather than to no image, which would
     * be wrong. It is never the other way round: a thumbnail with no portrait
     * is not a state anything writes, and `validateIndividual` normalises one
     * away rather than refusing it — silently, because no author can cause it
     * and there is no field on screen to hang a message under.
     */
    portraitThumbKey: text("portrait_thumb_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * How to read {@link individuals.createdBy} beside it (`YEO-104`).
     *
     * ## Why this column is `not null` *and* has no default
     *
     * Both halves are load-bearing, and the second is the unusual one.
     *
     * `not null` is what makes the column able to answer "why is there no
     * author" rather than merely failing to have one. Every row has a source
     * even when it has no email, and the three sources are three different
     * facts — see `INDIVIDUAL_AUTHOR_SOURCES` in `lib/individual-author.ts`,
     * which defines the labels this enum is built from.
     *
     * **No default** is how the ticket's "a new path that forgets should fail
     * a test, not silently write a null" is enforced, and it is enforced by
     * the compiler rather than by a test: with no default, Drizzle's insert
     * type makes this column *required*, so a write path that does not say
     * who created the row does not build. `db/individual-author.db.test.ts`
     * guards the guard — it asserts the column is still `not null` with no
     * default, so the compile error cannot be quieted by adding one.
     *
     * A default is also the specific wrong answer this ticket names. Any
     * value it could take would be stamped onto every row that already
     * existed, which is authorship invented for people nobody can attribute.
     * The backfill in `drizzle/0011_individual_author.sql` writes `legacy` to
     * those rows precisely *because* `legacy` claims nothing about a person —
     * it says the column did not exist yet, which is the one thing that is
     * true of all of them.
     *
     * The migration therefore adds the column with a temporary default and
     * drops it in the same statement block: the default exists only long
     * enough for Postgres to fill the existing rows, and never long enough
     * for an application insert to reach it.
     */
    createdBySource: createdBySource("created_by_source").notNull(),
    /**
     * The signed-in email that added this person by hand (`YEO-104`), the way
     * `pages.updated_by` and `revisions.created_by` record who wrote an edit.
     *
     * Null whenever {@link individuals.createdBySource} is anything but
     * `member`, and that null is fully explained by the column beside it — it
     * is never "a name we lost". `lib/individual-author.ts` holds the pairing
     * rules, and `individualAuthorEmail` is the only sanctioned way to ask
     * this row for an author, so no renderer has to remember that
     * `member` is the one source that comes with an address.
     *
     * No foreign key, and no `users` table for one to point at: membership is
     * `ALLOWED_EMAILS` (`lib/session.ts`), so an email is all there is to
     * record and it stays recorded after somebody is removed from that list —
     * which is what a history is for.
     *
     * No index. Nothing filters or groups by it: the feed reads it off rows
     * it has already selected by `created_at`, which is the same judgement
     * `importId` below makes about its own reads.
     */
    createdBy: text("created_by"),
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
  categories: many(pageCategories),
}));

export const revisionsRelations = relations(revisions, ({ one }) => ({
  page: one(pages, { fields: [revisions.pageId], references: [pages.id] }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  pages: many(pageCategories),
}));

export const pageCategoriesRelations = relations(pageCategories, ({ one }) => ({
  page: one(pages, {
    fields: [pageCategories.pageId],
    references: [pages.id],
  }),
  category: one(categories, {
    fields: [pageCategories.categoryId],
    references: [categories.id],
  }),
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
