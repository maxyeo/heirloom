import { collapseWhitespace, decodeHtmlEscapes } from "@/lib/html-text";
import { entryPath } from "@/lib/wiki-paths";

/**
 * Turning Postgres's answer to a full-text search over entries (E8-T1,
 * `YEO-55`) into something a component can render, as a plain function over
 * plain values.
 *
 * ## Why this is a module and not four lines in `lib/pages.ts`
 *
 * The same split `lib/people-search.ts` and `lib/people.ts` make for the
 * sibling half of this feature, for the same reason: `npm test` — what CI
 * runs — has no `DATABASE_URL` (docs/testing.md), so anything that lives in
 * the module holding `db.select()` is unassertable there. `lib/pages.ts`'s
 * `searchEntries` is the query; this is everything about the shape of the
 * result, and `lib/entry-search.test.ts` asserts it against literals with no
 * Postgres in the import graph.
 *
 * The division is not the same one, though, and the difference is the point
 * of the ticket. People search ranks in TypeScript because spelling tolerance
 * is not a predicate a B-tree can answer. Entry search ranks in *Postgres*,
 * because a `tsvector` and a GIN index are exactly the thing Postgres is for
 * — see `db/schema.ts`'s `pages.search_vector`. So what is left here is
 * narrower than `searchPeople`: no ranking, no matching, only the reading of
 * a `ts_headline` string.
 *
 * ## No search service
 *
 * The acceptance criterion says it outright, and it is worth writing down
 * where somebody would look for the seam: there is no Elasticsearch, no
 * Meilisearch, no Algolia, no embedding index, and no second store to keep in
 * step with `pages`. A few hundred entries against a GIN index is one query,
 * and the vector is a generated column, so there is no sync job that can lag
 * and no reindex that can be forgotten. What would change the answer is a
 * corpus where ranking quality — synonyms, typo tolerance, per-reader
 * relevance — became the product; at that point the honest move is a search
 * engine, not a longer `ORDER BY`.
 */

/**
 * How many entries a results page shows.
 *
 * The same 20 `lib/people-search.ts` chose, and deliberately the same number:
 * E8-T3 puts these two lists on one page under two headings, and two groups
 * that quietly disagreed about how deep a result set goes would read as a
 * defect in whichever one came up shorter.
 */
export const DEFAULT_LIMIT = 20;

/**
 * The markers `ts_headline` wraps a matched term in, and which
 * `parseSnippet` reads back out.
 *
 * `<mark>` and `</mark>` are Postgres's `StartSel`/`StopSel` defaults in
 * spirit — the defaults are `<b>`/`</b>` — and they name what the segments
 * become in `components/EntrySearchResults.tsx`. What matters is that they
 * cannot collide with the entry's own text, and that is provable rather than
 * assumed, in two steps:
 *
 * 1. **No tag survives.** `ts_headline` runs the same parser `to_tsvector`
 *    does, which classifies `<p>`, `<em>` and `<a href="…">` as tags; the
 *    text it reassembles is the words between them. A real `<mark>` in the
 *    body — which `lib/sanitize-html.ts` does not even allow — would be
 *    stripped like any other tag.
 * 2. **No `<` survives either.** A `<` an author actually typed is stored as
 *    `&lt;`, because `sanitizeHtml` escapes it (see `decodeHtmlEscapes` in
 *    `lib/html-text.ts`, whose whole argument is that `&amp;`, `&lt;`, `&gt;`
 *    and `&quot;` are the only escapes that can still be in a stored body).
 *
 * So a `<` in a headline came from a marker. `parseSnippet` splits on the
 * markers *before* decoding those escapes, which keeps step 2 true no matter
 * what the prose says: an author who writes about `<mark>` tags has that
 * stored as `&lt;mark&gt;` and gets it back as text, not as a highlight.
 */
export const SNIPPET_START = "<mark>";
export const SNIPPET_STOP = "</mark>";

/**
 * What `ts_headline` is asked for, as its options string.
 *
 * Kept here rather than in `lib/pages.ts` so that the markers and the code
 * that parses them are one edit apart, and so the numbers are visible to a
 * test rather than buried in a query.
 *
 * - `MaxFragments=2` with a delimiter is what makes this a *snippet* rather
 *   than a prefix: two windows around two different occurrences, joined by an
 *   ellipsis, instead of one window around the first. That is the acceptance
 *   criterion — the matched term shown in context — for an entry that
 *   mentions the term in two places.
 * - `MinWords=12`/`MaxWords=28` is roughly a line and a half at this page's
 *   measure. Enough context to recognise the sentence; short enough that a
 *   list of twenty results is still a list.
 * - `ShortWord=0` turns off the rule that trims fragments starting or ending
 *   in a word of three characters or fewer. On English prose that rule mostly
 *   removes a leading "the" or a trailing "of", which makes the snippet read
 *   as though it had been mistyped rather than trimmed.
 *
 * When nothing in the *body* matches — the term was only in the title —
 * `ts_headline` returns the opening of the body with nothing marked, which is
 * the right answer: the reader still gets to see what the entry is about.
 */
