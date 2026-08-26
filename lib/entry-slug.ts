/**
 * How an entry's title becomes the address it lives at (E1-T8, `YEO-22`).
 *
 * ## Why the author never sees any of this
 *
 * The ticket is explicit: "slug" is not a word the author should ever
 * encounter. They type a title and get an entry. Everything in this file
 * therefore has to succeed on whatever they typed — there is no error to show
 * them and no field for them to fix, because the field does not exist. That
 * constraint is what shapes the two exports: `slugFromTitle` always returns
 * something usable, and `slugCandidate` can always produce another address
 * when the obvious one is taken.
 *
 * ## Why the slug is not ASCII
 *
 * The obvious implementation strips everything outside `[a-z0-9-]`, and it
 * turns 日本語 into an empty string. A family wiki is exactly the place where
 * that is not a corner case: the names in it are the names of a family, and
 * some families do not write theirs in the Latin alphabet. Wikipedia keeps
 * non-Latin titles in the URL (`/wiki/北京` is a real address), browsers show
 * them decoded in the address bar, and Next decodes the `[slug]` segment
 * before it reaches `getPageBySlug`, so an exact match against the stored
 * text keeps working with no encoding step anywhere.
 *
 * So the rule is "keep every Unicode letter and digit", not "keep ASCII".
 * Accent folding below is a separate, narrower decision.
 */

/**
 * The address used when a title contains no letters or digits at all — an
 * emoji, a row of punctuation, "…".
 *
 * Such a title is still a title, so it must still produce an entry; it just
 * cannot produce a *descriptive* address. Collision handling then does the
 * rest, so a second one becomes `entry-2` rather than failing.
 */
export const FALLBACK_SLUG = "entry";

/**
 * Slugs a page may not have, because a static route already answers there.
 *
 * `/wiki/new` is this ticket's own create form, and Next resolves a static
 * segment before the dynamic `[slug]` one — so an entry titled "New" would
 * take an address that renders the create form instead of the entry, and its
 * author would have no way to tell. Treating the name as already taken costs
 * one entry the suffix `-2` and removes the failure mode entirely.
 *
 * `lib/entry-slug.test.ts` checks this set against the directories actually
 * present under `app/wiki`, so a static route added later cannot quietly
 * start shadowing entries.
 *
 * `category` is E11-T8's (`YEO-78`): `/wiki/category` lists every category and
 * `/wiki/category/[slug]` lists what is filed under one. Being in this set
 * buys a second thing there, worth knowing before anyone considers removing
 * it — `lib/article-tabs.ts` reads a reserved first segment as "this is not an
 * entry", so this is also what stops the shell rendering an *Article / Edit /
 * View history* row above a category listing, two of whose three tabs would
 * point at addresses that do not exist.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["new", "category"]);

/**
 * How long a base slug may be, in code points rather than UTF-16 units, so
 * the limit means the same thing for every script.
 *
 * Long enough for a full name with dates, short enough that the address stays
 * something a person can read out. A disambiguating suffix is added after
 * this, so the cap is not a hard limit on the final slug.
 */
export const MAX_SLUG_LENGTH = 80;

/**
 * How many numbered candidates are offered before falling back to a random
 * one. See `slugCandidate`.
 */
export const NUMBERED_CANDIDATES = 20;

/**
 * Apostrophes, in the forms a word processor and a phone keyboard produce.
 *
 * They are removed rather than treated as punctuation, which is the one
 * decision here that a reader might not expect: `O'Brien` becomes `obrien`,
 * not `o-brien`. An apostrophe inside a name is a spelling mark, not a word
 * boundary — nobody says "o brien" — and the hyphenated form reads as two
 * names. Same argument for `L'Estrange`, `d'Arcy` and `Ma'ayan`.
 */
