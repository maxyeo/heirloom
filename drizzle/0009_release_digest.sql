ALTER TABLE "gedcom_imports" DROP CONSTRAINT "gedcom_imports_digest_unique";--> statement-breakpoint
ALTER TABLE "gedcom_imports" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gedcom_imports" ADD COLUMN "released_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "gedcom_imports_live_digest_idx" ON "gedcom_imports" USING btree ("digest") WHERE "gedcom_imports"."released_at" is null;