/**
 * The pure parts of the keep-alive (`YEO-145`).
 *
 * `db/keep-alive.ts` runs `main()` at import time, so nothing in it can be
 * imported by a test without also pinging a database. These three functions
 * take a plain value and return one, which is the repo's stated bar for
 * "logic worth testing" — see `db/destructive-target.ts` for the same split
 * and docs/testing.md for the rule.
 *
 * Extracting them is not bookkeeping. `postgresErrorCode` shipped broken once
 * already on this branch — it read `err.code`, which Drizzle never sets — and
 * that was caught by running the script against a live database rather than
 * by anything cheaper. `describeTarget` is the boundary that decides what
 * part of a connection string reaches stdout. Both deserve assertions that
 * run in `npm test` with no Postgres anywhere near them.
 */

/**
 * How much of a project ref to log. Supabase refs are 20 characters, so five
 * is far too few to collide across the handful of projects one account has,
 * and far too few to be useful to anyone reading the public log.
 */
const REF_PREFIX = 5;

function truncateRef(ref: string): string {
  return ref.length > REF_PREFIX ? `${ref.slice(0, REF_PREFIX)}\u2026` : ref;
}

/**
 * Which database are we actually keeping awake?
 *
 * The failure this guards against is the one that is invisible from the
 * Actions tab: a green cron pinging the wrong database while the real one
 * sleeps. Naming the target is what makes that visible.
 *
 * ## Why the ref is truncated
 *
 * This repository is public, so its Actions logs are world-readable and this
 * line is published hourly, forever. The Supabase project ref is not a
 * credential — it is already in the project's own `*.supabase.co` hostname —
 * but it is the username half of the pooler credential pair
 * (`postgres.<ref>`), and there is no reason to hand that out on a schedule.
 *
 * A prefix keeps everything the line is for: it still distinguishes one
 * project from another, still catches a `DATABASE_URL` repointed at the
 * wrong database, and still matches against the ref quoted in a pause
 * warning email. It just stops being a copy-pasteable identifier.
 *
 * Nothing here may return any other part of the URL. The password lives in
 * `url.password`, and no branch below reads it.
 */
export function describeTarget(connectionString: string | undefined): string {
  if (!connectionString) return "unknown (DATABASE_URL unset)";

  try {
    const url = new URL(connectionString);
    // Supabase's shared pooler identifies the project in the *username*
    // (`postgres.<ref>`), not the host — every project in a region shares one
    // hostname, so the host alone cannot tell two of them apart.
    const [, projectRef] = decodeURIComponent(url.username).split(".");
    return projectRef
      ? `${url.host} (project ${truncateRef(projectRef)})`
      : `${url.host} (no project ref in username; not a Supabase pooler URL)`;
  } catch {
    // A malformed URL is the connection's problem to report, not ours. Say
    // nothing rather than risk putting a password in a log line — note that
    // `decodeURIComponent` throws on a malformed escape, so a password
    // containing one lands here too.
    return "unparseable DATABASE_URL";
  }
}

/**
 * The Postgres `SQLSTATE` behind an error, wherever it ended up.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` and hangs the original
 * `PostgresError` off `cause`, so the code is never on the error you catch.
 * An earlier version of this checked `err.code` directly and silently never
 * matched — the fallback it guarded looked correct and was dead. Walking the
 * chain rather than reaching for `cause.code` keeps that true if a future
 * Drizzle adds another layer.
 */
export function postgresErrorCode(err: unknown): string | undefined {
  // A cyclic `cause` would spin forever. The depth bound is the cheap fix;
  // no real error chain is anywhere near it.
  for (let e = err, depth = 0; e != null && depth < 16; depth++) {
    const { code } = e as { code?: unknown };
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Just enough of an environment to read a few variables out of.
 *
 * Deliberately not `NodeJS.ProcessEnv`: this project augments that type with
 * required keys (`NODE_ENV` among them), so a test would have to construct a
 * whole plausible environment to assert on one variable. These functions read
 * strings by name and care about nothing else, and the signature should say
 * so. `process.env` satisfies it.
 */
export type EnvLike = Readonly<Partial<Record<string, string>>>;

/**
 * Who pinged: the Actions event name, or `local` for a hand run.
 *
 * Distinguishes the cron actually firing from someone having just tested it,
 * which is the difference you need when working out whether the schedule has
 * quietly stopped.
 */
export function describeSource(env: EnvLike): string {
  if (env.GITHUB_ACTIONS !== "true") return "local";
  return env.GITHUB_EVENT_NAME ?? "github-actions";
}

/**
 * The Actions run this ping came from, or null outside Actions. Null rather
 * than a guess: a fabricated URL in a diagnostic table is worse than a blank.
 */
export function runUrl(env: EnvLike): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}
