import Link from "next/link";

/**
 * What a reader gets when `page.tsx` calls `notFound()` on a category slug no
 * row holds (E11-T8, `YEO-78`).
 *
 * Scoped to this segment rather than reusing the entry's, which is the
 * behaviour `app/wiki/[slug]/not-found.tsx` anticipated when it explained why
 * it was not put at the root: "a sibling route can still write its own". The
 * copy has to differ, because the two situations differ. An entry that does
 * not exist is one somebody has not written yet and could; a category is
 * created by filing an entry under it, so there is no "write it" to offer
 * here — only a way back to the categories that do exist.
 *
 * It takes no props — `not-found.tsx` never receives the `params` that led
 * here — so the copy cannot name the missing category. The address is in the
 * URL bar a few characters above this text.
 */
export default function CategoryNotFound() {
  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>No such category</h1>

      <div className="wiki-body">
        <p>
          There is no category at this address. It may have been retired, or the
          link that led here may be older than the category it names.
        </p>
        <p>
          <Link href="/wiki/category">See every category</Link>
        </p>
      </div>
    </main>
  );
}