const APOSTROPHES = /['‘’ʼʹ՚＇]/gu;

/** Any run of characters that is neither a letter nor a digit. */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * Strip the accent from an accented Latin letter, and only from those.
 *
 * NFD splits `é` into `e` + a combining acute, which is what makes accent
 * folding a two-line operation. Applying it indiscriminately would also fold
 * marks that are not accents on a Latin letter, and in some scripts that
 * changes the word: Cyrillic `ё` decomposes to `е` + diaeresis but is a
 * distinct letter, and Greek and Vietnamese carry tone marks that are part of
 * the spelling. The lookbehind restricts folding to marks sitting on an
 * unaccented ASCII letter, so `Émile` becomes `emile` while `Пётр` and
 * `Ελληνικά` keep their spelling; NFC afterwards recomposes everything that
 * was left alone.
 *
 * `NFD` rather than `NFKD` deliberately: compatibility decomposition also
 * rewrites ligatures, fullwidth forms and CJK compatibility ideographs, which
 * is a much larger promise than "handles accents" and one this has no reason
 * to make.
 */
function foldLatinAccents(title: string): string {
  return title
    .normalize("NFD")
    .replace(/(?<=[A-Za-z])\p{M}+/gu, "")
    .normalize("NFC");
}

function trimSeparators(slug: string): string {
  return slug.replace(/^-+|-+$/g, "");
}

/**
 * Cut an over-long slug back to `MAX_SLUG_LENGTH`, at a word boundary where
 * there is one to cut at.
 *
 * Slicing by code point rather than by index, so the cut cannot land in the
 * middle of a surrogate pair and leave half a character in the URL. Cutting
 * back to the last `-` avoids ending on a fragment of a word; a slug with no
 * `-` in it at all (one very long word, or a CJK title, which has no spaces
 * to become hyphens) has no boundary to find and is cut where the cap falls.
 */
function truncate(slug: string): string {
  const points = [...slug];
  if (points.length <= MAX_SLUG_LENGTH) return slug;

  const cut = points.slice(0, MAX_SLUG_LENGTH).join("");
  // The cap landing exactly on a separator is already a clean break.
  if (points[MAX_SLUG_LENGTH] === "-") return trimSeparators(cut);

  const boundary = cut.lastIndexOf("-");
  const shortened = boundary === -1 ? cut : cut.slice(0, boundary);
  return trimSeparators(shortened) || trimSeparators(cut);
}

/**
 * Derive the address for an entry from its title.
 *
 * Total: every string maps to a non-empty slug, because there is no UI in
 * which to report a failure. Deterministic: the same title always gives the
 * same base, so two entries with the same name collide and get disambiguated
 * rather than silently landing on different addresses.
 *
 * @param title the title as typed, trimmed or not
 * @returns a slug of Unicode letters, digits and hyphens, never empty
 */
export function slugFromTitle(title: string): string {
  const folded = foldLatinAccents(title);
  const words = folded.replace(APOSTROPHES, "").toLowerCase();
  const hyphenated = trimSeparators(words.replace(SEPARATORS, "-"));

  return truncate(hyphenated) || FALLBACK_SLUG;
}

/**
 * A random tail for the case where the numbered candidates run out.
 *
 * Base 36 of a slice of a UUID: short, URL-safe, and enough entropy that it
 * ends the loop in practice on the first try.
 */
function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 6);
}

/**
 * The nth address to try for a base slug.
 *
 * Attempt 0 is the base itself, then `-2`, `-3`, and so on. The numbering
 * starts at 2 because that is how a person counts a second thing with the
 * same name, and because `rose-hall-1` implies a `rose-hall-0` that does not
 * exist.
 *
 * Past `NUMBERED_CANDIDATES` the suffix becomes random instead of continuing
 * to count. Twenty entries sharing one title is already beyond anything real,
 * and the alternative — counting on forever — turns a pathological case into
 * an unbounded number of round trips to Postgres. A random tail ends it in
 * one, and this path exists only so that creation never has to fail in front
 * of an author who was given no way to influence the address.
 *
 * @param base the slug derived from the title
 * @param attempt zero-based; how many addresses have already been rejected
 * @param entropy overridable only so the fallback is testable
 */
export function slugCandidate(
  base: string,
  attempt: number,
  entropy: () => string = randomToken,
): string {
  if (attempt <= 0) return base;
  if (attempt < NUMBERED_CANDIDATES) return `${base}-${attempt + 1}`;
  return `${base}-${entropy()}`;
}
