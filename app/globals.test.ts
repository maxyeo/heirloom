import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { filesUnder, SOURCE_DIRS } from "@/test/route-inventory";

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

/**
 * The palette, and the one way it is read (E10-T5, `YEO-107`).
 *
 * Both contrast criteria this file holds — 4.5:1 for text and 3:1 for
 * everything else — are computed from `app/globals.css` with the arithmetic
 * below rather than transcribed from a table. That is deliberate and it is
 * why the helpers are up here instead of inside one `describe`: two copies of
 * the WCAG formula are two chances to get it wrong, and the failure they both
 * have to catch is somebody nudging a token by two hex digits, which a
 * transcription follows along with.
 *
 * There are no colours in this block. The names are the only thing it knows.
 */

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

/** Every `--color-*` this stylesheet declares, in declaration order. */
function declaredColours(): string[] {
  return [...css.matchAll(/(--color-[a-z0-9-]+):\s*#[0-9a-fA-F]{3,8};/g)].map(
    (found) => found[1],
  );
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

/** The colours this stylesheet sets text in. */
const INKS = [
  "--color-ink",
  "--color-ink-muted",
  "--color-link",
  "--color-link-visited",
  "--color-link-new",
];

/** The colours it fills a surface with. Anything drawn on one is drawn on all
 * five as far as these suites are concerned — see "Which pairs are asked
 * about" below. */
const SURFACES = [
  "--color-paper",
  "--color-panel",
  "--color-wash",
  "--color-diff-added",
  "--color-diff-removed",
];

/**
 * How deeply nested the character at `index` is in `{ … }`.
 *
 * Every layer in this file is written as `@layer name { … }`, so "depth zero"
 * and "outside every layer" are the same statement, and a declaration inside
 * one unlayered rule is at depth one. This is the cheap way to say either
 * without parsing CSS.
 */
function braceDepth(index: number): number {
  const before = css.slice(0, index);
  return before.split("{").length - 1 - (before.split("}").length - 1);
}

/**
 * The formula, checked against the values the standard names. Without this
 * every suite below could pass because `ratio` returns 21 for everything,
 * which is the way a home-made contrast check usually breaks.
 */
describe("the contrast formula", () => {
  it("computes the ratios the standard's own examples give", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(ratio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // Order must not matter: the formula sorts its own arguments.
    expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });
});

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
    /*
     * `#a2a9b1` is Vector 2022's border and it is 2.37:1 on paper, which is
     * a hairline the audience this application is for cannot reliably see.
     * `YEO-107` moved it to WikimediaUI's next grey down — the one Codex
     * ships as `border-color-interactive` — and "non-text contrast" below is
     * what holds the reason. This literal only pins the answer reached.
     */
    ["--color-rule", "#72777d"],
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
 * Borders and rules are not here, and that is a division of labour rather
 * than an omission: SC 1.4.11 asks 3:1 of them rather than 4.5:1, and
 * "non-text contrast" below is the suite that holds it. E10-T5 left that gap
 * open on purpose and `YEO-107` closed it.
 */
describe("text contrast", () => {
  /** WCAG 2.2 SC 1.4.3, at the size everything in this skin is set at. */
  const AA_TEXT = 4.5;

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

/**
 * WCAG AA non-text contrast (`YEO-107`), computed the same way.
 *
 * ## What the criterion actually asks
 *
 * SC 1.4.11 wants 3:1 of two things and nothing else: the visual information
 * needed to identify a **user interface component** and its state, and the
 * parts of a **graphical object** needed to understand the content. It says
 * nothing about decoration, and it explicitly exempts an appearance the
 * browser determines — so a native control this stylesheet has not restyled
 * is already compliant and repainting it would only make it ours to get
 * wrong.
 *
 * That shape is why `app/globals.css` carries two border tokens rather than
 * one pushed down until its worst case passes. `--color-rule` bounds a
 * control or a region and owes 3:1. `--color-rule-soft` repeats a separation
 * the layout has already made and owes nothing. The argument lives at the
 * tokens; this suite is where it is held to.
 *
 * ## Why exemptions are a list with reasons rather than a shorter loop
 *
 * A guard that only asks about the tokens somebody remembered to add is a
 * guard that goes quiet exactly when the palette grows. So every `--color-*`
 * the stylesheet declares has to land in one of four buckets — a surface, an
 * ink, a non-text colour held to 3:1, or an exemption **with a stated
 * reason** — and `covers every colour the stylesheet declares` fails if one
 * of them is in none of them. Adding a token without deciding what it is
 * becomes a red test rather than a silent gap.
 *
 * Nothing here asserts that an exempt colour *fails* 3:1. It is allowed to be
 * darker than it has to be; what it is not allowed to be is unclassified.
 */
describe("non-text contrast", () => {
  /** WCAG 2.2 SC 1.4.11. */
  const AA_NON_TEXT = 3;

  /**
   * The colours that draw a control, a state, or a line the reader has to
   * see. Every one of them is held to 3:1 on every surface.
   *
   *   `--color-rule`      buttons, fields, menus, panels, table cells, the
   *                       card on the tree canvas, the rule under an h1 or
   *                       h2, the seam between a slide-up panel's pinned
   *                       header and the body that scrolls under it, and —
   *                       through `--xy-edge-stroke` — every edge on the
   *                       family tree.
   *   `--color-link`      every focus indicator in the application, the
   *                       selected article tab, and a selected person's ring.
   *   `--color-link-new`  the frame around the sign-in error.
   *
   * ## The panel header seam, which was the close call (`YEO-118`)
   *
   * `YEO-107` left the five slide-up panels — `components/PersonPanel.tsx`,
   * `AddPersonPanel.tsx`, `AddChildForm.tsx`, `AddSpouseForm.tsx`,
   * `SetParentsForm.tsx` — drawing that seam in `--color-rule-soft`, on the
   * reading that the heading and the Close button identify the header by
   * themselves. That reading borrows the list-row argument, and a panel
   * header is not a list row.
   *
   * Run 1.4.11's own test on it instead. A slide-up panel is a user
   * interface component and its extent is information the reader needs,
   * which is why its outer edge was made structural in the first place.
   * Inside it, the header and the scrolling body are one fill: the `aside`
   * carries `bg-panel` and the `overflow-y-auto` body declares no background
   * of its own. So once the body has scrolled, the only thing left saying
   * where the pinned half stops and the moving half starts is this line —
   * and at 1.53:1 on `--color-panel` it was not saying it to anybody who
   * needed telling. Take it away and a scrolled paragraph abuts the panel's
   * title and reads as part of it.
   *
   * That is a different answer from the one every other `rule-soft` site
   * gets, and the difference is the point. A row rule separates two things
   * of the same kind, so deleting it costs nothing. This one separates two
   * regions that move independently, and the answer to "would something
   * stop being identifiable" is not a clean no. `--color-rule-soft` is for
   * the lines whose removal costs nothing; a line whose removal costs
   * something is the structural token's, whether or not 1.4.11 would have
   * tolerated the softer one.
   *
   * It is also the cheaper end of the trade `YEO-107` warned about. Nothing
   * here darkens a token so its worst case passes — the seam moves to a
   * colour the panel's own frame is already drawn in, so the panel gets one
   * border weight instead of two.
   */
  const NON_TEXT = ["--color-rule", "--color-link", "--color-link-new"];

  /**
   * Colours that draw something 1.4.11 does not reach, and why. A reason is
   * required; the assertion below is that none of them is empty.
   */
  const EXEMPT: Record<string, string> = {
    "--color-rule-soft":
      "the decorative hairline. It repeats a separation the layout has " +
      "already made — one row of a list or of the infobox from the next, " +
      "the frame of a thumbnail, the line the article tabs attach to. " +
      "Remove any of those and nothing becomes unreadable and no control " +
      "becomes unfindable, which is the test 1.4.11 applies. What it is " +
      "not for is a seam between two regions that move independently: " +
      "`YEO-118` took the five slide-up panel headers off this token " +
      "because a pinned header and the body scrolling under it share one " +
      "fill, so that line is the only thing saying which half is pinned. " +
      "The rule of thumb is that a hairline between two things of the " +
      "same kind is decorative, and a hairline between two things that " +
      "behave differently is not.",
    "--color-diff-added-rule":
      "the gutter mark on a block a revision added, and exempt on " +
      "1.4.11's own test rather than 1.4.1's (`YEO-118`; the reason this " +
      "entry used to give — that the words say it too — is the " +
      "use-of-colour question, which is a different criterion and was " +
      "being answered in this one's place). A diff row is not a user " +
      "interface component: nothing in it is operated and it carries no " +
      "state. So the only half of 1.4.11 that reaches it is the " +
      "graphical-object half, which asks whether this part of the drawing " +
      "is needed to understand it. Take the 4px rule away and the row is " +
      "still filled, and still marked `+` in the gutter the rule was " +
      "sitting in. What a reader has to do here is tell one status from " +
      "another, and the rule is not what lets them: added and removed are " +
      "two different fills, changed and moved are solid against dashed, " +
      "and the moved rows draw that border in `--color-rule`, above the " +
      "floor. The coloured rule is the saturated edge of its own fill " +
      "rather than the line that bounds the row — 1.41:1 against the fill " +
      "it edges — so it thickens a boundary the fill has already made " +
      "instead of being one.",
    "--color-diff-removed-rule":
      "the gutter mark on a block a revision removed, exempt on the " +
      "argument its counterpart above sets out, and the clearer case of " +
      "the two: at 1.16:1 against the fill it edges it is barely a " +
      "separate colour, which is the strongest evidence there is that " +
      "nothing is being identified by it.",
  };

  it.each(NON_TEXT)("draws %s above 3:1 on every surface", (colour) => {
    const failures = SURFACES.filter(
      (surface) => ratio(token(colour), token(surface)) < AA_NON_TEXT,
    ).map(
      (surface) =>
        `${colour} on ${surface}: ${ratio(token(colour), token(surface)).toFixed(2)}:1`,
    );

    expect(failures).toEqual([]);
  });

  it("covers every colour the stylesheet declares", () => {
    const classified = new Set([
      ...SURFACES,
      ...INKS,
      ...NON_TEXT,
      ...Object.keys(EXEMPT),
    ]);

    const declared = declaredColours();
    // A guard that scans nothing passes for the wrong reason.
    expect(declared.length).toBeGreaterThan(10);
    expect(declared.filter((name) => !classified.has(name))).toEqual([]);
  });

  it("gives every exemption a reason", () => {
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(token(name)).toMatch(/^#[0-9a-f]{3,8}$/i);
      // Long enough to be an argument rather than a label.
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("never claims a colour is both held to 3:1 and exempt from it", () => {
    expect(NON_TEXT.filter((name) => name in EXEMPT)).toEqual([]);
  });

  /**
   * A surface is a fill, not a border.
   *
   * `--color-wash` was drawing the seam under the sticky header and down the
   * sidebar's edge at 1.18:1 — a line only in the sense that a declaration
   * exists. The fix is not to darken a surface, which is needed at that
   * lightness for the thing it actually is; it is to stop a fill token doing
   * a border's job. `call sites` below is where that is enforced, because it
   * is a property of the components rather than of this file.
   */
  it("draws the seams around the shell in the structural rule", () => {
    expect(ratio(token("--color-wash"), token("--color-paper"))).toBeLessThan(
      AA_NON_TEXT,
    );
  });

  /**
   * Focus indicators, which are the one non-text thing a keyboard reader
   * cannot work around. Both of these are `--color-link`, which the loop
   * above holds to 3:1 — asserting the *colour* here is what connects the two
   * halves, so that swapping the outline to a hex or to a softer token fails
   * rather than quietly dropping below the floor.
   */
  it("draws every focus indicator in a colour this suite checks", () => {
    expect(css).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-link\);/,
    );
    expect(css).toMatch(
      /\.react-flow__node\.selectable:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-link\);/,
    );
    expect(NON_TEXT).toContain("--color-link");
  });
});

/**
 * The family tree's edges (`YEO-107`).
 *
 * React Flow draws every edge at `#b1b1b7`, which is 2.13:1 on the paper the
 * canvas sits on — and an edge is the whole of what says who is married to
 * whom, so it is a graphical object in 1.4.11's sense rather than decoration.
 *
 * It cannot be fixed at the edges. `lib/tree-layout.ts` states, and
 * `lib/tree-layout.test.ts` enforces, that no edge declares a colour: the
 * qualification on a relationship rides entirely on `strokeDasharray`, and an
 * edge that could carry a colour is an edge somebody later tints red. So the
 * colour arrives from the stylesheet, once, for both dash states — which is
 * the only place the two rules can both be true.
 */
describe("the family tree's edges", () => {
  it("draws them in the structural rule rather than React Flow's grey", () => {
    expect(css).toMatch(/--xy-edge-stroke:\s*var\(--color-rule\);/);
  });

  it("leaves the canvas's other controls above the floor too", () => {
    // The zoom buttons are stacked and divided only by this line, and the
    // minimap's shapes are its drawing rather than its frame.
    expect(css).toMatch(
      /--xy-controls-button-border-color:\s*var\(--color-rule\);/,
    );
    expect(css).toMatch(
      /--xy-minimap-node-background-color:\s*var\(--color-rule\);/,
    );
  });

  it("declares them where React Flow's own stylesheet can be seen", () => {
    // One rule, unlayered, next to the focus ring: everything that exists
    // *because of* `@xyflow/react/dist/style.css` is in one place, so that
    // tidying one of them somewhere else is a visible move rather than a
    // silent one. Depth one is "inside `.react-flow { … }` and no layer".
    expect(braceDepth(css.indexOf("--xy-edge-stroke"))).toBe(1);
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
  it("puts the outline back on a focused node", () => {
    expect(css).toMatch(
      /\.react-flow__node\.selectable:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-link\);/,
    );
  });

  it("declares it outside every layer, or React Flow wins", () => {
    const at = css.indexOf(".react-flow .react-flow__node");
    expect(at).toBeGreaterThan(-1);
    expect(braceDepth(at)).toBe(0);
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

/**
 * The skip link (`YEO-108`).
 *
 * Every property that matters about this element is a CSS one — where it is,
 * whether it is on screen, and whether it is still in the tab order while it
 * is not. jsdom applies no stylesheet, so `components/SkipLink.test.tsx` can
 * assert that focus moves and cannot assert any of that; this is where the
 * other half lives, exactly as it does for the focus ring above.
 */
describe("the skip link", () => {
  function rule(selector: string): string {
    const found = new RegExp(
      `${selector.replace(/[.:]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(css);
    if (!found) throw new Error(`no rule for \`${selector}\``);
    return found[1];
  }

  it("stays in the tab order while it is off screen", () => {
    // The one thing a skip link cannot do is be hidden: `display: none` and
    // `visibility: hidden` both take an element out of the tab order, and the
    // tab order is the only place this link can be found at all.
    const declarations = rule(".skip-link");
    expect(declarations).not.toMatch(/display:\s*none/);
    expect(declarations).not.toMatch(/visibility:\s*hidden/);
    expect(declarations).toMatch(/transform:\s*translateY\(-\d+%\)/);
  });

  it("comes back on focus", () => {
    expect(rule(".skip-link:focus")).toMatch(/transform:\s*none/);
  });

  it("clears the sticky header it is revealed over", () => {
    // The header and the sidebar drawer are both `z-index: 40`. A link that
    // appears behind the wordmark has not appeared.
    expect(rule(".skip-link")).toMatch(/z-index:\s*50/);
    expect(rule(".skip-link")).toMatch(/position:\s*fixed/);
  });
});

describe("call sites", () => {
  /**
   * `.css` on top of the shared footprint (`YEO-102`).
   *
   * The directories come from `test/route-inventory.ts` like every other
   * scanner's: this list was character-for-character `SOURCE_DIRS` and
   * nothing obliged it to stay that way, so a directory added there for the
   * auth boundary's sake would have left the token layer unguarded in it
   * while this file stayed green.
   *
   * The extensions do not, and cannot: `sourceFiles` refuses a directory it
   * cannot parse, and a stylesheet is exactly that. `globals.css` is also the
   * one file this test is *about*, so leaving it out of the scan would be a
   * guard that cannot see its own subject. See `SOURCE_DIRS` for why the two
   * dimensions are shared separately.
   */
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
    return filesUnder(SOURCE_DIRS, sourceExtensions);
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

  /**
   * A surface token is a fill, not a border (`YEO-107`).
   *
   * `--color-paper`, `--color-panel` and `--color-wash` are chosen to be a
   * background for text, so they are within about 1.2:1 of each other and of
   * nothing that matters. Drawn as a border — `border-b border-wash` under
   * the sticky header, `border-r border-wash` down the sidebar — they make a
   * seam that exists in the stylesheet and not on the screen, and no amount
   * of darkening the *token* can fix that without ruining the fill.
   *
   * So the rule is structural rather than numeric, and it is the kind that
   * decays one component at a time: the two border tokens are the only
   * things that draw a line, and this scan is what keeps the third from
   * being reinvented as a utility.
   */
  it("never draws a border in a colour meant to be a fill", () => {
    const asABorder = /\b(?:border|divide|outline|ring)-(?:paper|panel|wash)\b/;

    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(5);

    const offenders = files
      .filter((file) => !exempt.has(file))
      .filter((file) =>
        asABorder.test(readFileSync(join(repoRoot, file), "utf8")),
      );

    expect(offenders).toEqual([]);
  });

  /**
   * A slide-up panel's header seam is structural (`YEO-118`).
   *
   * The argument is in "non-text contrast" above, next to the token it moved
   * to. This is the half of it that rots: all five panels are the same three
   * lines of Tailwind, the seam is one word away from the decorative token it
   * used to be, and every other `border-b` in the application's lists really
   * is `border-rule-soft` — so copying a neighbour, or reverting a line
   * nobody reads twice, puts it back with nothing failing.
   *
   * Narrow on purpose. It says the seam under the header is structural; it
   * does not say these files may never use the decorative token, because a
   * list drawn *inside* one of these panels would be a row rule like any
   * other and would take it correctly.
   */
  it("draws every slide-up panel's header seam in the structural rule", () => {
    const panels = [
      join("components", "PersonPanel.tsx"),
      join("components", "AddPersonPanel.tsx"),
      join("components", "AddChildForm.tsx"),
      join("components", "AddSpouseForm.tsx"),
      join("components", "SetParentsForm.tsx"),
    ];

    // `readFileSync` throws on a renamed panel rather than reporting a clean
    // scan of four files, which is the same reason `token()` throws.
    const sources = panels.map(
      (file) => [file, readFileSync(join(repoRoot, file), "utf8")] as const,
    );

    // The negative is the one that catches a revert; the positive is what
    // stops the negative passing because the seam was deleted or renamed.
    expect(
      sources
        .filter(([, source]) => /border-b border-rule-soft/.test(source))
        .map(([file]) => file),
    ).toEqual([]);

    expect(
      sources
        .filter(([, source]) => /border-b border-rule(?![\w-])/.test(source))
        .map(([file]) => file),
    ).toEqual(panels);
  });
});
