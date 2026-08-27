/**
 * Two opaque strings, compared by code unit rather than by collation
 * (`YEO-111`, widened by `YEO-116`).
 *
 * ## What "reach for this" means
 *
 * The rule is not about the *type* of the two strings — it is about what
 * happens to the answer. If the order this produces is ever going to sit on
 * screen where a person reads it, this is the wrong function. If the order
 * only has to be *the same order twice* — because nothing renders it, or
 * because something else already decided the order a reader sees and this is
 * only breaking a tie underneath it — this is the right one. `YEO-111` used
 * it for the tab order's tie-break on a person id; by `YEO-116` the callers
 * include a union id, a GEDCOM tag path, a partner search's final id
 * tie-break and a storage key, and `YEO-121` added `/search`'s own final id
 * tie-break, which had been writing the same two lines out by hand since
 * before this module existed. All of them fit the same rule: the value is
 * *compared*, never *read* as sorted text — `lib/partner-search.ts`'s call
 * and `lib/people-search.ts`'s both sit underneath a collation comparison on
 * the folded name precisely because that name, unlike the id below it, is
 * read.
 *
 * ## Why not `localeCompare`
 *
 * `localeCompare`'s answer comes from the collation data the process happens
 * to hold, not from the two strings in front of it. It varies with `LANG`,
 * with a `full-icu` build versus a `small-icu` one, and with the ICU version a
 * Node upgrade brings in — none of which is a property of the values being
 * compared. Two ids that differ only in case are enough to show it:
 * `"Zeta" < "apple"` by code unit, while every ICU locale this repository
 * could run under puts `apple` first.
 *
 * Pinning a locale (`localeCompare("en", { sensitivity: "variant" })`) only
 * fixes the `LANG` half — the tailoring behind `en` is still ICU data that a
 * build can lack and a version can change. `<` compares UTF-16 code units and
 * is defined by the language rather than by the runtime's tables, so it gives
 * the same answer everywhere, forever. Passing `undefined` as the locale is
 * the trap in the middle: it reads the ambient locale, so it *looks* pinned
 * and is not.
 *
 * `lib/gedcom-export.ts` made this call first, for the same reason, and says
 * so in its own header and in `docs/gedcom.md`: "String comparison is by code
 * unit, not by locale." `YEO-111` brought the rule to the tab order; this
 * ticket brings it to every other place in the codebase that was breaking a
 * tie on a string nobody reads.
 *
 * ## Where `localeCompare` stays, and why that is not a contradiction
 *
 * Code-unit order is not human alphabetical order — it sorts every capital
 * ahead of every lowercase letter and puts `é` after `z` — so it is the wrong
 * comparator for anything a reader looks at *as sorted text*. Two comparisons
 * in this codebase are exactly that, and they keep `localeCompare`
 * deliberately:
 *
 * - `lib/parent-options.ts` sorts a family picker's labels — "Mary Ellis and
 *   Thomas Hale" above "Rose Hale and Walter Doyle" — so that the list reads
 *   the way a person scans a list, accented names included.
 * - `lib/person-detail.ts`'s `compareByBirth` sorts siblings by birth date
 *   first and, only when two share a date, by their *formatted name* — text
 *   built for a person to read, not an id.
 *
 * Both are choices about what a reader sees, made on strings that exist to be
 * read. Everything this function is used for exists to be compared, and nowhere
 * to be read — including the *id* half of `compareByBirth`'s own tie-break,
 * one step further down: two siblings sharing both a birth date and a
 * formatted name have nothing left to read, only an id order to be
 * consistent about.
 *
 * ## Never 0 for two different ids
 *
 * `Array.prototype.sort` has been stable since ES2019, so a comparator that
 * returns 0 falls back to input order — and every caller of this function is
 * using it precisely because it does not trust input order (an unordered
 * `SELECT`, a `Map`'s iteration order, the order sightings arrived in a file
 * walk). A tie that resolved to 0 would quietly reintroduce whichever of
 * those bugs the caller was written to escape. It cannot happen here: `<`/`>`
 * only tie on strings that are equal code unit for code unit, and every
 * caller's tie-break value is unique among the records it is comparing.
 * `localeCompare` had no such guarantee — collation ignores differences below
 * its sensitivity setting, so `"a"` and `"A"` compare equal under a
 * case-insensitive tailoring, and two genuinely distinct values would have
 * fallen through to whatever unordered source produced them.
 *
 * @param a one string
 * @param b another string
 * @returns negative if `a` sorts first, positive if `b` does, 0 only when the
 *   two strings are identical
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
