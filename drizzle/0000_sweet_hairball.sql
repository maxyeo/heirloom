CREATE TYPE "public"."child_relation" AS ENUM('biological', 'adopted', 'step', 'foster');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female', 'other', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."union_end_reason" AS ENUM('ongoing', 'death', 'divorce', 'separation', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."union_type" AS ENUM('marriage', 'partnership', 'unknown');--> statement-breakpoint
CREATE TABLE "individuals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid,
	"given_name" text NOT NULL,
	"surname" text,
	"sex" "sex" DEFAULT 'unknown' NOT NULL,
	"birth_date" date,
	"birth_place" text,
	"death_date" date,
	"death_place" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_html" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "union_children" (
	"union_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"relation" "child_relation" DEFAULT 'biological' NOT NULL,
	CONSTRAINT "union_children_union_id_child_id_pk" PRIMARY KEY("union_id","child_id")
);
--> statement-breakpoint
CREATE TABLE "unions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_a_id" uuid,
	"partner_b_id" uuid,
	"type" "union_type" DEFAULT 'marriage' NOT NULL,
	"start_date" date,
	"end_date" date,
	"end_reason" "union_end_reason" DEFAULT 'ongoing' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "individuals" ADD CONSTRAINT "individuals_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "union_children" ADD CONSTRAINT "union_children_union_id_unions_id_fk" FOREIGN KEY ("union_id") REFERENCES "public"."unions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "union_children" ADD CONSTRAINT "union_children_child_id_individuals_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unions" ADD CONSTRAINT "unions_partner_a_id_individuals_id_fk" FOREIGN KEY ("partner_a_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unions" ADD CONSTRAINT "unions_partner_b_id_individuals_id_fk" FOREIGN KEY ("partner_b_id") REFERENCES "public"."individuals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "individuals_surname_idx" ON "individuals" USING btree ("surname","given_name");--> statement-breakpoint
CREATE INDEX "pages_updated_at_idx" ON "pages" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "revisions_page_id_created_at_idx" ON "revisions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE INDEX "union_children_child_id_idx" ON "union_children" USING btree ("child_id");