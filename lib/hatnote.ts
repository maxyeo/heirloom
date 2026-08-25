import { formatLifespan, type Lifespan } from "@/lib/format-date";
import {
  collapseWhitespace,
  decodeHtmlEscapes,
  HTML_TOKEN_PATTERN,
} from "@/lib/html-text";
import { formatPersonName } from "@/lib/person-format";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * The hatnote (E11-T9, `YEO-79`): the indented italic line above the lead
 * paragraph, which answers "am I reading about the right person" before the
 * reader has started reading.
 *
 * ## Two hatnotes, and how they compose
 *
 * An entry can have both, and when it does **both render, the author's first**:
 *
 * - The **manual** one is what the author wrote — editorial, and about this
 *   entry: *"This entry is about the house. For the ship, see …"*.
 * - The **automatic** one is a fact about the database — *"For other people
 *   named Rose Whitfield, see …"* — derived from `individuals` at render time
 *   and stored nowhere.
 *
 * Suppressing either for the other was the alternative and it is wrong in both
 * directions. Hiding the automatic note when an author has written one hides a
 * collision the author *cannot have known about*: the namesake may have been
 * added to the tree years later, by someone else, and the entry that needs the
 * warning is exactly the one nobody has revisited. Hiding the manual note when
 * a namesake exists throws away the sentence somebody deliberately wrote. They
 * say different things, so they are two lines.
 *
 * When the name-collision lookup returns nothing, there is no automatic note at
 * all — not an empty one, not a placeholder. When both are absent the entry
 * renders **no element**: see `components/ArticleHatnote.tsx`, and the
 * assertion in its test, because an empty wrapper above the lead is precisely
 * the kind of thing that regresses without anybody noticing.
 *
 * ## Why this module is pure
 *
 * It imports `sanitize-html` the package and nothing with a runtime
 * environment, so `npm test` — which CI runs with no `DATABASE_URL`
 * (docs/testing.md) — can check every decision here directly. The reads that
 * find a namesake live in `lib/namesakes.ts`, on the other side of that line.
 */

/**
 * The class Vector 2022 gives a hatnote, and the selector `app/globals.css`
 * paints indented and italic. MediaWiki's own name, kept for the reason
 * docs/product.md gives for borrowing the whole skin: a reader who knows
 * Wikipedia already knows what this line is for.
 */
export const HATNOTE_CLASS = "hatnote";

/**
 * The tags that end a line of text when a hatnote is flattened.
 *
 * Exactly the block-level half of `ALLOWED_TAGS` in `lib/sanitize-html.ts`,
 * plus `br`. They become a *space* rather than disappearing, which is the
 * whole of why this list exists: `<p>one</p><p>two</p>` pasted into the field
 * has to read "one two" and not "onetwo". `ul` is here as well as `li` —
 * dropping it silently would be harmless today and wrong the moment the
 * allowlist gains a container whose text is not inside an `li`.
 */
const LINE_BREAKING_TAGS: ReadonlySet<string> = new Set([
  "p",
  "br",
  "h2",
  "h3",
  "h4",
  "ul",
  "li",
]);

/**
 * A hatnote as it is stored and rendered: text, and links, and nothing else.
 *
 * ## Why this is a flatten between two sanitiser passes, not a second allowlist
 *
 * The acceptance criterion is "plain text plus links; not a full editor
 * surface", and the obvious way to enforce it is a second `sanitize-html`
 * options object with `allowedTags: ["a"]`. That is a second allowlist, and a
 * second allowlist is a second thing to tighten when the first one is
 * tightened — the failure mode being that a tag disallowed in an entry body
 * goes on being allowed in the line above it, which is the one place on the
 * page nobody thinks to look.
 *
 * So there is exactly one allowlist, and it is `sanitizeHtml`'s. This function
 * runs it, walks its output — a *closed* tag set, which is the guarantee
 * `lib/content-diff.ts` and `lib/red-links.ts` already build on — keeping
 * anchors and text and turning everything else into a space or nothing, and
 * then runs `sanitizeHtml` over the result again. The second pass is the same
 * argument `lib/article-outline.ts` makes for its own: what this function
 * returns is sanitiser output *whatever it was given*, so narrowing a hatnote
 * cannot become a way around the pipeline, because the narrowing sits inside
 * it. It costs a parse, and `sanitizeHtml` is idempotent, so it costs nothing
 * else.
 *
 * The narrowing is therefore a **transform**, not a policy: it can only ever
 * remove from what the allowlist already permitted.
 *
 * ## Run on write and on read, like the body
 *
 * `lib/save-page.ts` normalises before storing and
 * `app/wiki/[slug]/page.tsx` normalises again before rendering, for the reason
 * `lib/sanitize-html.ts` sets out at length: sanitising on write alone bets
 * that every row was written by code that had this wired in, and that bet
 * loses on the first `db:seed` and the first `UPDATE` in a SQL console. A row
 * holding `<strong>` — which no editor here can produce, but a direct POST
 * can — reads as its own text rather than as bold.
 *
 * ## Empty is empty
 *
 * A hatnote with no visible text is `""`, not `"<a href=\"/wiki/x\"></a>"` and
 * not `" "`. That is what makes "omitted entirely when empty" checkable with
 * one comparison at the call site instead of a rule every caller has to
 * remember, and it is why a value that is only whitespace, only markup, or
 * only an empty link all collapse to the same answer.
 *
 * @param html whatever is stored, or whatever an editor submitted
 * @returns text and anchors, whitespace-collapsed and trimmed, or `""`
 */
