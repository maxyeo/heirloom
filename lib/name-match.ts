/**
 * The name-matching primitives shared by every search over people (E8-T2,
 * `YEO-56`), and by the partner picker before it (E3-T4, `YEO-32`).
 *
 * ## Why this module exists, and why it did not always
 *
 * `lib/partner-search.ts` invented accent folding and the three-tier literal
 * ranking for the tree's own picker, and until this ticket both were private
 * to that file. E8-T2 needs the same two things for a second surface — the
 * `/search` route — plus a third the picker never needed: tolerance for a
 * name that is not merely accented differently but *spelled* differently,
 * because a full-page search is where an author goes to find "Katharine" when
 * the record was transcribed as "Catherine". Duplicating `fold` and
 * `termRank` into a second file would have left two descriptions of the same
 * accent-folding rule to keep in sync; moving them here and having
 * `lib/partner-search.ts` import them back leaves exactly one.
 *
 * `lib/partner-search.ts`'s ranking is unchanged by the move — it calls
 * `foldName` and `literalTermRank` where it used to call its own private
 * `fold` and `termRank`, and asserts nothing new. `lib/partner-search.test.ts`
 * and `components/PartnerPicker.test.tsx` pass against this module without
 * being told it exists.
 *
 * ## Why it is a plain module with no imports
 *
 * `npm test` — what CI runs — has no `DATABASE_URL` (docs/testing.md), and
 * this module is reached from both a Client Component (`PartnerPicker`) and a
 * database-backed one (`lib/people.ts`, by way of `lib/people-search.ts`). It
 * stays importable from either side of that line by importing nothing itself.
 *
 * ## Two kinds of tolerance, and why both are needed
 *
 * `nameKey` catches names that were always going to be spelled two different
 * ways — "Catherine" and "Katharine" are not a typo of one another, they are
 * two transcriptions of one sound. `withinOneEdit` catches the other kind: a
 * single slipped, doubled, dropped or swapped letter, which is a typo rather
 * than a variant, and which a phonetic key can miss precisely because it does
 * not change how the name sounds enough to fold the same way. The worked case
 * for the second is "Rosalind" against "Rosaline": `nameKey` reduces them to
 * `rslnd` and `rsln` — different, because the substituted letter (`d` for
 * `e`) survives the vowel-dropping step on one side and not the other — while
 * `withinOneEdit` sees them for what they are, one substitution apart.
 */

/**
 * Strip accents and case so that "jose" finds "José".
 *
 * NFD splits an accented character into its base letter and a combining
 * mark; removing the marks leaves the base letters. The combining range is
 * written out as `\u0300-\u036f` rather than as `\p{Diacritic}` because
 * unicode property escapes need an ES2018 target and this project compiles
 * to ES2017.
 */
export function foldName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * How well one person answers one term by literal matching, lower being
 * better, `null` being not at all.
 *
 * Three tiers, and the order is what makes a list feel like it is answering
 * the question rather than filtering an array: a name that *starts* with what
 * was typed first, then a later word in the name that does, then anything
 * that merely contains it somewhere. Typing "ros" puts Rosalind above
 * Ambrose, because a name beginning with what you typed is what you meant.
 *
 * A given name and a surname are both tier 0 when either begins with the
 * term. That is deliberate: "hale" and "thomas" are equally good ways to ask
 * for Thomas Hale, and ranking one above the other would only be guessing at
 * which half of a name the author reached for.
 *
 * @param haystacks the folded text a person can be found by
 * @param term one folded search word
 * @returns 0, 1 or 2 (better to worse), or null when nothing matches
 */
export function literalTermRank(
  haystacks: readonly string[],
  term: string,
): number | null {
  let best: number | null = null;

  for (const hay of haystacks) {
    let rank: number | null = null;
    if (hay.startsWith(term)) rank = 0;
    else if (hay.includes(` ${term}`)) rank = 1;
    else if (hay.includes(term)) rank = 2;

    if (rank !== null && (best === null || rank < best)) best = rank;
  }

  return best;
}

/**
 * Leading letter clusters that are silent, or nearly, in English — spelled
 * with a consonant a reader never says. `knight`, `gnome`, `pneumonia` and
 * `wrist` all lose their first letter here so that a name beginning the same
 * way collapses onto the sound rather than the spelling.
 */
const SILENT_INITIAL_CLUSTER = /^(kn|gn|pn|wr)/;