export const SNIPPET_OPTIONS = [
  `StartSel=${SNIPPET_START}`,
  `StopSel=${SNIPPET_STOP}`,
  "MaxWords=28",
  "MinWords=12",
  "MaxFragments=2",
  "FragmentDelimiter= … ",
  "ShortWord=0",
].join(", ");

/**
 * One run of snippet text, and whether Postgres matched the query to it.
 *
 * Segments rather than a string of HTML, because the alternative is React's
 * raw-markup escape hatch over a value assembled from entry content — and the
 * value would be safe (see `SNIPPET_START`), which is precisely the kind of
 * safety that is one refactor away from not being. A `<mark>` React renders
 * from a boolean cannot be anything but a `<mark>`, and the tripwire in
 * `lib/sanitize-html.call-sites.test.ts` never has to hear about this file.
 */
export type SnippetSegment = {
  text: string;
  matched: boolean;
};

/**
 * A row as `lib/pages.ts`'s `searchEntries` selects it: the entry's identity,
 * and the headline Postgres built.
 *
 * Spelled out rather than inferred, for the reason `WikiEntry` in
 * `lib/pages.ts` gives for itself — widening the query and widening the type
 * are then the same edit. `bodyHtml` is deliberately *not* here: the whole
 * point of asking Postgres for a headline is that a search over a few hundred
 * entries does not have to ship a few hundred entry bodies to the application
 * to excerpt them.
 */
export type EntrySearchRow = {
  id: string;
  slug: string;
  title: string;
  snippet: string;
};

/**
 * One search result: enough to display it and to follow it.
 *
 * Mirrors `PersonMatch` in `lib/people-search.ts` field for field where the
 * two overlap — `id`, `href`, and one primary label — because E8-T3 renders
 * them side by side under two headings. `snippet` is what an entry has that a
 * person does not: a person is found *by* their name and shown their
 * lifespan, an entry is found by its prose and has to show the reader which
 * prose.
 */
export type EntryMatch = {
  id: string;
  slug: string;
  title: string;
  href: string;
  snippet: SnippetSegment[];
};

/**
 * Read a `ts_headline` string back as marked and unmarked runs.
 *
 * Three things happen to each run, in an order that matters:
 *
 * 1. **Split on the markers first.** See `SNIPPET_START` — before the escapes
 *    are decoded, the only `<` in the string is a marker, so the split cannot
 *    be fooled by prose about markup.
 * 2. **Decode the escapes**, so `&amp;` reads as `&`. `decodeHtmlEscapes` is
 *    the same decoder `lib/content-diff.ts` and `lib/red-links.ts` use, and
 *    the reason it covers only four escapes is written down there.
 * 3. **Collapse whitespace**, because `ts_headline` leaves a gap where each
 *    tag it dropped used to be — `<p>one</p><p>two</p>` comes back as
 *    `" one  two "`. `collapseWhitespace` trims, which is why it is applied
 *    to the whole string ahead of the split rather than to each run: trimming
 *    each run separately would weld `"two "`, `"fox"` and `" three"` into
 *    `"twofoxthree"`.
 *
 * Total by construction. An unterminated `<mark>` — which Postgres does not
 * produce, but which a truncated string would — ends the marked run at the
 * end of the snippet rather than throwing, and an empty snippet (an entry
 * whose body is still empty, which is every entry the moment it is created)
 * returns `[]` rather than one blank segment for a component to have to
 * special-case.
 *
 * @param headline `ts_headline`'s output, built with `SNIPPET_OPTIONS`
 * @returns the runs in order, each flagged as matched or not; never contains
 *   an empty run
 */
export function parseSnippet(headline: string): SnippetSegment[] {
  const collapsed = collapseWhitespace(headline);
  if (collapsed === "") return [];

  const segments: SnippetSegment[] = [];

  /** Where the run that is currently being read starts. */
  let cursor = 0;
  /** Whether that run sits inside a `<mark>`. */
  let matched = false;

  const push = (text: string) => {
    const decoded = decodeHtmlEscapes(text);
    if (decoded !== "") segments.push({ text: decoded, matched });
  };

  while (cursor < collapsed.length) {
    const marker = matched ? SNIPPET_STOP : SNIPPET_START;
    const at = collapsed.indexOf(marker, cursor);

    if (at === -1) {
      push(collapsed.slice(cursor));
      break;
    }

    push(collapsed.slice(cursor, at));
    cursor = at + marker.length;
    matched = !matched;
  }

  return segments;
}

/**
 * Turn the selected rows into results.
 *
 * The order is Postgres's, untouched: `searchEntries` asks for it by
 * `ts_rank` and this must not quietly re-sort what the database ranked. That
 * is the opposite of `searchPeople`, which does all of its ranking here — and
 * the difference is the ticket. See this module's own docblock.
 *
 * @param rows the rows `lib/pages.ts` selected, best first
 * @returns the same rows, in the same order, ready to render
 */
export function toEntryMatches(rows: readonly EntrySearchRow[]): EntryMatch[] {
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    href: entryPath(row.slug),
    snippet: parseSnippet(row.snippet),
  }));
}
