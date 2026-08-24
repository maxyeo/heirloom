/**
 * Which database `DATABASE_URL` resolves to.
 *
 * `.env.local` is one file per developer, but a developer legitimately wants
 * to point at more than one database from it: the local Postgres for
 * everyday work, `heirloom_test` for `npm run test:db`, and — rarely, and on
 * purpose — production, without editing `.env.local` back and forth to get
 * there. `DATABASE_TARGET` is the switch between those, read once by
 * `lib/load-env.ts` before anything else looks at `DATABASE_URL`.
 *
 * Kept pure and separate from `lib/load-env.ts` so it can be unit-tested with
 * a plain object — see docs/testing.md's rule that logic worth testing is
 * logic that takes a plain value and returns one, with `lib/tree-layout.ts`
 * as the model.
 */

/**
 * Target name -> the env var that holds its connection string.
 *
 * `DATABASE_URL` itself is deliberately not a value here: it is the *default*
 * (target unset), not one of the named targets, so it can't be selected via
 * `DATABASE_TARGET=DATABASE_URL` and doesn't show up in the error message
 * listing valid values.
 */
const DATABASE_TARGETS = {
  test: "TEST_DATABASE_URL",
  production: "PRODUCTION_DATABASE_URL",
} as const;

type DatabaseTarget = keyof typeof DATABASE_TARGETS;

function isDatabaseTarget(value: string): value is DatabaseTarget {
  return Object.hasOwn(DATABASE_TARGETS, value);
}

/**
 * Resolve what `DATABASE_URL` should be, given `DATABASE_TARGET` and whatever
 * else is in `env`.
 *
 * - `DATABASE_TARGET` unset -> `env.DATABASE_URL` as-is. This is the local
 *   development database, and the only case where the two agree.
 * - `DATABASE_TARGET=test` -> `env.TEST_DATABASE_URL`.
 * - `DATABASE_TARGET=production` -> `env.PRODUCTION_DATABASE_URL`.
 * - anything else -> throws. A typo (`prod`, `Test`, a trailing space) must
 *   not silently fall through to the development database — that would be
 *   the exact hazard this switch exists to prevent, just moved one env var
 *   over.
 * - a recognised target whose variable is unset or empty -> throws, naming
 *   the variable, rather than returning `undefined` and letting the failure
 *   surface later as an opaque connection error.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const target = env.DATABASE_TARGET;

  if (!target) {
    return env.DATABASE_URL;
  }

  if (!isDatabaseTarget(target)) {
    const valid = Object.keys(DATABASE_TARGETS).join(", ");
    throw new Error(
      `Unrecognised DATABASE_TARGET "${target}". Valid values are: ${valid}. ` +
        "Leave it unset to use DATABASE_URL as-is (the local development database).",
    );
  }

  const variable = DATABASE_TARGETS[target];
  const value = env[variable];
  if (!value) {
    throw new Error(
      `DATABASE_TARGET=${target} requires ${variable} to be set, but it is ` +
        `empty or missing. Set it in .env.local.`,
    );
  }

  return value;
}
