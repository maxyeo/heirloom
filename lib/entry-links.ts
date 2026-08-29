import { compareEntriesByTitle, type TitledEntry } from "@/lib/page-index";
import { ENTRY_PATH_PREFIX, entryPath } from "@/lib/wiki-paths";

/**
 * Linking one entry to another (E2-T5, `YEO-28`) — the address arithmetic and
 * the title search, as plain functions over plain values.
 *
 * ## Why a picker and not a syntax
 *
 * The obvious way to link entries in a wiki is `[[double brackets]]`, and the
 * ticket rules it out in as many words. docs/product.md is why: the author is
 * not a developer, and No-Markdown is not a preference about asterisks — it is
 * the rule that nothing they type is secretly a command.
 * `lib/editor-extensions.ts` already switches off every input rule for that
 * reason, and adding a wiki-link rule back would reintroduce the exact
 * surprise those `false`s exist to prevent. So this is a picker: the author
 * presses Link and chooses an entry from a list of entries.
 *
 * ## Why it lives in `lib/`
 *
 * Same reason as `lib/page-index.ts` and `lib/partner-search.ts`: the
 * decisions here — what an internal address looks like, which entries a query
 * finds and in what order — are the whole of the feature's behaviour, and in
 * this shape `npm test` can check them with no database and no document. The
 * panel in `components/EntryEditor.tsx` renders what this file decides.
 *
 * Nothing here imports `@/db`. `TitledEntry` is `lib/page-index.ts`'s
 * structural `{ title, slug }` rather than `WikiEntrySummary`, which is what
 * keeps `@/lib/pages` — and postgres.js behind it — out of the import graph of
 * a suite CI runs with no `DATABASE_URL` (docs/testing.md).
 */

/**
 * The address of an entry, as an `href` to put in the document.
 *
 * **Site-relative, and that is the acceptance criterion.** No origin, no
 * scheme, no host: `/wiki/rose-hall`, never `https://wiki.example/wiki/rose-hall`.
 * Bodies are stored HTML that outlives the domain they were written on, so an
 * absolute href is a link that breaks the day the wiki moves — and it would
 * break *silently*, still resolving, still blue, pointing at somebody else's
 * server.
 *
 * The encoding argument that used to be restated here now lives in
 * `lib/wiki-paths.ts`, which is where it is actually applied (`YEO-128`).
 *
 * Kept as a name of its own rather than replaced at its call sites by
 * `entryPath`, because it means something narrower: this is the address that
 * goes *into stored HTML*, and `entrySlugFromHref` below is the half that
 * reads it back out. The pair is the contract — a link the editor writes has
 * to be one the link panel can still recognise years later — and that is a
 * different promise from "the URL of a page", which is `entryPath`'s.
 *
 * @param slug the entry's `pages.slug`, as stored
 * @returns a site-relative href, e.g. `/wiki/rose-hall`
 */
export function entryHref(slug: string): string {
  return entryPath(slug);
}

/**
 * The reverse: which entry, if any, an `href` already in the document points
 * at.
 *
 * This is what lets the link panel reopen on an existing link and say *"this
 * links to Rose Hall"* rather than showing the author a URL — and, when the
 * slug matches no entry, what lets it say the entry is gone. It is also the
 * shape E11-T6 (`YEO-76`) resolves red links with: the sanitiser allows
 * exactly one attribute on `a`, and it is `href` (`lib/sanitize-html.ts`), so
 * no marker class or `data-` attribute can survive a save. The href *is* the
 * marker, and it has to be readable as one.
 *
 * Returns `null` for anything that is not one of this wiki's entry addresses,
 * which is the correct answer for an external link. Deliberately strict:
 *
 * - An absolute URL is external even when it names this host. `https://…/wiki/rose`
 *   is a link that leaves the site and comes back, and treating it as internal
 *   would mean rewriting an author's deliberate absolute link.
 * - A deeper path is a route, not an entry. `/wiki/rose/edit` and
 *   `/wiki/rose/history` are real pages, and neither is the entry itself.
 * - A malformed percent-escape decodes to nothing rather than throwing.
 *   `decodeURIComponent` raises `URIError` on a lone `%`, and a stray
 *   character in stored HTML should not take the editor down with it.
 *
 * A fragment or query is stripped before matching, so `/wiki/rose#early-life`
 * is a link to `rose`. Losing the fragment would make the panel report an
 * entry that "no longer exists" for a link that is perfectly fine.
 *
 * @param href the `href` as it appears on the `a`
 * @returns the entry's slug, decoded, or `null` if this is not an entry link
 */
