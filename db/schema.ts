import { relations } from "drizzle-orm";
import {
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
  },
  (t) => [index("pages_updated_at_idx").on(t.updatedAt)],
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
    birthPlace: text("birth_place"),
    deathDate: date("death_date"),
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
  endDate: date("end_date"),
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
