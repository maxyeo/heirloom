import { describe, expect, it } from "vitest";

import { assertRestoreTarget } from "@/db/restore-guard";

// As in `db/seed-guard.test.ts`: `NodeJS.ProcessEnv` requires `NODE_ENV` and
// nothing else, so fixtures stay focused on the key under test.
function env(overrides: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const SUPABASE =
  "postgresql://postgres.project-a:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres";

/**
 * The parsing underneath — local hosts, IPv6, case folding, exact matching,
 * and why the token is `user@host` — is `db/destructive-target.ts`'s, and is
 * covered there. These tests are about the part that is this guard's own: the
 * variable it reads, and that a restore is refused unless that specific
 * variable authorises this specific target.
 */
describe("assertRestoreTarget", () => {
  it("allows a local database without ceremony, so drills stay cheap", () => {
    expect(
      assertRestoreTarget("postgresql://localhost:5432/heirloom_test", env({})),
    ).toEqual({ allowed: true });
  });

  it("refuses a remote database with no override", () => {
    const result = assertRestoreTarget(SUPABASE, env({}));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain("aws-0-us-west-2.pooler.supabase.com");
      // The refusal has to say what would be lost, and print the exact token
      // to set — an operator mid-incident should be copying, not guessing.
      expect(result.message).toContain("drops the public and drizzle schemas");
      expect(result.message).toContain(
        "RESTORE_ALLOW_DESTRUCTIVE=postgres.project-a@aws-0-us-west-2.pooler.supabase.com",
      );
    }
  });

  it("allows a remote database when the override names it exactly", () => {
    expect(
      assertRestoreTarget(
        SUPABASE,
        env({
          RESTORE_ALLOW_DESTRUCTIVE:
            "postgres.project-a@aws-0-us-west-2.pooler.supabase.com",
        }),
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses when the override names a different project on the same pooler", () => {
    const result = assertRestoreTarget(
      SUPABASE,
      env({
        RESTORE_ALLOW_DESTRUCTIVE:
          "postgres.project-b@aws-0-us-west-2.pooler.supabase.com",
      }),
    );
    expect(result.allowed).toBe(false);
  });

  /**
   * The reason `db/restore-guard.ts` does not simply reuse
   * `SEED_ALLOW_DESTRUCTIVE`. Authorising a seed — which deletes rows from
   * five known tables — is not authorising a restore, which drops the schemas
   * and the migration ledger with them. Somebody who set the seed override an
   * hour ago and still has it in their shell has consented to the first thing
   * and not to the second.
   */
  it("is not authorised by the seed override", () => {
    const result = assertRestoreTarget(
      SUPABASE,
      env({
        SEED_ALLOW_DESTRUCTIVE:
          "postgres.project-a@aws-0-us-west-2.pooler.supabase.com",
      }),
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses an unset DATABASE_URL rather than assuming it is safe", () => {
    const result = assertRestoreTarget(undefined, env({}));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toMatch(/DATABASE_URL is not set/);
    }
  });

  it("refuses an unparseable DATABASE_URL", () => {
    const result = assertRestoreTarget("not a url", env({}));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toMatch(/could not be parsed/i);
    }
  });
});