export function entrySlugFromHref(href: string): string | null {
  if (!href.startsWith(ENTRY_PATH_PREFIX)) return null;

  // `//wiki/x` also starts with `/wiki/`… no — but `/wiki//x` does, and a
  // protocol-relative `//host/wiki/x` does not start with `/wiki/` at all, so
  // the prefix test above is already the whole of that check.
  const path = href.slice(ENTRY_PATH_PREFIX.length);

  // Everything from the first `#` or `?` belongs to the fragment or the query,
  // not to the address of the entry.
  const segment = path.split(/[#?]/, 1)[0];

  // One segment, and a non-empty one: `/wiki/` is the index and
  // `/wiki/rose/edit` is a different route.
  if (segment === "" || segment.includes("/")) return null;

  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** How many entries the picker offers at once. */
const DEFAULT_LIMIT = 8;

export type SearchEntriesOptions = {
  /** How many to return. A query matching more than this is one to narrow. */
  limit?: number;
};

/**
 * Strip accents and case so that "emile" finds "Émile Lefèvre".
 *
 * The same fold `lib/partner-search.ts` applies to names, and for the same
 * reason: a family wiki's titles are a family's names, transcribed off
 * headstones and census records that disagree about diacritics constantly. An
 * author who types the plain letters should not be told the entry is not
 * there.
 *
 * The combining range is written out as `\u0300-\u036f` rather than as
 * `\p{Diacritic}` because unicode property escapes need an ES2018 target and
 * this project compiles to ES2017.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * How well a title answers one term, lower being better, `null` being not at
 * all.
 *
 * Three tiers, which is what makes the list feel like it is answering the
 * question rather than filtering an array: a title that *starts* with what was
 * typed first, then one where a later word does, then anything that merely
 * contains it. Typing "ros" puts "Rose Hall" above "Ambrose Lane".
 */
function termRank(title: string, term: string): number | null {
  if (title.startsWith(term)) return 0;
  if (title.includes(` ${term}`)) return 1;
  if (title.includes(term)) return 2;
  return null;
}

/**
 * Find the entries a query is describing.
 *
 * ## Why this searches an array rather than the database
 *
 * The corpus is a family's entries — a few hundred at the outside, which is
 * the same judgement `listPages` makes when it reads the whole table without a
 * `LIMIT`. Titles for all of them are a few kilobytes, so the edit route hands
 * them to the editor as a prop and a keystroke costs one pass over an array.
 * No endpoint, no debounce against a network, nothing to keep in sync. That is
 * `lib/partner-search.ts`'s bargain too, and it is the same bargain: the list
 * cannot lag behind the typing, because there is nothing for it to wait for.
 *
 * ## The matching rules
 *
 * Terms are independent and unordered — "rose 1904" and "1904 rose" are the
 * same question — and every term has to match something, so adding a word
 * narrows rather than widens. An empty query is not an empty answer: it
 * returns the first `limit` entries in title order, so the picker opens with
 * something to click rather than a blank box.
 *
 * @param entries every entry that exists, in any order
 * @param query what the author typed, in whatever case and spacing they used
 * @returns the best matches, best first, at most `limit` of them
 */
export function searchEntries<T extends TitledEntry>(
  entries: readonly T[],
  query: string,
  options: SearchEntriesOptions = {},
): T[] {
  const { limit = DEFAULT_LIMIT } = options;
  const terms = fold(query).split(/\s+/).filter(Boolean);

  const scored: { entry: T; rank: number }[] = [];

  for (const entry of entries) {
    const title = fold(entry.title);

    let rank = 0;
    let matched = true;
    for (const term of terms) {
      const termScore = termRank(title, term);
      if (termScore === null) {
        matched = false;
        break;
      }
      rank += termScore;
    }
    if (!matched) continue;

    scored.push({ entry, rank });
  }

  /**
   * Ties break on the index's own ordering — `Intl.Collator` on the title,
   * then on the slug — rather than on the order the rows arrived in. Reusing
   * `compareEntriesByTitle` is deliberate: an author who has just read
   * `/wiki` should meet equally-good matches in the order that page put them
   * in, and two places deciding what "alphabetical" means is two places for
   * it to drift.
   */
  scored.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : compareEntriesByTitle(a.entry, b.entry),
  );

  return scored.slice(0, limit).map((scoredEntry) => scoredEntry.entry);
}
