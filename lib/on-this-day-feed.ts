import type { UnionType } from "@/lib/union-input";

/**
 * What "on this day" *is* (E8-T5, `YEO-59`) — which stored dates are allowed
 * to have a day at all, what an anniversary row looks like, the rule that
 * orders one source against another, and how a row reads — as plain functions
 * over plain values.
 *
 * `lib/on-this-day.ts` is the half that queries; this is the half that
 * decides. The split is `lib/recent-changes-feed.ts`/`lib/recent-changes.ts`'s,
 * one section along the same home page, and it is not a stylistic preference:
 * `npm test` — the suite CI's `check` job runs — has no `DATABASE_URL` at all
 * (docs/testing.md), so a module that imports `@/db`, even only for a type,
 * cannot be loaded there. Everything below is arithmetic over strings and
 * numbers, so all of it is checked by the suite that gates a merge.
 *
 * ## The rule this section is really about
 *
 * A birthday needs a day, and most of the dates in a family archive do not
 * have one. `db/schema.ts` keeps that honestly: a date is a `date` column
 * plus a `date_qualifier`, a `date_precision`, and — since `YEO-88` — an
 * upper bound that turns the point into a range. Three of those four can
 * independently mean "there is no day here":
 *
 *   - `qualifier` is `about`/`before`/`after`. "About 1890" is the ticket's
 *     own example, and the stored day is not even claimed to be right.
 *   - `precision` is `year` or `month`. Postgres has to be handed a real
 *     calendar day, so a year off a headstone is stored as **1 January** and
 *     a month from a parish register as the **1st** — an *anchor*, not an
 *     assertion (`datePrecision` in `db/schema.ts`).
 *   - `upper` is non-null. `BET 1890 AND 1900` is two points; neither of them
 *     is an anniversary.
 *
 * The acceptance criterion names only the first, because it was written
 * against E4-T1, before precision (E4-T2) and ranges (`YEO-88`) existed. Left
 * at that, this section would put every year-precision birth in the archive on
 * the home page **on 1 January** — hundreds of people, all "born today",
 * every one of them a day the schema invented to have something to store.
 * That is precisely the failure `formatQualifiedDate`'s docblock describes
 * shipping once already, and `docs/testing.md`'s "fixtures carry the awkward
 * value" was written about the same three columns. So the predicate is all
 * three, and `lib/on-this-day.ts` states it once in SQL.
 *
 * It is a *widening* of the criterion rather than a departure from it: every
 * date the criterion excludes is still excluded, and the ones it did not know
 * to mention are excluded for the same reason it gives.
 */

/**
 * Today, as the three numbers this section needs.
 *
 * A plain record rather than a `Date`, because everything downstream wants
 * the calendar parts and nothing wants the instant: the queries compare a
 * month and a day, and the rows are dated by year. Passing a `Date` around
 * would leave every consumer to decide *which* zone's month it was reading,
 * which is the bug this type exists to make impossible to write.
 */
export type AnniversaryDate = {
  /** Four-digit year, used only to say how long ago something was. */
  year: number;
  /** 1–12, as Postgres `extract(month from …)` reports it — not `Date`'s 0–11. */
  month: number;
  /** 1–31. */
  day: number;
};

/**
 * Which day "today" is, read in UTC.
 *
 * ## Why UTC, when the reader is not in it
 *
 * Because every other date this application shows is already pinned there,
 * and a section that disagreed with the rest of the page would be worse than
 * one that is occasionally a few hours early or late.
 * `formatQualifiedDate` and `formatRevisionTimestamp` both pin `en-GB` and
 * UTC, and both give the same reason: `Intl` and `Date` otherwise read the
 * *environment's* zone, so the identical row renders differently on the
 * machine that builds this and the machine that serves it. A `date` column
 * has no time part at all, so "which day is 1912-06-04" has no zone in it
 * either — only "which day is now" does.
 *
 * The honest cost: a reader in Auckland sees their grandmother's birthday
 * appear late in the morning rather than at midnight. The alternative is to
 * decide the day in the browser, which would make this a Client Component,
 * put the query behind a request the server cannot make until the page has
 * loaded, and hand every reader a different home page to no great end. The
 * server's day is the one the rest of the site already uses.
 *
 * `app/page.tsx` is `export const dynamic = "force-dynamic"`, so this is
 * evaluated per request rather than baked into a build — which is what stops
 * the section being permanently stuck on the day of the last deploy.
 *
 * @param now the instant to read the day from; defaults to the real clock,
 *   and is a parameter so that a test can state a day rather than depend on
 *   when it runs
 */
