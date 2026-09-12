import "../lib/load-env";

import { eq, sql } from "drizzle-orm";

import { db } from "./index";
import { describeSource, describeTarget, runUrl } from "./keep-alive-context";
import { keepAlive } from "./schema";

/**
 * Keep-alive ping.
 *
 * Supabase pauses free projects after roughly a week of inactivity, and a
 * family wiki that gets visited monthly will be found asleep. This runs
 * hourly from `.github/workflows/keep-alive.yml`.
 *
 * This deliberately goes through `db/index.ts` rather than opening its own
 * connection. The point is not to prove that *some* Postgres is reachable —
 * it is to prove that the application's own connection path still works:
 * the pooler URL, `prepare: false`, and the credentials the deployed app
 * actually uses. A keep-alive that passes while the app cannot connect would
 * be worse than none, because it would be reassuring.
 *
 * ## Why this writes, when `select 1` was enough for a year
 *
 * It wasn't. A pause warning arrived on 2026-09-12 while the daily `select 1`
 * had been green for a fortnight straight, which rules out the two
 * comfortable explanations — the cron is not silently skipped, and the
 * credentials are not stale. What is left is that the ping was not being
 * counted, and a read is the kind of thing that plausibly isn't: it can be
 * served from cache, it produces no WAL, and it leaves nothing behind.
 *
 * An insert cannot be served from cache. It produces WAL, it touches disk,
 * and — the part that matters for diagnosing the *next* warning — it leaves a
 * row in the database it actually reached.
 *
 * This is an argument from evidence, not from documentation: Supabase
 * publishes that "database queries" count as activity, and by that reading
 * `select 1` should always have been enough. The warning email says otherwise.
 * If a future warning arrives even with hourly writes landing, then the
 * metric is not database activity at all and the next thing to try is HTTP
 * traffic to the project's API — see docs/deploying.md.
 */

/**
 * How many pings to keep. Hourly, so three days: long enough to show a gap
 * across a weekend, short enough that the table never becomes a thing anyone
 * has to think about. The prune runs on every ping rather than on a schedule
 * of its own, because a cleanup that needs its own cron is a second thing
 * that can silently stop.
 */
const KEEP_ALIVE_HISTORY = 72;

/**
 * Drop everything past the newest `KEEP_ALIVE_HISTORY` rows.
 *
 * `pinged_at` is not unique — two runs can collide on the same millisecond —
 * so the cut is made by ordering on `(pinged_at, id)` and keeping the first
 * N, rather than by comparing timestamps to a threshold, which would keep or
 * drop a whole tied group together.
 */
async function prune(): Promise<void> {
  const pruned = await db.execute<{ id: string }>(sql`
    delete from ${keepAlive}
    where ${keepAlive.id} not in (
      select ${keepAlive.id} from ${keepAlive}
      order by ${keepAlive.pingedAt} desc, ${keepAlive.id} desc
      limit ${KEEP_ALIVE_HISTORY}
    )
    returning ${keepAlive.id}
  `);

  if (pruned.length > 0) {
    console.log(
      `Pruned ${pruned.length} row(s) beyond the last ${KEEP_ALIVE_HISTORY}.`,
    );
  }
}

async function main() {
  console.log(
    `Keep-alive -> ${describeTarget(process.env.DATABASE_URL)}, source ${describeSource(process.env)}.`,
  );

  const started = Date.now();

  /**
   * `duration_ms` is written by the update below rather than here, and the
   * reason is worth stating because the obvious version is wrong: a value
   * computed inside `.values({...})` is evaluated synchronously, while
   * building the argument, before any statement is sent. `db.insert(...)`
   * is a Proxy `get` that constructs Drizzle lazily and opens no socket —
   * postgres.js connects on await — so such a value times object
   * construction and reads as a round trip of two or three milliseconds.
   * An earlier version of this file did exactly that and stored 3ms for a
   * write whose real round trip was 24ms.
   *
   * The second statement is not a cost here. More WAL is the entire point
   * of this file.
   */
  const [row] = await db
    .insert(keepAlive)
    .values({
      source: describeSource(process.env),
      runUrl: runUrl(process.env),
      durationMs: 0,
    })
    .returning({ id: keepAlive.id, pingedAt: keepAlive.pingedAt });

  // An insert that returns nothing is a failure, not a success. Without
  // this the script would pass on any non-throwing result — the same trap
  // the original guarded with its `ok !== 1` check.
  if (!row) throw new Error("Keep-alive insert returned no row.");

  const durationMs = Date.now() - started;

  await db
    .update(keepAlive)
    .set({ durationMs })
    .where(eq(keepAlive.id, row.id));

  console.log(
    `Wrote keep-alive row at ${row.pingedAt.toISOString()} in ${durationMs}ms.`,
  );

  /**
   * The row is already committed by this point, so the database is provably
   * awake and the ping has done its job. A prune that fails — a lock timeout,
   * a statement timeout on the pooler, a future permissions change — must not
   * turn that into a red run, because the issue it would file says "could not
   * write to the database", which would be false and would point whoever
   * reads it at the wrong problem entirely.
   *
   * The table growing past its bound while this keeps failing is the lesser
   * harm, and the warning is where you would look for it.
   */
  try {
    await prune();
  } catch (err) {
    console.log(
      "::warning title=Keep-alive prune failed::The ping was written, so the " +
        "database is awake; only the cleanup failed. The table will grow " +
        "past its bound until this is fixed.",
    );
    console.warn("Prune failed:", err);
  }

  // `db/index.ts` holds the pool open by design and exposes no way to close
  // it, so the process would otherwise hang until the job timeout. `db/seed.ts`
  // ends the same way.
  process.exit(0);
}

main().catch((err) => {
  console.error("Keep-alive failed:", err);
  process.exit(1);
});
