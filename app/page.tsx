import Link from "next/link";

import { auth, signOut } from "@/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  const title = process.env.NEXT_PUBLIC_SITE_TITLE ?? "Heirloom";

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p className="mt-2 text-stone-500 dark:text-stone-400">
        Signed in as {session?.user?.email}
      </p>

      <nav className="mt-10 flex flex-col gap-3">
        <Link
          href="/tree"
          className="rounded-md border border-stone-300 px-4 py-3 transition hover:bg-stone-50 dark:border-stone-600 dark:hover:bg-stone-800"
        >
          <span className="font-medium">Family tree</span>
          <span className="block text-sm text-stone-500 dark:text-stone-400">
            Everyone, and how they connect
          </span>
        </Link>
      </nav>

      <form
        className="mt-12"
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button
          type="submit"
          className="text-sm text-stone-500 underline underline-offset-4 hover:text-stone-800 dark:hover:text-stone-200"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
