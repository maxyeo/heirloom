import { afterEach, describe, expect, it, vi } from "vitest";

import { allowedEmails, isAllowedSignIn } from "@/lib/allowed-emails";

/**
 * The membership model, checked (E10-T2, `YEO-66`).
 *
 * `app/auth-boundary.test.ts` proves that every route and action demands a
 * session. This proves the other half: that having a Google account is not
 * the same as having a session here. Both are needed — a boundary that
 * faithfully rejects everyone without a session, and then hands one to
 * anybody who can click "Continue with Google", is not a boundary.
 */

const LIST = "rose@example.com, Bennett@Example.com";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("allowedEmails", () => {
  it("parses a comma-separated list", () => {
    expect(allowedEmails("a@example.com,b@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("trims and lower-cases, because a person typed these into a dashboard", () => {
    expect(allowedEmails("  Rose@Example.COM , bennett@example.com ")).toEqual([
      "rose@example.com",
      "bennett@example.com",
    ]);
  });

  it("yields nothing for an unset or empty variable", () => {
    // Not an empty-ish list containing `""`, which would admit an identity
    // whose email is blank.
    expect(allowedEmails(undefined)).toEqual([]);
    expect(allowedEmails("")).toEqual([]);
    expect(allowedEmails(" , ,, ")).toEqual([]);
  });

  it("reads ALLOWED_EMAILS when given nothing", () => {
    vi.stubEnv("ALLOWED_EMAILS", LIST);
    expect(allowedEmails()).toEqual([
      "rose@example.com",
      "bennett@example.com",
    ]);
  });
});

describe("isAllowedSignIn", () => {
  it("admits a verified address on the list", () => {
    expect(
      isAllowedSignIn({ email: "rose@example.com", emailVerified: true }, LIST),
    ).toBe(true);
  });

  /**
   * The acceptance criterion this file exists for. Nothing about this
   * identity is forged: Google really did authenticate `stranger@gmail.com`
   * and really did verify the address. Sign-in still fails, because
   * authentication is not authorisation and `ALLOWED_EMAILS` is the whole of
   * the latter.
   */
  it("refuses a valid, verified Google identity that is not on the list", () => {
    expect(
      isAllowedSignIn(
        { email: "stranger@gmail.com", emailVerified: true },
        LIST,
      ),
    ).toBe(false);
  });

  it("refuses an identity with no email at all", () => {
    expect(isAllowedSignIn({ email: null }, LIST)).toBe(false);
    expect(isAllowedSignIn({ email: undefined }, LIST)).toBe(false);
    expect(isAllowedSignIn({ email: "" }, LIST)).toBe(false);
    // Not even against a list that has been mis-configured with a blank entry.
    expect(isAllowedSignIn({ email: "" }, "rose@example.com,,")).toBe(false);
  });

  it("refuses an address the provider says it did not verify", () => {
    expect(
      isAllowedSignIn(
        { email: "rose@example.com", emailVerified: false },
        LIST,
      ),
    ).toBe(false);
  });

  /**
   * Absent is not the same as false. `emailVerified` is missing when the
   * provider sent no profile, and refusing on that would lock out any future
   * provider that does not report the field — a different failure from the
   * one the check is for.
   */
  it("admits a listed address when the provider did not report verification", () => {
    expect(isAllowedSignIn({ email: "rose@example.com" }, LIST)).toBe(true);
    expect(
      isAllowedSignIn({ email: "rose@example.com", emailVerified: null }, LIST),
    ).toBe(true);
  });

  it("compares case-insensitively on both sides", () => {
    // `Bennett@Example.com` is how the list has it; Google may send either.
    expect(isAllowedSignIn({ email: "BENNETT@example.com" }, LIST)).toBe(true);
    expect(isAllowedSignIn({ email: "bennett@example.com" }, LIST)).toBe(true);
  });

  it("refuses everyone when the allowlist is unset", () => {
    // The failure mode worth stating: a missing ALLOWED_EMAILS locks the site
    // rather than opening it.
    expect(isAllowedSignIn({ email: "rose@example.com" }, undefined)).toBe(
      false,
    );
    expect(isAllowedSignIn({ email: "rose@example.com" }, "")).toBe(false);
  });

  it("reads ALLOWED_EMAILS when given nothing", () => {
    vi.stubEnv("ALLOWED_EMAILS", LIST);
    expect(isAllowedSignIn({ email: "rose@example.com" })).toBe(true);
    expect(isAllowedSignIn({ email: "stranger@gmail.com" })).toBe(false);
  });
});
