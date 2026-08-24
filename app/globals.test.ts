import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The visual foundation (E11-T1) is a set of values rather than a function, so
 * what is worth testing is not that CSS parses — the build proves that — but
 * the two properties the rest of the skin depends on:
 *
 *   1. The Wikipedia values are the ones actually declared. These are read off
 *      a reference mockup that no test can see, so a typo in a hex is
 *      invisible until someone compares two pages side by side.
 *   2. Nothing outside this stylesheet declares a colour of its own. That is
 *      the property that makes the token layer worth having at all, and it is
 *      the one that decays quietly, one call site at a time.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Comments stripped, because the stylesheet's comments quote the selectors
 * they explain — "h3 and below carry no rule" reads to a regex as a rule for
 * h3. Structure is what these assertions are about, so structure is all they
 * should see.
 */
const css = readFileSync(join(repoRoot, "app/globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("theme tokens", () => {
  // Exactly the values the ticket's acceptance criteria name.
  it.each([
    ["--color-link", "#3366cc"],
    ["--color-link-visited", "#795cb2"],
    ["--color-link-new", "#d33"],
    ["--color-panel", "#f8f9fa"],
    ["--color-rule", "#a2a9b1"],
    ["--color-ink", "#202122"],
    ["--container-content", "46em"],
  ])("declares %s as %s", (token, value) => {
    expect(css).toContain(`${token}: ${value};`);
  });

  it("puts Georgia behind Linux Libertine for headings, and hosts neither", () => {
    expect(css).toContain(
      '--font-serif: "Linux Libertine", Georgia, Times, serif;',
    );
    // A self-hosted or Google-served face would be a webfont request on every
    // page view. The ticket is explicit that Georgia is the first cut.
    expect(css).not.toMatch(/@font-face|fonts\.googleapis\.com/);
  });

  it("sets the content column to Wikipedia's size and leading", () => {
    expect(css).toContain("--text-body: 0.875rem;");
    expect(css).toContain("--text-body--line-height: 1.6;");
  });
});

describe("heading rules", () => {
  it("puts the bottom rule on h1 and h2", () => {
    expect(css).toMatch(
      /h1,\s*h2\s*\{[^}]*border-bottom:\s*1px solid var\(--color-rule\);/,
    );
  });

  it("puts no rule on h3 and below", () => {
    // Any block whose selector reaches h3–h6 must not declare a border.
    expect(css).not.toMatch(/h[3-6][^{}]*\{[^}]*border/);
  });
});

describe("links", () => {
  it("stays underline-free until hover", () => {
    expect(css).toMatch(/\ba\s*\{[^}]*text-decoration:\s*none;/);
    expect(css).toMatch(/a:hover\s*\{[^}]*text-decoration:\s*underline;/);
  });

  it("keeps a red link red after it has been followed", () => {
    // Source order matters here: `a.new` and `a:visited` have equal
    // specificity, so the later one wins.
    expect(css.indexOf("a.new,")).toBeGreaterThan(css.indexOf("a:visited"));
  });
});

describe("the section [edit] link", () => {
  /**
   * E11-T4's whole visual claim is "Wikipedia's small bracketed style", and
   * every part of it is a token this file already declares — `--text-note`
   * exists for `[edit]` links by name (docs/design-tokens.md). A literal
   * `0.75rem` here would look identical and mean the size had escaped the
   * scale.
   */
  it("is small sans furniture floated to the end of the heading line", () => {
    const rule = css.match(/\.wiki-editsection\s*\{[^}]*\}/)?.[0] ?? "";

    expect(rule).toContain("float: right;");
    expect(rule).toContain("font-size: var(--text-note);");
    expect(rule).toContain("font-family: var(--font-sans);");
    // No colour of its own: the anchor inside is a link like any other.
    expect(rule).not.toContain("color:");
  });
});

describe("call sites", () => {
  const sourceDirs = ["app", "components", "lib"];
  const sourceExtensions = [".ts", ".tsx", ".css"];

  /**
   * globals.css is where the colours live, and a test that checks them has to
   * name them. Everything else is fair game.
   */
  const exempt = new Set([
    join("app", "globals.css"),
    join("app", "globals.test.ts"),
  ]);

  function sourceFiles(): string[] {
    return sourceDirs.flatMap((dir) =>
      readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
        .filter((entry) => sourceExtensions.some((ext) => entry.endsWith(ext)))
        .map((entry) => join(dir, entry)),
    );
  }

  it("declares every colour in globals.css and nowhere else", () => {
    // The lookbehind excludes HTML numeric character references, which are a
    // `#` followed by digits and so are otherwise indistinguishable from a
    // short hex. `lib/sanitize-html.test.ts` contains `java&#115;cript:` — an
    // entity-encoded scheme, not a colour — and without this the guard reads
    // `#115` as one and fails on a file that declares no colour at all.
    const hex = /(?<!&)#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

    const files = sourceFiles();
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(5);

    const offenders = files
      .filter((file) => !exempt.has(file))
      .filter((file) => hex.test(readFileSync(join(repoRoot, file), "utf8")));

    expect(offenders).toEqual([]);
  });
});
