import { describe, expect, it } from "vitest";

import {
  classifyDestructiveTarget,
  overrideAuthorises,
} from "@/db/destructive-target";

/**
 * The decision `db/seed-guard.ts` and `db/restore-guard.ts` share. Each of
 * them tests its own wording and its own override variable; this file tests
 * the parsing they both stand on, once.
 */
describe("classifyDestructiveTarget", () => {
  it("treats the three spellings of this machine as local", () => {
    for (const url of [
      "postgresql://localhost:5432/heirloom",
      "postgresql://127.0.0.1:5432/heirloom",
      "postgresql://[::1]:5432/heirloom",
    ]) {
      expect(classifyDestructiveTarget(url).kind).toBe("local");
    }
  });

  it("folds hostname case, which can only widen the local set", () => {
    expect(classifyDestructiveTarget("postgresql://LOCALHOST/x").kind).toBe(
      "local",
    );
  });

  // Regression coverage for exact-match versus substring matching: a refactor
  // to `.includes()` would let both of these through, which is precisely the
  // class of accident these guards exist to prevent.
  it("does not treat a host that merely contains 'localhost' as local", () => {
    expect(
      classifyDestructiveTarget("postgresql://localhost.evil.example/x").kind,
    ).toBe("remote");
    expect(
      classifyDestructiveTarget("postgresql://evil.example.localhost/x").kind,
    ).toBe("remote");
  });

  it("builds the override token as user@host", () => {
    const target = classifyDestructiveTarget(
      "postgresql://postgres.project-a:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres",
    );
    expect(target).toEqual({
      kind: "remote",
      hostname: "aws-0-us-west-2.pooler.supabase.com",
      token: "postgres.project-a@aws-0-us-west-2.pooler.supabase.com",
    });
  });

  it("falls back to the bare host when the URL carries no username", () => {
    expect(
      classifyDestructiveTarget("postgresql://db.example.invalid/x"),
    ).toEqual({
      kind: "remote",
      hostname: "db.example.invalid",
      token: "db.example.invalid",
    });
  });

  // A Postgres role name is compared as typed, so unlike the hostname it must
  // not be case-folded: folding it would let an override written for one role
  // authorise a different one.
  it("leaves the username's case alone", () => {
    const target = classifyDestructiveTarget(
      "postgresql://Postgres.Project-A@db.example.invalid/x",
    );
    expect(target.kind === "remote" && target.token).toBe(
      "Postgres.Project-A@db.example.invalid",
    );
  });

  it("distinguishes 'no connection string' from 'unusable connection string'", () => {
    expect(classifyDestructiveTarget(undefined).kind).toBe("missing");
    expect(classifyDestructiveTarget("").kind).toBe("missing");
    expect(classifyDestructiveTarget("not a url").kind).toBe("unparseable");
  });
});

describe("overrideAuthorises", () => {
  const remote = classifyDestructiveTarget(
    "postgresql://user:pw@db.example.invalid/x",
  );

  it("authorises only the exact token, in the named variable", () => {
    expect(
      overrideAuthorises(
        remote,
        { NODE_ENV: "test", MY_OVERRIDE: "user@db.example.invalid" },
        "MY_OVERRIDE",
      ),
    ).toBe(true);
    expect(
      overrideAuthorises(
        remote,
        { NODE_ENV: "test", OTHER_OVERRIDE: "user@db.example.invalid" },
        "MY_OVERRIDE",
      ),
    ).toBe(false);
  });

  // The stale-flag case. Naming the target is what stops `export
  // ...=1`, left in a shell hours ago, from authorising a database nobody was
  // thinking about.
  it("is not satisfied by a truthy value", () => {
    expect(
      overrideAuthorises(
        remote,
        { NODE_ENV: "test", MY_OVERRIDE: "1" },
        "MY_OVERRIDE",
      ),
    ).toBe(false);
  });

  it("never authorises a target that could not be identified", () => {
    for (const target of [
      classifyDestructiveTarget(undefined),
      classifyDestructiveTarget("not a url"),
    ]) {
      expect(
        overrideAuthorises(
          target,
          { NODE_ENV: "test", MY_OVERRIDE: "anything" },
          "MY_OVERRIDE",
        ),
      ).toBe(false);
    }
  });
});
