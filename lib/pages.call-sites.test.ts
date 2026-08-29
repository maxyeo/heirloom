import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { schema } from "@/db";
import * as livePages from "@/lib/live-pages";
import type { SchemaAccess, SchemaImport } from "@/test/route-inventory";
import {
  read,
  schemaAccess,
  schemaAccessOfSource,
  SOURCE_DIRS,
  sourceFiles,
} from "@/test/route-inventory";

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
 * state, and here it has two specific shapes worth naming rather than leaving
 * to be discovered. One of them is closed below; the other is not.
 *
 * **The spelling is asserted, not assumed** (`YEO-124`). The scan finds its
 * candidates by the text `schema.pages`, so on its own it would see only the
 * modules that happen to be written that way. A module written as
 * `import { pages } from "@/db/schema"` queries the same table and never
 * enters the candidate set at all — not exempt-but-unlisted, which the stale
 * check below would catch, but *invisible*, with this file green while an
 * unfiltered reader ships. Nobody has to be careless to write it: the bare
 * import is the more idiomatic Drizzle style, and it reviews as correct code.
 *
 * So rather than teach the scan every spelling, the last assertion here
 * forbids the others, and `schema.pages` becomes the only way to reach the
 * table by construction. That is the cheaper half of the trade and the better
 * one: it makes a convention every module already follows explicit instead of
 * merely prevalent, and it leaves the scan above complete rather than nearly
 * complete.
 *
 * **The check is per file**, and this one stays open. A module that names the
 * predicate for query A can gain an unfiltered query B without this noticing.
 * There are two such reads today and both are deliberate, so they are named
 * here rather than left to be found:
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
 *
 * **Test files are out of scope by construction**, not by coincidence
 * (`YEO-130`). `!isTest(file)` below removes them from the population both
 * halves of this file read, and since `YEO-127` that filter is the only thing
 * standing between the spelling rule and a real file in this tree:
 * `lib/relationship-derivation.test.ts` opens with
 * `import * as schema from "@/db/schema"`, which the rule now names as a door
 * and would report. It would not have before `YEO-127`, when the
 * discriminator read the local binding alone and that import lands on
 * `schema` like the canonical one does. So an exclusion that used to keep out
 * a shape the rule waved through anyway now keeps out a specific file the
 * rule would fail on, and narrowing `isTest` has quietly become a breaking
 * change rather than a tidy-up. `TESTS_THE_RULE_WOULD_REPORT` below records
 * which file and why, and fails out loud if either stops being so.
 *
 * Two smaller things it does not do, for the record. It guards `pages` and no
 * other table — `revisions` and `page_categories` have no soft delete of
 * their own to forget, so there is nothing yet for the same rule to protect
 * there. And the spelling rule covers `SOURCE_DIRS` minus tests, which is the
 * same population the scan covers; `db/` and `test/` may spell the schema
 * however they like, for the reason `isTest` gives below.
 */

/**
 * What a query names when it means this table — and, since `YEO-124`, the
 * only thing it may name. `otherDoors` below is what makes that true.
 */
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
 *
 * That argument is about the scan. Since `YEO-127` this filter is load-bearing
 * for the spelling rule as well, and for one file that exists rather than for
 * a shape nobody has written — `TESTS_THE_RULE_WOULD_REPORT` below is the
 * record of which, and the block at the end of this file is what keeps the
 * record honest (`YEO-130`).
 */
