import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Google sign-in proves *who* someone is. It has no opinion on whether they
 * are allowed in — anyone with a Google account can complete the handshake.
 * This allowlist is the entire membership model.
 */
function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  // JWT sessions: no database adapter, no users/accounts/sessions tables.
  // At this scale the session cookie is all the machinery we need.
  session: { strategy: "jwt" },
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  callbacks: {
    signIn({ user, profile }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      // Google sets email_verified on consumer accounts; refuse anything else.
      if (profile && profile.email_verified === false) return false;
      return allowedEmails().includes(email);
    },
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
});
