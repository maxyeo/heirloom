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
 * - Any other host is refused unless `env.SEED_ALLOW_DESTRUCTIVE` names the
 *   *exact* `user@host` pair the connection would use (or just the host, if
 *   the URL carries no username). Hostname alone is not enough to identify a
 *   database on this project's actual production topology: Supabase's
 *   pooler is a single shared regional hostname
 *   (`aws-0-us-west-2.pooler.supabase.com`) serving every project behind it,
 *   and it is the *username* (`postgres.<project-ref>`) that picks which
 *   project a connection actually lands on. An override that named only the
 *   hostname would authorise seeding any project reachable through that
 *   pooler, not the one the developer was thinking about — so the username
 *   is part of the token being matched, whenever the URL has one.
 * - Naming the target, rather than a bare boolean flag, means a stale
 *   `export SEED_ALLOW_DESTRUCTIVE=1` left in a shell can't later authorise
 *   wiping a database the developer wasn't thinking about — it has to match
 *   what is actually being connected to, compared exactly (no substring
 *   matching: `localhost.evil.example` and `evil.example.localhost` are
 *   both refused, not treated as local).
 * - A missing or unparseable `databaseUrl` is refused rather than assumed
 *   safe. Unlike `db/migrate.ts`'s `describe()`, where an unparseable string
 *   only affects a log line, this decision gates a destructive delete, so the
 *   same leniency is not appropriate here.
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

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
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

  // `postgresql:`/`postgres:` are non-special WHATWG URL schemes, so
  // `.hostname` is not lowercased for us the way it would be for `http:`.
  // Hostnames are case-insensitive (DNS folds case), so lowering it here
  // only ever *widens* which strings count as "the same host" — it can
  // never make a remote host register as local, and it can never make an
  // override match a host it wasn't written for, only recognise a
  // differently-cased spelling of the same one. Usernames are NOT folded
  // the same way — a Postgres role name is compared as typed — so
  // `username` below is left exactly as parsed, not lowercased.
  const hostname = parsed.hostname.toLowerCase();
  const username = parsed.username;

  if (LOCAL_HOSTNAMES.has(hostname)) {
    return { allowed: true };
  }

  const expectedToken = username ? `${username}@${hostname}` : hostname;

  if (env.SEED_ALLOW_DESTRUCTIVE === expectedToken) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message:
      `Refusing to seed "${hostname}": db:seed deletes every row in ` +
      "individuals, unions, unionChildren, revisions, and pages before " +
      `inserting anything. To run it anyway, set ` +
      `SEED_ALLOW_DESTRUCTIVE=${expectedToken}.`,
  };
}
