import "../lib/load-env";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";

import postgres from "postgres";

import {
  compareRowCounts,
  createDumpSummariser,
  parseManifest,
  type BackupManifest,
  type DumpSummary,
} from "./dump-manifest";
import { runPgTool } from "./pg-tool";
import { assertRestoreTarget } from "./restore-guard";

/**
 * Restore a dump taken by `db/backup.ts`, and check that it worked.
 *
 * This is one script rather than two on purpose. The restore an operator runs
 * on their worst day and the restore CI runs every night have to be the same
 * code, or the nightly run is testing something nobody will use. So the
 * verification is not a separate harness bolted on for CI — it is what this
 * command does, every time, including in an emergency, where "did all of it
 * come back?" is precisely the question.
 *
 *   npm run db:restore -- --from backups/heirloom-<timestamp>.sql.gz
 *
 * It is the most destructive thing in this repository: it drops the `public`
 * and `drizzle` schemas and replays the dump over them. `db/restore-guard.ts`
 * is what stands between that and the wrong database.
 */

/**
 * Which database to restore *into*.
 *
 * Deliberately a shorter chain than `db/backup.ts`'s. Backup falls back
 * through `MIGRATE_DATABASE_URL` as a convenience, because reading from the
 * wrong-but-related database is harmless. Writing to it is not: a restore
 * silently preferring whatever happens to be in `MIGRATE_DATABASE_URL` could
 * drop the schemas of the deployed database because a variable was left set
 * in a shell. So it is `DATABASE_URL` — as resolved by `DATABASE_TARGET`, so
 * `DATABASE_TARGET=test` works the way it does everywhere else — unless
 * `RESTORE_DATABASE_URL` names somewhere else explicitly, which is the kind
 * of deliberateness this command is worth.
 */
const SOURCES = ["RESTORE_DATABASE_URL", "DATABASE_URL"] as const;

/**
 * Host, port and database name — no username, and never the password.
 *
 * `db/migrate.ts` logs host and port only. This one adds the database name
 * because of what it is about to do to it: "restoring into localhost:5432" is
 * not enough for someone to catch that they are pointed at the wrong database
 * one line before it is dropped.
 */
function describeHost(url: string): string {
  try {
    const { hostname, port, pathname } = new URL(url);
    return `${hostname}${port ? `:${port}` : ""}${pathname}`;
  } catch {
    return "(unparseable, not logged)";
  }
}

/** Read the dump: gunzipping if it is gzipped, and summarising as it goes. */
async function inspect(file: string): Promise<{
  summary: DumpSummary;
  sha256: string;
}> {
  const summariser = createDumpSummariser();
  const lines = createInterface({
    input: openDump(file),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    summariser.line(line);
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }

  return { summary: summariser.summary(), sha256: hash.digest("hex") };
}

/**
 * A readable of the dump's SQL, whether it is stored gzipped or not.
 *
 * `.sql` as well as `.sql.gz` because a dump that has been round-tripped by
 * hand — decrypted, inspected, edited to recover one table — is still a dump
 * worth restoring with the checks in this file rather than with a bare
 * `psql <`.
 */
function openDump(file: string): NodeJS.ReadableStream {
  const raw = createReadStream(file);
  return file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
}

/** The manifest sitting beside `heirloom-<ts>.sql.gz`, if there is one. */
function siblingManifest(dumpPath: string): string {
  return path.join(
    path.dirname(dumpPath),
    `${path.basename(dumpPath).replace(/\.sql(\.gz)?$/, "")}.manifest.json`,
  );
}

async function loadManifest(file: string): Promise<BackupManifest | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return parseManifest(JSON.parse(text), path.basename(file));
}

