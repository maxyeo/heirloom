import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  actionSourceFiles,
  appSourceFiles,
  footprintUsage,
  footprintUsageOfSource,
  repositorySources,
  SOURCE_DIRS,
  sourceFiles,
  uncategorisedCodeDirs,
  unscannedSources,
} from "@/test/route-inventory";

/**
 * The footprint every scanner in this repository walks (`YEO-100`,
 * `YEO-102`).
 *
 * `app/auth-boundary.test.ts` and `lib/sanitize-html.call-sites.test.ts` are
 * each thorough about the files they are given and say nothing whatever about
 * the files they are not. Which files those are was, until `YEO-100`, two
 * constants in two modules and a comment in each asking the reader to believe
 * they agreed — and an extension list that no assertion depended on, so a
 * `.jsx` component could have rendered anything at all and both suites would
 * have stayed green while covering strictly less ground than the day before.
 *
 * A blind spot that fails green is worth a test of its own, because it is the
 * kind that is never noticed by the person who opens it.
 *
 * `YEO-100` closed that for two files and added a guard so a third copy could
 * not appear. The guard was a hand-written array of the same two names, and
 * two other scanners — `app/globals.test.ts` and
 * `lib/storage.call-sites.test.ts` — were already doing everything it
 * forbade, in silence, because nobody had typed them into it. `YEO-102`
 * derives the guard's subject list instead: it is every module the repository
 * holds, and a scanner is answerable to it the moment it exists.
 */

describe("unscannedSources", () => {
  it("names the JavaScript a tripwire here cannot read", () => {
    // Not reachable from the real tree — see the last test in this file, which
    // is the assertion that it stays that way. So this is the only place the
    // refusal branch is ever executed.
    expect(
      unscannedSources([
        "Component.jsx",
        "helper.js",
        "esm-only.mjs",
        "legacy.cjs",
      ]),
    ).toEqual(["Component.jsx", "helper.js", "esm-only.mjs", "legacy.cjs"]);
  });

  it("passes over TypeScript, including the module-suffixed spellings", () => {
    // `.mts` and `.cts` are named by `SOURCE_EXTENSIONS`, so they are scanned
    // rather than refused. Asserted rather than left to the reader: it is the
    // one case where the two lists could overlap, and this decides which way
    // it goes.
    expect(
      unscannedSources(["page.tsx", "lib.ts", "node.mts", "node.cts"]),
    ).toEqual([]);
  });

  it("says nothing about files that were never source", () => {
    // A stylesheet or a fixture is not a gap in a scanner of TypeScript.
    expect(
      unscannedSources(["globals.css", "tokens.json", "README.md", "logo.svg"]),
    ).toEqual([]);
  });

  it("sees a file nested anywhere under the directory", () => {
    // `readdirSync(recursive)` yields paths, not basenames, and a `.js` buried
    // three levels down is exactly as invisible as one at the top.
    expect(unscannedSources([`wiki${sep}[slug]${sep}chart.js`])).toEqual([
      `wiki${sep}[slug]${sep}chart.js`,
    ]);
  });
});