export function todayAnniversary(now: Date = new Date()): AnniversaryDate {
  return {
    year: now.getUTCFullYear(),
    // `getUTCMonth` is 0-based and Postgres's `extract(month …)` is not, so
    // the conversion happens here, once, rather than at the call site that
    // builds the query.
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
}

/**
 * One of the two people a union is between, as a row names them.
 *
 * Its own type because a union carries up to two of these and a birth carries
 * the same pair of fields inline — writing "id and already-joined name" three
 * times is how a renderer ends up joining a name itself for one of them.
 */
export type AnniversaryPerson = {
  /** `individuals.id`, which is what `treeHref` deep-links to. */
  personId: string;
  /** Already joined by `formatPersonName`, so no renderer repeats that rule. */
  name: string;
};

/**
 * Something that happened on today's date, in some earlier year.
 *
 * ## Why this is a discriminated union and not one flat row type
 *
 * The same answer `RecentChange` reaches next door, and for a sharper reason
 * here: a birth and a death are about **one** person, and a marriage is about
 * **two**. Collapsed into one shape, every row would carry a `people` array
 * that a renderer had to trust held exactly one member for a birth — a rule
 * nothing checks and nothing states — plus a `unionType` that is meaningless
 * on two of the three arms and would have to be nullable to say so.
 *
 * Kept apart structurally, a birth cannot be rendered with two names and a
 * marriage cannot be rendered without asking which two people it was between.
 * The compiler checks that every arm is handled, so a fourth kind of
 * anniversary added later is a type error at each renderer rather than a row
 * that silently renders blank.
 *
 * That is the same "widen rather than collapse" answer `db/schema.ts` reaches
 * for date ranges and the two portrait columns, applied to a read model.
 *
 * Every arm carries `year`, because that is the one thing all three have in
 * common and the only field the ordering reads. There is deliberately no
 * `date`: every row in this feed falls on today's month and day by
 * construction, so the day part carries no information a reader does not
 * already have from the heading, and a row that carried it could drift out of
 * agreement with the query that selected it.
 */
export type Anniversary =
  /**
   * Somebody was born on today's date.
   *
   * Sourced from `individuals.birth_date` with the three-part predicate this
   * module's header argues for. Nothing here says whether the person is still
   * alive: "born on this day in 1890" is true either way, and a section that
   * quietly dropped the living would be strange on a family wiki whose
   * readers are mostly in it.
   */
  | ({ kind: "birth"; year: number } & AnniversaryPerson)
  /**
   * Somebody died on today's date.
   *
   * The arm that makes this section more than a birthday list, and the reason
   * the ticket names all three events rather than one: a family archive is
   * kept as much for the anniversaries nobody wants to be reminded of by a
   * calendar app.
   */
  | ({ kind: "death"; year: number } & AnniversaryPerson)
  /**
   * A union began on today's date.
   *
   * ## Why partnerships and unrecorded types are here too
   *
   * The criterion says "marriages", and `unions.type` has three members:
   * `marriage`, `partnership` and `unknown`. Filtering to the first would
   * mean a couple recorded as a partnership never has an anniversary, and a
   * couple whose type was never established never has one either — a silent
   * gap, in a section whose entire purpose is to surface what the archive
   * already holds. So every union with a usable start date is here, and the
   * *word* differs instead: `formatAnniversaryEvent` says "Married",
   * "Partnered" or "Together from", which is the vocabulary
   * `components/PersonPanel.tsx` already uses for exactly this distinction. A
   * partnership is not a marriage and must not borrow the word for it; it is
   * still an anniversary.
   *
   * ## Why `partners` is an array
   *
   * Because both `unions.partner_a_id` and `unions.partner_b_id` are
   * nullable, and deliberately so — `db/schema.ts`: "we know the mother, the
   * father is unknown" is extremely common in older generations. A pair of
   * nullable fields would push that into every renderer as two null checks
   * and a decision about what "and" means with one side missing. An array of
   * the partners that *are* recorded pushes it into one place, and
   * `lib/on-this-day.ts` refuses to select a union with neither — there would
   * be nobody to name and nowhere to link.
   *
   * So `partners` holds one or two people. It is not typed as a
   * one-or-two-tuple: the guarantee comes from a `WHERE` clause in another
   * module, and a type that claimed it here would be claiming something this
   * module cannot check.
   */
  | {
      kind: "union-started";
      /** `unions.id` — the tie-break key, since a union has no slug. */
      unionId: string;
      /** Which word the row uses. See the arm's docblock. */
      unionType: UnionType;
      /** The partners the row can name: one or two, never none. */
      partners: readonly AnniversaryPerson[];
      year: number;
    };

/**
 * How many rows the section shows.
 *
 * Ten, matching `RECENT_CHANGES_LIMIT` in the section directly above it —
 * two home page sections that disagreed about how long a glance is would
 * read as an accident rather than as a decision. The number does the same
 * second job it does there: it is also the limit each source query takes, and
 * they are the same number on purpose. No source can contribute more than
 * every row of the merged feed, so ten from each is exactly enough to be
 * certain the merge is correct however the years interleave — fewer could
 * drop a row that belonged, more could never change the answer.
 *
 * A day busy enough to overflow this is a good problem and an unlikely one:
 * it takes eleven recorded events sharing one date in one family.
 */
export const ON_THIS_DAY_LIMIT = 10;

/**
 * The tie-break key for two anniversaries in the same year.
 *
 * Sorting on `year` alone is not a *total* order, and ties are the ordinary
 * case rather than an exotic one here: two siblings born on the same day in
 * the same year are twins, and a couple's marriage is one row however many
 * people it names. Without a tie-break the orderings are all valid and the
 * section can reshuffle between two requests that read identical rows — the
 * "make it total, not merely stable" rule `searchEntries`, `searchPeople` and
 * `mergeRecentChanges` each state for their own sorts.
 *
 * The key is the arm's own identity, unique within its table and prefixed by
 * the kind so that it is unique across all three — a person appears in both
 * the birth and the death query, and a person id and a union id are both
 * UUIDs and could otherwise collide in principle.
 */
function tieBreakKey(anniversary: Anniversary): string {
  switch (anniversary.kind) {
    case "birth":
      return `birth:${anniversary.personId}`;
    case "death":
      return `death:${anniversary.personId}`;
    case "union-started":
      return `union-started:${anniversary.unionId}`;
  }
}

/**
 * Interleave the three sources into one list, **oldest first**.
 *
 * ## Why oldest first, when the feed above it is newest first
 *
 * Because they are answering different questions. "Recently changed" is a
 * feed, where the newest row is the one you came for and everything below it
 * is context. This is a page of a calendar: every row happened on the same
 * day of the year, and what distinguishes them is where they sit in the
 * family's history. Read downwards from the earliest, the section reads as
 * the day's own chronology — which is how Wikipedia's own "On this day"
 * orders its entries, and this application borrows Wikipedia's reading
 * conventions everywhere else it has an opinion.
 *
 * ## Why the merge is here and not a `UNION ALL`
 *
 * `mergeRecentChanges` makes the argument in full and it holds unchanged: the
 * arms have different column lists — one person, one person, and up to two
 * plus a type — so a single statement would have to pad every row with the
 * columns it does not use, reassembling in SQL exactly the flat, mostly-null
 * row the union exists to avoid. Whatever came back would then be
 * discriminated in TypeScript anyway, from the nulls.
 *
 * What SQL keeps is the part only it can do: each source is filtered, ordered
 * and limited by Postgres against its own table, so this function never sees
 * more than `ON_THIS_DAY_LIMIT` rows per source however large the archive
 * grows.
 *
 * @param sources the three already-limited source lists, in any order
 * @param limit how many rows to keep, defaulting to `ON_THIS_DAY_LIMIT`
 * @returns at most `limit` anniversaries, oldest first, in a total order
 */
export function mergeAnniversaries(
  sources: readonly Anniversary[][],
  limit: number = ON_THIS_DAY_LIMIT,
): Anniversary[] {
  // A new array rather than sorting a caller's: `sources` is `readonly` at
  // the outer level but its members are not, and a merge has no business
  // reordering the lists it was handed.
  const all = sources.flat();

  all.sort((a, b) => {
    const byYear = a.year - b.year;
    if (byYear !== 0) return byYear;

    // Ascending on the key, which is arbitrary but *fixed* — the point is
    // that two rows from the same year always come back in the same order,
    // not that one of them deserves to be first.
    return tieBreakKey(a) < tieBreakKey(b) ? -1 : 1;
  });

  return all.slice(0, limit);
}

/**
 * The year out of a stored `YYYY-MM-DD` date.
 *
 * Here rather than in `lib/on-this-day.ts` so that the one piece of arithmetic
 * the query layer performs is checked by `npm test` along with everything
 * else.
 *
 * No malformed-value guard, and — as `formatQualifiedYear` says of itself for
 * the same operation — that is not an omission. The column is a Postgres
 * `date`, so what arrives is `YYYY-MM-DD`; there is no third case for a guard
 * to catch, and this only ever takes the first four characters, which needs no
 * parser and cannot throw.
 */
export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * What happened, and in which year: `Born 1890`, `Died 1947`, `Married 1912`.
 *
 * One string rather than a verb and a year the renderer joins, because the
 * three arms do not share a shape — "Together from 1912" is four words where
 * the others are two, and a renderer assembling `${verb} ${year}` would have
 * to special-case it back apart.
 *
 * Capitalised because it opens the row's second line, the same position
 * `RecentChangesList`'s byline occupies with the same treatment.
 */
export function formatAnniversaryEvent(anniversary: Anniversary): string {
  switch (anniversary.kind) {
    case "birth":
      return `Born ${anniversary.year}`;
    case "death":
      return `Died ${anniversary.year}`;
    case "union-started":
      return `${UNION_VERB[anniversary.unionType]} ${anniversary.year}`;
  }
}

/**
 * How a union's start reads, by type.
 *
 * `components/PersonPanel.tsx`'s `UNION_NOUN` is where this vocabulary was
 * settled — "Married", "Partnered", "Together" — and this repeats the
 * distinction rather than the table, because the panel's words head a
 * dateless row and these have a year hanging off them. "Together 1912" would
 * read as a date the couple *were* together rather than the year they began,
 * which the preposition fixes; the other two are already past-tense verbs and
 * take a year directly.
 *
 * A `Record` over `UnionType` rather than a `switch` with a default, so that
 * a fourth member added to the enum is a compile error here rather than a row
 * that silently reads as a marriage.
 */
const UNION_VERB: Record<UnionType, string> = {
  marriage: "Married",
  partnership: "Partnered",
  unknown: "Together from",
};

/**
 * How long ago it was: `136 years ago`, `1 year ago`, or nothing.
 *
 * The line this whole section exists for — "1890" is a fact and "136 years
 * ago" is the reason somebody opens the site on a day they had not planned
 * to.
 *
 * Null in two cases, both of which would otherwise print something false or
 * silly:
 *
 *   - **This year.** A baby born this morning is not "0 years ago"; the row
 *     already says `Born 2026`, and today is not an anniversary of itself.
 *   - **A future year.** Nothing stops a typo putting a birth in 2091, and
 *     "-65 years ago" reads as a defect in the page rather than in the
 *     record. Rendering nothing leaves the year on screen, which is the part
 *     that is actually wrong and the part somebody can go and fix.
 *
 * The singular is here rather than in the component so that `1 year ago` is
 * checked by `npm test` — an anniversary exactly one year old is both easy to
 * get wrong and easy never to see, since every fixture anybody reaches for is
 * decades old. `formatPersonCount` next door exists for the same reason.
 *
 * @param year the year the event happened in
 * @param todayYear the year it is now, from `todayAnniversary`
 * @returns the interval in words, or null when there is none to state
 */
export function formatYearsAgo(year: number, todayYear: number): string | null {
  const years = todayYear - year;
  if (years <= 0) return null;
  return years === 1 ? "1 year ago" : `${years} years ago`;
}