export function normaliseHatnote(html: string | null | undefined): string {
  const safe = sanitizeHtml(html);
  if (!safe) return "";

  /**
   * The pieces of the flattened line. Anchor tags go in **verbatim** — they
   * are already sanitiser output, so their attribute values are escaped and
   * their href has been through the scheme list — and copying them rather
   * than re-serialising them is what keeps this function from having an
   * opinion about escaping at all.
   */
  const parts: string[] = [];
  /** Whether the last thing pushed ended in a space, so runs cannot double. */
  let pendingSpace = false;

  const pushSpace = () => {
    // Nothing before it, so there is nothing for it to separate. This is also
    // what trims the leading edge without a second pass.
    if (parts.length > 0) pendingSpace = true;
  };

  const push = (piece: string) => {
    if (pendingSpace) {
      parts.push(" ");
      pendingSpace = false;
    }
    parts.push(piece);
  };

  for (const token of safe.matchAll(HTML_TOKEN_PATTERN)) {
    // Read by index rather than compared against `undefined`, as the other
    // consumers of this pattern do: `RegExpExecArray` types every group as
    // `string`, and none of these alternatives can match an empty string, so
    // truthiness says exactly "this alternative fired".
    const tagName = token[2];
    const text = token[4];

    if (text) {
      // Collapsed here rather than over the joined string, so that whitespace
      // *inside* an anchor's attributes is never touched — a `pages.slug` is
      // a `text` column and nothing stops one holding a space.
      const collapsed = text.replace(/\s+/g, " ");
      const trimmed = collapsed.trim();
      if (collapsed.startsWith(" ")) pushSpace();
      if (trimmed) push(trimmed);
      if (trimmed && collapsed.endsWith(" ")) pushSpace();
      continue;
    }

    // No tag name: the comment alternative matched. Not text, not rendered.
    if (!tagName) continue;

    const name = tagName.toLowerCase();
    // The one tag a hatnote keeps, opening and closing alike.
    if (name === "a") {
      push(token[0]);
      continue;
    }
    // `strong`, `em` and anything else the allowlist permits: the tag goes and
    // its text — already handled above as its own token — stays.
    if (LINE_BREAKING_TAGS.has(name)) pushSpace();
  }

  const flattened = parts.join("");
  // Only markup, or only whitespace, or only an empty link. All one state.
  if (!hatnoteText(flattened)) return "";

  return sanitizeHtml(flattened);
}

/**
 * A hatnote as a reader hears it: the words, with the links' text in place and
 * the markup gone.
 *
 * The emptiness test `normaliseHatnote` uses, and the reason it can be one
 * comparison — a line whose only content is an anchor with no text between its
 * tags has nothing in it, however much markup it holds.
 *
 * @param html a hatnote, stored or flattened
 * @returns its text, whitespace collapsed and trimmed
 */
export function hatnoteText(html: string | null | undefined): string {
  if (!html) return "";

  let text = "";
  for (const token of html.matchAll(HTML_TOKEN_PATTERN)) {
    if (token[4]) text += token[4];
  }

  return collapseWhitespace(decodeHtmlEscapes(text));
}

