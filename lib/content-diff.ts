import { sanitizeHtml } from "@/lib/sanitize-html";

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
 * and a diff that reported "no changes" for it would be lying. The set is
 * exactly the block-level half of `ALLOWED_TAGS` in `lib/sanitize-html.ts` —
 * if a tag is added there, it belongs in `BLOCK_TAGS` below too.
 */
export type ContentBlockKind =
  "paragraph" | "heading2" | "heading3" | "heading4" | "listItem";

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
 * Tags, text runs, and comments, in one pass.
 *
 * Three alternatives in one regex rather than three passes, so the scanner
 * sees the document in source order and a `<` inside a text run cannot be
 * mistaken for a tag it is not. Comments are matched first so that a `>`
 * inside one does not terminate a phantom tag.
 */
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][^\s/>]*)[^>]*>|([^<]+)/g;

/**
 * The four escapes `sanitizeHtml` emits, decoded in one pass.
 *
 * Deliberately not a character-reference decoder. `sanitize-html` parses its
 * input with htmlparser2, which decodes *every* entity in the document —
 * `&mdash;`, `&#8212;`, `&#x2019;`, `&nbsp;` all reach this module as the
 * characters they name — and re-escapes only `&`, `<`, `>` and `"` on the way
 * out. So those four are the entire set that can still be in the string
 * scanned below, and a named table, a decimal branch and a hex branch would
 * each be code no input can reach.
 *
 * One pass matters even for four. Replacing `&amp;` before `&lt;` would turn
 * the *literal* text `&amp;lt;` — which is how a real `&lt;` in the prose is
 * stored — into `<`, so the same paragraph would read as edited every time it
 * was round-tripped. Matching all four in one `replace` decodes each `&...;`
 * exactly once.
 */
const ESCAPE_PATTERN = /&(amp|lt|gt|quot);/g;

const ESCAPES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

function decodeEscapes(text: string): string {
  return text.replace(ESCAPE_PATTERN, (_whole, name: string) => ESCAPES[name]);
}

/**
 * Whitespace as the browser renders it: any run of it is one space, and the
 * ends are trimmed.
 *
 * This is what makes the diff indifferent to how the editor happened to
 * pretty-print its output. Without it, the same sentence saved by TipTap and
 * then re-saved after a manual `UPDATE` that added a newline would read as a
 * changed paragraph. JavaScript's `\s` includes ` `, so a non-breaking
 * space — which renders as a space — collapses with the rest.
 */
function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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
    const text = normaliseWhitespace(decodeEscapes(buffer));
    buffer = "";
    // A block with nothing in it is not a change anyone can see. TipTap emits
    // `<p></p>` for a blank line, and a diff that reported those would drown
    // the real edits.
    if (text) blocks.push({ kind: currentKind(), text });
  };

  for (const token of safe.matchAll(TOKEN_PATTERN)) {
    // Read by index rather than destructured with `!== undefined` checks:
    // `RegExpExecArray` types every group as `string`, so comparing one
    // against `undefined` is a type error even though an unmatched
    // alternative really does leave the slot empty. Truthiness says the same
    // thing here — neither `[^<]+` nor `[a-zA-Z][^\s/>]*` can match an empty
    // string, so an empty slot is always an alternative that did not fire.
    const closing = token[1];
    const tagName = token[2];
    const text = token[3];

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
 * half cannot contain: `normaliseWhitespace` keeps only what was in the
 * document, and an HTML parser will not hand one back. Concatenating without a
 * separator that cannot appear in either half would let one kind's text
 * collide with another's.
 */
function blockKey(block: ContentBlock): string {
  return `${block.kind}\u0000${block.text}`;
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
  return markMovedBlocks(
    diffByLongestCommonSubsequence(
      extractContentBlocks(beforeHtml),
      extractContentBlocks(afterHtml),
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
  }
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
