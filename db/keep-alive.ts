import "../lib/load-env";

import { sql } from "drizzle-orm";

import { db } from "./index";

/**
 * Keep-alive ping.
 *
 * Supabase pauses free projects after roughly a week of inactivity, and a
 * family wiki that gets visited monthly will be found asleep. A daily query
 * is enough to reset that clock.
 *
 * This deliberately goes through `db/index.ts` rather than opening its own
 * connection. The point is not to prove that *some* Postgres is reachable —
 * it is to prove that the application's own connection path still works:
 * the pooler URL, `prepare: false`, and the credentials the deployed app
 * actually uses. A keep-alive that passes while the app cannot connect would
 * be worse than none, because it would be reassuring.
 *
 * The query itself is `select 1`. Touching a real table would also assert the
 * schema, but it would then fail loudly mid-migration for a reason that has
 * nothing to do with the database being awake, and a cron that cries wolf
 * gets muted.
 */
async function main() {
  const started = Date.now();
  const rows = await db.execute<{ ok: number }>(sql`select 1 as ok`);

  // A connection that answers with something unexpected is a failure, not a
  // success. Without this the script would pass on any non-throwing result.
  if (rows[0]?.ok !== 1) {
    throw new Error(`Unexpected keep-alive result: ${JSON.stringify(rows)}`);
  }

  console.log(`Database responded in ${Date.now() - started}ms.`);

  // `db/index.ts` holds the pool open by design and exposes no way to close
  // it, so the process would otherwise hang until the job timeout. `db/seed.ts`
  // ends the same way.
  process.exit(0);
}

main().catch((err) => {
  console.error("Keep-alive failed:", err);
  process.exit(1);
});
