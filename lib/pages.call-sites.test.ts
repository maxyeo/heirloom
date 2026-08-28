import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { schema } from "@/db";
import * as livePages from "@/lib/live-pages";
import { read, SOURCE_DIRS, sourceFiles } from "@/test/route-inventory";

/**
 * `lib/pages.db.test.ts` and its siblings prove each query filters retired
 * entries out. This proves that a query *nobody thought about* cannot quietly
 * fail to (E1-T10, `YEO-122`).
 *
 * The shape is `lib/storage.call-sites.test.ts`'s, which in turn borrowed it
 * from `lib/sanitize-html.call-sites.test.ts` and `app/globals.test.ts`. Same
 * genre of invariant every time: a rule that is obvious while there is one
 * call site, and invisible by the time there are twelve.
 *
 * ## Why this one is worth the file
 *
 * Because every way of getting it wrong is silent. `YEO-122` added
 * `pages.deleted_at` and left a dozen modules issuing SQL against that table,
 * each of which had to decide what to do about it. A module that forgets
 * throws nothing, logs nothing, and looks right in review — it goes on
 * returning the rows it always returned. What a reader sees is an entry
 * somebody retired still sitting in search results, or still offered as a link
 * on a person's panel, and nothing anywhere connects that to the query that
 * did not ask.
 *
 * The worst version is not even visible to a reader. `lib/image-references.ts`
 * has the *opposite* obligation — it must go on seeing retired entries, or the
 * sweep reclaims their photographs and the backup does not carry photographs
 * (docs/backups.md). Somebody tidying the codebase by adding the filter
 * "everywhere it was missing" would be deleting a family's pictures, and the
 * only thing standing in their way is a paragraph. Now it is also this file.
 *
 * ## Why a file allowlist, and not `sanitize-html`'s marker scheme
 *
 * The marker-plus-register scheme next door is the better one, and it is
 * unavailable here. `dangerouslySetInnerHTML` is a single JSX attribute — one
 * syntax node an id can hang beside. `schema.pages` is not a call site: one
 * Drizzle query names it four or five times, in a `select` map, a `.from()`, a
 * `.where()` and a `.innerJoin()`, and there is no node type in the tree
 * meaning "a query". A marker per occurrence would be five markers per query,
 * and a marker per query has nothing to attach itself to.
 *
 * So the granularity available is the file, and what makes a file-level
 * exemption tolerable is what makes `lib/storage.call-sites.test.ts`'s
 * tolerable: it grants exactly the module named, with the argument beside it,
 * and a stale entry fails rather than lingering.
 *
 * ## What this can and cannot see
 *
 * A tripwire, not a proof — the same caveat both files it is modelled on
 * state, and here it has a specific shape worth naming rather than leaving to
 * be discovered.
 *
 * **The check is per file.** A module that names the predicate for query A can
 * gain an unfiltered query B without this noticing. There are two such reads
 * today and both are deliberate, so they are named here rather than left to be
 * found:
 *
 *   - `getPageBySlug` in `lib/pages.ts`, which must return the retired row so
 *     that `/wiki/[slug]` can render a tombstone rather than a 404;
 *   - the `already-linked` read-back in `lib/link-person-entry.ts`, which
 *     reads a link that already exists rather than making one, and where
 *     filtering would fall through and create a second entry about a person
 *     who has one.
 *
 * If that blind spot ever costs something, the upgrade is to count
 * `.from(schema.pages)` and `Join(schema.pages` occurrences per file against a
 * registered expected count. That is a real design and it is not built here,
 * because a count nobody can explain is worse than a rule everybody can.
 */

/** What a query names when it means this table. */
const TABLE = "schema.pages";

/**
 * The names `lib/live-pages.ts` exports, as they are written at a call site.
 */
const PREDICATES = ["LIVE_PAGES", "RETIRED_PAGES"] as const;

/**
 * The column itself, for the modules that read it rather than filter on it.
 */
const COLUMN = "deletedAt";

