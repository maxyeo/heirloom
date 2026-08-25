CREATE TABLE "gedcom_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest" text NOT NULL,
	"file_name" text,
	"byte_count" integer NOT NULL,
	"individual_count" integer NOT NULL,
	"union_count" integer NOT NULL,
	"union_child_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" text,
	CONSTRAINT "gedcom_imports_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "union_children" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "individuals" ADD CONSTRAINT "individuals_import_id_gedcom_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."gedcom_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "union_children" ADD CONSTRAINT "union_children_import_id_gedcom_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."gedcom_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unions" ADD CONSTRAINT "unions_import_id_gedcom_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."gedcom_imports"("id") ON DELETE set null ON UPDATE no action;