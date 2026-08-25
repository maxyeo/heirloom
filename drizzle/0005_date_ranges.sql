ALTER TABLE "individuals" ADD COLUMN "birth_date_upper" date;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "birth_date_upper_precision" date_precision DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "death_date_upper" date;--> statement-breakpoint
ALTER TABLE "individuals" ADD COLUMN "death_date_upper_precision" date_precision DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "start_date_upper" date;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "start_date_upper_precision" date_precision DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "end_date_upper" date;--> statement-breakpoint
ALTER TABLE "unions" ADD COLUMN "end_date_upper_precision" date_precision DEFAULT 'day' NOT NULL;