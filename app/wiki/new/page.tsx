import type { Metadata } from "next";

import { NewEntryForm } from "@/components/NewEntryForm";
import { requireSession } from "@/lib/session";

/**
 * Where an entry begins (E1-T8, `YEO-22`).
 *
 * `/wiki/new` is a static segment, so Next resolves it ahead of the sibling
 * `[slug]` route and no entry can ever be reached at this address. That is
 * also why `new` is in `RESERVED_SLUGS` — an entry titled "New" would derive
 * to it and quietly get this form instead of itself. See `lib/entry-slug.ts`.
 */

/**
 * Reads a session cookie, like the read route, so there is nothing to
 * prerender. Stated rather than inferred from the first request-time API this
 * happens to touch.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Start a new entry" };

export default async function NewEntryPage() {
  // `lib/session.ts` is the only access boundary there is — no RLS underneath,
  // one database role for everyone — so the check goes here as well as inside
  // the action the form posts to. Neither is redundant: this one keeps the
  // form off a stranger's screen, the one in the action is what actually
  // stops a stranger creating an entry.
  await requireSession();

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Start a new entry</h1>

      <div className="wiki-body">
        <p className="text-caption text-ink-muted">
          Give it a title and you will be taken straight into the editor.
        </p>
      </div>

      <NewEntryForm />
    </main>
  );
}
