import { describe, expect, it } from "vitest";

import { assertSeedTarget } from "@/db/seed-guard";

// `NodeJS.ProcessEnv` requires `NODE_ENV`; every other key is optional. This
// keeps the fixtures below focused on the keys each test actually cares
// about instead of repeating NODE_ENV in each one.
function env(overrides: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

describe("assertSeedTarget", () => {
  it("allows localhost without any override", () => {
    expect(
      assertSeedTarget("postgresql://localhost:5432/heirloom", env({})),
    ).toEqual({ allowed: true });
  });

  it("allows 127.0.0.1 and ::1 the same way", () => {
    expect(
      assertSeedTarget("postgresql://127.0.0.1:5432/heirloom", env({})),
    ).toEqual({ allowed: true });
    expect(
      assertSeedTarget("postgresql://[::1]:5432/heirloom", env({})),
    ).toEqual({ allowed: true });
  });

  it("allows a differently-cased spelling of a local host", () => {
    // Hostnames are case-insensitive; this only widens the local set, it
    // cannot make a remote host register as local.
    expect(
      assertSeedTarget("postgresql://LOCALHOST:5432/heirloom", env({})),
    ).toEqual({ allowed: true });
  });

  it("refuses a remote host with no override", () => {
    const result = assertSeedTarget(
      "postgresql://user:pw@db.example.invalid:5432/postgres",
      env({}),
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain("db.example.invalid");
      expect(result.message).toContain("deletes every row");
      expect(result.message).toContain(
        "SEED_ALLOW_DESTRUCTIVE=user@db.example.invalid",
      );
    }
  });

  // Regression coverage for exact-match vs. substring matching: a future
  // refactor to `.includes()`-style comparison would silently let either of
  // these through, which is precisely the class of accident this guard
  // exists to prevent.
  it("refuses hosts that merely contain 'localhost' as a substring", () => {
    expect(
      assertSeedTarget(
        "postgresql://localhost.evil.example:5432/postgres",
        env({}),
      ).allowed,
    ).toBe(false);
    expect(
      assertSeedTarget(
        "postgresql://evil.example.localhost:5432/postgres",
        env({}),
      ).allowed,
    ).toBe(false);
  });

  it("allows a remote host with no username when the override names that exact host", () => {
    const result = assertSeedTarget(
      "postgresql://db.example.invalid:5432/postgres",
      env({ SEED_ALLOW_DESTRUCTIVE: "db.example.invalid" }),
    );
    expect(result).toEqual({ allowed: true });
  });

  it("allows a remote host with a username when the override names user@host", () => {
    const result = assertSeedTarget(
      "postgresql://user:pw@db.example.invalid:5432/postgres",
      env({ SEED_ALLOW_DESTRUCTIVE: "user@db.example.invalid" }),
    );
    expect(result).toEqual({ allowed: true });
  });

  it("still refuses when the override names a different host", () => {
    const result = assertSeedTarget(
      "postgresql://user:pw@db.example.invalid:5432/postgres",
      env({ SEED_ALLOW_DESTRUCTIVE: "some-other-host.invalid" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses when the override names the right host but the wrong user", () => {
    // This is the case a hostname-only override would have missed: on a
    // shared pooler (Supabase's Supavisor), the host alone does not
    // identify a project — the username does.
    const result = assertSeedTarget(
      "postgresql://postgres.project-a:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres",
      env({
        SEED_ALLOW_DESTRUCTIVE: "postgres.project-b@aws-0-us-west-2.pooler.supabase.com",
      }),
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses when the override names the right user but the wrong host", () => {
    const result = assertSeedTarget(
      "postgresql://postgres.project-a:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres",
      env({ SEED_ALLOW_DESTRUCTIVE: "postgres.project-a@some-other-pooler.example" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses a bare-hostname override when the URL carries a username", () => {
    // The one case that actually distinguishes this implementation from a
    // hostname-only one. Every other test above still passes if `username`
    // is ignored entirely — an override shaped `user@host` never equals a
    // bare hostname, so those refusals happen for the wrong reason. Here a
    // hostname-only guard would *allow*, which is the exact defect the
    // user@host token was introduced to close: on a shared pooler the host
    // is not the database's identity.
    const result = assertSeedTarget(
      "postgresql://postgres.project-a:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres",
      env({ SEED_ALLOW_DESTRUCTIVE: "aws-0-us-west-2.pooler.supabase.com" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses an unparseable DATABASE_URL rather than assuming it is safe", () => {
    const result = assertSeedTarget("not a url", env({}));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toMatch(/could not be parsed/i);
    }
  });

  it("refuses when DATABASE_URL is unset", () => {
    const result = assertSeedTarget(undefined, env({}));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toMatch(/DATABASE_URL is not set/);
    }
  });
});
