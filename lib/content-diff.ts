import {
  attributeValue,
  collapseWhitespace,
  decodeHtmlEscapes,
  HTML_TOKEN_PATTERN,
} from "@/lib/html-text";
import { hatnoteText, normaliseHatnote } from "@/lib/hatnote";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { imageKeyFromHref } from "@/lib/storage-key";

/**
 * The diff between two revisions of an entry (E1-T6, `YEO-20`), as plain
 * functions over plain values.
 *
 * ## What this diffs, and what it deliberately does not
 *
 * The ticket's first constraint is that the diff is over **rendered content,
 * not HTML source** — "the author does not read HTML". So the unit here is a
 * *block of rendered text*: a paragraph, a heading, a list item. `<p>Rose was
 * born in <strong>1912</strong>.</p>` becomes the one block `Rose was born in
 * 1912.`, and an edit that only re-wraps that sentence in different markup —
 * bolding a word, splitting an anchor — produces no diff rows at all, because
 * nothing the reader sees has changed.
 *
 * Its second constraint is the note on the ticket, which is worth quoting
 * because it is the reason this file looks the way it does:
 *
 * > A paragraph-level diff that is obviously correct beats a word-level diff
 * > that is occasionally confusing.
 *
 * So a changed paragraph is shown as one removed block and one added block,
 * whole. There is no intra-paragraph highlighting, no word-level pass, and no
 * DOM-diffing dependency. Editing one word re-prints the sentence twice; that
 * is a sentence a reader can compare in a glance, and it is never wrong. A
 * word-level layer on top of this would be a strictly additive change if it
 * ever earns its place, and everything below stays the same shape.
 *
 * ## Why this module has no database import
 *
 * docs/testing.md's rule: `npm test` — what CI runs — has no `DATABASE_URL`.
 * `lib/revisions.ts` imports `@/db`, and an `async` Server Component is not
 * unit-testable at all, so the only way the diff algorithm gets tested on
 * every push is to keep it here, over values. `@/lib/sanitize-html` is safe to
 * import: it reaches for `sanitize-html` the package and nothing else.
 */

/**
 * What kind of thing a block is, in the rendered article.
 *
 * The heading levels are kept apart rather than folded into one `"heading"`
 * because promoting a section from `h3` to `h2` genuinely changes the article,
 * and a diff that reported "no changes" for it would be lying. All but the
 * last are exactly the block-level half of `ALLOWED_TAGS` in
 * `lib/sanitize-html.ts` — if a tag is added there, it belongs in `BLOCK_TAGS`
 * below too.
 *
 * `hatnote` is the exception, and it is one because it is not in the body at
 * all: it is `pages.hatnote` / `revisions.hatnote`, a column of its own
 * (E11-T9, `YEO-79`). It gets a kind here rather than being folded into
 * `paragraph` for the same reason `heading2` and `heading3` are kept apart —
 * two blocks are "the same" only when kind *and* text match, so a distinct
 * kind is what makes moving a sentence out of the hatnote and into the lead
 * report as the edit it is. Without it, a hatnote-only save would write a
 * revision and then diff as "No change to the rendered content", which is the
 * worst of both answers.
 *
 * `image` is here for exactly that argument, one ticket later (E5-T3,
 * `YEO-43`). A photograph is the first thing an author can put in an entry
 * that a reader sees and that carries **no text at all**, so every other kind
 * here would have swallowed it: an `<img>` folded into the paragraph around
 * it contributes an empty string, and adding, removing or swapping one would
 * have diffed as "No change to the rendered content" — the worst of both
 * answers again, and this time about the one piece of content nobody can
 * retype from memory.
 *
 * `category` is here on the same argument, one more ticket later (`YEO-106`).
 * A re-filing used to write no revision at all, so there was nothing on this
 * side of the seam for a diff to be wrong about; now that it writes one, a
 * diff with no kind for it would render a revision whose summary reads "No
 * change to the rendered content" — the worst of both answers for the third
 * time, and this time about the only thing that revision recorded. It is its
 * own kind rather than a paragraph because a category is not prose: filing an
 * entry under "Emigrated to Canada" and typing that sentence into the lead are
 * different edits, and two blocks are the same only when kind *and* text
 * match.
 */
