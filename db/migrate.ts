import "../lib/load-env";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Apply pending migrations.
 *
 * This runs as the first half of Vercel's build command, so a merge to `main`
 * migrates production before the code that depends on the new schema is ever
 * served. The ordering is the whole point: a migration that runs *after* the
 * deploy leaves a window where new code queries columns that do not exist yet.
 * A failure here fails the build, and a failed build is not promoted — so a
 * migration that cannot be applied never gets a deploy that assumes it was.
 *
 * It deliberately does not go through `db/index.ts`, for three reasons that
 * all point the same way:
 *
 *  - that module is a long-lived pool with no way to close it, and a build
 *    step must exit;
 *  - migrations want `max: 1`, because DDL applied over several connections
 *    can interleave;
 *  - migrations want a *different connection string* (see below).
 *
 * It also uses `drizzle-orm`'s migrator rather than `drizzle-kit migrate`.
 * drizzle-kit is a development tool and a devDependency; more importantly it
 * opens its own connection, so there is no way to set the flags below.
 */

/**
 * Supabase's transaction pooler (port 6543) is the right connection for
 * serverless request handlers and the wrong one for DDL: it hands out a
 * different backend per transaction, does not support prepared statements,
 * and does not guarantee the session semantics migrations assume. Point
 * `MIGRATE_DATABASE_URL` at the session pooler or the direct connection
 * (port 5432) instead.
 *
 * The fallback to `DATABASE_URL` keeps local development and any plain
 * Postgres a one-variable setup — there is only one URL to have there, and it
 * is already the right kind.
 */
const connectionString =
  process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;

async function main() {
  if (!connectionString) {
    throw new Error(
      "Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set. " +
        "Copy .env.example to .env.local, or set them in the deploy environment.",
    );
  }

  // `prepare: false` for the same reason as `db/index.ts` — required if this
  // ever does run through the transaction pooler, harmless otherwise. `max: 1`
  // so every statement lands on one backend, in order.
  const client = postgres(connectionString, { prepare: false, max: 1 });

  const started = Date.now();
  try {
    // The folder is the committed `drizzle/` output of `npm run db:generate`.
    // Nothing generates migrations here: this only ever applies files that a
    // human reviewed and merged.
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log(`Migrations up to date in ${Date.now() - started}ms.`);
  } finally {
    // Unlike the app's pool, this connection is ours to close, so the build
    // step exits instead of idling until a timeout.
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
