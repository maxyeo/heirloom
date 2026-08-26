ALTER TABLE "revisions" ADD COLUMN "categories" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "revisions" AS r
SET "categories" = filed.names
FROM (
	SELECT pc."page_id", array_agg(c."name" ORDER BY c."slug" COLLATE "C") AS names
	FROM "page_categories" pc
	JOIN "categories" c ON c."id" = pc."category_id"
	GROUP BY pc."page_id"
) AS filed
WHERE r."page_id" = filed."page_id"
	AND r."id" = (
		SELECT newest."id"
		FROM "revisions" AS newest
		WHERE newest."page_id" = r."page_id"
		ORDER BY newest."created_at" DESC, newest."id" DESC
		LIMIT 1
	);
