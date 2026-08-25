/**
 * Is this connection string one a destructive script may point at?
 *
 * Two scripts in `db/` destroy data outright: `db/seed.ts` deletes every row
 * before inserting the fixture, and `db/restore.ts` drops the schemas before
 * replaying a dump into them. Both need the same decision — is this database
 * local, or is it somewhere that has to be named explicitly first — and the
 * subtleties in making it are the same subtleties, so they are made once
 * here.
 *
 * What is deliberately *not* shared is the refusal message. A message that
 * tries to serve both scripts ends up saying "this operation" instead of
 * naming what is about to be lost, and that sentence is the last thing
 * standing between a tired operator and a wiped database. So each caller
 * (`db/seed-guard.ts`, `db/restore-guard.ts`) maps the decision below onto
 * its own wording, and the shared part stays down to the parsing.
 *
 * Pure, so it can be unit-tested with a plain string — see docs/testing.md.
 */

// The WHATWG `URL` parser keeps IPv6 hosts bracketed in `.hostname`
// (`new URL("postgresql://[::1]:5432/x").hostname === "[::1]"`), so the
// bracketed form is what has to be listed here, not the bare address.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type DestructiveTarget =
  /** No connection string at all. */
  | { kind: "missing" }
  /** There is a string, but it is not a URL anything can be concluded from. */
  | { kind: "unparseable" }
  /** A database on this machine. The everyday case, allowed without ceremony. */
  | { kind: "local"; hostname: string }
  /**
   * Anything else. `token` is what an override variable has to equal, and
   * `hostname` is what a message should name.
   */
  | { kind: "remote"; hostname: string; token: string };

/**
 * Classify `databaseUrl` as somewhere destruction is routine, somewhere it
 * has to be authorised, or somewhere nothing can be concluded about.
 *
 * A missing or unparseable string is its own answer rather than being folded
 * into "remote": the caller is gating a delete, and "I could not tell what
 * this is" deserves a different sentence from "this is production". Unlike
 * `db/migrate.ts`'s `describe()`, where an unparseable string only spoils a
 * log line, nothing here may fall back to assuming safety.
 *
 * `token` — the value an override must match — is `user@host`, or the bare
 * host when the URL carries no username. Hostname alone is not enough to
 * identify a database on this project's actual production topology:
 * Supabase's pooler is a single shared regional hostname
 * (`aws-0-us-west-2.pooler.supabase.com`) serving every project behind it,
 * and it is the *username* (`postgres.<project-ref>`) that picks which
 * project a connection lands on. An override naming only the hostname would
 * authorise destroying any project reachable through that pooler, not the one
 * the operator was thinking about.
 */
export function classifyDestructiveTarget(
  databaseUrl: string | undefined,
): DestructiveTarget {
  if (!databaseUrl) {
    return { kind: "missing" };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { kind: "unparseable" };
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

  // Compared exactly, never by substring: `localhost.evil.example` and
  // `evil.example.localhost` are both remote, not local.
  if (LOCAL_HOSTNAMES.has(hostname)) {
    return { kind: "local", hostname };
  }

  return {
    kind: "remote",
    hostname,
    token: username ? `${username}@${hostname}` : hostname,
  };
}

/**
 * Whether `env` authorises destroying `target`, by naming it in `variable`.
 *
 * Naming the target, rather than setting a bare boolean flag, means a stale
 * `export SEED_ALLOW_DESTRUCTIVE=1` left in a shell cannot later authorise
 * wiping a database the operator was not thinking about — it has to match
 * what is actually being connected to.
 */
export function overrideAuthorises(
  target: DestructiveTarget,
  env: NodeJS.ProcessEnv,
  variable: string,
): boolean {
  return target.kind === "remote" && env[variable] === target.token;
}
