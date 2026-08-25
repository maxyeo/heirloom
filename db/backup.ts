import "../lib/load-env";

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGunzip, createGzip } from "node:zlib";

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import {
  createDumpSummariser,
  missingTables,
  type BackupManifest,
} from "./dump-manifest";
import { runPgTool } from "./pg-tool";
import * as schema from "./schema";

/**
 * Take a backup of the whole database.
 *
 * This is the operator's half of the pair E7-T4 completes: export is a
 * feature the family can use to take their data with them, and this is the
 * thing that means the data survives an accident nobody noticed. They are not
 * substitutes. See docs/backups.md for the schedule, the retention policy,
 * and how to restore one.
 *
 * It writes two files per run:
 *
 *  - `heirloom-<timestamp>.sql.gz` — a plain-SQL `pg_dump`, gzipped.
 *  - `heirloom-<timestamp>.manifest.json` — table names, row counts, and the
 *    dump's SHA-256. No family data, so it can be read without decrypting
 *    anything, and `db/restore.ts` checks a restore against it.
 *
 * Plain SQL rather than `pg_dump`'s custom format on purpose. A custom-format
 * archive can only be read by a `pg_restore` new enough to understand it,
 * which makes the recoverability of these files depend on a binary nobody is
 * versioning. A gzipped SQL file can be restored by any `psql`, and read by a
 * person, in ten years. The backup of a family's history is the wrong place
 * to be clever about format.
 *
 * The plaintext never touches the disk: `pg_dump`'s stdout is piped through
 * gzip into the output file, and the summary below is taken by reading that
 * file back. Reading back is also the stronger check — it asserts what
 * actually landed on disk rather than what this process believed it wrote.
 */

/**
 * Which connection to dump from.
 *
 * Same problem `db/migrate.ts` has, for the same reason. Supabase's
 * transaction pooler (port 6543) hands out a different backend per
 * transaction, and `pg_dump` needs one session for the whole run — it opens a
 * repeatable-read transaction and holds it. Point this at the session pooler
 * or the direct connection (port 5432).
 *
 * `MIGRATE_DATABASE_URL` sits in the middle of the chain because it is
 * already exactly the right kind of connection, and an operator who has set
 * it should not have to set a second variable holding the same string.
 * `BACKUP_DATABASE_URL` exists in front of it so backups can be pointed
 * somewhere else deliberately — a read replica, or a role with nothing but
 * read access — without that also moving where migrations are applied.
 *
 * The final fallback to `DATABASE_URL` is what keeps local development and
 * any plain Postgres a one-variable setup, as everywhere else in this repo.
 */
const SOURCES = [
  "BACKUP_DATABASE_URL",
  "MIGRATE_DATABASE_URL",
  "DATABASE_URL",
] as const;

/**
 * Host and port only, and the name of the variable it came from. A connection
 * string carries a password, and a log — especially one in a public
 * repository's Actions output — is not a place to put one.
 */
function describe(source: string, url: string) {
  try {
    const { hostname, port } = new URL(url);
    return { source, host: `${hostname}${port ? `:${port}` : ""}` };
  } catch {
    // As in `db/migrate.ts`: postgres.js and libpq accept forms `URL` does
    // not, and the connection attempt is the real test of the string. Only
    // the log line suffers.
    return { source, host: "(unparseable, not logged)" };
  }
}

/**
 * Every table the running code expects to exist, read out of `db/schema.ts`
 * rather than listed here.
 *
 * The listed-here version rots: someone adds a table, the backup silently
 * stops covering everything it should, and nobody finds out until a restore.
 * Deriving it means a new table is automatically a table this refuses to
 * leave out.
 */
function requiredTables(): string[] {
  const tables = Object.values(schema)
    // `is` is Drizzle's own runtime check, so enums, relations and any other
    // export sharing the module are filtered out by the same rule Drizzle
    // itself uses rather than by a guess about their shape.
    .filter((value) => is(value, PgTable))
    .map((table) => {
      const { name, schema: tableSchema } = getTableConfig(table);
      return `${tableSchema ?? "public"}.${name}`;
    });

  // Not part of `db/schema.ts` — Drizzle owns it — but a backup without the
  // migration ledger restores to a database that thinks no migration has
  // ever been applied, and the next deploy would replay `0000` on top of a
  // full schema and die. It matters as much as any application table.
  return [...tables, "drizzle.__drizzle_migrations"];
}

