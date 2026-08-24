import { auth, signOut } from "@/auth";
import { AppShell } from "@/components/AppShell";

/**
 * `AppShell` with the signed-in viewer filled in.
 *
 * The split is the one docs/testing.md asks for: `components/` never imports
 * `@/auth`, because a module that does cannot be loaded by a test that has no
 * `AUTH_*` — and the failure spreads to every component in the same import
 * graph. So the shell takes the viewer and the sign-out action as props, and
 * the reading of them happens here, in `app/`, alongside the routes.
 *
 * Not a `layout.tsx`. The shell belongs on the signed-in pages and nowhere
 * else: `/signin` is a centred card with no navigation to offer and no account
 * to name, and putting `auth()` in the root layout would also run it while
 * Next prerenders `not-found` at build time, in a CI environment that
 * deliberately has no `AUTH_*` set at all. Nesting it under the segments that
 * already require a session keeps both problems from existing.
 */
export async function SiteChrome({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <AppShell
      viewerName={session?.user?.name ?? null}
      viewerEmail={session?.user?.email ?? null}
      signOutAction={async () => {
        "use server";
        await signOut({ redirectTo: "/signin" });
      }}
    >
      {children}
    </AppShell>
  );
}
