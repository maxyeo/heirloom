import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The GEDCOM parser imports nothing (E6-T1, `YEO-46`).
 *
 * ## Why this is a test and not a sentence in a docblock
 *
 * "Pure function… no `db` import in this module" is an acceptance criterion,
 * and it is the kind that decays silently. Nobody imports `@/db` into a parser
 * on purpose. What happens is that somebody two tickets from now needs a
 * constant that lives in `lib/family-graph.ts`, imports it, and drags
 * postgres.js into a module that a test with no `DATABASE_URL` has to be able
 * to load. The suite goes red for reasons that look nothing like the change.
 *
 * The shape is borrowed from `lib/sanitize-html.call-sites.test.ts`, which
 * guards its own seam this way. What is different here is that the invariant
 * can be checked *completely* rather than approximately: purity is a property
 * of the whole import closure, so this walks it — every module the parser
 * reaches, transitively — instead of grepping one file.
 *
 * ## Why the assertion is "nothing" rather than "not the database"
 *
 * Because it is the stronger statement and it is currently true. These five
 * modules reach nothing outside themselves — no `@/db`, but also no React, no
 * `next/*`, no Auth.js, and no npm package at all. Asserting the empty set
 * means the test fails on the *first* import added, whoever adds it and
 * whatever it is, rather than on a blocklist somebody has to have thought to
 * extend.
 *
 * That makes it deliberately strict, and that is the point: three later
 * tickets rest on this staying true. E6-T3 (`YEO-48`) previews a file before
 * writing anything, E6-T4 (`YEO-49`) needs the read and the write to be
 * separable to roll one back, and E7-T2 (`YEO-52`) round-trips export through
 * import with no database in sight. If a genuine dependency ever belongs here,
 * adding it to `ALLOWED` is one line — and having to justify that line is the
 * whole mechanism.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The public entry point. Everything it reaches is in scope. */
const ENTRY = join("lib", "gedcom.ts");

/**
 * Packages the parser may import.
 *
 * Empty, and it should stay that way. See the docblock above: the value of
 * this list is that adding to it is a decision somebody has to write down.
 */
const ALLOWED: ReadonlySet<string> = new Set([]);

/** `from "x"`, `import "x"`, and the re-export form `export … from "x"`. */
const SPECIFIER = /\bfrom\s+"([^"]+)"|\bimport\s+"([^"]+)"/g;

function read(file: string): string {
  return readFileSync(join(repoRoot, file), "utf8");
}

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2]);
}

/**
 * Resolve an import to a repo-relative source path, or `null` when it names a
 * package rather than a file in this repository.
 */
function resolveLocal(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) {
    return `${specifier.slice(2)}.ts`;
  }

  if (specifier.startsWith(".")) {
    const absolute = resolve(dirname(join(repoRoot, fromFile)), specifier);
    return `${relative(repoRoot, absolute)}.ts`;
  }

  return null;
}

/** Every module reachable from the entry point, and every package they name. */
function closure(): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const queue = [ENTRY];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.includes(file)) continue;
    files.push(file);

    for (const specifier of specifiers(read(file))) {
      const local = resolveLocal(file, specifier);
      if (local === null) packages.add(specifier);
      else queue.push(local);
    }
  }

  return { files, packages: [...packages].sort() };
}

describe("the parser's import closure", () => {
  const { files, packages } = closure();

  it("is the modules it is supposed to be", () => {
    // Named rather than counted, so that a module joining the closure is a
    // visible edit to this list rather than a number going up by one.
    expect(files.sort()).toEqual(
      [
        join("lib", "ansel.ts"),
        join("lib", "field-input.ts"),
        join("lib", "gedcom-encoding.ts"),
        join("lib", "gedcom-lines.ts"),
        join("lib", "gedcom-report.ts"),
        join("lib", "gedcom.ts"),
        join("lib", "individual-input.ts"),
        join("lib", "parse-date.ts"),
      ].sort(),
    );
  });

  it("imports no package at all", () => {
    expect(packages.filter((name) => !ALLOWED.has(name))).toEqual([]);
  });

  it("never reaches the database", () => {
    // The acceptance criterion, stated directly as well as implied by the
    // assertion above — so that a failure says what rule was broken.
    for (const file of files) {
      expect(read(file)).not.toContain('from "@/db');
      expect(read(file)).not.toContain('from "./db');
      expect(read(file)).not.toContain("drizzle-orm");
    }
  });

  it("reuses the shared date grammar rather than a second one", () => {
    // The other half of "no duplicate parsers": E4-T2's module is in the
    // closure on purpose, and its own docblock names this ticket as the
    // caller it was written for.
    expect(files).toContain(join("lib", "parse-date.ts"));
  });
});
