/**
 * Whether `db/restore.ts` is allowed to run against the resolved
 * `DATABASE_URL`.
 *
 * A restore is the most destructive thing in this repository. `db/seed.ts`
 * deletes rows; a restore drops the `public` and `drizzle` schemas outright
 * and replays a dump over the empty space, so what is lost is not just the
 * data but the schema, the migration ledger, and anything a person put in
 * that database that the dump does not know about.
 *
 * It is also the one destructive operation whose *point* is sometimes to run
 * against production — that is what a backup is for. So this cannot be a
 * refusal that only a developer can satisfy: it has to be a speed bump that
 * an operator having their worst day can clear deliberately, and cannot clear
 * by accident.
 *
 * Same shape and same reasoning as `db/seed-guard.ts`; the decision they
 * share is in `db/destructive-target.ts`. Pure, so it is unit-tested with a
 * plain string and a plain env object — see docs/testing.md.
 */

import {
  classifyDestructiveTarget,
  overrideAuthorises,
} from "./destructive-target";

/**
 * The variable that has to name the target before a remote restore is
 * allowed. Deliberately not `SEED_ALLOW_DESTRUCTIVE`: someone who once
 * authorised seeding a database, and still has that in their shell, has not
 * thereby authorised dropping its schemas.
 */
const OVERRIDE = "RESTORE_ALLOW_DESTRUCTIVE";

const DAMAGE =
  "db:restore drops the public and drizzle schemas and replays the dump " +
  "over them, so everything currently in that database is gone — rows, " +
  "schema, and migration history alike";

export type RestoreGuardResult =
  { allowed: true } | { allowed: false; message: string };

/**
 * Decide whether `db/restore.ts` may run against `databaseUrl`.
 *
 * - Local hosts are allowed without ceremony. Restoring into a scratch
 *   database on your own machine is how a backup gets tested, and a drill
 *   people have to argue with is a drill they stop running — which is the
 *   failure mode this whole feature exists to avoid.
 * - Anywhere else is refused unless `env.RESTORE_ALLOW_DESTRUCTIVE` names the
 *   exact `user@host` the connection would use. The refusal prints that
 *   token, so the operator copies it rather than guessing the format.
 * - Missing or unparseable is refused rather than assumed safe.
 */
export function assertRestoreTarget(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): RestoreGuardResult {
  const target = classifyDestructiveTarget(databaseUrl);

  switch (target.kind) {
    // Both variables are named, in the order `db/restore.ts` consults them.
    // An operator mid-incident has usually just set one of the two, and a
    // message naming only the other sends them to check the wrong thing.
    case "missing":
      return {
        allowed: false,
        message:
          "Neither RESTORE_DATABASE_URL nor DATABASE_URL is set, so there is " +
          `no way to tell what would be overwritten. Refusing to run: ${DAMAGE}.`,
      };

    case "unparseable":
      return {
        allowed: false,
        message:
          "The connection string (RESTORE_DATABASE_URL, or DATABASE_URL if " +
          "that is unset) could not be parsed as a URL. Refusing to run " +
          `rather than assume it is safe to overwrite — ${DAMAGE}.`,
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
          `Refusing to restore over "${target.hostname}": ${DAMAGE}. If that ` +
          `is genuinely what you want — recovering a lost database is exactly ` +
          `when it is — set ${OVERRIDE}=${target.token}.`,
      };
  }
}
