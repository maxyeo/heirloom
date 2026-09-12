import { describe, expect, it } from "vitest";

import {
  describeSource,
  describeTarget,
  type EnvLike,
  postgresErrorCode,
  runUrl,
} from "@/db/keep-alive-context";

/**
 * `describeTarget` is the keep-alive's redaction boundary: it is the only
 * thing standing between a connection string and stdout, and its output goes
 * into a public repository's Actions log on every run. These assertions are
 * about what it must *never* emit as much as what it must.
 */
describe("describeTarget", () => {
  const SUPABASE =
    "postgresql://postgres.examplerefaaaaaaaaaaaa:hunter2@aws-0-us-west-2.pooler.supabase.com:6543/postgres";

  it("names the host and enough of the ref to check against a pause email", () => {
    expect(describeTarget(SUPABASE)).toBe(
      "aws-0-us-west-2.pooler.supabase.com:6543 (project examp\u2026)",
    );
  });

  /**
   * This repository is public, so every line this returns is published to a
   * world-readable Actions log every hour. The ref is not a credential, but
   * it is the username half of the pooler pair, so the log gets a prefix and
   * not the identifier. Asserting the full ref is *absent* is the form that
   * survives someone later "improving" the message.
   */
  it("publishes a prefix of the ref, never the whole thing", () => {
    expect(describeTarget(SUPABASE)).not.toContain("examplerefaaaaaaaaaaaa");
    // A ref shorter than the prefix is returned whole rather than padded or
    // truncated to nonsense — there is nothing to hide in four characters.
    expect(describeTarget("postgresql://postgres.abcd:pw@h:5432/d")).toContain(
      "(project abcd)",
    );
  });

  /**
   * The regression that matters. A later "let's also log the database name"
   * edit is the classic way a password reaches a log, so this asserts the
   * absence of the secret rather than the presence of the ref — the former
   * keeps holding when someone widens the string, the latter does not.
   */
  it("never emits the password, on any input shape", () => {
    for (const url of [
      SUPABASE,
      "postgresql://postgres.abc:hunter2@host:5432/postgres",
      // Reserved characters percent-encoded, the shape a generated password
      // actually takes.
      "postgresql://user:p%40ss%3Aword@host:5432/db",
      // A malformed percent-escape: `decodeURIComponent` throws, and the
      // catch branch must not fall back to printing the input.
      "postgresql://user:hunter2@host:5432/db?opt=%zz%zz",
      // No scheme at all, so `new URL` itself throws.
      "hunter2",
    ]) {
      expect(describeTarget(url)).not.toContain("hunter2");
      expect(describeTarget(url)).not.toContain("p@ss");
      expect(describeTarget(url)).not.toContain("%40");
    }
  });

  it("says so rather than guessing when the URL is not a Supabase pooler string", () => {
    expect(describeTarget("postgresql://localhost:5432/heirloom")).toBe(
      "localhost:5432 (no project ref in username; not a Supabase pooler URL)",
    );
  });

  it("distinguishes an unset variable from an unparseable one", () => {
    expect(describeTarget(undefined)).toBe("unknown (DATABASE_URL unset)");
    expect(describeTarget("")).toBe("unknown (DATABASE_URL unset)");
    expect(describeTarget("not a url")).toBe("unparseable DATABASE_URL");
  });
});

/**
 * This function shipped broken on this branch: it read `err.code`, which
 * Drizzle never sets, so the fallback it guards was dead code that read as
 * correct. It was caught by a live-database run. These assertions catch it
 * with no Postgres at all, and keep catching it if Drizzle adds a layer.
 */
describe("postgresErrorCode", () => {
  it("finds the code on a bare driver error", () => {
    expect(
      postgresErrorCode(Object.assign(new Error("x"), { code: "42P01" })),
    ).toBe("42P01");
  });

  it("finds it through Drizzle's wrapper, which is where it actually lives", () => {
    const wrapped = new Error("Failed query", {
      cause: Object.assign(new Error("relation does not exist"), {
        code: "42P01",
      }),
    });
    expect(postgresErrorCode(wrapped)).toBe("42P01");
  });

  it("keeps working if another layer is added", () => {
    const deep = new Error("outer", {
      cause: new Error("middle", {
        cause: Object.assign(new Error("inner"), { code: "42P01" }),
      }),
    });
    expect(postgresErrorCode(deep)).toBe("42P01");
  });

  it("returns undefined rather than throwing on errors with no code", () => {
    expect(postgresErrorCode(new Error("plain"))).toBeUndefined();
    expect(postgresErrorCode(undefined)).toBeUndefined();
    expect(postgresErrorCode(null)).toBeUndefined();
    expect(postgresErrorCode("a string")).toBeUndefined();
  });

  /**
   * A non-string `code` is the hazard the `typeof` guard exists for: postgres.js
   * connection errors carry a numeric `errno`, and a truthy-but-wrong value
   * would compare unequal to "42P01" and silently rethrow — which is correct —
   * but must not be *returned* as if it were a SQLSTATE.
   */
  it("ignores a non-string code and keeps looking", () => {
    const err = Object.assign(new Error("outer"), {
      code: 42,
      cause: Object.assign(new Error("inner"), { code: "42P01" }),
    });
    expect(postgresErrorCode(err)).toBe("42P01");
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    expect(postgresErrorCode(a)).toBeUndefined();
  });
});

describe("describeSource and runUrl", () => {
  const ACTIONS = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "maxyeo/heirloom",
    GITHUB_RUN_ID: "123",
  } satisfies EnvLike;

  it("reports the Actions event, which separates the cron from a hand test", () => {
    expect(describeSource(ACTIONS)).toBe("schedule");
    expect(
      describeSource({ ...ACTIONS, GITHUB_EVENT_NAME: "workflow_dispatch" }),
    ).toBe("workflow_dispatch");
  });

  it("calls anything outside Actions local", () => {
    expect(describeSource({})).toBe("local");
    // The variable is the string "false" in some runners' shells; only the
    // exact string "true" means Actions.
    expect(describeSource({ GITHUB_ACTIONS: "false" })).toBe("local");
  });

  it("builds the run URL, and returns null rather than a partial one", () => {
    expect(runUrl(ACTIONS)).toBe(
      "https://github.com/maxyeo/heirloom/actions/runs/123",
    );
    expect(runUrl({})).toBeNull();
    expect(runUrl({ ...ACTIONS, GITHUB_RUN_ID: undefined })).toBeNull();
  });
});
