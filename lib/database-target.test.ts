import { describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "@/lib/database-target";

// `NodeJS.ProcessEnv` requires `NODE_ENV`; every other key is optional. This
// keeps the fixtures below focused on the keys each test actually cares
// about instead of repeating NODE_ENV in each one.
function env(overrides: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

describe("resolveDatabaseUrl", () => {
  it("uses DATABASE_URL as-is when DATABASE_TARGET is unset", () => {
    expect(
      resolveDatabaseUrl(
        env({ DATABASE_URL: "postgresql://localhost:5432/heirloom" }),
      ),
    ).toBe("postgresql://localhost:5432/heirloom");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveDatabaseUrl(env({}))).toBeUndefined();
  });

  it("resolves to TEST_DATABASE_URL when DATABASE_TARGET=test", () => {
    expect(
      resolveDatabaseUrl(
        env({
          DATABASE_TARGET: "test",
          DATABASE_URL: "postgresql://localhost:5432/heirloom",
          TEST_DATABASE_URL: "postgresql://localhost:5432/heirloom_test",
        }),
      ),
    ).toBe("postgresql://localhost:5432/heirloom_test");
  });

  it("resolves to PRODUCTION_DATABASE_URL when DATABASE_TARGET=production", () => {
    expect(
      resolveDatabaseUrl(
        env({
          DATABASE_TARGET: "production",
          DATABASE_URL: "postgresql://localhost:5432/heirloom",
          PRODUCTION_DATABASE_URL: "postgresql://prod-host:6543/postgres",
        }),
      ),
    ).toBe("postgresql://prod-host:6543/postgres");
  });

  it("throws on an unrecognised DATABASE_TARGET rather than falling back", () => {
    expect(() =>
      resolveDatabaseUrl(
        env({
          DATABASE_TARGET: "prod",
          DATABASE_URL: "postgresql://localhost:5432/heirloom",
          PRODUCTION_DATABASE_URL: "postgresql://prod-host:6543/postgres",
        }),
      ),
    ).toThrow(/Unrecognised DATABASE_TARGET "prod"/);
  });

  it("throws naming the missing variable when a recognised target's variable is unset", () => {
    expect(() =>
      resolveDatabaseUrl(
        env({
          DATABASE_TARGET: "test",
          DATABASE_URL: "postgresql://localhost:5432/heirloom",
        }),
      ),
    ).toThrow(/TEST_DATABASE_URL/);
  });

  it("throws when a recognised target's variable is set to an empty string", () => {
    expect(() =>
      resolveDatabaseUrl(
        env({
          DATABASE_TARGET: "production",
          PRODUCTION_DATABASE_URL: "",
        }),
      ),
    ).toThrow(/PRODUCTION_DATABASE_URL/);
  });
});
