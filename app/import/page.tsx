import type { Metadata } from "next";
import Link from "next/link";

import { GedcomImport } from "@/components/GedcomImport";
import { requireSession } from "@/lib/session";

/**
 * Import a GEDCOM file (E6-T3, `YEO-48`).
 *
 * Everything on this page happens in the browser against
 * `app/api/import/route.ts`, so there is nothing for this component to read
 * and nothing to pass down. What it owns is the two things a Server Component
 * can own that a Client Component cannot: the session guard, and the framing
 * that tells somebody what they are about to do before they do it.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Import a family tree",
};

export default async function ImportPage() {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  await requireSession();

  return (
    // The same column as the wiki index: `max-w-content` is Vector 2022's 46em
    // measure, and the padding is the mobile half of it.
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      {/* Serif, and carrying its own bottom rule, from globals.css. */}
      <h1>Import a family tree</h1>

      <div className="wiki-body">
        <p>
          GEDCOM is the file every genealogy program can export. Upload one here
          and this will read it and tell you what it contains — how many people,
          how many unions, who the first of them are, and everything in the file
          it could not use. Nothing is added to the{" "}
          <Link href="/tree">family tree</Link> until you have seen that and
          said to go ahead.
        </p>
      </div>

      <GedcomImport />
    </main>
  );
}
