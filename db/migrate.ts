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
const source = process.env.MIGRATE_DATABASE_URL
  ? "MIGRATE_DATABASE_URL"
  : "DATABASE_URL";
const connectionString = process.env[source];

/**
 * Which variable was used, and against what host.
 *
 * The fallback above is the quiet failure this guards. Forgetting to set
 * `MIGRATE_DATABASE_URL` in the deploy environment does not raise anything:
 * migrations simply run over the transaction pooler, and with `prepare: false`
 * and `max: 1` ordinary additive DDL usually succeeds there. The
 * misconfiguration then sits unnoticed until some later migration needs
 * something the transaction pooler cannot do, and the build that breaks is not
 * the one that introduced the mistake. A line in the build log is enough to
 * make it visible on the first deploy instead.
 *
 * Host and port only. A connection string carries a password, and build logs
 * are not a place to put one.
 */
function describe(url: string) {
  try {
    const { hostname, port } = new URL(url);
    return `${source} -> ${hostname}${port ? `:${port}` : ""}`;
  } catch {
    // Not a defect worth failing on: postgres.js accepts forms that `URL`
    // does not, and the connection attempt below is the real test of whether
    // the string is usable.
    return `${source} (unparseable, not logged)`;
  }
}

async function main() {
  if (!connectionString) {
    throw new Error(
      "Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set. " +
        "Copy .env.example to .env.local, or set them in the deploy environment.",
    );
  }

  console.log(`Migrating: ${describe(connectionString)}`);

  const client = postgres(connectionString, {
    // For the same reason as `db/index.ts` — required if this ever does run
    // through the transaction pooler, harmless otherwise.
    prepare: false,
    // So every statement lands on one backend, in order.
    max: 1,
    connection: {
      /**
       * Two merges landing within a minute build concurrently, and the second
       * build's DDL waits on a lock the first build's open transaction holds.
       * Usually that resolves the moment the first commits. If it does not,
       * the wait is otherwise unbounded and the second build burns until the
       * platform's own build timeout kills it — which reports as a timeout
       * rather than as the lock contention it was. Thirty seconds is far
       * longer than a healthy migration holds anything, so a build that trips
       * this fails fast and says why.
       */
      lock_timeout: 30_000,
      /**
       * A backstop for the other shape of stall: a statement that acquired its
       * locks and then never finished. Generous, because a future backfill is
       * allowed to be slow, but still well inside a build timeout.
       */
      statement_timeout: 300_000,
    },
  });

  const started = Date.now();
  try {
    // The folder is the committed `drizzle/` output of `npm run db:generate`.
    // Nothing generates migrations here: this only ever applies files that a
    // human reviewed and merged.
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log(`Migrations up to date in ${Date.now() - started}ms.`);
  } finally {
    /**
     * Unlike the app's pool, this connection is ours to close, so the build
     * step exits instead of idling until a timeout.
     *
     * Bounded, because `finally` replaces the in-flight error with anything
     * thrown here: a close that hangs would turn a legible migration failure
     * into a hang, and a close that rejects would report itself instead of the
     * failure that mattered. The exit code is 1 either way, but the log is the
     * only thing anyone reads.
     */
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
