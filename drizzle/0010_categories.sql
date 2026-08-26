CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "page_categories" (
	"page_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "page_categories_page_id_category_id_pk" PRIMARY KEY("page_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "page_categories" ADD CONSTRAINT "page_categories_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_categories" ADD CONSTRAINT "page_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_categories_category_id_idx" ON "page_categories" USING btree ("category_id");