/**
 * What counts as having decided.
 *
 * ## Why the rule is not "everybody filters"
 *
 * That was the first draft of this file and it was wrong, and the way it was
 * wrong is worth keeping, because the guard found it: three modules failed
 * that were behaving exactly as E1-T10 asks them to. The ticket's own table
 * has **three** correct answers, not one, and a rule admitting only the first
 * would have pushed the other two into `EXEMPT` — where a genuinely missing
 * filter would then have been invisible, which is the opposite of the point.
 *
 *   - **Filter.** `lib/pages.ts`'s list reads, `lib/categories.ts`,
 *     `lib/namesakes.ts`, `lib/entry-infobox.ts`, `lib/recent-changes.ts`,
 *     `lib/link-person-entry.ts`. These name `LIVE_PAGES`.
 *   - **Look for the retired one on purpose.** `lib/create-page.ts`, which
 *     offers an author their own retired entry back instead of minting a
 *     near-twin beside it. This names `RETIRED_PAGES`.
 *   - **Read the row and refuse it by name.** `lib/save-page.ts` and
 *     `lib/restore-revision.ts`, which cannot filter: they have to tell "this
 *     entry is retired" from "there is no entry here" in order to say which,
 *     and a filtered query collapses the two into one silence. These select
 *     the column and branch on it inside the lock they already hold.
 *
 * So the invariant this file actually guards is the one the ticket states:
 * *every module that queries `pages` has made a decision about `deleted_at`*.
 * Naming one of these three tokens is the evidence of a decision — they exist
 * for no other reason — and the two modules that must not decide are named in
 * `EXEMPT` with the argument for each.
 *
 * The looseness is real and is the tripwire caveat again: a module could name
 * the column in a docblock and filter nowhere. That is not the realistic
 * failure. The realistic failure is a new query written by somebody who has
 * never heard of `deleted_at`, and this catches every one of those.
 */
const DECISION_TOKENS = [...PREDICATES, COLUMN];

/**
 * file -> why it names `schema.pages` without the predicate.
 *
 * Exactly two, and both are exempt because filtering here would be a *bug*
 * rather than because filtering is merely unnecessary. That distinction is the
 * bar for adding a third: a module that simply has no opinion about retired
 * entries is a module that has not thought about them yet.
 */
const EXEMPT: Record<string, string> = {
  /**
   * **Must not filter**, and this is the trap E1-T10 is mostly about.
   *
   * An image counts as referenced if any body or revision mentions it, and a
   * retirement is reversible — so a retired entry's body refers to its
   * photographs exactly as much as a superseded revision's does. Filter them
   * out and retiring an entry makes its pictures unreferenced, the next
   * `npm run db:images-sweep --delete` reclaims them, and the restore months
   * later brings the paragraphs back around broken `<img>` tags — baked, by
   * then, into append-only revision rows that can never be edited. The files
   * are not recoverable: the nightly backup carries the rows that point at
   * images and never the images themselves
   * (docs/backups.md#what-is-not-in-these-backups).
   *
   * `lib/image-references.db.test.ts` is the assertion; this is the guard
   * against somebody adding the filter for consistency.
   */
  [join("lib", "image-references.ts")]:
    "a retired entry's body still references its photographs — see §2 of E1-T10",

  /**
   * **Must not filter**, and must carry the columns.
   *
   * An archive is what the family is left holding if the database is lost, so
   * anything it leaves out is destroyed rather than hidden. A retired entry's
   * row, its revisions and its photographs are all still here and all still
   * restorable by an `UPDATE`, so all three belong in the file.
   *
   * The second half is quieter and worse: `deleted_at` has to travel *with*
   * the rows, or a restore comes back as a wiki in which every retirement any
   * member ever made has been silently undone. Nothing about that restore
   * would look wrong at the time.
   */
  [join("lib", "export-full.ts")]:
    "the archive carries retired rows and the deleted_at column — see §1 of E1-T10",
};

/**
 * Whether this file is a test.
 *
 * Filtered out by rule rather than by fifteen entries in `EXEMPT` above, and
 * the rule has an argument. A `.db.test.ts` file's whole job is to insert
 * fixture rows, retire them, assert on them and delete them again in
 * `afterAll` — every one of those names `schema.pages` and none of them is a
 * read that shows anybody anything. Requiring each to name the predicate would
 * turn every teardown into an exemption, and a register of fifteen exemptions
 * is a register nobody reads.
 */
