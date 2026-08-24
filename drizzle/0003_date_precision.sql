CREATE TYPE "public"."date_precision" AS ENUM('day', 'month', 'year');--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "birth_date_precision" date_precision DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "death_date_precision" date_precision DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "start_date_precision" date_precision DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "end_date_precision" date_precision DEFAULT 'day' NOT NULL;