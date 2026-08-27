import { compareIds } from "./compare-ids";
import type { GraphPerson } from "./family-graph";
import { formatLifespan } from "./format-date";
import { foldName, literalTermRank } from "./name-match";
import { formatPersonName } from "./person-format";

/**
 * Finding somebody who is already on the tree (E3-T4, `YEO-32`).
 *
 * ## Why this is a plain function over a plain value
 *
 * The whole family graph is already in the browser — it has to be, because the
 * layout is computed client-side (docs/architecture.md) — and a family tree is
 * hundreds of people at most. So searching it is a filter over an array, not a
 * request. No endpoint, no debounce against a network, nothing to keep in sync
 * with the canvas the author is looking at.
 *
 * It lives in `lib/` rather than inside the picker component for the reason
 * docs/testing.md gives as the house rule: what looks like component behaviour
 * is usually a decision that can be moved into a module and checked in Node.
 * "Does typing `hal` find Thomas Hale, and does it rank him above Rosalind" is
 * exactly that kind of decision, and asserting it against a literal beats
 * mounting an input and reading the DOM back.
 *
 * ## Why matching is not just `includes`
 *
 * Two properties a family tree needs that a substring test does not give:
 *
 * - **Accents are not a spelling.** A tree with José and Jose in it should find
 *   both from either query. Genealogical sources disagree about diacritics
 *   constantly — a name is transcribed off a headstone, a census, an emigration
 *   record — and an author who types the plain letters should not be told
 *   nobody is there.
 * - **Terms are independent.** "hale 1899" and "1899 hale" are the same
 *   question. Requiring every term to match *something* about the person, in
 *   any order, is what makes a year usable as a disambiguator between two
 *   people with the same name — which is the case the picker exists to get
 *   right, since choosing the wrong Thomas silently marries the wrong couple.
 *
 * Accent folding and the three-tier ranking below moved to
 * `lib/name-match.ts` for E8-T2 (`YEO-56`), which needed both again for
 * `/search` and had a third kind of tolerance to add beside them. This
 * module's own ranking is unchanged by that move — it calls `foldName` and
 * `literalTermRank` exactly where it used to call its own private `fold` and
 * `termRank`.
 */

/** A person as the picker offers them: enough to choose between two Thomases. */
export type PartnerCandidate = {
  id: string;
  name: string;
  /** Years only — `1899–1960`, `b. 1910`, or empty when nothing is recorded. */
  lifespan: string;
};

export type SearchPartnersOptions = {
  /**
   * People to leave out of the results entirely.
   *
   * The person gaining a spouse is the only id the add-spouse flow passes.
   * Their existing partners are deliberately *not* excluded: a couple who
   * divorced and remarried each other is a real record, and hiding the
   * previous spouse would make it unenterable.
   */
  excludeIds?: readonly string[];
  /** How many to return. A list longer than this is a query to narrow. */
  limit?: number;
};

/**
 * Enough rows to choose from, few enough to read without scrolling past the
 * form underneath. A query matching more than this is not yet a query.
 */
const DEFAULT_LIMIT = 8;

/**
 * Search the people already on the tree.
 *
 * An empty query is not an empty answer: it returns the first `limit` people
 * in name order, so the picker opens with something to click. On a tree of a
 * dozen that is often the whole answer, and on a large one it is a prompt to
 * type rather than a wall.
 *
 * @param people every person on the tree, as the canvas already holds them
 * @param query what the author typed, in whatever case and spacing they used
 * @returns the best matches, best first, at most `limit` of them
 */
export function searchPartners(
  people: readonly GraphPerson[],
  query: string,
  options: SearchPartnersOptions = {},
): PartnerCandidate[] {
  const { excludeIds = [], limit = DEFAULT_LIMIT } = options;
  const excluded = new Set(excludeIds);

  const terms = foldName(query).split(/\s+/).filter(Boolean);

  const scored: { candidate: PartnerCandidate; rank: number; sort: string }[] =
    [];

  for (const person of people) {
    if (excluded.has(person.id)) continue;

    const name = formatPersonName(person.givenName, person.surname);
    const lifespan = formatLifespan(person);

    /**
     * The searchable text, in the order the tiers should prefer. The full name
     * first, so that a prefix of it outranks a prefix of the surname alone;
     * the surname on its own, so that "hale" finds Thomas Hale at tier 0
     * rather than tier 1; and the two dates, so that a year can be typed
     * alongside a name to tell two people of that name apart.
     */
    const haystacks = [
      foldName(name),
      foldName(person.surname ?? ""),
      foldName(person.birthDate ?? ""),
      foldName(person.deathDate ?? ""),
    ].filter(Boolean);

    // Every term has to match something, in any order. One that matches
    // nothing means the author was describing somebody else.
    let rank = 0;
    let matched = true;
    for (const term of terms) {
      const termScore = literalTermRank(haystacks, term);
      if (termScore === null) {
        matched = false;
        break;
      }
      rank += termScore;
    }
    if (!matched) continue;

    scored.push({
      candidate: { id: person.id, name, lifespan },
      rank,
      /**
       * Ties break on name and then on id, so the list is stable rather
       * than dependent on the order the rows happened to arrive from
       * Postgres. `foldName` already lowercases and strips accents, so
       * comparing the folded name by code unit still lands in the order a
       * reader expects — the rank above is this list's real order, and the
       * name here is only breaking a tie underneath it, the one part of this
       * change whose output a reader does see.
       *
       * `\0` separates the two halves rather than a space, because a
       * space is a character a name can contain: "Mary Anne" + id would
       * otherwise sort against "Mary" + " Anne..." and the tie-break
       * would depend on the id of an unrelated person. Written as the
       * escape, never as a literal byte — a raw NUL makes git treat the
       * whole file as binary and `gh pr diff` refuse to show it.
       *
       * That separator used to be silently defeated (`YEO-116`): ICU treats
       * U+0000 as completely ignorable — `new Intl.Collator("en-US", {
       * sensitivity: "variant" }).compare("mary\0", "mary") === 0` — so under
       * `localeCompare` the two halves collated as if nothing sat between
       * them, exactly the ambiguity `\0` exists to rule out. `compareIds`
       * below compares code units, where `\0` (0x00) sorts below every
       * printable character and is a real, present character rather than one
       * ICU discards, so the separator now does the job it was written for.
       */
      sort: `${foldName(name)}\0${person.id}`,
    });
  }

  scored.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : compareIds(a.sort, b.sort),
  );

  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/**
 * Split what was typed into the search box into a first and last name.
 *
 * The picker's "add them as a new person" carries the query into the name
 * fields, and the query is almost always a name — so throwing it away and
 * presenting two empty inputs would make the author type it twice.
 *
 * The last word becomes the surname and everything before it the given names,
 * which is right for "Rose Hale" and for "Mary Anne Hale", and wrong for the
 * naming orders it is wrong for. That is acceptable *because it is a
 * prefill*: both fields are ordinary inputs sitting in front of the author,
 * already filled in, at the moment they are looking at them. A guess that is
 * visible and editable costs a correction; one that happens at save time
 * costs a wrong row.
 *
 * A single word is a given name, not a surname: `individuals.given_name` is
 * the required column and the one every label falls back to, so a lone
 * "Walter" belongs there.
 */
export function splitTypedName(query: string): {
  givenName: string;
  surname: string;
} {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { givenName: "", surname: "" };
  if (words.length === 1) return { givenName: words[0], surname: "" };

  return {
    givenName: words.slice(0, -1).join(" "),
    surname: words[words.length - 1],
  };
}
