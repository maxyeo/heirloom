CREATE TYPE "public"."created_by_source" AS ENUM('member', 'import', 'legacy');--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "created_by_source" "created_by_source" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "individuals" ALTER COLUMN "created_by_source" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "created_by" text;
