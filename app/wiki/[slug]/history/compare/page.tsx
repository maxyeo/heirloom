import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  contentBlockText,
  describeBlockKind,
  describeContentDiffSummary,
  describeDiffStatus,
  diffEntryContent,
  hasContentChanges,
  summariseContentDiff,
  type ContentBlockKind,
  type ContentDiffStatus,
} from "@/lib/content-diff";
import { getPageBySlug } from "@/lib/pages";
import {
  formatRevisionAuthor,
  formatRevisionTimestamp,
  isRevisionId,
  revisionTimestampIso,
} from "@/lib/revision-format";
import { getRevisionById } from "@/lib/revisions";
import { requireSession } from "@/lib/session";

/**
 * Reads a session cookie, two search parameters and three database rows, so —
 * as with every other route under `/wiki` — there is nothing to prerender.
 */
export const dynamic = "force-dynamic";

/**
 * Hand-written rather than taken from the generated `PageProps<"/wiki/[slug]/
 * history/compare">` helper, for the reason all three sibling routes give:
 * that helper exists only after `next dev`/`next build`/`next typegen` has
 * run, and CI's `npm run typecheck` runs on a fresh checkout before `npm run
 * build`, when `.next/types` does not exist yet.
 *
 * `searchParams` is a promise in this version of Next, like `params`, and its
 * values are `string | string[] | undefined` because a query string may repeat
 * a key. See `node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/page.md`.
 */
type ComparePageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * One search parameter, or nothing.
 *
 * `?from=a&from=b` arrives as an array, and there is no defensible way to pick
 * one of the two: a URL that names two "from" revisions does not identify a
 * comparison. Rejecting it outright is what turns that into the same 404 as
 * any other malformed link, rather than a page that quietly diffs against
 * whichever id happened to come first.
 */
function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The page and the two revisions being compared, loaded once per request.
 *
 * `requireSession()` lives inside this `cache()`-wrapped loader rather than at
 * the two call sites below (`generateMetadata` and the page) for the reason
 * `app/wiki/[slug]/page.tsx` documents at length: `lib/session.ts` is the only
 * access boundary this app has — no RLS underneath, one database role for
 * everyone — so an unguarded `generateMetadata` would be a second door onto
 * the same rows, one that would leak an entry's title into a `<title>` tag
 * nobody had to sign in for.
 *
 * Four ways this can miss, all folded into one `undefined` and all turned into
 * the same 404 by the caller:
 *
 *   - either id is not shaped like a revision id. Checked *first*, and before
 *     any query: `revisions.id` is a Postgres `uuid` column, and a non-UUID
 *     string reaching `eq(...)` raises `invalid input syntax for type uuid`
 *     rather than returning no rows — a 500 for what is really a bad link.
 *     See `isRevisionId`.
 *   - the slug resolves to no page.
 *   - either id resolves to no revision (a stale or mistyped link).
 *   - either revision belongs to a *different* page. This is the cross-entry
 *     guard the sibling detail route documents, and it has to be applied to
 *     **both** ids here: a revision id is a database-wide identifier, so
 *     nothing else stops `?from=<rose's>&to=<somebody else's>` from rendering
 *     a diff between two unrelated entries under Rose's title, which is a
 *     wrong answer confidently presented.
 *
 * The pair is then ordered oldest-first by `createdAt`, not by which parameter
 * was called `from`. A diff has a direction — what it said, then what it says —
 * and the reader should get that direction whichever order the two radio
 * buttons on the history page were clicked in.
 */
const loadComparison = cache(
  async (slug: string, fromId: string, toId: string) => {
    await requireSession();

    if (!isRevisionId(fromId) || !isRevisionId(toId)) return undefined;

    const page = await getPageBySlug(slug);
    if (!page) return undefined;

    // Independent lookups of two rows in the same table: no reason to make the
    // second wait on the first.
    const [from, to] = await Promise.all([
      getRevisionById(fromId),
      getRevisionById(toId),
    ]);

    if (!from || !to) return undefined;
    if (from.pageId !== page.id || to.pageId !== page.id) return undefined;

    const [older, newer] =
      from.createdAt <= to.createdAt ? [from, to] : [to, from];

    return { page, older, newer };
  },
);

export async function generateMetadata({
  params,
  searchParams,
}: ComparePageProps): Promise<Metadata> {
  const { slug } = await params;
  const query = await searchParams;
  const from = singleParam(query.from);
  const to = singleParam(query.to);

  if (!from || !to) return { title: "Not found" };

  const loaded = await loadComparison(slug, from, to);

  return {
    title: loaded ? `Comparing revisions: ${loaded.page.title}` : "Not found",
  };
}

