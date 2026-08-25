import type { DateQualifier } from "@/lib/family-graph";
import { formatLifespan } from "@/lib/format-date";
import {
  foldName,
  literalTermRank,
  nameKey,
  withinOneEdit,
} from "@/lib/name-match";
import { formatPersonName } from "@/lib/person-format";
import { treeHref } from "@/lib/tree-selection";

/**
 * Ranking a page of search results over people (E8-T2, `YEO-56`), as a plain
 * function over plain rows.
 *
 * ## Why this is not `lib/partner-search.ts` with a new caller
 *
 * The two modules answer genuinely different questions, and the ticket is
 * explicit that they should stay that way rather than merge into one
 * "search people" function with a flag.
 *
 * `searchPartners` picks *one person already in front of you on a canvas*
 * out of at most a few hundred — its job is disambiguation between two
 * people of the same name, which is why a year typed alongside a name
 * narrows the field there. `searchPeople` is the destination of a
 * bookmarkable, sharable `/search?q=` page: there is no canvas of candidates
 * to narrow, there is a database to ask, and the acceptance criteria are
 * "search given name and surname" and "tolerate a spelling variant" — not
 * "let a year disambiguate". So this module's haystacks are the full name
 * and the surname alone, and deliberately **not** the two dates
 * `searchPartners` searches: adding them here would be building a feature
 * nobody asked for into a module that is supposed to be honestly narrower
 * than its sibling, and lifespan stays what it always was for this ticket —
 * something a result *shows*, not something it is found by.
 *
 * What is new here and has no equivalent in the picker is spelling
 * tolerance: `nameKey` and `withinOneEdit`, from `lib/name-match.ts`, are
 * what let "Catherine" find a person recorded as "Katharine". The picker
 * never needed this — a tree of a few hundred people, all visible on one
 * canvas, is a place an author scrolls when a query comes up short. A
 * full-page search is where that scroll doesn't exist, and "I know I typed
 * her name" has to actually mean something.
 *
 * ## Why it is a plain module with no `@/db` import
 *
 * `npm test` — what CI runs — has no `DATABASE_URL` (docs/testing.md).
 * `lib/people.ts` is the thin database module that reads `individuals` and
 * hands the rows here; this module is what makes the ranking itself
 * something `lib/people-search.test.ts` can assert against a literal, with
 * no Postgres anywhere in the import graph.
 */

/**
 * Enough of a row to search and to show a lifespan alongside it.
 *
 * Structural rather than an import of `GraphPerson`, for the same reason
 * `TitledEntry` in `lib/page-index.ts` and `EntryLink` in `lib/entry-link.ts`
 * are: this module has to stay reachable from `lib/people.ts`'s narrow
 * select without dragging `lib/family-graph.ts` — and the whole graph query
 * behind it — into its import graph for a type alone. The two date
 * qualifiers are here because `formatLifespan` needs them; nothing about
 * *why* a date is missing or approximate can be shown without them, and a
 * lifespan that silently treated "before 1920" as "1920" would be exactly
 * the invented certainty `lib/format-date.ts`'s own docblock warns against.
 */
export type PersonSearchRow = {
  id: string;
  givenName: string;
  surname: string | null;
  birthDate: string | null;
  birthDateQualifier: DateQualifier;
  deathDate: string | null;
  deathDateQualifier: DateQualifier;
};

/**
 * One search result: enough to display it and to follow it.
 *
 * `lifespan` is what the third acceptance criterion asks for — disambiguating
 * between two same-named relatives — and `href` is what the fourth does:
 * every result is already the E2-T4 deep link, built through `treeHref` so
 * there is exactly one place that knows the `?person=` contract's shape.
 */
export type PersonMatch = {
  id: string;
  name: string;
  lifespan: string;
  href: string;
};

/**
 * Enough rows for a results page to read as an answer rather than a wall.
 * Larger than the partner picker's 8: this is a full page with room to
 * scroll, not a list squeezed above a form, and the acceptance criteria ask
 * for a *search*, which implies seeing enough of the tail to judge whether
 * to narrow the query further. 20 is generously more than the picker's
 * budget while still being a page a reader can scan in one sitting.
 */
const DEFAULT_LIMIT = 20;

/**
 * The collator ties break on, built once — the same reasoning as
 * `lib/page-index.ts`'s own: `Intl.Collator` is the Unicode collation
 * algorithm pinned to one locale by the application, rather than the host's
 * default, so a tie between two results orders the same way on a laptop and
 * in a serverless function. Constructing a collator is the expensive part;
 * comparing with it is not.
 */
const collator = new Intl.Collator("en");

/**
 * How well one term matches one word of a name is worth trying only once the
 * word is long enough that a false match is implausible. A two-letter term
 * has a phonetic key that is nearly meaningless (most short names collapse
 * onto a handful of keys), and a one-letter edit-distance check would count
 * almost any word as "one edit away". These thresholds are what keep a
 * one- or two-letter term from dragging in the whole tree under the guise of
 * spelling tolerance — short terms still get every literal tier, which is
 * plenty for "who begins with 'A'".
 */
const MIN_PHONETIC_TERM_LENGTH = 3;
const MIN_EDIT_TERM_LENGTH = 4;

