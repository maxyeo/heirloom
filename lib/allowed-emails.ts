/**
 * Who is allowed in (E10-T2, `YEO-66`).
 *
 * Google sign-in proves *who* someone is and has no opinion on whether they
 * belong here — anyone with a Google account can complete the handshake. So
 * `ALLOWED_EMAILS` is the entire membership model, as `docs/architecture.md`
 * puts it, and this file is that model.
 *
 * It lives here rather than inside `auth.ts` for one reason: `auth.ts` calls
 * `NextAuth()` at module scope, which loads next-auth, which cannot be
 * imported outside the Next.js runtime. A decision that cannot be imported
 * cannot be tested, and "is this person allowed in" is the last decision in
 * the codebase that should go unchecked. Moving it to a plain module makes it
 * a function with a test; `auth.ts` keeps the callback and delegates.
 */

/**
 * The allowlist, parsed.
 *
 * Read at call time rather than at module load, because the environment is
 * not guaranteed to be populated when this module is first evaluated — and
 * because a value captured once is a value that cannot be changed without a
 * redeploy for reasons nobody documented.
 *
 * Comparison is lower-cased on both sides: addresses are configured by a
 * person typing them into Vercel, and `Rose@Example.com` is the same mailbox
 * as `rose@example.com`. Empty entries are dropped so that a trailing comma,
 * or an unset variable, yields an empty list rather than a list containing
 * `""` — which would otherwise admit an identity with a blank email.
 *
 * @param raw the comma-separated list; defaults to `ALLOWED_EMAILS`
 * @returns the addresses, trimmed, lower-cased, and never containing `""`
 */
export function allowedEmails(
  raw: string | undefined = process.env.ALLOWED_EMAILS,
): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/** What a provider hands over about the person signing in. */
export type SignInIdentity = {
  /** From the `user`, which Auth.js fills in from the provider's profile. */
  email: string | null | undefined;
  /**
   * Google sets this on consumer accounts. It is `null`/`undefined` when
   * there is no profile at all — a distinction that matters below.
   */
  emailVerified?: boolean | null;
};

/**
 * Whether this identity may sign in.
 *
 * Three ways to be refused, in order:
 *
 * 1. **No email.** There is nothing to check against the list, and the rest
 *    of the app keys on `session.user.email` — `requireSession()` rejects a
 *    session without one, so admitting it here would only produce an account
 *    that can sign in and then do nothing.
 * 2. **An email the provider says it did not verify.** Only an explicit
 *    `false` refuses. A missing value means the provider sent no profile, not
 *    that it sent a failing one, and treating "absent" as "unverified" would
 *    lock out any future provider that simply does not report the field.
 * 3. **An email that is not on the list.** The allowlist is the membership
 *    model; a perfectly valid, fully verified Google identity that nobody put
 *    on it is exactly the caller this is here to turn away.
 *
 * @param identity the email, and whether the provider vouched for it
 * @param raw the allowlist; defaults to `ALLOWED_EMAILS`
 * @returns true only if the address is verified and on the list
 */
export function isAllowedSignIn(
  identity: SignInIdentity,
  raw: string | undefined = process.env.ALLOWED_EMAILS,
): boolean {
  const email = identity.email?.trim().toLowerCase();
  if (!email) return false;
  if (identity.emailVerified === false) return false;
  return allowedEmails(raw).includes(email);
}