function isTest(file: string): boolean {
  return file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

describe("queries against schema.pages", () => {
  const files = sourceFiles(SOURCE_DIRS).filter((file) => !isTest(file));

  /** Every non-test source file that names the table, with its text. */
  const mentions = files
    .map((file) => ({ file, source: read(file) }))
    .filter(({ source }) => source.includes(TABLE));

  it("scans the source tree", () => {
    // A guard that scans nothing passes for the wrong reason — a renamed
    // directory would otherwise turn this file green and useless. `db` and
    // `test` are outside `SOURCE_DIRS` and that is deliberate rather than
    // inherited: this rule is about what the application shows a reader, and
    // `db/seed.ts` empties the table while `test/db-timestamps.ts` backdates a
    // fixture. Neither is a read anybody sees the results of.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join("lib", "pages.ts"));
  });

  it("finds the query sites, so the guard below is not vacuous", () => {
    // Four of the twelve, named rather than counted. If any of these stops
    // naming the table, the module has been rewritten and the assertion below
    // has stopped meaning what it says — look at it rather than delete it.
    const found = mentions.map(({ file }) => file);

    expect(found).toContain(join("lib", "pages.ts"));
    expect(found).toContain(join("lib", "categories.ts"));
    expect(found).toContain(join("lib", "namesakes.ts"));
    expect(found).toContain(join("lib", "recent-changes.ts"));
  });

  it("leaves no unexempt query undecided about deleted_at", () => {
    const offenders = mentions
      .filter(({ file }) => !Object.hasOwn(EXEMPT, file))
      .filter(({ source }) => !DECISION_TOKENS.some((t) => source.includes(t)))
      .map(({ file }) => file);

    // Pick one of the three answers in `DECISION_TOKENS` above and write it
    // down. Almost always that is `LIVE_PAGES` from `@/lib/live-pages` — and
    // if the query *joins* `pages`, it goes in the `ON` clause rather than the
    // `WHERE`, which is not the same thing: `NULL IS NULL` is true, so a
    // `WHERE` on a left join reaches the right answer by accident and the
    // wrong one as soon as anybody makes the join inner.
    //
    // If the module genuinely must see retired entries, that is an argument to
    // make in `EXEMPT` above rather than a filter to leave out — and the bar
    // is the one both entries there meet: filtering would be a *bug*, not
    // merely unnecessary.
    expect(offenders).toEqual([]);
  });

  it("names predicates the module actually exports", () => {
    // Without this, renaming an export of `lib/live-pages.ts` — or adding a
    // third — would be a self-service pass: the guard above accepts any file
    // containing one of these strings, and nothing else checks that the
    // strings still mean anything. A renamed `LIVE_PAGES` would leave every
    // filtered module naming a token that no longer exists, and this file
    // would go on approving all of them.
    //
    // Importing the module here is safe under `npm test`, which deliberately
    // has no `DATABASE_URL`: `db/index.ts` connects lazily behind a Proxy, so
    // naming a column opens no socket. That is the same property CI's `check`
    // job proves of `npm run build`.
    expect(Object.keys(livePages).sort()).toEqual([...PREDICATES].sort());
  });

  it("keeps the column spelled the way the schema spells it", () => {
    // The other half of the pair above, for the third token. `deletedAt` is a
    // property name rather than an import, so nothing but this would notice it
    // being renamed — and a renamed column would leave `lib/save-page.ts` and
    // `lib/restore-revision.ts` passing this guard by naming a field that no
    // longer exists, which is precisely the two modules whose refusal is the
    // acceptance criterion.
    expect(Object.keys(schema.pages)).toContain(COLUMN);
  });

  it("keeps no exemption that has stopped naming the table", () => {
    // The failure this pair is really here for. An entry matching nothing is
    // not harmless: it is an argument nobody has to make again, sitting where
    // the next person who wants to skip the filter will find it and widen it.
    // The same check catches a rename, where the key names a file that is no
    // longer there and has stopped exempting anything at all.
    const stale = Object.keys(EXEMPT).filter(
      (file) => !mentions.some((mention) => mention.file === file),
    );

    expect(stale).toEqual([]);
  });
});
