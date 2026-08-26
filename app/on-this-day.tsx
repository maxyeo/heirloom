import { OnThisDayList } from "@/components/OnThisDayList";
import { listOnThisDay } from "@/lib/on-this-day";
import { todayAnniversary } from "@/lib/on-this-day-feed";

/**
 * The home page's "On this day" section (E8-T5, `YEO-59`), data and all.
 *
 * ## Why this file is in `app/` and not in `components/`
 *
 * The rule `app/recent-changes.tsx` states next door, followed rather than
 * restated: **no file under `components/` imports `@/db`**, directly or
 * transitively. `npm test` runs with no `DATABASE_URL` at all
 * (docs/testing.md), so a component that reached the query layer could not be
 * mounted, and neither could anything that imported it — docs/testing.md's
 * account of `components/FamilyTree.tsx` is the worked example of that failure
 * spreading, where one component pulling in a server action took the whole
 * canvas suite down with it.
 *
 * So the read happens here, alongside the route, and
 * `components/OnThisDayList.tsx` takes plain rows as a prop.
 *
 * Keeping the `await` here rather than hoisting it into `app/page.tsx` is also
 * what keeps the sections concurrent: Next renders sibling Server Components
 * in parallel, so this section and `<RecentChanges />` cost the page its
 * slower one rather than the sum of the two. Two `await`s in `page.tsx` would
 * be sequential unless whoever added the second remembered `Promise.all`, and
 * forgetting is silent — nothing breaks, the page is just slower.
 *
 * ## Why today is read here rather than inside the query
 *
 * Because two things need it and they must agree. `listOnThisDay` needs the
 * month and the day to select rows; `OnThisDayList` needs the year to say how
 * long ago each one was. Read separately they could straddle midnight — a row
 * selected for the 31st, described relative to the 1st — which is a bug that
 * would appear once a month for a few milliseconds and never be reproducible.
 * Read once here, both halves are answering about the same day by
 * construction.
 *
 * `app/page.tsx` is `export const dynamic = "force-dynamic"`, so this runs per
 * request and the day is genuinely today rather than the day of the last
 * deploy.
 *
 * That is the whole of this file — read the day, `await`, and hand the rows
 * on. It cannot be unit-tested (React and Vitest cannot mount an `async`
 * Server Component), which is precisely why there must be nothing in it worth
 * testing.
 */
export async function OnThisDay() {
  const today = todayAnniversary();
  const anniversaries = await listOnThisDay(today);

  return <OnThisDayList anniversaries={anniversaries} todayYear={today.year} />;
}
