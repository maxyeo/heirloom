/**
 * Whether `db/seed.ts` is allowed to run against the resolved `DATABASE_URL`.
 *
 * `db/seed.ts` deletes every row before inserting anything, with no
 * confirmation and nothing to undo it. Kept as a pure function, separate from
 * `db/seed.ts` itself, so it can be unit-tested with a plain string and a
 * plain env object and needs no database — see docs/testing.md.
 *
 * The decision underneath — local, or somewhere that has to be named first —
 * lives in `db/destructive-target.ts`, which `db/restore-guard.ts` shares.
 * Everything below is the part specific to seeding: what is about to be
 * deleted, and which variable authorises it.
 */

import {
  classifyDestructiveTarget,
  overrideAuthorises,
} from "./destructive-target";

/** The variable that has to name the target before a remote seed is allowed. */
const OVERRIDE = "SEED_ALLOW_DESTRUCTIVE";

/**
 * What `db/seed.ts` empties, spelled out in every refusal. A message that
 * only says "this is destructive" is one people learn to click past; one that
 * lists the tables is one they read.
 */
const DAMAGE =
  "pageCategories, categories, individuals, unions, unionChildren, " +
  "revisions, and pages";

export type SeedGuardResult =
  { allowed: true } | { allowed: false; message: string };

/**
 * Decide whether `db/seed.ts` may run against `databaseUrl`.
 *
 * - Local hosts (`localhost`, `127.0.0.1`, `::1`) are allowed without
 *   ceremony — that is the everyday path and it should stay frictionless.
 * - Any other host is refused unless `env.SEED_ALLOW_DESTRUCTIVE` names the
 *   *exact* `user@host` pair the connection would use (or just the host, if
 *   the URL carries no username). Why the token includes the username, and
 *   why it is compared exactly rather than by substring, is in
 *   `db/destructive-target.ts`.
 * - Naming the target, rather than a bare boolean flag, means a stale
 *   `export SEED_ALLOW_DESTRUCTIVE=1` left in a shell can't later authorise
 *   wiping a database the developer wasn't thinking about.
 * - A missing or unparseable `databaseUrl` is refused rather than assumed
 *   safe. Unlike `db/migrate.ts`'s `describe()`, where an unparseable string
 *   only affects a log line, this decision gates a destructive delete.
 * - Only the host and user are checked, not the port or database name —
 *   `SEED_ALLOW_DESTRUCTIVE` authorises the (user, host) pair, and any
 *   database reachable as that user on that host is treated as equally
 *   destroyable. That is a deliberately coarser guarantee than "this exact
 *   database"; narrowing it further is out of scope here.
 */
export function assertSeedTarget(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): SeedGuardResult {
  const target = classifyDestructiveTarget(databaseUrl);

  switch (target.kind) {
    case "missing":
      return {
        allowed: false,
        message:
          "DATABASE_URL is not set. Refusing to run: db:seed deletes every " +
          `row in ${DAMAGE} before inserting anything, and there is nothing ` +
          "to check that against.",
      };

    case "unparseable":
      return {
        allowed: false,
        message:
          "DATABASE_URL could not be parsed as a URL. Refusing to run rather " +
          "than assume it is safe to delete every row from — db:seed deletes " +
          `${DAMAGE} before inserting anything.`,
      };

    case "local":
      return { allowed: true };

    case "remote":
      if (overrideAuthorises(target, env, OVERRIDE)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        message:
          `Refusing to seed "${target.hostname}": db:seed deletes every row ` +
          `in ${DAMAGE} before inserting anything. To run it anyway, set ` +
          `${OVERRIDE}=${target.token}.`,
      };
  }
}
