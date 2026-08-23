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
        "SEED_ALLOW_DESTRUCTIVE=db.example.invalid",
      );
    }
  });

  it("allows a remote host when the override names that exact host", () => {
    const result = assertSeedTarget(
      "postgresql://user:pw@db.example.invalid:5432/postgres",
      env({ SEED_ALLOW_DESTRUCTIVE: "db.example.invalid" }),
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