/**
 * How well one person answers one term, across every tier this module knows:
 * the three literal tiers (0–2, from `literalTermRank`), a phonetic match
 * against a whole word of the name (3), or a one-edit match against a whole
 * word of the name (4). Lower is better; `null` is no match at all.
 *
 * The literal tiers are tried first and returned immediately when they hit,
 * because they are always the better answer — a term that is literally
 * present in the name should never be outranked by a spelling variant of it.
 * Only when nothing literal matches does the function reach for the fuzzy
 * tiers, phonetic before edit-distance, because phonetic tolerance is the
 * more targeted of the two: it is validated against real transcription
 * variants, where a bare edit distance would as happily match an unrelated
 * name that is one letter away by coincidence.
 */
function termRank(
  haystacks: readonly string[],
  words: readonly string[],
  term: string,
): number | null {
  const literal = literalTermRank(haystacks, term);
  if (literal !== null) return literal;

  if (term.length >= MIN_PHONETIC_TERM_LENGTH) {
    const termKey = nameKey(term);
    if (termKey && words.some((word) => nameKey(word) === termKey)) return 3;
  }

  if (term.length >= MIN_EDIT_TERM_LENGTH) {
    if (words.some((word) => withinOneEdit(term, word))) return 4;
  }

  return null;
}

/**
 * Search for people by name (E8-T2, `YEO-56`).
 *
 * An empty query returns `[]`, not the first `limit` rows the way
 * `searchPartners` does for the same input. The picker's empty answer is
 * right for a picker that opens as an empty list waiting to be narrowed —
 * something has to be there to click. `/search` opens with no query at all,
 * and the honest state for that is an invitation to type a name, not an
 * arbitrary slice of the family rendered as though it were an answer to a
 * question nobody asked. The route (`app/search/page.tsx`) is what turns
 * this empty array into that invitation.
 *
 * @param rows every candidate row, in any order — `lib/people.ts` supplies
 *   them ordered by surname then given name, but nothing here depends on
 *   that
 * @param query what the author typed
 * @param options `limit`, defaulting to `DEFAULT_LIMIT`
 * @returns the best matches, best first, at most `limit` of them
 */
export function searchPeople(
  rows: readonly PersonSearchRow[],
  query: string,
  options: { limit?: number } = {},
): PersonMatch[] {
  const { limit = DEFAULT_LIMIT } = options;

  const terms = foldName(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: { match: PersonMatch; rank: number; sortName: string }[] = [];

  for (const row of rows) {
    const name = formatPersonName(row.givenName, row.surname);
    const foldedName = foldName(name);

    // The literal haystacks: the full name, and the surname on its own so
    // that a surname-only query ranks as a tier-0 prefix rather than a
    // tier-1 "later word" match — the same reason `searchPartners` searches
    // the surname twice over.
    const haystacks = [foldedName, foldName(row.surname ?? "")].filter(Boolean);

    // Every whole word of the name, for the two fuzzy tiers: a phonetic or
    // edit-distance match has to be against something somebody would call a
    // "name", not against an arbitrary substring.
    const words = foldedName.split(/\s+/).filter(Boolean);

    // Every term has to match something, in any order — "hale ros" and
    // "ros hale" are the same question, and a term matching nobody means the
    // author was describing somebody else.
    let rank = 0;
    let matched = true;
    for (const term of terms) {
      const termScore = termRank(haystacks, words, term);
      if (termScore === null) {
        matched = false;
        break;
      }
      rank += termScore;
    }
    if (!matched) continue;

    scored.push({
      match: {
        id: row.id,
        name,
        lifespan: formatLifespan(row),
        href: treeHref(row.id),
      },
      rank,
      sortName: foldedName,
    });
  }

  /**
   * Rank first, then name, then id — three comparisons in sequence rather
   * than one over a single concatenated key, and the third is the one that
   * has to be there.
   *
   * `searchPartners` ties break on a `name`-NUL-`id` key, reasoning that a
   * space is a character a name can contain and so cannot safely separate
   * the two halves. That is right about the space and wrong about the
   * remedy, because the function at the other end is a *collator*:
   * `Intl.Collator` gives NUL no primary weight at all, so `compare` of
   * "mary" + NUL + "a" against "marya" is `0`, and the separator chosen to
   * keep the halves apart is invisible to the only code that ever reads it.
   * Comparing the two fields one after the other needs no separator, so
   * there is nothing left to be invisible — and the id comparison is a plain
   * code-unit one, because an id is an opaque uuid rather than language and
   * there is nothing for a collator to know about it.
   *
   * Without the id step the order would only be *stable* — a property of
   * this array, since JavaScript's sort is, rather than of the answer. Two
   * people of the same name at the same rank would then order by however
   * Postgres happened to hand them back. With it the order is total, and the
   * same query returns the same page every time.
   */
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;

    const byName = collator.compare(a.sortName, b.sortName);
    if (byName !== 0) return byName;

    if (a.match.id === b.match.id) return 0;
    return a.match.id < b.match.id ? -1 : 1;
  });

  return scored.slice(0, limit).map((entry) => entry.match);
}
