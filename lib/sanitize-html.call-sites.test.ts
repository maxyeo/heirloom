import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `lib/sanitize-html.test.ts` proves the sanitiser is correct. This proves it
 * is *reached* — the property that decays quietly, one new call site at a
 * time, and the one that actually keeps a script out of a reader's session.
 *
 * The shape is borrowed from `app/globals.test.ts`, which guards the token
 * layer the same way ("no file outside globals.css declares a colour"). Same
 * genre of invariant: cheap to state here, invisible until it is violated.
 *
 * ## What this can and cannot see
 *
 * It is a tripwire, not a proof. It reads source text, so it cannot follow a
 * value from a sanitiser call to the `__html` it eventually lands in — the
 * read route assigns to a local first, and chasing that would mean a type
 * checker rather than a regex.
 *
 * What it does catch is the realistic failure: a new component that reaches
 * for `dangerouslySetInnerHTML` with the sanitiser nowhere in the file. That
 * is how this goes wrong in practice — not by someone carefully laundering a
 * sanitised value into an unsanitised one, but by someone rendering
 * `page.bodyHtml` straight from a query because it was already a string.
 *
 * If a file legitimately needs raw HTML that has no business going through the
 * entry allowlist (a JSON-LD `<script>`, say), add it to `EXEMPT` with a note
 * saying why. Making that an edit someone has to justify is the point.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_DIRS = ["app", "components", "lib"];
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * This file names the API in order to search for it, and the sanitiser's own
 * docblock quotes an example call. Neither renders anything.
 */
const EXEMPT = new Set([
  join("lib", "sanitize-html.call-sites.test.ts"),
  join("lib", "sanitize-html.ts"),
  /**
   * The shell's sidebar boot script (E11-T2). Not HTML from the database and
   * not HTML from a person: a constant string of JavaScript declared in
   * `lib/sidebar-preference.ts`, with nothing interpolated into it that
   * anything outside this repository can reach. Running it through the entry
   * allowlist would strip it to nothing, which is precisely what that
   * allowlist is for and precisely the wrong thing here.
   *
   * The tripwire still matters: if `AppShell` ever grows a *second*
   * `dangerouslySetInnerHTML` carrying something a reader wrote, this
   * exemption would hide it. It covers a file that renders one constant, and
   * it should be deleted the day that stops being true.
   */
  join("components", "AppShell.tsx"),
  /**
   * The hatnote (E11-T9, `YEO-79`). Exempt for the *opposite* reason to
   * `AppShell` above: its `__html` has been through the allowlist, and it must
   * not be put through it again here.
   *
   * `app/wiki/[slug]/page.tsx` normalises the stored hatnote — which is
   * `sanitizeHtml` twice over, see `lib/hatnote.ts` — and then hands the
   * result to `markMissingEntryLinks`, which adds the `class` and `title` that
   * paint a link to a missing entry red. The allowlist permits neither
   * attribute on an `a`. So a `sanitizeHtml` call *inside this component*
   * would not be a belt-and-braces second pass; it would silently delete the
   * red links, which is precisely the ordering trap `lib/red-links.ts`
   * documents and `lib/red-links.test.ts` asserts against for the body.
   *
   * What keeps this honest is that the component renders what it is given and
   * derives no markup of its own: the automatic half of the hatnote is React
   * elements through `entryLinkProps`, not a string. The day it starts
   * building HTML from a database value, this exemption is hiding something
   * and should go.
   */
  join("components", "ArticleHatnote.tsx"),
]);

function sourceFiles(): string[] {
  return SOURCE_DIRS.flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
      .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
      .map((entry) => join(dir, entry)),
  );
}

describe("dangerouslySetInnerHTML call sites", () => {
  const files = sourceFiles().filter((file) => !EXEMPT.has(file));

  const callSites = files.filter((file) =>
    readFileSync(join(repoRoot, file), "utf8").includes(
      "dangerouslySetInnerHTML",
    ),
  );

  it("scans the source tree", () => {
    // A guard that scans nothing passes for the wrong reason — a renamed
    // directory would otherwise turn this file green and useless.
    expect(files.length).toBeGreaterThan(5);
  });

  it("finds the read route, so the guard below is not vacuous", () => {
    // The one call site that exists today. When a second arrives, this stays
    // true; if this ever empties, the assertion below has stopped meaning
    // anything and should be looked at rather than deleted.
    expect(callSites).toContain(join("app", "wiki", "[slug]", "page.tsx"));
  });

  it("routes every one of them through the sanitiser", () => {
    /**
     * The two ways into the one allowlist. `normaliseHatnote` is not a second
     * sanitiser and does not count as an alternative to the first — it *is*
     * `sanitizeHtml`, run twice with a structural flatten between the passes
     * (`lib/hatnote.ts`) — so a file that renders a hatnote it narrowed itself
     * satisfies this guard for the same reason a file that sanitises a body
     * does. Adding a genuinely different entry point here would be the thing
     * to argue about; adding another spelling of this one is not.
     */
    const entryPoints: readonly [module: string, call: RegExp][] = [
      ["@/lib/sanitize-html", /\bsanitizeHtml\s*\(/],
      ["@/lib/hatnote", /\bnormaliseHatnote\s*\(/],
    ];

    const offenders = callSites.filter((file) => {
      const source = readFileSync(join(repoRoot, file), "utf8");
      return !entryPoints.some(
        ([module, call]) =>
          source.includes(`from "${module}"`) && call.test(source),
      );
    });

    expect(offenders).toEqual([]);
  });
});
