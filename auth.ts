import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { isAllowedSignIn } from "@/lib/allowed-emails";

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
    /**
     * The membership check itself is `lib/allowed-emails.ts`, not this
     * callback. This module calls `NextAuth()` at import time and so cannot
     * be loaded outside the Next.js runtime — including by Vitest — which
     * would leave the one decision that separates "has a Google account" from
     * "may read this family's private wiki" as the only untested rule in the
     * codebase. See `lib/allowed-emails.test.ts`.
     */
    signIn({ user, profile }) {
      return isAllowedSignIn({
        email: user.email,
        emailVerified: profile?.email_verified,
      });
    },
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
});
