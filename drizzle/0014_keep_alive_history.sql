CREATE TABLE "keep_alive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pinged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"run_url" text,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "keep_alive_pinged_at_idx" ON "keep_alive" USING btree ("pinged_at" DESC NULLS LAST);