CREATE TYPE "public"."date_qualifier" AS ENUM('exact', 'about', 'before', 'after');--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "birth_date_qualifier" date_qualifier DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "death_date_qualifier" date_qualifier DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "start_date_qualifier" date_qualifier DEFAULT 'exact' NOT NULL;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "end_date_qualifier" date_qualifier DEFAULT 'exact' NOT NULL;