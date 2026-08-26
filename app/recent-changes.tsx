import { RecentChangesList } from "@/components/RecentChangesList";
import { listRecentChanges } from "@/lib/recent-changes";

/**
 * The home page's "Recently changed" section (E8-T4, `YEO-58`), data and all.
 *
 * ## Why this file is in `app/` and not in `components/`
 *
 * For exactly the reason `app/site-chrome.tsx` is. That file is the shell
 * with the signed-in viewer already filled in, and its docblock states the
 * rule: "`components/` never imports `@/auth`, because a module that does
 * cannot be loaded by a test that has no `AUTH_*` — and the failure spreads
 * to every component in the same import graph."
 *
 * `@/db` is the same hazard from the same direction, and the codebase has
 * held the line on it just as consistently — **no file under `components/`
 * imports `@/db`, directly or transitively.** `npm test` runs with no
 * `DATABASE_URL` at all (docs/testing.md), so a component that reached the
 * query layer could not be mounted, and neither could anything that imported
 * it: docs/testing.md's own account of `components/FamilyTree.tsx` is the
 * worked example of that failure spreading, where one component pulling in a
 * server action took the whole canvas suite down with it.
 *
 * So the read happens here, alongside the route, and
 * `components/RecentChangesList.tsx` takes plain rows as a prop — the same
 * "take it, do not import it" rule docs/testing.md generalises from three
 * separate collisions.
 *
 * ## Why it is a component at all, rather than lines in `app/page.tsx`
 *
 * So that the home page composes sections instead of accumulating queries. A
 * section owns its own read, so adding one is an import and a line of JSX in
 * `app/page.tsx` and nothing else — no query threaded down from the route, no
 * props to widen, and no section that has to know what another section reads.
 *
 * Keeping the `await` in the section rather than in the page also keeps the
 * sections concurrent. Next renders sibling Server Components in parallel, so
 * two sections that each await their own query cost the page its slowest
 * section rather than the sum of them. Two `await`s hoisted into `page.tsx`
 * would be sequential unless whoever added the second remembered
 * `Promise.all`, and forgetting is silent — nothing breaks, the page is just
 * slower.
 *
 * ## The pattern for the next section
 *
 * E8-T5's "On this day" (`YEO-59`) is next, and it should be this shape
 * exactly: an `app/on-this-day.tsx` that awaits its own `lib/` read and hands
 * the rows to a plain synchronous component under `components/` that a test
 * can mount.
 *
 * That is the whole of this file — `await`, and hand the rows on. It cannot
 * be unit-tested (React and Vitest cannot mount an `async` Server Component),
 * which is precisely why there must be nothing in it worth testing.
 */
export async function RecentChanges() {
  const changes = await listRecentChanges();

  return <RecentChangesList changes={changes} />;
}
