import Link from "next/link";

import { viewerInitials, viewerLabel } from "@/lib/viewer";

/**
 * The right-hand end of the header: who is signed in, and the way out.
 *
 * A `<details>` rather than a scripted popover, so it is a server component
 * with no hydration cost and it works before — and without — JavaScript. The
 * trade is that it does not close on an outside click; the summary toggles it
 * back, and Escape closes it in browsers that implement that for `<details>`.
 *
 * ## Why settings is here
 *
 * E7-T3 (`YEO-53`) needed a way in to `/settings`, and this menu is the second
 * item the note above anticipated. It is not in the sidebar: the sidebar's
 * five links are `lib/site-nav.ts`'s own set — four off the E11 reference
 * mockup, in the mockup's order, plus "New entry" for the create flow — and
 * `lib/site-nav.test.ts` asserts them exactly, so giving settings a sixth is
 * a decision about the shell rather than about settings. `app/tree/page.tsx`
 * makes the same call for the import link, from the other direction. An
 * account menu is also where a reader looks for their own settings, which is
 * the better argument of the two.
 *
 * The sign-out action arrives as a prop. `components/` stays clear of
 * `@/auth`, which is what keeps anything in here mountable in a suite that has
 * no `AUTH_*` — see docs/testing.md.
 */
export function AccountMenu({
  name,
  email,
  signOutAction,
}: {
  name: string | null;
  email: string | null;
  signOutAction: () => Promise<void>;
}) {
  const label = viewerLabel(name, email);

  return (
    <details className="relative ml-auto shrink-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-panel px-1.5 py-1 text-note text-ink-muted hover:bg-panel [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-full bg-wash text-note font-bold"
        >
          {viewerInitials(name, email)}
        </span>
        {/* The name is the summary's accessible name at every width; below the
            small breakpoint it is only announced, because a header that fits a
            display name on a phone has stopped fitting the search slot. */}
        <span className="sr-only sm:not-sr-only sm:max-w-32 sm:truncate">
          {label}
        </span>
      </summary>

      <div className="absolute right-0 z-50 mt-1 w-60 rounded-panel border border-rule bg-paper p-3">
        {email ? (
          <p className="text-note break-words text-ink-muted">
            Signed in as {email}
          </p>
        ) : null}

        <p className="mt-2">
          <Link
            href="/settings"
            className="text-note text-link hover:underline"
          >
            Settings
          </Link>
        </p>

        <form action={signOutAction} className="mt-2">
          <button type="submit" className="text-note text-link hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
