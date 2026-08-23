import { config } from "dotenv";

import { resolveDatabaseUrl } from "./database-target";

/**
 * Next.js loads `.env.local` on its own, but standalone tooling — drizzle-kit
 * and any `tsx` script — does not, and `dotenv/config` only reads `.env`.
 * Load `.env.local` first; dotenv never overwrites an already-set variable, so
 * `.env` acts as a fallback and real environment variables win over both.
 */
config({ path: ".env.local", quiet: true });
config({ quiet: true });

/**
 * `DATABASE_TARGET` picks which of the connection strings in `.env.local`
 * `DATABASE_URL` actually resolves to for this run — see
 * `lib/database-target.ts` for the full explanation and `.env.example` for
 * the variables it reads. This is the one place that runs, so every
 * standalone entry point (`drizzle.config.ts`, `db/seed.ts`, `db/migrate.ts`,
 * `db/keep-alive.ts`, `test/db-setup.ts`) sees the same resolved value.
 *
 * `db/migrate.ts` layers its own `MIGRATE_DATABASE_URL` fallback on top of
 * whatever `DATABASE_URL` ends up as here, and that fallback wins regardless
 * of `DATABASE_TARGET` — it exists for a different reason (Supabase's
 * transaction pooler being wrong for DDL) and is only ever set in the deploy
 * environment, not via this switch. The two do not fight: `DATABASE_TARGET`
 * decides which database `DATABASE_URL` means, and `MIGRATE_DATABASE_URL`,
 * when present, overrides that specifically for applying migrations.
 *
 * `process.env` coerces every assignment to a string, so `undefined` would
 * become the literal string `"undefined"` — hence the explicit delete rather
 * than an unconditional assignment.
 */
const resolvedDatabaseUrl = resolveDatabaseUrl(process.env);
if (resolvedDatabaseUrl === undefined) {
  delete process.env.DATABASE_URL;
} else {
  process.env.DATABASE_URL = resolvedDatabaseUrl;
}