/**
 * How many namesakes the automatic hatnote names before it starts counting.
 *
 * Five, the same cap `NAMED_RELATIVE_LIMIT` in `lib/person-infobox.ts` puts on
 * a list of relatives, and for the same reason: past about five names a line
 * of prose stops being read and starts being skipped, which costs the hatnote
 * the one job it has. Beyond the cap the line says "and 3 others" — honest
 * about there being more, rather than quietly truncating.
 */
export const NAMESAKE_LIMIT = 5;

/**
 * Somebody who shares a name, as the hatnote needs them.
 *
 * Structural rather than an import of the row type in `lib/namesakes.ts`, for
 * the reason `lib/format-date.ts` gives for `QualifiedDate`: that module
 * imports `@/db`, and a fixture in a test is not a database row and should not
 * have to be one. `Lifespan` is that module's own five-column group, so the
 * dates arrive already grouped rather than as loose columns this type would
 * have to restate.
 */
export type NamesakePerson = Lifespan & {
  /** `individuals.id` — the React key, and never rendered. */
  id: string;
  givenName: string;
  surname: string | null;
  /**
   * The `pages.slug` of this person's entry, or `null` when they have none.
   *
   * Null is ordinary rather than exceptional, and it is why the automatic
   * hatnote renders through `entryLinkProps` rather than as plain `<Link>`s:
   * a namesake with no entry is the purest red link there is (see
   * `EntryLinkTarget` in `lib/red-links.ts`), and the honest thing to show is
   * an invitation to write about them.
   */
  slug: string | null;
};

/**
 * How a namesake reads in the line: `Rose Whitfield (1890–1962)`,
 * `Rose Whitfield (b. about 1921)`, or just `Rose Whitfield`.
 *
 * The lifespan is the whole point of the parenthetical — it is the thing that
 * tells two people with one name apart, and it comes from `formatLifespan` in
 * `lib/format-date.ts` rather than from a second formatter written here, which
 * is the rule that module exists to enforce. It returns `""` when neither date
 * is recorded, and then there are no brackets at all: `Rose Whitfield ()` would
 * be a gap presented as a fact, and most of a nineteenth-century record is
 * missing.
 *
 * @param person the namesake, with their two dates as stored
 * @returns the name, with the years after it when there are years to give
 */
export function formatNamesake(person: NamesakePerson): string {
  const name = formatPersonName(person.givenName, person.surname);
  const lifespan = formatLifespan(person);

  return lifespan ? `${name} (${lifespan})` : name;
}

/**
 * The words in front of the list: `For other people named Rose Whitfield, see`.
 *
 * Wikipedia's own phrasing, and the phrasing the ticket asks for. It says
 * "other people", so it is only ever correct on an entry that is itself about
 * one of them — which is the only situation `lib/namesakes.ts` looks for a
 * namesake in.
 *
 * @param name the shared name, as `formatPersonName` renders it
 */
export function namesakeHatnoteLead(name: string): string {
  return `For other people named ${name}, see`;
}

/**
 * What goes between two names in the list: nothing, a comma, or the word
 * "and".
 *
 * A function over indices rather than a `join`, because the names are links
 * and a joined string cannot hold one. The component interleaves this between
 * elements; keeping the decision here is what lets `npm test` check the shape
 * of the sentence without rendering anything.
 *
 * The last separator is a word rather than another comma when the list ends
 * here — this is a sentence a reader reads, which is the same argument
 * `describeContentDiffSummary` in `lib/content-diff.ts` makes for its own
 * join. When the list does *not* end here, because `hasMore` says a count
 * follows, every separator is a comma and the "and" goes in front of the
 * count instead.
 *
 * @param index which name, zero-based
 * @param count how many names are being listed
 * @param hasMore whether a "and N others" tail follows the last name
 */
export function namesakeSeparator(
  index: number,
  count: number,
  hasMore: boolean,
): string {
  if (index === 0) return " ";
  if (index === count - 1 && !hasMore) return " and ";
  return ", ";
}

/**
 * The tail of a list that ran past `NAMESAKE_LIMIT`: `and 3 others`.
 *
 * Deliberately not a link. There is no disambiguation page in this wiki to
 * point at — docs/product.md's infobox note explains why apparatus here is
 * derived rather than authored — so the honest thing is to say the number and
 * stop, rather than to offer a sixth name chosen arbitrarily or a link that
 * leads to a list nobody has written.
 *
 * @param count how many namesakes are not named in the line; must be positive
 */
export function describeExtraNamesakes(count: number): string {
  return `and ${count} ${count === 1 ? "other" : "others"}`;
}