/** Every table in `public` and `drizzle`, and how many rows it holds. */
async function countRows(
  client: postgres.Sql,
): Promise<Record<string, number>> {
  const tables = await client<{ schema: string; table: string }[]>`
    select schemaname as schema, tablename as table
    from pg_tables
    where schemaname in ('public', 'drizzle')
    order by schemaname, tablename
  `;

  const counts: Record<string, number> = {};
  for (const { schema, table } of tables) {
    // The identifiers come from `pg_tables` — the server's own answer about
    // what exists — and are still passed through postgres.js's identifier
    // escaping rather than interpolated as text.
    const [row] = await client<{ count: number }[]>`
      select count(*)::int as count from ${client(schema)}.${client(table)}
    `;
    counts[`${schema}.${table}`] = row.count;
  }
  return counts;
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      manifest: { type: "string" },
    },
  });

  if (!values.from) {
    throw new Error(
      "Usage: npm run db:restore -- --from <dump.sql.gz> [--manifest <file>]",
    );
  }
  const dumpPath = path.resolve(values.from);

  const source = SOURCES.find((name) => process.env[name]);
  const connectionString = source ? process.env[source] : undefined;

  /**
   * Before anything is read, and long before anything is dropped. The guard
   * is the only thing standing between this command and a database somebody
   * still needs.
   */
  const allowed = assertRestoreTarget(connectionString, process.env);
  if (!allowed.allowed) {
    throw new Error(allowed.message);
  }
  // `assertRestoreTarget` refuses a missing connection string, so by here
  // there is one; this keeps the compiler in agreement without an assertion.
  if (!connectionString || !source) {
    throw new Error("Unreachable: the guard above refuses a missing target.");
  }

  console.log(
    `Restoring ${path.basename(dumpPath)} into ${source} -> ` +
      `${describeHost(connectionString)}`,
  );

  /**
   * Read the dump before touching the database. A dump that turns out to be
   * truncated is a dump that must not be restored *over* anything — finding
   * that out after dropping the schemas would turn a recoverable situation
   * into an unrecoverable one.
   */
  const { summary, sha256 } = await inspect(dumpPath);
  if (summary.truncated || !summary.complete) {
    throw new Error(
      `${path.basename(dumpPath)} is not a complete pg_dump — it ` +
        `${summary.truncated ? "ends inside a COPY block" : "has no completion footer"}. ` +
        "Refusing to restore from it. Nothing has been changed.",
    );
  }

  const manifestPath = values.manifest
    ? path.resolve(values.manifest)
    : siblingManifest(dumpPath);
  const manifest = await loadManifest(manifestPath);

  if (manifest) {
    if (manifest.sha256 !== sha256) {
      throw new Error(
        `${path.basename(dumpPath)} does not match its manifest: expected ` +
          `sha256 ${manifest.sha256}, got ${sha256}. The file has been ` +
          "changed or damaged since it was taken. Nothing has been changed.",
      );
    }
    const drift = compareRowCounts(manifest.tables, summary.tables);
    if (drift.length > 0) {
      throw new Error(
        `${path.basename(manifestPath)} disagrees with the dump it ` +
          `describes:\n  ${drift.join("\n  ")}\nNothing has been changed.`,
      );
    }
    console.log(
      `Dump verified against ${path.basename(manifestPath)} (taken ` +
        `${manifest.takenAt}, ${manifest.totalRows} rows).`,
    );
  } else {
    console.warn(
      `No manifest at ${path.basename(manifestPath)}. Restoring anyway, and ` +
        "checking the result against the dump's own contents.",
    );
  }

  const client = postgres(connectionString, {
    prepare: false,
    max: 1,
    // postgres.js prints notices as inspected objects by default, which turns
    // the entirely expected "schema drizzle does not exist, skipping" from
    // the drop below into six lines of noise in the middle of a restore log.
    // Kept rather than silenced — a notice from a real restore is worth
    // seeing — but as the one line it is.
    onnotice: (notice) => console.log(`  postgres: ${notice.message}`),
  });
  const started = Date.now();

  try {
    /**
     * The dump creates both schemas itself (`CREATE SCHEMA public;` is in
     * every `pg_dump` of this shape), so they are dropped and *not*
     * recreated. Dropping rather than restoring over the top is what makes
     * the row counts below mean something: a restore that merged into
     * existing rows could satisfy every count while holding data from two
     * different points in time.
     */
    await client.unsafe(
      "drop schema if exists public cascade; " +
        "drop schema if exists drizzle cascade;",
    );

    const { child, finished } = runPgTool(
      "psql",
      [
        `--dbname=${connectionString}`,
        // Any error aborts the restore instead of leaving a half-restored
        // database that reported success. psql's default is to carry on.
        "--set=ON_ERROR_STOP=1",
        // All of it or none of it. Without this an error partway through
        // leaves whatever had already been applied, which is the worst of
        // both outcomes: not the old database, and not the new one.
        "--single-transaction",
        "--quiet",
        "--file=-",
      ],
      // stdout discarded: `--quiet` silences psql's chatter but not the
      // result sets of the handful of `SELECT set_config(...)` and
      // `setval(...)` calls every dump contains, which are of no interest to
      // anyone reading a restore log. Errors go to stderr and are kept.
      ["pipe", "ignore", "pipe"],
    );

    await Promise.all([
      finished,
      pipeline(openDump(dumpPath), child.stdin as NodeJS.WritableStream),
    ]);

    const restored = await countRows(client);
    const expected = manifest?.tables ?? summary.tables;
    const differences = compareRowCounts(expected, restored);

    if (differences.length > 0) {
      throw new Error(
        "Restore finished, but the database does not match the dump:\n  " +
          differences.join("\n  "),
      );
    }

    const total = Object.values(restored).reduce((sum, n) => sum + n, 0);
    console.log(
      `Restored ${total} rows across ${Object.keys(restored).length} tables ` +
        `in ${Date.now() - started}ms, and verified every count against the dump.`,
    );
    for (const [table, count] of Object.entries(restored).sort()) {
      console.log(`  ${table}: ${count}`);
    }
  } finally {
    // Bounded, for the reason `db/migrate.ts` gives: a close that hangs or
    // rejects would replace a legible failure with itself.
    await client.end({ timeout: 5 }).catch(() => {});
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Restore failed:", err);
  process.exit(1);
});