/**
 * How a block's text is set, by what kind of block it is.
 *
 * The diff carries no markup — that is the point of it — so the shape of the
 * article has to be redrawn from `ContentBlockKind` alone. These mirror
 * `app/globals.css`'s base rules for the same elements (serif at h2, bold sans
 * from h3 down) minus the bottom rule, which in here would read as a divider
 * between diff rows rather than as a heading's underline.
 *
 * A `Record` rather than a `switch` so that adding a kind is a type error at
 * this call site, the same way `describeBlockKind` makes it one at its own.
 */
const BLOCK_TEXT_CLASS: Readonly<Record<ContentBlockKind, string>> = {
  paragraph: "",
  heading2: "font-serif text-h2",
  heading3: "font-bold text-h3",
  heading4: "font-bold text-h4",
  // Indented, with the marker drawn in below — a bullet is how a reader knows
  // a line belongs to a list, and there is no `<ul>` here to supply one.
  listItem: "ps-4",
  // The line above the lead (E11-T9, `YEO-79`), drawn as it is drawn on the
  // article: indented and italic. `.hatnote` itself is not reused, because the
  // stylesheet's rule carries a bottom margin meant for sitting above a
  // paragraph, and in here every row supplies its own spacing.
  hatnote: "ps-4 italic",
  // A photograph's row is its alt text (E5-T3, `YEO-43`), which is a
  // description of the picture rather than words the author wrote into the
  // article — so it is set in the note size and muted, the way a caption is.
  // The picture itself is deliberately not rendered here: a diff of thirty
  // revisions would become thirty image fetches, each one a signed-URL
  // redirect, to say something the row already says in words.
  image: "text-note text-ink-muted",
};

/**
 * How a row is framed, by what happened to its block.
 *
 * Three signals per row, and only one of them is colour:
 *
 *   1. **The fill and the 4px left rule.** Blue for an addition, yellow for a
 *      removal — Wikipedia's diff palette, chosen there because red and green
 *      are the pair the most common colour blindness collapses (see the token
 *      block in `app/globals.css`).
 *   2. **The border style.** Solid where content genuinely arrived or left,
 *      dashed where it only moved. That is a difference a monochrome print,
 *      a screenshot and a high-contrast mode all keep.
 *   3. **The words.** `describeDiffStatus` is rendered as real text in the
 *      row, not as a `title` or an `aria-label`, so it survives all of the
 *      above *and* a screen reader.
 *
 * The ticket asks for additions and removals to be "visually distinct without
 * relying on colour alone". Strip the colour from this table and rows 2 and 3
 * still answer the question, which is the test that matters.
 */
const ROW_CLASS: Readonly<Record<ContentDiffStatus, string>> = {
  // No fill and no rule: unchanged blocks are context, and context that is
  // decorated as heavily as the changes stops the changes standing out. Muted
  // ink is the third distinction — the eye finds the darker rows first.
  unchanged: "border-transparent text-ink-muted",
  added: "border-solid border-diff-added-rule bg-diff-added",
  removed: "border-solid border-diff-removed-rule bg-diff-removed",
  // Neutral fill, dashed rule. A moved block was neither added nor removed,
  // and tinting it as either would be the confusion the ticket warns about.
  "moved-out": "border-dashed border-rule bg-panel",
  "moved-in": "border-dashed border-rule bg-panel",
};

/**
 * The gutter mark. Deliberately just `+` and `−`, with no glyph invented for a
 * move: at the position it prints, a moved block really has left (`−`) or
 * arrived (`+`), and the dashed frame and the words are what say the two ends
 * are the same content. An exotic arrow would be one more thing to decode, and
 * one more character to fall back to a tofu box in some font.
 */
const ROW_MARKER: Readonly<Record<ContentDiffStatus, string>> = {
  unchanged: "",
  added: "+",
  removed: "−",
  "moved-out": "−",
  "moved-in": "+",
};

