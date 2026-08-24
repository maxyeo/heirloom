import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requireSession,
  requireSessionOr401,
  UnauthorizedError,
} from "@/lib/session";

/**
 * The boundary itself (E10-T2, `YEO-66`).
 *
 * `app/auth-boundary.test.ts` proves every route and action *reaches* this
 * module. This proves the module decides correctly once reached — including
 * the case that is easy to get wrong in the safe-looking direction, a session
 * object that exists but carries no email.
 *
 * `@/auth` is mocked because it cannot be imported: `auth.ts` calls
 * `NextAuth()` at module scope and next-auth does not load outside the
 * Next.js runtime. Nothing else is stubbed — `requireSession` runs for real.
 */

const authState = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("@/auth", () => ({ auth: async () => authState.session }));

const signedIn = { user: { name: "Rose", email: "rose@example.com" } };

beforeEach(() => {
  authState.session = null;
});

describe("requireSession", () => {
  it("returns the session of a signed-in caller", async () => {
    authState.session = signedIn;
    await expect(requireSession()).resolves.toBe(signedIn);
  });

  it("throws when there is no session at all", async () => {
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  /**
   * The whole app keys on `session.user.email` — it is the author recorded on
   * every revision. A session without one is not a caller that can be
   * attributed, so it is not a caller that gets in.
   */
  it("throws on a session carrying no email", async () => {
    authState.session = {};
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);

    authState.session = { user: {} };
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);

    authState.session = { user: { email: null } };
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);

    authState.session = { user: { email: "" } };
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("requireSessionOr401", () => {
  /**
   * The route-handler flavour. A thrown error inside a route handler is a
   * 500, which tells a caller the server broke rather than that they are not
   * welcome; this returns the refusal instead of raising it.
   */
  it("hands back a 401 and no session when nobody is signed in", async () => {
    const { session, response } = await requireSessionOr401();

    expect(session).toBeNull();
    expect(response).toBeInstanceOf(Response);
    expect(response?.status).toBe(401);
  });

  it("hands back the session and no response when someone is", async () => {
    authState.session = signedIn;
    const { session, response } = await requireSessionOr401();

    expect(session).toBe(signedIn);
    expect(response).toBeNull();
  });

  it("refuses a session carrying no email, as requireSession does", async () => {
    // The two flavours must not disagree about who is signed in.
    authState.session = { user: { email: null } };
    const { session, response } = await requireSessionOr401();

    expect(session).toBeNull();
    expect(response?.status).toBe(401);
  });
});
