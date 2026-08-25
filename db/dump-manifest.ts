/**
 * Reading a `pg_dump` plain-text dump well enough to check it.
 *
 * A backup that runs every night and is never read is a hypothesis. Two
 * things have to be true of each dump, and neither is visible from the exit
 * code of `pg_dump`:
 *
 *  1. **It is whole.** A dump cut short — a dropped connection, a full disk,
 *     a killed runner — is a valid-looking file that restores a prefix of the
 *     database and reports success. `pg_dump` writes a footer line as its
 *     last act, so a dump without that line is one nobody should trust.
 *  2. **The restore put back what was taken.** That needs a number to compare
 *     against, and the honest place to get it is the dump itself rather than
 *     a second query against the live database: rows written between the dump
 *     and the count would make the comparison disagree for a reason that has
 *     nothing to do with the backup. Counting the rows *in the file* makes
 *     "restore what this file contains, then check you got it" an exact
 *     statement about the file, and that is the statement worth asserting.
 *
 * So this module reads a dump and reports what is in it. It is pure — it
 * takes lines and returns a value — so it is unit-tested against literal dump
 * text and needs no database, per docs/testing.md. `db/backup.ts` feeds it a
 * stream and `db/restore.ts` compares its numbers against the restored
 * database.
 */

/**
 * `pg_dump`'s own last line. It is emitted after everything else has been
 * written, which is exactly the property that makes it worth looking for.
 */
const COMPLETION_MARKER = "-- PostgreSQL database dump complete";

/**
 * `COPY public.individuals (id, given_name, ...) FROM stdin;`
 *
 * The column list is optional in principle, so it is optional here. Only
 * matched while *outside* a data block: a row of table data is free to begin
 * with the word COPY, and misreading one as a statement would silently move
 * every subsequent row into the wrong table's count.
 */
const COPY_START = /^COPY\s+([^\s(]+)\s*(?:\([^)]*\))?\s+FROM stdin;/;

/**
 * The end of a COPY data block. A line consisting of exactly `\.` cannot
 * occur as data: COPY's text format escapes a literal backslash as `\\`.
 */
const COPY_END = "\\.";

export type DumpSummary = {
  /** Rows per table, keyed exactly as the dump names them (`public.pages`). */
  tables: Record<string, number>;
  totalRows: number;
  /** The dump ended with `pg_dump`'s completion footer. */
  complete: boolean;
  /** The dump ended in the middle of a COPY block, so it is definitely cut short. */
  truncated: boolean;
};

/**
 * A line-at-a-time reader, so a large dump is summarised as it streams
 * instead of being held in memory. `summariseDump` below is the same thing
 * for a string, which is what tests hand it.
 */
export function createDumpSummariser() {
  const tables: Record<string, number> = {};
  let openTable: string | null = null;
  let totalRows = 0;
  let complete = false;

  return {
    line(line: string): void {
      if (openTable !== null) {
        if (line === COPY_END) {
          openTable = null;
        } else {
          tables[openTable] += 1;
          totalRows += 1;
        }
        return;
      }

      const started = COPY_START.exec(line);
      if (started) {
        openTable = started[1];
        // A table can be dumped in one COPY block only, but initialising to
        // whatever is already there costs nothing and keeps a second block
        // additive rather than silently resetting the count to zero.
        tables[openTable] ??= 0;
        return;
      }

      // Not `endsWith`: the marker is a whole line, and a comment that
      // merely quotes it (this file's own source, for instance, were it ever
      // dumped as data) should not certify a truncated file as complete.
      if (line === COMPLETION_MARKER) {
        complete = true;
      }
    },

    summary(): DumpSummary {
      return {
        tables: { ...tables },
        totalRows,
        complete,
        truncated: openTable !== null,
      };
    },
  };
}

/** `createDumpSummariser` over a whole string. */
export function summariseDump(dump: string): DumpSummary {
  const summariser = createDumpSummariser();
  for (const line of dump.split("\n")) {
    summariser.line(line);
  }
  return summariser.summary();
}