export default async function CompareRevisionsPage({
  params,
  searchParams,
}: ComparePageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const from = singleParam(query.from);
  const to = singleParam(query.to);

  // A URL with only one revision in it does not name a comparison. This route
  // exists as the target of the history page's form, which always submits
  // both, so anything else here is a hand-edited or truncated link — the same
  // situation the sibling routes turn into a 404 rather than into an empty
  // state nobody arrives at legitimately.
  if (!from || !to) notFound();

  const loaded = await loadComparison(slug, from, to);
  if (!loaded) notFound();

  const { page, older, newer } = loaded;

  const historyHref = `/wiki/${encodeURIComponent(slug)}/history`;
  const rows = diffEntryContent(older, newer);
  const changed = hasContentChanges(rows);
  // The title is stored on the revision alongside the body, so renaming an
  // entry is a change between two revisions even when not one word of the
  // prose moved. The body diff cannot see it — it is not in `body_html` — so
  // it is reported separately rather than left for the reader to notice.
  const titleChanged = older.title !== newer.title;

  return (
    <main className="mx-auto max-w-content px-4 py-8 sm:px-6 sm:py-10">
      <h1>Comparing revisions: {page.title}</h1>

      <p className="mb-6 text-caption">
        <Link href={historyHref}>Return to revision history</Link>
        {" · "}
        <Link href={`/wiki/${encodeURIComponent(slug)}`}>
          Return to the current version
        </Link>
      </p>

      {/*
        The two ends of the comparison, named before anything is said about
        what changed between them. Ordered oldest-left, and labelled — a diff
        that does not say which side is which is a diff you cannot trust the
        direction of.
      */}
      <div className="mb-4 grid gap-4 rounded-panel border border-rule bg-wash px-4 py-3 sm:grid-cols-2">
        {[
          { label: "Older revision", revision: older },
          { label: "Newer revision", revision: newer },
        ].map(({ label, revision }) => (
          <div key={label}>
            <p className="text-note text-ink-muted">{label}</p>
            <p>
              <Link
                href={`/wiki/${encodeURIComponent(slug)}/history/${revision.id}`}
              >
                <time dateTime={revisionTimestampIso(revision.createdAt)}>
                  {formatRevisionTimestamp(revision.createdAt)}
                </time>
              </Link>
            </p>
            <p className="text-caption text-ink-muted">
              {formatRevisionAuthor(revision.createdBy)}
            </p>
          </div>
        ))}
      </div>

      {older.id === newer.id ? (
        /*
          Both radio buttons on the same row. Not an error — the URL is
          well-formed and the revision exists — so it gets an explanation and
          a way back rather than a 404.
        */
        <p className="text-caption text-ink-muted">
          These are the same revision. Choose two different ones on the{" "}
          <Link href={historyHref}>revision history</Link> to see what changed.
        </p>
      ) : (
        <>
          {titleChanged ? (
            <p className="mb-2">
              The title changed from <strong>{older.title}</strong> to{" "}
              <strong>{newer.title}</strong>.
            </p>
          ) : null}

          <p className="mb-4 text-caption text-ink-muted">
            {describeContentDiffSummary(summariseContentDiff(rows))} Headings,
            paragraphs and list items are compared whole, as they read — so a
            save that only changed the markup shows nothing.
          </p>

          {changed ? (
            /*
              One column, in document order, with the unchanged blocks left in
              between. Not two columns side by side: at this measure — 46em, a
              Wikipedia article's width — two columns of prose would each be
              too narrow to read, and the author would be comparing wrapped
              fragments rather than sentences. `role="list"` restores what
              Tailwind's preflight takes away, which Safari and VoiceOver need
              in order to announce the count.
            */
            <ol role="list" className="space-y-1">
              {rows.map((row, index) => (
                <li
                  // Rows are positional and a block's text can repeat within
                  // one diff, so the index is the identity here — there is no
                  // stabler key, and nothing about a row survives a re-render
                  // with different data anyway.
                  key={index}
                  className={`flex gap-3 border-s-4 px-3 py-1.5 ${ROW_CLASS[row.status]}`}
                >
                  {/*
                    Hidden from assistive technology on purpose: the label
                    below says "Added" in words, and a screen reader announcing
                    "plus" before it would be the same fact twice. Fixed width
                    and tabular so every row's text starts on the same column.
                  */}
                  <span
                    aria-hidden
                    className="w-3 shrink-0 select-none font-mono text-ink-muted"
                  >
                    {ROW_MARKER[row.status]}
                  </span>

                  <div className="min-w-0 flex-1">
                    {row.status === "unchanged" ? null : (
                      <p className="text-note text-ink-muted">
                        {describeDiffStatus(row.status)} ·{" "}
                        {describeBlockKind(row.block.kind)}
                      </p>
                    )}

                    {/*
                      `break-words`, matching the read route: a diff row holds
                      whatever was typed, including an unbroken URL wider than
                      the column.
                    */}
                    <p
                      className={`break-words ${BLOCK_TEXT_CLASS[row.block.kind]}`}
                    >
                      {row.block.kind === "listItem" ? (
                        <span aria-hidden className="-ms-4 pe-2 select-none">
                          {"•"}
                        </span>
                      ) : null}
                      {contentBlockText(row.block)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            /*
              The state that only a diff over rendered content can report, and
              the reason it is worth reporting: two revisions can hold
              byte-different HTML and identical content — a word wrapped in
              `<em>` and unwrapped again, or the copy `lib/save-page.ts` writes
              when the save button was pressed with nothing typed.

              It has to be said differently when the title moved, because the
              title is a change and it is reported a few lines above. "Nothing
              changed" printed under "the title changed from X to Y" reads as
              the page contradicting itself, even though the second sentence
              only ever meant the body.
            */
            <p className="text-caption text-ink-muted">
              {titleChanged
                ? "Apart from the title, nothing a reader can see changed between these two revisions."
                : "Nothing a reader can see changed between these two revisions."}{" "}
              The stored markup may differ, but the words, the headings and the
              list items are the same.
            </p>
          )}
        </>
      )}
    </main>
  );
}