export type ContentBlockKind =
  | "paragraph"
  | "heading2"
  | "heading3"
  | "heading4"
  | "listItem"
  | "hatnote"
  | "image"
  | "category";

/**
 * One block of rendered content: what kind of thing it is, and the text a
 * reader sees in it.
 *
 * Two blocks are "the same" when both fields match — see `blockKey`. That is
 * the whole identity model, and it is why the diff is stable under
 * markup-only edits.
 */
export type ContentBlock = {
  kind: ContentBlockKind;
  text: string;
  /**
   * Which photograph, as its storage key — `image` blocks only, and absent on
   * every other kind.
   *
   * The model is widened rather than made to approximate, because the two
   * fields above cannot identify a picture. A photograph's `text` is its alt
   * text, which is what a reader hears; it is routinely empty, and it is very
   * often *the same* across two different pictures in one entry. Keying
   * identity on that alone would make replacing one photograph with another
   * diff as unchanged — the failure this kind exists to prevent, rather than a
   * smaller version of it.
   *
   * The key rather than the `src` path: it is the durable handle
   * (docs/architecture.md#the-storage-seam), and it is what E5-T5's sweep and
   * the full export reason about, so a diff row and an archive entry name the
   * same object.
   */
  source?: string;
};

/**
 * What happened to one block between the two revisions.
 *
 * `moved-out` and `moved-in` are the same block appearing twice — once where
 * it used to be, once where it is now. See `markMovedBlocks` for why they are
 * worth distinguishing from a plain removal and a plain addition.
 */
export type ContentDiffStatus =
  "unchanged" | "added" | "removed" | "moved-out" | "moved-in";

/** One line of the rendered diff. */
export type ContentDiffRow = {
  status: ContentDiffStatus;
  block: ContentBlock;
};

/** Row counts, for the one-line summary above a diff. */
export type ContentDiffSummary = {
  unchanged: number;
  added: number;
  removed: number;
  /** Blocks that moved. One move is *one* count here, not two rows' worth. */
  moved: number;
};

/**
 * The block-level tags, mapped to what a block of each is called.
 *
 * `ul` is absent on purpose: a list is not itself content, it is a container
 * for `li`s that are. Diffing at the `ul` level would report a whole list as
 * changed because one bullet in it did.
 */
const BLOCK_TAGS: Readonly<Record<string, ContentBlockKind>> = {
  p: "paragraph",
  h2: "heading2",
  h3: "heading3",
  h4: "heading4",
  li: "listItem",
};

/**
 * The scanner, the escape decoder and the whitespace rule all live in
 * `lib/html-text.ts` now.
 *
 * They were written here for E1-T6 and moved out for E11-T6 (`YEO-76`), which
 * walks the same sanitised HTML to find the links in it. The reasoning has
 * not changed — a closed tag set is what makes a regex enough, and a DOM
 * implementation in the server bundle would be over-building — it is only
 * that two modules now depend on agreeing with `sanitizeHtml`'s output, and
 * one description of that agreement is safer than two.
 */

