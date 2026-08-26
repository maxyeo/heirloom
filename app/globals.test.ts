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
    /*
     * Both of these moved in E10-T5, and neither is a redesign. `#795cb2` and
     * `#d33` are Vector 2022's older link colours and they miss WCAG AA on
     * the surfaces this application actually paints them on; `#6a60b0` and
     * `#bf3c2c` are Wikimedia's own accessible replacements. The reasoning is
     * in `app/globals.css`, and "text contrast" below is what holds it — this
     * pair of literals only pins the specific answer that was reached.
     */
    ["--color-link-visited", "#6a60b0"],
    ["--color-link-new", "#bf3c2c"],
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

/**
 * WCAG AA text contrast (E10-T5), computed rather than asserted.
 *
 * ## Why this is arithmetic and not a table of expected ratios
 *
 * The criterion is "text contrast meets WCAG AA", and the honest way to hold
 * it is to state the *rule* and let the test do the sums: every colour this
 * stylesheet paints text in clears 4.5:1 against every surface it can be
 * painted on. A table of "link on panel is 5.09" would be a transcription of
 * the answer, and the failure it has to catch — somebody nudging a token by
 * two hex digits — is precisely the one that a transcription follows along
 * with.
 *
 * So the values are read back out of `app/globals.css`. There are no colours
 * in this block at all, which is also what keeps it honest about the file it
 * is describing rather than about a copy of it.
 *
 * ## 4.5:1, and why not 3:1
 *
 * WCAG 2.2 SC 1.4.3 (Contrast, Minimum) is 4.5:1 for ordinary text and
 * relaxes to 3:1 only at 18pt, or 14pt bold. The largest thing this skin sets
 * is `--text-h1` at 1.8rem — 28.8px, or 21.6pt — so the relaxation would
 * apply to headings, and headings are `--color-ink` at better than 13:1
 * everywhere regardless. Everything the relaxation could have helped with is
 * *smaller* than body text: `--text-note` is 12px. One threshold for the
 * whole palette is therefore both simpler and stricter than the standard
 * requires, and nothing in the skin has to argue for an exemption.
 *
 * ## Which pairs are asked about
 *
 * The cross product, deliberately, rather than the pairs that exist today.
 * `--color-wash` is the binding surface — it is the darkest — and it is easy
 * to believe no link is ever on it until you look: a `th` in a wikitable, the
 * highlighted row in `components/SearchSuggestions.tsx`, the two-revision
 * header on the compare view. A test that only checked the combinations
 * somebody had noticed would have passed on the palette this ticket had to
 * change.
 *
 * Borders and rules are **not** here. `--color-rule` at 2.37:1 on paper is a
 * hairline rather than text; the standard's 3:1 floor for non-text contrast
 * (SC 1.4.11) is a separate question from this ticket's criterion, and
 * quietly folding it in would mean darkening every rule in a skin whose whole
 * point is that it looks like Wikipedia.
 */