/**
 * A rough phonetic key for one word of a name (E8-T2's spelling tolerance).
 *
 * This is deliberately a folk etymology of English spelling rather than a
 * real phonetic algorithm (Soundex, Metaphone, …): a handful of ordered
 * substitutions, applied to the whole word, are enough to fold the specific
 * kind of variation genealogical records actually show — "Catherine" against
 * "Katharine", "Elisabeth" against "Elizabeth", a `Smith` transcribed as
 * `Smyth`. A general-purpose phonetic library would do at least as well and
 * pull in a dependency this project does not otherwise need (AGENTS.md: no
 * new dependencies).
 *
 * The steps, applied in this order, because each is defined against what the
 * step before it already produced:
 *
 * 1. `foldName`, then strip everything outside `a`–`z`. This is what makes an
 *    apostrophe, a hyphen or a stray digit disappear rather than break every
 *    later step's assumption that it is looking at letters. Empty in, empty
 *    out — there is no key for a word with nothing left to key.
 * 2. Silent initial clusters lose their misleading first letter, and a
 *    leading `x` (the "Xavier" sound) becomes `s`.
 * 3. Digraphs are rewritten to the single consonant they sound like:
 *    `sch`→`sk`, `ph`→`f`, `th`→`t`, `ck`→`k`, `gh`→`g`. The order against
 *    step 4 is load-bearing rather than tidy: run step 4 first and every
 *    `c` would already be a `k`, so `sch` would have become `skh` and this
 *    rule would never fire at all. Each substitution here is written against
 *    the alphabet the substitution before it leaves behind, which is why
 *    this is an ordered list and not a map applied all at once.
 * 4. Individual letters that spell one of a small number of sounds two ways
 *    are folded onto one of them: `c`/`q`→`k` (the hard-c and q sound),
 *    `x`→`ks`, `z`→`s`, `j`→`g` (as in the "soft g" of *gem*), `y`→`i`.
 * 5. Runs of the same letter collapse to one, so a doubled consonant reads
 *    the same as a single one (`Ann`/`Anne`, `Phillip`/`Philip`).
 * 6. The first letter is kept as-is — it carries the most information about
 *    which name this is, and dropping it (the way Soundex does) would fold
 *    every name that merely *ends* the same way onto one key — and every
 *    `a e i o u h w` in the rest of the word is dropped, because English
 *    vowels (and the near-silent `h`/`w`) are exactly what varies most
 *    between two spellings of one name: "Sara"/"Sarah", "Johann"/"Johan".
 *
 * ## The trade this deliberately makes
 *
 * The key still over-collapses, even keeping the first letter fixed: "Rose"
 * and "Ross" both key to `rs`, "Hale" and "Hall" both key to `hl`, and "Mary"
 * and "Moore" both key to `mr`. Those are real, different names, folded onto
 * one key on purpose.
 *
 * That is acceptable, and only acceptable, because a phonetic match is never
 * the best a search can do for a term — `lib/people-search.ts` ranks it
 * strictly below every literal tier from `literalTermRank`. An exact "Rose"
 * still outranks a phonetic "Ross", so the collision costs an extra row
 * further down the list, never a right answer bumped out by a wrong one. A
 * *stricter* key that never collided would also, somewhere, fail to catch a
 * real variant — the two failure modes trade off, and this module is built to
 * fail on the side a ranked list can absorb for free.
 *
 * @param word one word — a whole given name, or a whole surname
 * @returns the phonetic key, or `""` for a word with no letters in it
 */
export function nameKey(word: string): string {
  let s = foldName(word).replace(/[^a-z]/g, "");
  if (s === "") return "";

  s = s.replace(SILENT_INITIAL_CLUSTER, (cluster) => cluster.slice(1));
  s = s.replace(/^x/, "s");

  s = s.replace(/sch/g, "sk");
  s = s.replace(/ph/g, "f");
  s = s.replace(/th/g, "t");
  s = s.replace(/ck/g, "k");
  s = s.replace(/gh/g, "g");

  s = s
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/j/g, "g")
    .replace(/y/g, "i");

  s = s.replace(/(.)\1+/g, "$1");

  const first = s[0];
  const rest = s.slice(1).replace(/[aeiouhw]/g, "");
  return first + rest;
}

/**
 * Whether `a` and `b` are the same word, or one bounded edit apart —
 * a substitution, an insertion, a deletion, or one transposition of two
 * adjacent letters, each counted as a single edit.
 *
 * This is the net `nameKey` cannot catch: a genuine typo rather than a
 * spelling tradition, such as "Rosalind" against "Rosaline" (`rslnd` against
 * `rsln` — different keys, because the substituted letter survives the
 * vowel-dropping step on one side of the pair and not the other).
 *
 * Bounded to distance 1 rather than computing the real Damerau–Levenshtein
 * distance, because distance 1 is the question this module needs answered
 * and a full dynamic-programming table is work spent computing numbers
 * nobody reads: `lib/people-search.ts` only ever asks "is this within one
 * edit", never "how many edits".
 *
 * The length check is an early bail rather than an optimisation that could be
 * skipped: two words more than one character apart in length cannot be one
 * edit apart under any of the four operations above, so there is no case left
 * to check.
 *
 * @param a one folded word
 * @param b another folded word
 * @returns whether they are equal or one edit apart
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;

  const lengthDiff = a.length - b.length;
  if (lengthDiff < -1 || lengthDiff > 1) return false;

  if (lengthDiff === 0) {
    // Equal length: the only edits that keep it equal are a substitution or
    // a transposition of two adjacent letters. Find every position that
    // differs; more than two rules both out.
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs.push(i);
      if (diffs.length > 2) return false;
    }
    if (diffs.length === 1) return true; // one substitution
    if (diffs.length === 2) {
      const [i, j] = diffs;
      // A transposition, not two independent substitutions: the two mismatched
      // positions are adjacent and each holds the other's letter.
      return j === i + 1 && a[i] === b[j] && a[j] === b[i];
    }
    return false;
  }

  // Lengths differ by exactly one: walk both words together, and the first
  // time they disagree, advance only the longer one — that is what an
  // insertion (or, read the other way, a deletion) does to the alignment. A
  // second disagreement after that means more than one edit separates them.
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;

  let i = 0;
  let j = 0;
  let mismatches = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      mismatches++;
      if (mismatches > 1) return false;
      j++;
    }
  }
  return true;
}