/**
 * Turn an entry body into the sequence of content blocks a reader sees.
 *
 * ## Why it sanitises first
 *
 * Not for injection safety — this function's output is text, and the diff
 * route renders it as text nodes, so there is no `dangerouslySetInnerHTML`
 * anywhere downstream of here. It sanitises for *fidelity*: `sanitizeHtml`'s
 * `nonTextTags` drops the **contents** of `<script>`, `<style>` and friends
 * along with the tag, and without that pass a revision written before the
 * sanitiser existed would show `alert(1)` in the diff as though the author had
 * typed it into a paragraph. Doing it here rather than at the call site also
 * means no future caller can forget — and the function is idempotent, so a
 * caller that sanitises anyway pays only for the parse.
 *
 * ## Why a scanner rather than a DOM
 *
 * `jsdom` is a devDependency, for tests. Pulling a DOM implementation into the
 * server bundle to read five tag names out of an allowlisted document would be
 * the over-building the ticket warns against. The tag set here is closed —
 * `sanitizeHtml` guarantees it — and the scanner ignores everything it does not
 * recognise, so widening the allowlist degrades to "that markup contributes
 * text to its enclosing block", never to a crash.
 *
 * ## One known limitation
 *
 * A body whose block tags are *improperly nested* — `<p>A<h2>B</p>C</h2>`,
 * which TipTap's schema cannot produce but a hand-written `UPDATE` can —
 * comes back out of `sanitizeHtml` re-serialised with a stray empty `<p></p>`
 * where the overlap was, and the `flush()` on each block tag then splits what
 * a browser renders as one heading ("B C") into two heading blocks ("B" and
 * "C"). It fails safe: an extra row in the diff, never a crash and never lost
 * text. Fixing it would mean tracking overlap across the re-serialisation
 * boundary, which is a great deal of machinery for a shape only a legacy row
 * can hold.
 *
 * @param html an entry or revision body, as stored
 * @returns its blocks in document order; empty blocks are dropped
 */
export function extractContentBlocks(
  html: string | null | undefined,
): ContentBlock[] {
  const safe = sanitizeHtml(html);
  if (!safe) return [];

  const blocks: ContentBlock[] = [];
  /** The block tags currently open, outermost first. */
  const open: ContentBlockKind[] = [];
  let buffer = "";

  /**
   * The kind to file the buffered text under.
   *
   * A list item wins over anything nested inside it, because TipTap writes
   * `<li><p>Alice</p></li>` — the paragraph is a wrapper the editor emits, not
   * a paragraph the author wrote, and calling that block a paragraph would
   * make every bullet compare unequal to the same bullet typed elsewhere.
   * Text outside any block tag is a paragraph, which is what a browser renders
   * it as.
   */
  const currentKind = (): ContentBlockKind =>
    open.includes("listItem") ? "listItem" : (open.at(-1) ?? "paragraph");

  const flush = () => {
    const text = collapseWhitespace(decodeHtmlEscapes(buffer));
    buffer = "";
    // A block with nothing in it is not a change anyone can see. TipTap emits
    // `<p></p>` for a blank line, and a diff that reported those would drown
    // the real edits.
    if (text) blocks.push({ kind: currentKind(), text });
  };

  for (const token of safe.matchAll(HTML_TOKEN_PATTERN)) {
    // Read by index rather than destructured with `!== undefined` checks:
    // `RegExpExecArray` types every group as `string`, so comparing one
    // against `undefined` is a type error even though an unmatched
    // alternative really does leave the slot empty. Truthiness says the same
    // thing here — neither `[^<]+` nor `[a-zA-Z][^\s/>]*` can match an empty
    // string, so an empty slot is always an alternative that did not fire.
    const closing = token[1];
    const tagName = token[2];
    // Group 3 is the attribute run, which only the `img` branch below reads;
    // the text a reader sees is group 4. See `HTML_TOKEN_PATTERN`.
    const attributes = token[3];
    const text = token[4];

    if (text) {
      buffer += text;
      continue;
    }

    // No tag name: the comment alternative matched. Not rendered, not content.
    if (!tagName) continue;

    const tag = tagName.toLowerCase();

    // `<br>` is a line break inside one block, not a new block. It renders as
    // a gap between words, so that is what it contributes.
    if (tag === "br") {
      buffer += " ";
      continue;
    }

    /**
     * A photograph (E5-T3, `YEO-43`).
     *
     * Handled here rather than through `BLOCK_TAGS` because it is neither of
     * the two shapes that table describes. It is **void** — there is no
     * `</img>` to close, so it must never be pushed onto `open` — and it has
     * **no text**, so `flush()` would drop it: that function discards an empty
     * block on purpose, which is right for TipTap's `<p></p>` and exactly
     * wrong for a picture.
     *
     * So the buffer is flushed first, to close off whatever text preceded the
     * picture, and then the block is pushed directly.
     *
     * An `img` whose `src` is not one of ours contributes nothing. That is not
     * a case a stored body can reach — `sanitizeHtml` above has already
     * dropped any such tag whole — but the check is what makes that true here
     * rather than assumed, and it is the same `imageKeyFromHref` the export
     * and the sanitiser ask.
     */
    if (tag === "img") {
      if (closing) continue;
      flush();

      const source = imageKeyFromHref(attributeValue(attributes, "src") ?? "");
      if (source === null) continue;

      blocks.push({
        kind: "image",
        // The alt text, which is what a reader with a screen reader hears and
        // therefore the closest thing a picture has to text. Decoded and
        // collapsed like any other, and `""` when there is none — `source` is
        // what identifies the block, so an empty one is not a lost row.
        text: collapseWhitespace(
          decodeHtmlEscapes(attributeValue(attributes, "alt") ?? ""),
        ),
        source,
      });
      continue;
    }

    const kind = BLOCK_TAGS[tag];
    // `strong`, `em`, `a`, `ul` — inline marks and containers. Their text is
    // already being buffered; the tags themselves are exactly the HTML the
    // author does not read.
    if (!kind) continue;

    flush();

    if (closing) {
      // Truncating rather than popping is the tolerant reading of a close
      // tag: `</li>` closes the `<p>` still open inside it, which is what a
      // browser does. On well-formed input — which the sanitiser guarantees —
      // the two are identical.
      const index = open.lastIndexOf(kind);
      if (index !== -1) open.length = index;
    } else {
      open.push(kind);
    }
  }

  // Text after the last close tag, or a body with no block tags at all.
  flush();

  return blocks;
}

