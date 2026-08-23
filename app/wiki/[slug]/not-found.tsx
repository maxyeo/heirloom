import Link from "next/link";

/**
 * What a reader gets when `page.tsx` calls `notFound()` on a slug no row
 * holds. Scoped to this segment rather than added at the root, so the rest of
 * the app keeps Next's default 404 and a sibling route can still write its
 * own.
 *
 * It takes no props — `not-found.tsx` never receives the `params` that led
 * here — so the copy cannot name the missing entry. That is fine: the address
 * is in the URL bar, a few characters above this text.
 */
export default function WikiEntryNotFound() {
  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>No such entry</h1>

      <div className="wiki-body">
        <p>
          There is no entry at this address. It may have been renamed, or it
          may simply not have been written yet.
        </p>
        <p>
          <Link href="/">Return to the front page</Link>
        </p>
      </div>
    </main>
  );
}
