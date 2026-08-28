DROP INDEX "pages_updated_at_idx";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "pages_updated_at_idx" ON "pages" USING btree ("updated_at") WHERE "pages"."deleted_at" is null;