/**
 * The identity of a block, as one comparable string.
 *
 * A NUL separates the two halves because it is the one character the text
 * half cannot contain: `collapseWhitespace` keeps only what was in the
 * document, and an HTML parser will not hand one back. Concatenating without a
 * separator that cannot appear in either half would let one kind's text
 * collide with another's.
 */
function blockKey(block: ContentBlock): string {
  // Three parts now. `source` is a storage key — alphanumerics, `._-` and
  // slashes, by `assertSafeStorageKey` — so it cannot hold the separator
  // either, and it is the empty string for every kind but `image`.
  return `${block.kind}\u0000${block.text}\u0000${block.source ?? ""}`;
}

/**
 * Longest common subsequence over block identity, walked into a row list.
 *
 * The table is filled from the bottom-right so the walk that produces rows can
 * run *forward*, in document order, and push rows as it goes — no reversal
 * step, and no chance of the output ending up back to front.
 *
 * The table is `(n+1) × (m+1)` cells of `Int32Array` rather than nested
 * arrays: an entry is a few dozen blocks, so this is small either way, but a
 * flat typed array is one allocation instead of `n+1` of them and keeps the
 * inner loop free of bounds-checked object property lookups.
 */
function diffByLongestCommonSubsequence(
  before: ContentBlock[],
  after: ContentBlock[],
): ContentDiffRow[] {
  const beforeKeys = before.map(blockKey);
  const afterKeys = after.map(blockKey);
  const n = beforeKeys.length;
  const m = afterKeys.length;
  const width = m + 1;

  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        beforeKeys[i] === afterKeys[j]
          ? lcs[(i + 1) * width + (j + 1)] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)]);
    }
  }

  const rows: ContentDiffRow[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (beforeKeys[i] === afterKeys[j]) {
      // Either block would do — they are equal by the only definition this
      // module has. The new one is used so a row always carries the value
      // from the revision it is being compared *to*.
      rows.push({ status: "unchanged", block: after[j] });
      i += 1;
      j += 1;
      continue;
    }

    // The tie goes to the removal, which is what puts "what it said" above
    // "what it says now" when a paragraph is rewritten in place — the reading
    // order every diff tool trains people to expect.
    if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) {
      rows.push({ status: "removed", block: before[i] });
      i += 1;
    } else {
      rows.push({ status: "added", block: after[j] });
      j += 1;
    }
  }

  while (i < n) {
    rows.push({ status: "removed", block: before[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ status: "added", block: after[j] });
    j += 1;
  }

  return rows;
}

