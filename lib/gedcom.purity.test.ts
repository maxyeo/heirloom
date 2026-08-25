import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The GEDCOM parser and mapper import nothing (E6-T1 `YEO-46`, E6-T2
 * `YEO-47`).
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
 * Because it is the stronger statement and it is currently true. Both
 * closures reach nothing outside themselves — no `@/db`, but also no React,
 * no `next/*`, no Auth.js, and no npm package at all. Asserting the empty set
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

/**
 * The public entry points. Everything either one reaches is in scope.
 *
 * Two of them since E6-T2 (`YEO-47`). `lib/gedcom-map.ts` turns the parsed
 * file into `individuals` / `unions` / `union_children` rows, and it is under
 * exactly the same rule for exactly the same reason: E6-T3's preview has to
 * be able to say what an import *would* do, which is only possible while
 * deciding what to write and writing it are separate operations. The mapper
 * is the half that decides, so a `@/db` import in it would be the same defect
 * as one in the parser, arriving one module further along.
 *
 * Three since E7-T1 (`YEO-51`), and the third is what the other two were kept
 * pure *for*. `lib/gedcom-export.ts` writes the rows back out as a file, and
 * E7-T2 (`YEO-52`) round-trips export through import and compares the two
 * texts byte for byte — a comparison that can only be a test of the *format*
 * while neither half needs a database. The reading of the rows is
 * `lib/export-tree.ts`, which is deliberately on the other side of this line
 * and is not an entry point here.
 */
const ENTRIES = {
  parser: join("lib", "gedcom.ts"),
  mapper: join("lib", "gedcom-map.ts"),
  exporter: join("lib", "gedcom-export.ts"),
} as const;

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

/** Every module reachable from an entry point, and every package they name. */
function closure(entry: string): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const queue = [entry];

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
  const { files, packages } = closure(ENTRIES.parser);

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

describe("the mapper's import closure", () => {
  const { files, packages } = closure(ENTRIES.mapper);

  it("is the modules it is supposed to be", () => {
    // The parser's closure plus the three validation modules E3-T1 owns, and
    // nothing else. `lib/child-input.ts` and `lib/union-input.ts` are here
    // because the mapping writes *through* them rather than around them, and
    // `lib/row-id.ts` arrives with them — it is the check that makes a minted
    // id acceptable to `validateUnion` in the first place.
    expect(files.sort()).toEqual(
      [
        join("lib", "ansel.ts"),
        join("lib", "child-input.ts"),
        join("lib", "field-input.ts"),
        join("lib", "gedcom-encoding.ts"),
        join("lib", "gedcom-lines.ts"),
        join("lib", "gedcom-map.ts"),
        join("lib", "gedcom-report.ts"),
        join("lib", "gedcom.ts"),
        join("lib", "individual-input.ts"),
        join("lib", "parse-date.ts"),
        join("lib", "row-id.ts"),
        join("lib", "union-input.ts"),
      ].sort(),
    );
  });

  it("imports no package at all", () => {
    expect(packages.filter((name) => !ALLOWED.has(name))).toEqual([]);
  });

  it("never reaches the database", () => {
    for (const file of files) {
      expect(read(file)).not.toContain('from "@/db');
      expect(read(file)).not.toContain('from "./db');
      expect(read(file)).not.toContain("drizzle-orm");
    }
  });

  it("writes through E3-T1's validation layer rather than around it", () => {
    // Stated as membership of the closure, because the alternative failure is
    // silent: a mapping that assembled rows itself would still typecheck, and
    // would simply stop enforcing whatever `validateIndividual` learns next.
    expect(files).toContain(join("lib", "individual-input.ts"));
    expect(files).toContain(join("lib", "union-input.ts"));
    expect(files).toContain(join("lib", "child-input.ts"));
  });
});

describe("the exporter's import closure", () => {
  const { files, packages } = closure(ENTRIES.exporter);

  it("is the mapper's closure and itself, and nothing more", () => {
    // The exporter reaches everything the mapper does because it *reuses* the
    // mapping rather than restating it: `PEDIGREES` comes from
    // `lib/gedcom-map.ts` and `SEX_CODES` from `lib/gedcom.ts`, inverted
    // rather than copied. A closure that had shrunk would mean somebody had
    // written a second copy of one of those tables.
    expect(files.sort()).toEqual(
      [
        join("lib", "ansel.ts"),
        join("lib", "child-input.ts"),
        join("lib", "field-input.ts"),
        join("lib", "gedcom-encoding.ts"),
        join("lib", "gedcom-export.ts"),
        join("lib", "gedcom-lines.ts"),
        join("lib", "gedcom-map.ts"),
        join("lib", "gedcom-report.ts"),
        join("lib", "gedcom.ts"),
        join("lib", "individual-input.ts"),
        join("lib", "parse-date.ts"),
        join("lib", "row-id.ts"),
        join("lib", "union-input.ts"),
      ].sort(),
    );
  });

  it("imports no package at all", () => {
    expect(packages.filter((name) => !ALLOWED.has(name))).toEqual([]);
  });

  it("never reaches the database", () => {
    // `lib/export-tree.ts` is the half that does, and it is not in here.
    for (const file of files) {
      expect(read(file)).not.toContain('from "@/db');
      expect(read(file)).not.toContain('from "./db');
      expect(read(file)).not.toContain("drizzle-orm");
    }
  });

  it("reuses the mapping's own tables rather than a second copy of them", () => {
    // Stated as a source assertion as well as a closure one, because the
    // failure this guards against is not an import going missing — it is an
    // import staying put beside a hand-written table that has quietly stopped
    // agreeing with it.
    const source = read(ENTRIES.exporter);

    expect(source).toContain('import { SEX_CODES } from "./gedcom"');
    expect(source).toContain('import { PEDIGREES } from "./gedcom-map"');
  });
});