function isTest(file: string): boolean {
  return file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

/**
 * Every test under `SOURCE_DIRS` that `isTest` excludes and the spelling rule
 * would otherwise report, with the argument for each (`YEO-130`).
 *
 * `EXEMPT`'s shape, for `EXEMPT`'s reason: an exclusion worth keeping is one
 * somebody can read the case for. The difference is that `EXEMPT` is consulted
 * by a rule and this is not — `!isTest(file)` has already removed these files
 * before anything here is read, and deleting this constant would change no
 * verdict. What it buys is the failure. The block at the end of this file
 * asserts the list is exact, so a contributor who narrows `isTest` for an
 * unrelated reason, or writes a second test in this shape, meets an assertion
 * with the argument attached instead of a red suite in a file they were not
 * editing.
 *
 * It is worth having now and was not before. Until `YEO-127` the rule could
 * not tell `import * as schema from "@/db/schema"` from
 * `import { schema } from "@/db"` — it discriminated on the local binding and
 * both land on `schema` — so the entry below names a shape the rule as it
 * then stood would have waved through even in scope. Teaching the rule
 * the difference is what turned this exclusion from a convenience into a
 * guarantee, and a guarantee nobody wrote down is one somebody removes.
 */
const TESTS_THE_RULE_WOULD_REPORT: Record<string, string> = {
  [join("lib", "relationship-derivation.test.ts")]:
    "enumerates the schema's own exports with `Object.values` to prove no " +
    "table stores a relationship, and reaches `@/db/schema` rather than " +
    "`@/db` so that the client module stays out of the import graph of a " +
    "file that must run with no DATABASE_URL — see its header",
};

/**
 * The local name the schema must be bound to.
 *
 * Every module of the application that reaches the schema at all binds it
 * this way today, which is why the scan above works. Requiring the *name*
 * rather than the import is what closes the alias: `import { schema as s }`
 * reaches the same table through `s.pages`, and a rule about the module
 * specifier alone would wave it through.
 */
const CANONICAL_BINDING = "schema";

/** The table's own name in `db/schema.ts`, as a bare import would spell it. */
const TABLE_EXPORT = "pages";

/**
 * How `schemaAccess` spells a default import (`YEO-127`).
 *
 * Neither `@/db` nor `@/db/schema` has a default export, so there is no module
 * anybody could write that lands here, and against the tree this clause never
 * fires. It is in the rule anyway, because the alternative is a checker that
 * carefully records the shape and a rule that quietly throws it away.
 * `test/route-inventory.ts` argues for the recording on the grounds that
 * dropping the unexpected is the hole this whole guard exists to close — and
 * that argument only holds while something downstream is listening. Adding a
 * default export to either module is a one-line change; the rule should
 * already know what to say on the day somebody makes it.
 */
const DEFAULT_EXPORT = "default";

/**
 * Every way this module could reach `pages` that the scan above cannot see.
 *
 * Four doors. The argument for treating them alike is that a reader of the
 * scan has no way to tell which one a module used: each reaches the same rows
 * and none of them contains the text the scan looks for. Three can be written
 * against the modules as they stand today; the fourth is here so that it is
 * never the shape that was recorded and then dropped.
 *
 *   - **A bare table import**, `import { pages } from "@/db/schema"`, under
 *     any alias. This is the one `YEO-124` was filed about and the one a
 *     contributor writes without meaning anything by it.
 *   - **The schema under another name**, whether aliased out of `@/db` or
 *     taken as a namespace off `@/db/schema` — and that second one counts
 *     even when the name it lands on is `schema` itself, which is a different
 *     module reached a different way rather than the canonical import it
 *     resembles. `import * as db from "@/db"` is *not* here: it spells the
 *     table `db.schema.pages`, which the scan finds.
 *   - **A default import** from either module, which nothing can spell today
 *     and which is a door the moment something can. `DEFAULT_EXPORT` is the
 *     argument for keeping it in the rule while it is unreachable.
 *   - **`db.query.pages`**, Drizzle's relational API, which names the table
 *     without naming the schema at all. Nothing uses it today and it is a
 *     door rather than a hypothetical — the client is constructed with the
 *     schema (`db/index.ts`), so it works, and it is what the Drizzle
 *     documentation reaches for first.
 *
 * Type-only imports are dropped: a type cannot issue a query, and
 * `import type { Page } from "@/db/schema"` is a reasonable line to write.
 * Everything else about a module's schema imports is left alone —
 * `lib/pages.ts` imports `SEARCH_TEXT_CONFIG` from `@/db/schema` and that is
 * a string constant, not a way to the table.
 */
function otherDoors({ imports, relational }: SchemaAccess): string[] {
  const reachesSchema = ({ module, exported }: SchemaImport) =>
    (module === "@/db/schema" && exported === "*") ||
    (module === "@/db" && exported === CANONICAL_BINDING);

  /**
   * The one import that reaches the schema and is not a door: `schema`, out
   * of `@/db`, bound to `schema`.
   *
   * All three parts are load-bearing, and testing the local name on its own
   * was the bug `YEO-127` closed. `import * as schema from "@/db/schema"`
   * also leaves the schema bound to `schema`, so a rule reading only the
   * binding waved it through — while the docblock above listed it as a door.
   * It was covered in practice, because any use of it spells `schema.pages`
   * and the text scan finds that; but covered by the older guard, by
   * coincidence of spelling, rather than by the rule that claims it.
   */
  const isCanonicalImport = (entry: SchemaImport) =>
    entry.module === "@/db" &&
    entry.exported === CANONICAL_BINDING &&
    entry.local === CANONICAL_BINDING;

  const doors = imports
    .filter((entry) => !entry.typeOnly)
    .filter(
      (entry) =>
        entry.exported === TABLE_EXPORT ||
        entry.exported === DEFAULT_EXPORT ||
        (reachesSchema(entry) && !isCanonicalImport(entry)),
    )
    .map(({ module, exported, local }) => {
      const binding =
        exported === DEFAULT_EXPORT
          ? local
          : exported === "*"
            ? `* as ${local}`
            : exported === local
              ? `{ ${exported} }`
              : `{ ${exported} as ${local} }`;
      return `import ${binding} from "${module}"`;
    });

  return [...doors, ...relational];
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

  it("leaves the table one spelling, so the scan is not merely lucky", () => {
    // Every other assertion in this file starts from `mentions`, and
    // `mentions` starts from a string. This one runs over *every* source
    // file, including the ones that never name the table, because a module
    // that has found another door is precisely a module the string cannot
    // find. It is the assertion the rest of the file rests on.
    //
    // Nothing fails it today and nothing had to change for that (`YEO-124`).
    // What every module that reaches the schema already does is bind it as
    // `schema` out of `@/db`. Most write `{ db, schema }`, because most have
    // a query to run; `lib/live-pages.ts` writes `{ schema }` alone, since it
    // builds predicates and never issues SQL. The rule is about that binding
    // and not about the rest of the import clause, so it reads the two as the
    // same door — which is the accurate version of a sentence that used to
    // claim the whole application wrote `{ db, schema }` (`YEO-127`). The
    // point is that the door is now the only one.
    const offenders = files.flatMap((file) =>
      otherDoors(schemaAccess(file)).map((door) => `${file}: ${door}`),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * What the file set leaves out, asserted rather than described (`YEO-130`).
   *
   * Every other block here proves something about the files this one scans.
   * This proves the one thing worth knowing about the file it does not: that
   * `!isTest(file)` is load-bearing, for which file, and that nothing else has
   * quietly joined it. Without this the assertion above passes for two
   * different reasons that look identical from the outside — because the tree
   * is clean, and because the one file that is not was filtered out first.
   *
   * The omission is deliberate and stays deliberate. A derivation test that
   * reads table metadata is not a way the application shows anybody a retired
   * entry, which is the only thing this file is about.
   */
  describe("the tests the file set leaves out", () => {
    const scanned = sourceFiles(SOURCE_DIRS);
    const tests = scanned.filter(isTest);
    const recorded = Object.keys(TESTS_THE_RULE_WOULD_REPORT);

    it("keeps no record of a file that is no longer there", () => {
      // `EXEMPT`'s stale check, for `EXEMPT`'s reason: an argument nobody has
      // to make again is an argument the next person widens. A rename leaves
      // the key naming nothing, and the exclusion undocumented again.
      const stale = recorded.filter((file) => !tests.includes(file));

      expect(stale).toEqual([]);
    });

    it("excludes them by rule, not by their being outside the tree", () => {
      // The premise, and the half a reader would otherwise have to take on
      // trust. `sourceFiles` enumerates these exactly as it enumerates every
      // module the scan reads; `!isTest` is the whole of the difference.
      for (const file of recorded) {
        expect(scanned).toContain(file);
        expect(files).not.toContain(file);
      }
    });

    it("names every test the rule would report, and no others", () => {
      // The assertion that makes narrowing `isTest` a decision rather than an
      // accident. A new test written in one of `otherDoors`' shapes fails
      // here, where the argument for excluding it is, rather than in the
      // block above once somebody tightens the file set for another reason.
      const reported = tests.filter(
        (file) => otherDoors(schemaAccess(file)).length > 0,
      );

      expect(reported.sort()).toEqual([...recorded].sort());
    });

    it("reports the shape `YEO-127` closed, spelled out", () => {
      // Named rather than counted, because the count is what the entry costs
      // and the spelling is what it is about: this is exactly the namespace
      // import the fixture below pins, in a real file, reached through
      // `schemaAccess` rather than a string.
      expect(
        otherDoors(
          schemaAccess(join("lib", "relationship-derivation.test.ts")),
        ),
      ).toEqual(['import * as schema from "@/db/schema"']);
    });
  });
});

/**
 * The spelling rule, against fixtures rather than the tree (`YEO-124`).
 *
 * The assertion above passes over a repository where every module is already
 * written the right way, which means it has never once executed the branch
 * that finds something. A guard in that state is indistinguishable from a
 * guard that returns the empty list — and this one exists to catch a spelling
 * nobody has written yet, so the tree will never supply the case.
 *
 * Each fixture below is a module that queries `pages` correctly, compiles,
 * and would review as fine.
 */
describe("a module that reaches pages another way", () => {
  /**
   * The shape `YEO-124` is about. Idiomatic Drizzle, and the first thing the
   * documentation shows.
   */
  const BARE_IMPORT = `
    import { eq } from "drizzle-orm";

    import { db } from "@/db";
    import { pages } from "@/db/schema";

    export async function listEntries() {
      return db.select().from(pages).where(eq(pages.slug, "x"));
    }
  `;

  it("is invisible to the scan above", () => {
    // The premise. If this ever stops holding, the scan has grown to cover
    // the spelling itself and the rule below is the belt to its braces —
    // which is fine, but somebody should decide that on purpose.
    expect(BARE_IMPORT).not.toContain(TABLE);
  });

  it("is caught by the spelling rule anyway", () => {
    expect(otherDoors(schemaAccessOfSource(BARE_IMPORT))).toEqual([
      'import { pages } from "@/db/schema"',
    ]);
  });

  it("is caught under an alias, which is the same import", () => {
    const source = `
      import { pages as entries } from "@/db/schema";
      export const all = () => entries;
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([
      'import { pages as entries } from "@/db/schema"',
    ]);
  });

  it("is caught when the schema itself is renamed", () => {
    const source = `
      import { schema as tables } from "@/db";
      export const all = () => tables.pages;
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([
      'import { schema as tables } from "@/db"',
    ]);
  });

  it("is caught when the schema is taken as a namespace under another name", () => {
    const source = `
      import * as tables from "@/db/schema";
      export const all = () => tables.pages;
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([
      'import * as tables from "@/db/schema"',
    ]);
  });

  it("is caught as a namespace that lands on `schema`, the canonical name", () => {
    // The overlap `YEO-127` closed. This module was covered before the fix —
    // but by the text scan, which sees `schema.pages` and cannot tell which
    // module the `schema` came from, rather than by the rule that lists a
    // namespace off `@/db/schema` among its doors. Two guards agreeing by
    // coincidence of spelling is not either of them being right, and the
    // coincidence holds only for as long as the module writes `schema.pages`
    // somewhere the scan can read it.
    const source = `
      import * as schema from "@/db/schema";
      export const all = () => schema.pages;
    `;
    expect(source).toContain(TABLE);
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([
      'import * as schema from "@/db/schema"',
    ]);
  });

  it("is caught as a default import, which neither module offers yet", () => {
    // Unwritable against `@/db` as it stands — there is no default export to
    // bind — so this fixture is the only place the `DEFAULT_EXPORT` clause is
    // ever executed, and the only thing that makes the recorder's refusal to
    // drop the shape (`test/route-inventory.ts`) worth anything. Before
    // `YEO-127` the recording was real and the reporting was not.
    const source = `
      import database from "@/db";
      export const all = () => database.schema.pages;
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([
      'import database from "@/db"',
    ]);
  });

  it("is caught through the relational query API", () => {
    const source = `
      import { db } from "@/db";
      export const all = () => db.query.pages.findMany();
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([
      "db.query.pages",
    ]);
  });
});

/**
 * The other half, and the half a rule like this is usually deleted over: a
 * false failure against code that is written exactly as asked. Each of these
 * exists in the repository today.
 */
describe("a module the spelling rule must leave alone", () => {
  it("the spelling every module uses", () => {
    const source = `
      import { db, schema } from "@/db";
      import { LIVE_PAGES } from "@/lib/live-pages";
      export const all = () =>
        db.select().from(schema.pages).where(LIVE_PAGES);
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([]);
  });

  it("the schema without the client, which is `lib/live-pages.ts`", () => {
    // The opening of `lib/live-pages.ts`, and the module that makes the
    // sentence "the whole application imports `{ db, schema }`" false
    // (`YEO-127`). It has no use for the client because it exports predicates
    // rather than running queries. The rule asks what the schema is bound to,
    // not what else came with it.
    const source = `
      import { isNull } from "drizzle-orm";
      import { schema } from "@/db";
      export const LIVE_PAGES = isNull(schema.pages.deletedAt);
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([]);
  });

  it("a constant imported from the schema module", () => {
    // `lib/pages.ts` line for line. `SEARCH_TEXT_CONFIG` is a string, and a
    // rule that made reaching for it a violation would be a rule about
    // imports rather than about the table.
    const source = `
      import { db, schema } from "@/db";
      import { SEARCH_TEXT_CONFIG } from "@/db/schema";
      export const config = SEARCH_TEXT_CONFIG;
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([]);
  });

  it("a type-only import of the table's row", () => {
    const source = `
      import type { pages } from "@/db/schema";
      export type Row = typeof pages.$inferSelect;
    `;
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([]);
  });

  it("the whole of @/db as a namespace, which spells the table in full", () => {
    const source = `
      import * as database from "@/db";
      export const all = () => database.db.select().from(database.schema.pages);
    `;
    expect(source).toContain(TABLE);
    expect(otherDoors(schemaAccessOfSource(source))).toEqual([]);
  });
});
