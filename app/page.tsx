import Link from "next/link";

import { auth, signOut } from "@/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  const title = process.env.NEXT_PUBLIC_SITE_TITLE ?? "Heirloom";

  return (
    // `max-w-content` is Vector 2022's measure — see globals.css. The article
    // shell that sets this column beside a sidebar is E11-T2.
    <main className="mx-auto max-w-content px-6 py-10">
      <h1>{title}</h1>

      <div className="wiki-body">
        <p className="text-caption text-ink-muted">
          From {title}, the family wiki. Signed in as {session?.user?.email}.
        </p>

        <h2>Browse</h2>
        <ul>
          {/* First, and deliberately so. Until search exists (E8) the index is
              the only way to reach an entry whose address you do not already
              know, which is what makes it the fallback navigation rather than
              a page of its own. */}
          <li>
            <Link href="/wiki">All entries</Link> — everything written so far,
            alphabetically
          </li>
          <li>
            <Link href="/tree">Family tree</Link> — everyone, and how they
            connect
          </li>
        </ul>
      </div>

      <form
        className="mt-10"
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/signin" });
        }}
      >
        <button type="submit" className="text-note text-link hover:underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