describe("sourceFiles", () => {
  /**
   * Everything the guard below has an opinion about: every module in the
   * repository, whether or not anyone thinks of it as a scanner.
   *
   * `repositorySources` and not `sourceFiles`, and the difference is the whole
   * lesson of `YEO-102`. Two of the walkers named in `NOT_A_SOURCE_FOOTPRINT`
   * live outside `SOURCE_DIRS`, one of them is `test/route-inventory.ts`
   * itself, and a guard that cannot see the file it is guarding is not a
   * guard. Nothing stops the next one being a script at the repository root,
   * or being written in JavaScript.
   */
  const candidates = repositorySources();

  /**
   * Files that walk a directory tree of their own, and why each is not a
   * second answer to "where is the source".
   *
   * A map rather than a set, because the reason is the whole value of the
   * entry: the failure this guards against is somebody silencing it with a
   * filename, and a filename with no argument beside it is exactly what that
   * looks like. `lib/storage.call-sites.test.ts`' `ALLOWED` is the same shape
   * for the same reason.
   */
  const NOT_A_SOURCE_FOOTPRINT: Record<string, string> = {
    /**
     * The shared list and the shared walk themselves. This is the one place
     * both are allowed to exist, which is the entire property under test.
     */
    [join("test", "route-inventory.ts")]:
      "declares SOURCE_DIRS and holds the only readdirSync of the source tree",

    /**
     * Walks `app/wiki` for its directory *children*, to check that no static
     * segment has quietly taken an address entries resolve to. It is asking
     * about one route's shape, not about where source lives — the answer would
     * not change if `SOURCE_DIRS` grew a directory, and it would be wrong if
     * this used it.
     */
    [join("lib", "entry-slug.test.ts")]:
      "walks app/wiki for route segments, not the source tree",

    /**
     * Counts the `.sql` files in `drizzle/`, to compare against how far
     * through the migrations the database says it is. `drizzle/` is generated
     * output holding no TypeScript, so it is in neither list and belongs in
     * neither.
     */
    [join("lib", "export-full.db.test.ts")]:
      "counts migrations in drizzle/, which is generated SQL",
  };

  it("is the one footprint both tripwires scan", () => {
    // Close to tautological today, and worth being honest about:
    // `actionSourceFiles` is one line and that line is
    // `sourceFiles(SOURCE_DIRS)`, so what this pins is that the line stays
    // that. That is a smaller claim than "both tripwires agree" but not an
    // empty one. `app/auth-boundary.test.ts` reaches the tree through
    // `actionSourceFiles` and `lib/sanitize-html.call-sites.test.ts` through
    // `sourceFiles(SOURCE_DIRS)`, so giving the route half a footprint of its
    // own is a one-line edit that looks local and makes one guard quietly
    // narrower than the other. The tests above check the list is right; this
    // checks there is one.
    expect(actionSourceFiles()).toEqual(sourceFiles(SOURCE_DIRS));
  });

  it("is the only walk of the tree, and the only list of where it is", () => {
    // The drift `YEO-100` closed was not a wrong value, it was two right ones
    // that nothing obliged to stay equal. Once every scanner imports the list,
    // the only way back to that state is for somebody to write a second one or
    // walk the tree themselves to feed it — both of which are things you can
    // look for.
    //
    // What `YEO-100` could not do was know who to look at: its subject list was
    // two filenames typed out by hand, and the two scanners it did not name
    // were both already offenders. So the subject is derived — every module
    // this repository holds — and a new scanner is answerable to this the
    // moment it is written rather than the moment somebody remembers to add it
    // here.
    const offenders = candidates
      .filter((file) => !Object.hasOwn(NOT_A_SOURCE_FOOTPRINT, file))
      .map((file) => ({ file, usage: footprintUsage(file) }))
      .filter(
        ({ usage }) =>
          usage.walks.length > 0 || usage.directoryLists.length > 0,
      )
      .map(
        ({ file, usage }) =>
          `${file}: ${[
            ...usage.walks.map((call) => `${call}()`),
            ...usage.directoryLists.map((list) => `[${list.join(", ")}]`),
          ].join(", ")}`,
      );

    // Take the directories from `test/route-inventory.ts` — `SOURCE_DIRS` if
    // the question is about application code, `CODE_DIRS` if it is about
    // everything this repository builds — and enumerate with `sourceFiles` or,
    // if you need extensions it refuses, `filesUnder`. If what you are walking
    // is genuinely not the source tree, say so in `NOT_A_SOURCE_FOOTPRINT`.
    expect(offenders).toEqual([]);
  });

  it("keeps no exemption that has stopped being one", () => {
    // An exemption for a file that no longer walks anything is indistinguishable
    // from an exemption for one that does, and the next reader inherits both.
    // The same check catches a rename: a key naming a file that is no longer
    // there has stopped exempting anything at all.
    const stale = Object.keys(NOT_A_SOURCE_FOOTPRINT).filter((file) => {
      if (!candidates.includes(file)) return true;
      const usage = footprintUsage(file);
      return usage.walks.length === 0 && usage.directoryLists.length === 0;
    });

    expect(stale).toEqual([]);
  });

  it("sees both shapes of a private footprint", () => {
    // Neither branch is reachable from a repository in the state the test above
    // insists on, so these fixtures are the only place they run. Without them
    // the guard could stop finding anything at all and every assertion above
    // would go on passing.
    expect(
      footprintUsageOfSource('const files = readdirSync("app");').walks,
    ).toEqual(["readdirSync"]);
    expect(
      footprintUsageOfSource('const files = fs.readdirSync("app");').walks,
    ).toEqual(["readdirSync"]);
    // Built from `SOURCE_DIRS` and compared against a spread of it rather than
    // typed out, and not for tidiness: a literal `["app", "components", "lib"]`
    // anywhere in this file is a directory list, and the guard above would find
    // it here and be right to. A fixture that has to be exempted from the
    // property it demonstrates is not much of a fixture.
    expect(
      footprintUsageOfSource(`const dirs = ${JSON.stringify(SOURCE_DIRS)};`)
        .directoryLists,
    ).toEqual([[...SOURCE_DIRS]]);
  });

  it("mistakes neither prose nor a list of files for a footprint", () => {
    // Why this reads the syntax tree rather than the source text. `YEO-100`'s
    // guard was a `toContain("readdirSync")`, which cannot tell a call from
    // `lib/storage.ts`'s docblock about how `readdir` takes a prefix — and a
    // list of *files* is what every one of these scanners legitimately has.
    expect(
      footprintUsageOfSource("// readdirSync is what we do not do here.").walks,
    ).toEqual([]);
    expect(footprintUsageOfSource('const note = "readdirSync";').walks).toEqual(
      [],
    );
    expect(
      footprintUsageOfSource('const exempt = [join("app", "globals.css")];')
        .directoryLists,
    ).toEqual([]);
    expect(
      footprintUsageOfSource('const packages = ["sanitize-html"];')
        .directoryLists,
    ).toEqual([]);
  });

  it("covers every directory it claims to", () => {
    const files = sourceFiles();

    // A directory that has been renamed away enumerates nothing and takes its
    // half of both tripwires with it, silently.
    for (const dir of SOURCE_DIRS) {
      expect(
        files.filter((file) => file.startsWith(`${dir}${sep}`)).length,
      ).toBeGreaterThan(0);
    }

    // `app/` is scanned by the route half as well, through the same enumerator.
    expect(appSourceFiles().every((file) => files.includes(file))).toBe(true);
  });

  it("covers every directory that holds application code", () => {
    // The assertion above walks `SOURCE_DIRS` and so cannot notice a directory
    // missing *from* it — the direction that matters, since that is what
    // shrinking the footprint looks like and it fails green. This one walks
    // the repository instead, so a new top-level directory of TypeScript is an
    // error until somebody decides which side of the line it is on. It is the
    // same "list nobody remembers to extend" failure `SOURCE_DIRS` is
    // documented as removing, one level up: the list is now shared, but shared
    // and complete are different properties.
    //
    // The categories, and the argument for each directory that is out of
    // scope, live at `NON_APPLICATION_DIRS` rather than here (`YEO-102`) —
    // "which directories are out of scope" is half of "which directories are
    // in scope", and the answer should not be split across two files.
    //
    // Once a new directory lands in one list or the other, every scanner
    // follows: `SOURCE_DIRS` reaches the two tripwires and
    // `app/globals.test.ts`, and `CODE_DIRS` reaches
    // `lib/storage.call-sites.test.ts`. That is the property `YEO-102` adds —
    // before it, a new directory failed this test and then quietly went
    // unscanned by the two suites that kept their own lists.
    expect(uncategorisedCodeDirs()).toEqual([]);
  });

  it("holds nothing the tripwires cannot read", () => {
    // The assertion the extension list did not have, stated as the property
    // rather than as a list somebody has to re-read and re-derive the meaning
    // of: nothing under the scanned directories is invisible to a scanner of
    // TypeScript. The day a `.jsx` lands in `components/`, this is red and so
    // is every other suite that reaches for the tree.
    expect(() => sourceFiles()).not.toThrow();

    // `.mts` and `.cts` would pass this too, deliberately — see
    // `SOURCE_EXTENSIONS`.
    expect(sourceFiles().every((file) => /\.[mc]?tsx?$/.test(file))).toBe(true);
  });

  it("refuses a directory that does hold some, and names the files", () => {
    // Exercising the refusal needs a directory that really contains
    // JavaScript, and this repository contains none — that being the property
    // the test above asserts. Manufacturing one under `components/` would turn
    // every other suite red for as long as it existed, so the fixture is a
    // directory that is already here for another reason: the compiler this
    // very module parses with, which ships as `.js` like every other package.
    expect(() => sourceFiles(["node_modules/typescript/lib"])).toThrow(
      /can read: [\s\S]*\.js/,
    );

    // A failure nobody can act on gets the check deleted rather than the file
    // fixed, so the message has to carry both tripwires' names.
    expect(() => sourceFiles(["node_modules/typescript/lib"])).toThrow(
      /auth-boundary\.test\.ts/,
    );
  });
});