/**
 * Re-label removal/addition pairs of identical blocks as a move.
 *
 * This is the ticket's "sensible output when a whole section moves". A plain
 * subsequence diff already handles a moved section *correctly* — it keeps the
 * longer side and reports the shorter one as removed here and added there —
 * but what the author reads is four paragraphs deleted at the top and four
 * unfamiliar ones added at the bottom, and they have to compare them by eye to
 * discover nothing was lost. Saying so is the whole of this pass.
 *
 * It is deliberately not clever. A block that appears in *both* the removed
 * set and the added set is, by definition, content that survived the edit and
 * changed position — there is no heuristic and no similarity threshold, so it
 * cannot be subtly wrong the way a fuzzy move detector can. Where a block
 * appears more than once, the pairs are taken in document order, which makes
 * the labelling deterministic; which duplicate is called the moved one is
 * arbitrary, but nothing downstream depends on the choice.
 */
function markMovedBlocks(rows: ContentDiffRow[]): ContentDiffRow[] {
  const removedCounts = new Map<string, number>();
  const addedCounts = new Map<string, number>();

  for (const row of rows) {
    const counts =
      row.status === "removed"
        ? removedCounts
        : row.status === "added"
          ? addedCounts
          : undefined;
    if (!counts) continue;

    const key = blockKey(row.block);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // How many of each block are a move rather than a genuine deletion or a
  // genuine insertion: the smaller of the two counts. Deleting three copies
  // of a paragraph and adding one back is one move and two deletions.
  const remainingOut = new Map<string, number>();
  const remainingIn = new Map<string, number>();
  for (const [key, removed] of removedCounts) {
    const pairs = Math.min(removed, addedCounts.get(key) ?? 0);
    if (pairs === 0) continue;
    remainingOut.set(key, pairs);
    remainingIn.set(key, pairs);
  }

  if (remainingOut.size === 0) return rows;

  const take = (budget: Map<string, number>, key: string): boolean => {
    const left = budget.get(key) ?? 0;
    if (left === 0) return false;
    budget.set(key, left - 1);
    return true;
  };

  return rows.map((row) => {
    const key = blockKey(row.block);

    if (row.status === "removed" && take(remainingOut, key)) {
      return { status: "moved-out", block: row.block };
    }
    if (row.status === "added" && take(remainingIn, key)) {
      return { status: "moved-in", block: row.block };
    }
    return row;
  });
}

/**
 * Diff two entry bodies, block by block.
 *
 * @param beforeHtml the older revision's body, as stored
 * @param afterHtml the newer revision's body, as stored
 * @returns one row per block, in the order they should be read
 */
export function diffContent(
  beforeHtml: string | null | undefined,
  afterHtml: string | null | undefined,
): ContentDiffRow[] {
  return diffEntryContent({ bodyHtml: beforeHtml }, { bodyHtml: afterHtml });
}

/** One side of a comparison: an entry's stored content, column by column. */
export type DiffableEntry = {
  bodyHtml: string | null | undefined;
  /** `pages.hatnote` / `revisions.hatnote`, as stored (E11-T9, `YEO-79`). */
  hatnote?: string | null | undefined;
  /**
   * `revisions.categories`, as stored (`YEO-106`): the names the entry was
   * filed under at this revision, in slug order.
   *
   * Optional like the hatnote above, and read as "filed under nothing" when it
   * is absent — which is what `diffContent` means by omitting it, and what a
   * caller comparing two bare bodies means too.
   */
  categories?: readonly string[] | null | undefined;
};

/**
 * The hatnote as one block, or nothing at all when there is none.
 *
 * `normaliseHatnote` rather than `sanitizeHtml`, for the reason
 * `extractContentBlocks` sanitises what it is handed rather than trusting it:
 * a stored value can predate the narrowing. Text only, so re-pointing a link
 * without changing a word reports as no change — exactly what this module
 * already promises for a paragraph in the body.
 */
function hatnoteBlock(hatnote: string | null | undefined): ContentBlock[] {
  const text = hatnoteText(normaliseHatnote(hatnote));
  return text ? [{ kind: "hatnote", text }] : [];
}

/**
 * The filing as one block per category (`YEO-106`), or nothing when the entry
 * was filed under nothing.
 *
 * One block each rather than one block holding a comma-separated list, because
 * a list is a single string and a single string diffs as a single thing: an
 * entry gaining one category out of four would print the other three as
 * removed and re-added. Separate blocks make an added heading one addition and
 * leave the rest standing as unchanged rows, which is what actually happened.
 *
 * The order is the order the column is stored in — slug order, canonical, the
 * same on both sides of any comparison — so the subsequence diff never sees a
 * re-ordering that nobody performed. `markMovedBlocks` therefore has nothing
 * to find here, which is correct: a filing is a set, and a set has no
 * arrangement for a block to move within.
 *
 * Empty names are dropped for the reason `extractContentBlocks` drops empty
 * blocks: `normaliseEntryCategories` cannot produce one, so this only ever
 * fires on a row written by hand, and a blank row in a diff reads as a bug.
 */
function categoryBlocks(
  categories: readonly string[] | null | undefined,
): ContentBlock[] {
  return (categories ?? [])
    .filter((name) => name !== "")
    .map((name) => ({ kind: "category", text: name }));
}

/**
 * Diff two revisions of an entry — the hatnote, the body and the filing
 * together.
 *
 * The hatnote leads and the categories trail, because that is where each of
 * them renders and a diff should read in the order the page does. From there
 * on both are blocks like any other: adding one is an addition, clearing one
 * is a removal, and an unchanged one contributes an unchanged row so the
 * reader can see it stood still.
 *
 * `diffContent` above is this function with no hatnote on either side, kept
 * because a caller comparing two bodies — `lib/content-diff.test.ts` does it
 * throughout — should not have to name a column it is not asking about.
 *
 * @param before the older revision's content columns, as stored
 * @param after the newer revision's content columns, as stored
 * @returns one row per block, in the order they should be read
 */
export function diffEntryContent(
  before: DiffableEntry,
  after: DiffableEntry,
): ContentDiffRow[] {
  return markMovedBlocks(
    diffByLongestCommonSubsequence(
      [
        ...hatnoteBlock(before.hatnote),
        ...extractContentBlocks(before.bodyHtml),
        ...categoryBlocks(before.categories),
      ],
      [
        ...hatnoteBlock(after.hatnote),
        ...extractContentBlocks(after.bodyHtml),
        ...categoryBlocks(after.categories),
      ],
    ),
  );
}

/**
 * Count the rows by kind, so a page can say what happened in one line before
 * the reader starts reading blocks.
 *
 * A move is counted once, off its `moved-in` row, because one block moving is
 * one thing that happened even though it prints twice.
 */
export function summariseContentDiff(
  rows: ContentDiffRow[],
): ContentDiffSummary {
  const summary: ContentDiffSummary = {
    unchanged: 0,
    added: 0,
    removed: 0,
    moved: 0,
  };

  for (const row of rows) {
    if (row.status === "unchanged") summary.unchanged += 1;
    else if (row.status === "added") summary.added += 1;
    else if (row.status === "removed") summary.removed += 1;
    else if (row.status === "moved-in") summary.moved += 1;
  }

  return summary;
}

/**
 * The summary in a sentence, for the line above a diff.
 *
 * Here rather than in the route for the same reason `describeBlockKind` is:
 * the route is an `async` Server Component and cannot be unit-tested, and the
 * plural forms and the comma-then-"and" join are exactly the sort of thing
 * that reads fine in the one case it was written against and wrong in the
 * next. Over a plain value they can be checked by `npm test`.
 *
 * Unchanged blocks are not counted here. The reader can see how much of the
 * entry stood still by scrolling; what belongs in one line at the top is what
 * *happened*.
 */
export function describeContentDiffSummary(
  summary: ContentDiffSummary,
): string {
  const parts: string[] = [];

  const add = (count: number, singular: string, plural: string) => {
    if (count === 0) return;
    parts.push(`${count} ${count === 1 ? singular : plural}`);
  };

  add(summary.added, "addition", "additions");
  add(summary.removed, "removal", "removals");
  add(summary.moved, "move", "moves");

  if (parts.length === 0) return "No change to the rendered content.";
  if (parts.length === 1) return `${parts[0]}.`;

  // "A, B and C" — the last join is a word, not another comma, because this
  // is a sentence a reader reads rather than a row of statistics.
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

/**
 * Whether anything visible to a reader changed at all.
 *
 * Not the same question as "are these two different revisions". Two revisions
 * can hold byte-different HTML and identical rendered content — a save that
 * only re-wrapped a word in `<em>` and then removed it again, or the copy
 * `lib/save-page.ts` writes when nothing was typed — and this module's whole
 * premise is that the reader should be told about the second thing, not the
 * first.
 */
export function hasContentChanges(rows: ContentDiffRow[]): boolean {
  return rows.some((row) => row.status !== "unchanged");
}

/**
 * What to call a block in the interface.
 *
 * Here rather than in the route because it is the other half of
 * `ContentBlockKind` — adding a kind without a name for it should be a type
 * error in one place, not a missing label discovered on a page.
 */
export function describeBlockKind(kind: ContentBlockKind): string {
  switch (kind) {
    case "paragraph":
      return "Paragraph";
    case "heading2":
      return "Heading";
    case "heading3":
      return "Subheading";
    case "heading4":
      return "Sub-subheading";
    case "listItem":
      return "List item";
    case "hatnote":
      return "Hatnote";
    case "image":
      return "Photograph";
    case "category":
      return "Category";
  }
}

/**
 * What to render as a row's own text.
 *
 * For everything but a photograph this is the block's text unchanged, and the
 * function exists for the one case where it cannot be: an `image` block whose
 * `alt` is empty has nothing to show, and an *unchanged* row draws no kind
 * label either — so without this a picture that had never been described would
 * be a completely blank line in the diff, which reads as a bug rather than as
 * a photograph.
 *
 * Here rather than in the route for the reason `describeBlockKind` is here: it
 * is the other half of `ContentBlockKind`, and a kind added without a way to
 * render it should be a type error in one place instead of an empty row
 * discovered on a page.
 */
export function contentBlockText(block: ContentBlock): string {
  if (block.kind !== "image") return block.text;
  // Not the storage key, which is a UUID and tells a reader nothing. That a
  // picture is there, and that nobody has described it, is the whole of what
  // can honestly be said.
  return block.text || "Photograph with no description";
}

/**
 * What to say about a row, in words.
 *
 * The words are load-bearing rather than decorative: the ticket requires that
 * additions and removals be "visually distinct without relying on colour
 * alone", and the most robust way to not rely on colour is to write down what
 * happened. This string is rendered as real text — not a `title` attribute, not
 * `aria-label` — so it survives a monochrome print, a screenshot pasted into a
 * message, and a screen reader, all of which the tint and the marker glyph do
 * not.
 */
export function describeDiffStatus(status: ContentDiffStatus): string {
  switch (status) {
    case "unchanged":
      return "Unchanged";
    case "added":
      return "Added";
    case "removed":
      return "Removed";
    case "moved-out":
      return "Moved from here";
    case "moved-in":
      return "Moved to here";
  }
}
