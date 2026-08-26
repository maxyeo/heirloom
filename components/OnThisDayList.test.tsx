// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { OnThisDayList } from "@/components/OnThisDayList";
import type { Anniversary } from "@/lib/on-this-day-feed";
import { render } from "@/test/render";

/**
 * What the "On this day" section says, as markup (E8-T5, `YEO-59`).
 *
 * This component exists to be mountable — `app/on-this-day.tsx` is an `async`
 * Server Component and neither React nor Vitest can mount one
 * (docs/testing.md), so without the split two of the ticket's acceptance
 * criteria would be checked nowhere a test can reach. Those two are what this
 * file is about: that a quiet day shows nothing rather than an empty heading,
 * and that every row links through to the person.
 *
 * Not asserted here: which rows the section is given, which is
 * `lib/on-this-day.db.test.ts`'s — including the qualifier and precision rules
 * that decide whether a date has a day at all — and the ordering, the limit
 * and the wording, which are `lib/on-this-day-feed.test.ts`'s. This file is
 * handed the rows.
 */

const TODAY_YEAR = 2026;

const ROSE = "00000000-0000-4000-8000-000000005901";
const WALTER = "00000000-0000-4000-8000-000000005902";
const UNION = "00000000-0000-4000-8000-000000005903";

const born: Anniversary = {
  kind: "birth",
  personId: ROSE,
  name: "Rose Whitfield",
  year: 1890,
};

const died: Anniversary = {
  kind: "death",
  personId: WALTER,
  name: "Walter Whitfield",
  year: 1947,
};

const married: Anniversary = {
  kind: "union-started",
  unionId: UNION,
  unionType: "marriage",
  partners: [
    { personId: ROSE, name: "Rose Whitfield" },
    { personId: WALTER, name: "Walter Whitfield" },
  ],
  year: 1912,
};

function links(host: HTMLElement) {
  return [...host.querySelectorAll("a")];
}

describe("a quiet day", () => {
  it("renders nothing at all — not an empty heading", () => {
    const host = render(
      <OnThisDayList anniversaries={[]} todayYear={TODAY_YEAR} />,
    );

    /**
     * The acceptance criterion, and the reason it is `innerHTML` rather than
     * a query for the list: a `<section>` holding a heading and no `<li>`
     * would satisfy "there are no rows" while still putting a bold line, a
     * rule and its top margin on the home page — on most days of the year,
     * since a family archive's exact dates cover a minority of the calendar.
     * `components/ArticleCategories.test.tsx` asserts the same shape of
     * criterion the same way, for the same reason.
     */
    expect(host.innerHTML).toBe("");
  });
});

describe("a day the archive has something to say about", () => {
  it("heads the section once, however many rows there are", () => {
    const host = render(
      <OnThisDayList
        anniversaries={[born, married, died]}
        todayYear={TODAY_YEAR}
      />,
    );

    expect([...host.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "On this day",
    ]);
  });

  it("reports a birth, a death and a marriage side by side", () => {
    const host = render(
      <OnThisDayList
        anniversaries={[born, married, died]}
        todayYear={TODAY_YEAR}
      />,
    );

    // All three events the criterion names, in one section — the rows are in
    // the order they were handed over, because ordering is the merge's job.
    const rows = [...host.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "Rose WhitfieldBorn 1890 · 136 years ago",
      "Rose Whitfield and Walter WhitfieldMarried 1912 · 114 years ago",
      "Walter WhitfieldDied 1947 · 79 years ago",
    ]);
  });

  it("links a person to themselves on the tree", () => {
    const host = render(
      <OnThisDayList anniversaries={[born]} todayYear={TODAY_YEAR} />,
    );

    // The ticket's last criterion, through `treeHref` — the same deep link
    // `PersonSearchResults` and `RecentChangesList` send a person to.
    expect(links(host).map((link) => link.getAttribute("href"))).toEqual([
      `/tree?person=${ROSE}`,
    ]);
  });

  it("links both halves of a marriage separately", () => {
    const host = render(
      <OnThisDayList anniversaries={[married]} todayYear={TODAY_YEAR} />,
    );

    // Two links rather than one covering "Rose and Walter": a reader who
    // wants Walter should not have to open Rose to get to him.
    expect(links(host).map((link) => link.getAttribute("href"))).toEqual([
      `/tree?person=${ROSE}`,
      `/tree?person=${WALTER}`,
    ]);
  });

  it("names the one partner a half-recorded union has", () => {
    /*
      Both partner columns are nullable on purpose (`db/schema.ts`: "we know
      the mother, the father is unknown" is extremely common in older
      generations), so a union routinely names one person. The row must not
      read "Rose Whitfield and " with nothing after the conjunction.
    */
    const host = render(
      <OnThisDayList
        anniversaries={[
          {
            ...married,
            partners: [{ personId: ROSE, name: "Rose Whitfield" }],
          },
        ]}
        todayYear={TODAY_YEAR}
      />,
    );

    expect(host.querySelector("li")?.textContent).toBe(
      "Rose WhitfieldMarried 1912 · 114 years ago",
    );
    expect(links(host)).toHaveLength(1);
  });

  it("drops the interval, separator and all, for something that happened this year", () => {
    /*
      `formatYearsAgo` returns null for the current year and for anything
      later. The separator has to go with it, or a baby born this morning
      gets a row ending in a dangling middot.
    */
    const host = render(
      <OnThisDayList
        anniversaries={[{ ...born, year: TODAY_YEAR }]}
        todayYear={TODAY_YEAR}
      />,
    );

    expect(host.querySelector("li")?.textContent).toBe(
      "Rose WhitfieldBorn 2026",
    );
  });

  it("keeps a person's birth and death as two rows", () => {
    /*
      Somebody born and dead on the same date appears twice, keyed on the
      arm's kind as well as on their id — one key for both would be a
      duplicate-key warning and one of the two rows silently reused.
    */
    const host = render(
      <OnThisDayList
        anniversaries={[
          born,
          { ...died, personId: ROSE, name: "Rose Whitfield" },
        ]}
        todayYear={TODAY_YEAR}
      />,
    );

    expect(host.querySelectorAll("li")).toHaveLength(2);
  });

  it("announces itself as a list", () => {
    // `role="list"` restores what Tailwind's preflight strips along with the
    // markers — Safari and VoiceOver otherwise announce a run of links.
    const host = render(
      <OnThisDayList anniversaries={[born]} todayYear={TODAY_YEAR} />,
    );

    expect(host.querySelector("ul")?.getAttribute("role")).toBe("list");
  });
});