function timestamp(now: Date): string {
  // 20260824T062311Z — sorts lexicographically, and survives being a filename
  // on every filesystem, which `2026-08-24T06:23:11.123Z` does not.
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Run `pg_dump`, gzipping its output straight into `destination`. */
async function dump(connectionString: string, destination: string) {
  const { child, finished } = runPgTool(
    "pg_dump",
    [
      // The whole connection string, rather than PGHOST/PGUSER/PGPASSWORD
      // pulled out of it. Splitting it up would keep the password out of this
      // process's argv, but it would also quietly drop any query parameter
      // the URL carries — `sslmode`, or the `options=project%3D<ref>` some
      // pooler setups need — and a backup that connects somewhere subtly
      // different from the app is exactly the kind of wrong nobody notices.
      `--dbname=${connectionString}`,
      "--format=plain",
      // The roles in a dump are the source's roles. Keeping them makes the
      // dump restorable only into a cluster that happens to have the same
      // ones, which is the opposite of what a backup is for — restoring it
      // somewhere else is the whole point.
      "--no-owner",
      "--no-privileges",
      // Only what this application owns. A managed Postgres has schemas the
      // application neither created nor could recreate (`auth`, `storage`,
      // `extensions` on Supabase), and sweeping them in produces a dump that
      // fails partway through a restore against a plain Postgres.
      "--schema=public",
      "--schema=drizzle",
      // `pg_dump` takes an ACCESS SHARE lock on every table. If something is
      // holding a conflicting lock, the wait is otherwise unbounded and the
      // job burns until its timeout — reporting as a timeout rather than as
      // the contention it was. Same reasoning as `lock_timeout` in
      // `db/migrate.ts`.
      "--lock-wait-timeout=30s",
    ],
    ["ignore", "pipe", "pipe"],
  );

  const piped = pipeline(
    child.stdout as NodeJS.ReadableStream,
    createGzip(),
    createWriteStream(destination),
  );

  /**
   * Both are awaited, and neither is allowed to hide the other.
   *
   * Waiting only on the pipeline would accept a `pg_dump` that wrote a
   * partial dump and then failed; waiting only on the exit code would return
   * before the last bytes had been flushed to disk. But `Promise.all` would
   * also reject at the *first* failure and leave the other promise pending,
   * which surfaces later as an unhandled rejection on top of the error that
   * mattered. `allSettled` waits for both, and pg_dump's own complaint wins
   * when there is one — a write error is usually the consequence, and the
   * message on stderr is the diagnosis.
   */
  const [exit, write] = await Promise.allSettled([finished, piped]);
  if (exit.status === "rejected") throw exit.reason;
  if (write.status === "rejected") throw write.reason;

  return exit.value;
}

/** Read the gzipped dump back: row counts, completeness, and its hash. */
async function inspect(file: string) {
  const summariser = createDumpSummariser();
  const lines = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    summariser.line(line);
  }

  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += (chunk as Buffer).length;
  }

  return { summary: summariser.summary(), sha256: hash.digest("hex"), bytes };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: process.env.BACKUP_DIR ?? "backups" },
    },
  });

  const source = SOURCES.find((name) => process.env[name]);
  if (!source) {
    throw new Error(
      `None of ${SOURCES.join(", ")} is set. Copy .env.example to .env.local, ` +
        "or set one in the environment the backup runs in.",
    );
  }
  const connectionString = process.env[source] as string;
  const { host } = describe(source, connectionString);

  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });

  const takenAt = new Date();
  const stem = `heirloom-${timestamp(takenAt)}`;
  const dumpFile = `${stem}.sql.gz`;
  const dumpPath = path.join(outDir, dumpFile);
  const manifestPath = path.join(outDir, `${stem}.manifest.json`);

  console.log(`Backing up: ${source} -> ${host}`);

  const started = Date.now();
  /**
   * Everything from here on deletes the dump before failing. A file that is
   * not a usable backup is worse than no file at all: it is the one an
   * operator finds in the directory and believes.
   */
  const discard = async (why: string) => {
    await rm(dumpPath, { force: true });
    throw new Error(why);
  };

  let warnings: string;
  try {
    warnings = await dump(connectionString, dumpPath);
  } catch (err) {
    /**
     * A dump that failed partway has still written a partial `.sql.gz`, and
     * it would otherwise sit in the output directory with no manifest beside
     * it. On the CI runner that is harmless — the job stops here and the disk
     * is thrown away — but locally the files accumulate, and the whole point
     * of the checks below is that nothing unrestorable is left lying around
     * looking like a backup. The original error is what gets reported;
     * removing the fragment must not replace it.
     */
    await rm(dumpPath, { force: true });
    throw err;
  }
  if (warnings) console.warn(warnings);

  const { summary, sha256, bytes } = await inspect(dumpPath);

  if (summary.truncated) {
    await discard(
      `${dumpFile} ends in the middle of a COPY block, so it is cut short. ` +
        "Discarded it rather than leave an unrestorable file behind.",
    );
  }

  if (!summary.complete) {
    await discard(
      `${dumpFile} has no "PostgreSQL database dump complete" footer, so ` +
        "pg_dump did not finish writing it. Discarded it rather than leave " +
        "an unrestorable file behind.",
    );
  }

  const missing = missingTables(requiredTables(), summary.tables);
  if (missing.length > 0) {
    await discard(
      `${dumpFile} is missing ${missing.join(", ")}. Either it was taken ` +
        "against the wrong database, or against one that has not been " +
        "migrated. Discarded it rather than leave a partial backup behind.",
    );
  }

  const manifest: BackupManifest = {
    formatVersion: 1,
    takenAt: takenAt.toISOString(),
    source,
    host,
    dumpFile,
    bytes,
    sha256,
    tables: summary.tables,
    totalRows: summary.totalRows,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Wrote ${dumpFile} (${bytes} bytes, ${summary.totalRows} rows across ` +
      `${Object.keys(summary.tables).length} tables) in ${Date.now() - started}ms.`,
  );
  for (const [table, count] of Object.entries(summary.tables).sort()) {
    console.log(`  ${table}: ${count}`);
  }

  // A backup that says nothing about being empty is how "we have backups"
  // and "we have nothing" look identical for months. Not an error — a wiki
  // nobody has written in yet is legitimately empty — but never silent.
  if (summary.totalRows === 0) {
    console.warn(
      "Warning: every table in this dump is empty. That is correct for a " +
        "new install and alarming for anything else.",
    );
  }

  // `db/index.ts`'s pool is never opened by this script (only `schema` is
  // imported from it), but exiting explicitly keeps this the same shape as
  // the other scripts here.
  process.exit(0);
}

main().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});
