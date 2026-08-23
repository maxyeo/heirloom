/**
 * Whether `db/seed.ts` is allowed to run against the resolved `DATABASE_URL`.
 *
 * `db/seed.ts` deletes every row before inserting anything, with no
 * confirmation and nothing to undo it. Kept as a pure function, separate from
 * `db/seed.ts` itself, so it can be unit-tested with a plain string and a
 * plain env object and needs no database — see docs/testing.md.
 */

// The WHATWG `URL` parser keeps IPv6 hosts bracketed in `.hostname`
// (`new URL("postgresql://[::1]:5432/x").hostname === "[::1]"`), so the
// bracketed form is what has to be listed here, not the bare address.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type SeedGuardResult =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Decide whether `db/seed.ts` may run against `databaseUrl`.
 *
 * - Local hosts (`localhost`, `127.0.0.1`, `::1`) are allowed without
 *   ceremony — that is the everyday path and it should stay frictionless.
 * - Any other host is refused unless `env.SEED_ALLOW_DESTRUCTIVE` names that
 *   *exact* hostname. Naming the host, rather than a bare boolean flag, means
 *   a stale `export SEED_ALLOW_DESTRUCTIVE=1` left in a shell can't later
 *   authorise wiping a database the developer wasn't thinking about — it has
 *   to match the host actually being connected to.
 * - A missing or unparseable `databaseUrl` is refused rather than assumed
 *   safe. Unlike `db/migrate.ts`'s `describe()`, where an unparseable string
 *   only affects a log line, this decision gates a destructive delete, so the
 *   same leniency is not appropriate here.
 */
export function assertSeedTarget(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): SeedGuardResult {
  if (!databaseUrl) {
    return {
      allowed: false,
      message:
        "DATABASE_URL is not set. Refusing to run: db:seed deletes every " +
        "row in individuals, unions, unionChildren, revisions, and pages " +
        "before inserting anything, and there is nothing to check that " +
        "against.",
    };
  }

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    return {
      allowed: false,
      message:
        "DATABASE_URL could not be parsed as a URL. Refusing to run rather " +
        "than assume it is safe to delete every row from — db:seed deletes " +
        "individuals, unions, unionChildren, revisions, and pages before " +
        "inserting anything.",
    };
  }

  if (LOCAL_HOSTNAMES.has(hostname)) {
    return { allowed: true };
  }

  if (env.SEED_ALLOW_DESTRUCTIVE === hostname) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message:
      `Refusing to seed "${hostname}": db:seed deletes every row in ` +
      "individuals, unions, unionChildren, revisions, and pages before " +
      `inserting anything. To run it anyway, set ` +
      `SEED_ALLOW_DESTRUCTIVE=${hostname}.`,
  };
}
