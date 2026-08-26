import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  actionSourceFiles,
  appSourceFiles,
  read,
  repoRoot,
  SOURCE_DIRS,
  sourceFiles,
  unscannedSources,
} from "@/test/route-inventory";

/**
 * The footprint both tripwires scan (`YEO-100`).
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
    // `.mts` and `.cts` end in `.ts`, so they are scanned rather than refused.
    // Asserted rather than left to the reader: it is the one case where the
    // two lists overlap, and the overlap decides which way it goes.
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

  it("is imported by both tripwires rather than copied into them", () => {
    // A text check, and deliberately so — the drift `YEO-100` closes was not a
    // wrong value, it was two right ones that nothing obliged to stay equal.
    // Once both files import the list, the only way back to that state is for
    // somebody to write a second one, which is a thing you can look for.
    // `proxyMatchers` reads source text for a comparable reason.
    const tripwires = [
      join("app", "auth-boundary.test.ts"),
      join("lib", "sanitize-html.call-sites.test.ts"),
    ];

    for (const file of tripwires) {
      const source = read(file);

      expect(source).toContain('from "@/test/route-inventory"');
      // A second directory list, or a second walk of the tree to feed it.
      expect(source).not.toMatch(/=\s*\[\s*"app"/);
      expect(source).not.toContain("readdirSync");
    }
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
    const notApplicationCode = new Set([
      // Schema, migrations and scripts. Nothing here renders or answers a
      // request, so neither tripwire has a question to ask of it.
      "db",
      // The tripwires themselves, and the helpers they are built from. A
      // fixture in here is *meant* to contain the shapes being scanned for —
      // `test/inner-html-inventory.test.ts` is full of them — so scanning this
      // directory would turn every fixture into a call site to be justified.
      "test",
    ]);

    const holdsTypeScript = (dir: string): boolean =>
      readdirSync(join(repoRoot, dir), {
        recursive: true,
        encoding: "utf8",
      }).some((entry) => /\.[mc]?tsx?$/.test(entry));

    const uncategorised = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules")
      .filter(holdsTypeScript)
      .filter(
        (name) => !SOURCE_DIRS.includes(name) && !notApplicationCode.has(name),
      );

    expect(uncategorised).toEqual([]);
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
