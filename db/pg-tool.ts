import { spawn, type StdioOptions } from "node:child_process";

/**
 * Running `pg_dump` and `psql` as child processes.
 *
 * `db/backup.ts` and `db/restore.ts` plumb their streams very differently —
 * one gzips stdout into a file, the other feeds a decompressed dump into
 * stdin — but they fail identically, and the failures are worth handling
 * carefully in one place:
 *
 *  - **Not installed.** By far the most likely thing to go wrong on a new
 *    machine, and a bare `spawn ENOENT` sends people to look at the database
 *    rather than at their PATH.
 *  - **Non-zero exit.** Both tools explain themselves on stderr and then say
 *    nothing on stdout, so an exit code alone is useless. The message is the
 *    whole diagnosis, and it has to survive into the thrown error.
 *
 * These are the only two PostgreSQL binaries this repository shells out to.
 * Everything else goes through postgres.js.
 */

const INSTALL_HINT =
  "It ships with the PostgreSQL client tools (`brew install libpq`, or " +
  "`postgresql-client` on Debian/Ubuntu) — see docs/backups.md.";

export type PgTool = "pg_dump" | "psql";

/**
 * Spawn `bin`, returning the child (so the caller can attach its own streams)
 * and a promise that resolves with whatever it wrote to stderr, or rejects
 * with that text attached.
 *
 * stderr is captured rather than inherited even on success: `pg_dump` uses it
 * for warnings that are worth surfacing but are not failures, and a caller
 * that wants them printed can print them.
 */
export function runPgTool(bin: PgTool, args: string[], stdio: StdioOptions) {
  const child = spawn(bin, args, { stdio });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const finished = new Promise<string>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "ENOENT"
          ? new Error(`${bin} is not on PATH. ${INSTALL_HINT}`)
          : err,
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stderr.trim());
        return;
      }
      const detail = stderr.trim();
      reject(
        new Error(
          `${bin} exited with code ${code}.${detail ? `\n${detail}` : ""}`,
        ),
      );
    });
  });

  return { child, finished };
}