describe("text contrast", () => {
  /** The colours this stylesheet sets text in. */
  const INKS = [
    "--color-ink",
    "--color-ink-muted",
    "--color-link",
    "--color-link-visited",
    "--color-link-new",
  ];

  /** The colours it fills a surface behind that text with. */
  const SURFACES = [
    "--color-paper",
    "--color-panel",
    "--color-wash",
    "--color-diff-added",
    "--color-diff-removed",
  ];

  /** WCAG 2.2 SC 1.4.3, at the size everything in this skin is set at. */
  const AA_TEXT = 4.5;

  /**
   * A token's value, as declared. Throws rather than defaulting, because a
   * renamed token must fail this suite loudly instead of quietly contributing
   * no assertions.
   */
  function token(name: string): string {
    const value = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8});`).exec(css)?.[1];
    if (value === undefined) throw new Error(`${name} is not declared`);
    return value;
  }

  /** `#abc` and `#aabbcc` are the same colour; the maths only reads one. */
  function channels(hex: string): [number, number, number] {
    const digits = hex.slice(1);
    const full =
      digits.length === 3
        ? [...digits].map((digit) => digit + digit).join("")
        : digits;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [
      number,
      number,
      number,
    ];
  }

  /** Relative luminance, straight out of the WCAG 2.2 definition. */
  function luminance(hex: string): number {
    const [r, g, b] = channels(hex).map((value) => {
      const channel = value / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** The contrast ratio of two colours, also WCAG's own formula. */
  function ratio(one: string, other: string): number {
    const [lighter, darker] = [luminance(one), luminance(other)].sort(
      (a, b) => b - a,
    );
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * The formula, checked against the two values the standard names. Without
   * this the suite below could pass because `ratio` returns 21 for
   * everything, which is the way a home-made contrast check usually breaks.
   */
  it("computes the ratios the standard's own examples give", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(ratio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // Order must not matter: the formula sorts its own arguments.
    expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it.each(INKS)("sets %s above 4.5:1 on every surface", (ink) => {
    const failures = SURFACES.filter(
      (surface) => ratio(token(ink), token(surface)) < AA_TEXT,
    ).map(
      (surface) =>
        `${ink} on ${surface}: ${ratio(token(ink), token(surface)).toFixed(2)}:1`,
    );

    expect(failures).toEqual([]);
  });

  /**
   * A guard against the guard. Every name above has to resolve to something
   * this file declares, or the loop scans an empty cross product and reports
   * a palette nobody checked.
   */
  it("asks about every ink and every surface", () => {
    expect(INKS.length * SURFACES.length).toBe(25);
    for (const name of [...INKS, ...SURFACES]) {
      expect(token(name)).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
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

describe("photographs", () => {
  /**
   * The render half of E5-T2's orientation criterion. The upload endpoint
   * goes to some trouble to strip a photograph's coordinates while leaving
   * its orientation tag intact; a stylesheet that turned orientation off
   * would waste that quietly, and every portrait photograph in the wiki would
   * lie on its side with nothing in the diff to explain it.
   */
  it("renders them the way up the camera says", () => {
    expect(css).toContain("image-orientation: from-image;");
  });

  it("never turns that off", () => {
    expect(css).not.toContain("image-orientation: none");
  });
});

/**
 * The one rule in this file that may not be in a layer (E10-T5).
 *
 * `@xyflow/react/dist/style.css` is imported by `components/FamilyTree.tsx` as
 * a plain stylesheet, so its rules are unlayered — and an unlayered
 * declaration beats a layered one before specificity is consulted at all. It
 * ships `outline: none` on a focused node, which is why the `:focus-visible`
 * rule in `@layer base` gives every focusable thing in this application an
 * outline *except* a person on the family tree.
 *
 * Both halves of the fix are invisible to a reader of the diff and easy to
 * undo by tidying: somebody moving this rule into `@layer components` where
 * the rest of the canvas-adjacent styling would naturally go turns the focus
 * ring off again, silently, on the one surface the accessibility ticket was
 * written about. So the layer is asserted, not just the declaration.
 */
describe("the family tree's focus ring", () => {
  /**
   * Whether the character at `index` sits inside any `{ … }` block.
   *
   * Every layer in this file is written as `@layer name { … }`, so "at brace
   * depth zero" and "not inside a layer" are the same statement — and this is
   * the cheap way to say it without parsing CSS.
   */
  function insideABlock(index: number): boolean {
    const before = css.slice(0, index);
    const opened = before.split("{").length - 1;
    const closed = before.split("}").length - 1;
    return opened > closed;
  }

  it("puts the outline back on a focused node", () => {
    expect(css).toMatch(
      /\.react-flow__node\.selectable:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-link\);/,
    );
  });

  it("declares it outside every layer, or React Flow wins", () => {
    const at = css.indexOf(".react-flow .react-flow__node");
    expect(at).toBeGreaterThan(-1);
    expect(insideABlock(at)).toBe(false);
  });

  it("out-specifies the rule it is overriding", () => {
    // React Flow's selector is `.react-flow__node.selectable:focus-visible`.
    // Matching that exactly would leave the winner decided by which
    // stylesheet the bundler happened to emit second. The leading
    // `.react-flow` — the wrapper's own class — is there purely to add one to
    // the class count and settle it.
    expect(css).toContain(
      ".react-flow .react-flow__node.selectable:focus-visible",
    );
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
    /**
     * `DOWNSCALE_BACKGROUND` (E5-T3, `YEO-43`). Not a colour this application
     * paints: it is what a transparent pixel becomes when the image button
     * flattens an oversized PNG into a JPEG, which has no alpha channel.
     *
     * The value is baked into the bytes of a file that is then stored,
     * exported and opened in programs that are not this one, so it cannot be
     * a token — a token is a thing the stylesheet can change its mind about
     * later, and this one is already in every photograph it touched. White
     * rather than `--color-paper` for exactly that reason.
     */
    join("lib", "image-insert.ts"),
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