/**
 * What `db/backup.ts` writes alongside each dump, and what `db/restore.ts`
 * checks a restored database against.
 *
 * It carries no family data — table names and row counts only — which is what
 * lets it sit unencrypted next to the encrypted dump, where an operator can
 * read it without the passphrase. See docs/backups.md.
 */
export type BackupManifest = {
  /** Bumped if the shape below changes, so an old manifest fails loudly. */
  formatVersion: 1;
  takenAt: string;
  /** Which environment variable the connection came from. Never the URL itself. */
  source: string;
  /** `host:port`. No username, no password. */
  host: string;
  /** The dump file this describes, as a bare filename. */
  dumpFile: string;
  bytes: number;
  sha256: string;
  tables: Record<string, number>;
  totalRows: number;
};

/**
 * Parse a manifest read back off disk.
 *
 * `JSON.parse` returns `any`, and a restore that trusts it would compare row
 * counts against `undefined` and pass. This narrows it properly instead, and
 * says which field is wrong when it does not.
 */
export function parseManifest(json: unknown, filename: string): BackupManifest {
  const fail = (why: string): never => {
    throw new Error(`${filename} is not a usable backup manifest: ${why}.`);
  };

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return fail("expected a JSON object");
  }

  const record: Record<string, unknown> = { ...json };

  if (record.formatVersion !== 1) {
    return fail(
      `formatVersion is ${JSON.stringify(record.formatVersion)}, and this ` +
        "version of db/restore.ts only understands 1",
    );
  }

  const string = (key: string): string => {
    const value = record[key];
    return typeof value === "string" && value !== ""
      ? value
      : fail(`${key} is missing or not a non-empty string`);
  };

  const number = (key: string): number => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : fail(`${key} is missing or not a number`);
  };

  const rawTables = record.tables;
  if (
    typeof rawTables !== "object" ||
    rawTables === null ||
    Array.isArray(rawTables)
  ) {
    return fail("tables is missing or not an object");
  }

  const tables: Record<string, number> = {};
  for (const [table, count] of Object.entries(rawTables)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return fail(`tables["${table}"] is not a row count`);
    }
    tables[table] = count;
  }

  return {
    formatVersion: 1,
    takenAt: string("takenAt"),
    source: string("source"),
    host: string("host"),
    dumpFile: string("dumpFile"),
    bytes: number("bytes"),
    sha256: string("sha256"),
    tables,
    totalRows: number("totalRows"),
  };
}

/**
 * Which of `required` the dump does not contain at all.
 *
 * Presence, not row count: `pg_dump` emits a COPY block for every table it
 * dumps, empty or not, so a table missing from the summary was not dumped —
 * the dump was taken against the wrong database, or against one that has not
 * been migrated. A table that is present and empty is a different (and often
 * legitimate) thing, and is not reported here.
 */
export function missingTables(
  required: readonly string[],
  present: Record<string, number>,
): string[] {
  return required.filter((table) => !Object.hasOwn(present, table));
}

/**
 * Every way `actual` disagrees with `expected`, as sentences.
 *
 * All of them, rather than the first: an operator reading the output of a
 * failed restore drill wants the shape of the damage, not one example of it.
 * An empty array means the restored database holds exactly the rows the dump
 * carried.
 */
export function compareRowCounts(
  expected: Record<string, number>,
  actual: Record<string, number>,
): string[] {
  const differences: string[] = [];

  for (const [table, count] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, table)) {
      differences.push(
        `${table}: the dump carries ${count} row(s), but the restored ` +
          "database has no such table",
      );
    } else if (actual[table] !== count) {
      differences.push(
        `${table}: the dump carries ${count} row(s), the restored database ` +
          `has ${actual[table]}`,
      );
    }
  }

  for (const [table, count] of Object.entries(actual)) {
    if (!Object.hasOwn(expected, table)) {
      differences.push(
        `${table}: the restored database has ${count} row(s) the dump did ` +
          "not carry",
      );
    }
  }

  return differences;
}
