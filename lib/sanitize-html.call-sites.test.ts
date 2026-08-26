import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INNER_HTML_ATTRIBUTE,
  innerHtmlCallSites,
} from "@/test/inner-html-inventory";
import { read, SOURCE_DIRS, sourceFiles } from "@/test/route-inventory";

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
 * It is a tripwire, not a proof. `test/inner-html-inventory.ts` finds the call
 * sites in the syntax tree, so it knows a JSX attribute from a docblock — but
 * it still cannot follow a *value* from a sanitiser call to the `__html` it
 * eventually lands in. The read route assigns to a local first, and chasing
 * that would mean a type checker rather than an inventory.
 *
 * So the sanitiser half of the check is per file: a call site is satisfied by
 * its file importing and calling an entry point. What that catches is the
 * realistic failure — a new component that reaches for
 * `dangerouslySetInnerHTML` with the sanitiser nowhere in the file. That is
 * how this goes wrong in practice: not by somebody carefully laundering a
 * sanitised value into an unsanitised one, but by somebody rendering
 * `page.bodyHtml` straight from a query because it was already a string.
 *
 * ## Where it looks (`YEO-100`)
 *
 * `SOURCE_DIRS` and the enumerator both come from `test/route-inventory.ts`,
 * which is the module `app/auth-boundary.test.ts` scans from. That was always
 * the intent — the two tripwires are meant to cover the same ground — but
 * until `YEO-100` it was two copies of one array and a comment in each file
 * asking the reader to believe they matched. Now widening one widens both, and
 * the enumerator throws rather than skipping when it meets a file it cannot
 * parse, so neither footprint can shrink by accident.
 *
 * A sink outside those three directories is still invisible, exactly as it has
 * always been. That is a claim about where this application's code lives
 * rather than a property of the scanner, and `scans the source tree` below is
 * what keeps a renamed directory from turning this file silently vacuous.
 *
 * ## Exemptions are per call site, not per file
 *
 * `YEO-96`. A file legitimately needs raw HTML now and again — a JSON-LD
 * `<script>`, say, or markup that has *already* been through the allowlist and
 * must not go through it twice. What it never needs is a blanket pass.
 *
 * The exemption this file used to grant was a filename, so a second
 * `dangerouslySetInnerHTML` added to an exempt component later — by somebody
 * with no idea the file was exempt — was invisible here, and caught only by a
 * human reading the note beside it. The guard's own docblock conceded as much
 * in a sentence, and a sentence is the weakest possible enforcement: it is
 * "the caller's discipline, enforced at a distance", which is the argument
 * `YEO-93` was filed to remove from the ZIP writer.
 *
 * So an exemption is now two halves that have to agree. The call site carries
 * a marker comment naming an id; `EXEMPT` below registers that id against that
 * file, with the reason it exists. Neither half works alone — an unregistered
 * marker fails, and a registered id matching no call site fails too, so a
 * stale entry gets deleted rather than quietly widening to cover whatever is
 * added next to it.
 *
 * An id rather than a line number is what keeps it from rotting: it moves with
 * the call site through every edit above it.
 */

/**
 * file -> the exemption ids granted in it, and why.
 *
 * A map of ids rather than a set of filenames, for the same reason
 * `lib/storage.call-sites.test.ts` maps files to the vendor packages they may
 * name rather than exempting them outright: an exemption should buy exactly
 * the thing that was argued for, and nothing that arrives beside it later.
 *
 * Two entries that used to be here are gone rather than narrowed.
 * `lib/sanitize-html.ts` and this test only ever *named* the API — one in an
 * `@example` block, one in order to search for it — and neither renders
 * anything. A syntax tree does not mistake a comment for a call site, so there
 * is nothing left to exempt. `counts JSX, not prose` below pins that.
 */
const EXEMPT: Record<string, readonly string[]> = {
  /**
   * The shell's sidebar boot script (E11-T2). Not HTML from the database and
   * not HTML from a person: a constant string of JavaScript declared in
   * `lib/sidebar-preference.ts`, with nothing interpolated into it that
   * anything outside this repository can reach. Running it through the entry
   * allowlist would strip it to nothing, which is precisely what that
   * allowlist is for and precisely the wrong thing here.
   */
  [join("components", "AppShell.tsx")]: ["sidebar-boot-script"],

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
   * building HTML from a database value, that is a *second* call site, it
   * carries no marker of its own, and this file goes red. That sentence used
   * to be the only thing standing there; `YEO-96` made it an assertion.
   */
  [join("components", "ArticleHatnote.tsx")]: ["hatnote-already-sanitised"],
};

/** `file:line` — what somebody reading a failure actually needs. */
function where({ file, line }: { file: string; line: number }): string {
  return `${file}:${line}`;
}

/** The key an exemption is counted under, so both directions agree on it. */
function exemptionKey(file: string, marker: string): string {
  return `${file}: ${marker}`;
}

describe("dangerouslySetInnerHTML call sites", () => {
  const files = sourceFiles(SOURCE_DIRS);
  const callSites = innerHtmlCallSites(files);

  it("scans the source tree", () => {
    // A guard that scans nothing passes for the wrong reason — a renamed
    // directory would otherwise turn this file green and useless.
    expect(files.length).toBeGreaterThan(5);
  });

  it("finds the read routes, so the guard below is not vacuous", () => {
    // Both unexempt call sites that exist today: the entry itself, and the
    // revision it is diffed against. Naming both rather than one is the point
    // — a guard demonstrated on a single file is a guard nobody has watched
    // handle a second. If either disappears from this list the assertions
    // below have stopped meaning what they say, and should be looked at
    // rather than deleted.
    const found = callSites.map(({ file }) => file);

    expect(found).toContain(join("app", "wiki", "[slug]", "page.tsx"));
    expect(found).toContain(
      join("app", "wiki", "[slug]", "history", "[revisionId]", "page.tsx"),
    );
  });

  it("counts JSX, not prose", () => {
    // Why two whole-file exemptions could be deleted rather than narrowed.
    // Both of these files name the attribute — `lib/sanitize-html.ts` renders
    // a `<div>` in its `@example`, this one names it in order to search for it
    // — and neither puts anything into a DOM. A source-text scan had to buy
    // both off, which meant two files in which a real call site would have
    // been invisible.
    const named = [
      join("lib", "sanitize-html.ts"),
      join("lib", "sanitize-html.call-sites.test.ts"),
    ];

    for (const file of named) {
      expect(files).toContain(file);
      expect(read(file)).toContain(INNER_HTML_ATTRIBUTE);
    }

    expect(callSites.filter(({ file }) => named.includes(file))).toEqual([]);
  });

  it("routes every unexempt call site through the sanitiser", () => {
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

    const offenders = callSites
      .filter(({ file, marker }) => {
        if (marker !== null && EXEMPT[file]?.includes(marker)) return false;

        const source = read(file);
        return !entryPoints.some(
          ([module, call]) =>
            source.includes(`from "${module}"`) && call.test(source),
        );
      })
      .map(where);

    expect(offenders).toEqual([]);
  });

  it("grants no exemption the register did not agree to", () => {
    // A marker is a claim, not a grant. Without this, writing one at a call
    // site would be a self-service exemption — worth less than the doc comment
    // it replaced, because at least a comment had to be read by somebody.
    const unregistered = callSites
      .filter(
        ({ file, marker }) =>
          marker !== null && !EXEMPT[file]?.includes(marker),
      )
      .map((site) => `${where(site)}: ${site.marker}`);

    expect(unregistered).toEqual([]);
  });

  it("keeps no exemption that has stopped matching a call site", () => {
    // The failure this pair is really here for. An entry matching nothing is
    // not harmless: it is an argument nobody has to make again, sitting where
    // the next person who needs a marker will find it and reuse it.
    const claimed = new Map<string, number>();
    for (const { file, marker } of callSites) {
      if (marker === null) continue;
      const key = exemptionKey(file, marker);
      claimed.set(key, (claimed.get(key) ?? 0) + 1);
    }

    // Exactly one, in both directions. Zero is a stale entry to delete; two is
    // one id doing duty for two different arguments, which is the whole-file
    // exemption growing back a call site at a time. Reported as a sentence
    // rather than a count, because a diff of two object literals is not
    // something anybody can act on.
    const miscounted = Object.entries(EXEMPT)
      .flatMap(([file, markers]) =>
        markers.map((marker) => ({
          exemption: exemptionKey(file, marker),
          sites: claimed.get(exemptionKey(file, marker)) ?? 0,
        })),
      )
      .filter(({ sites }) => sites !== 1)
      .map(({ exemption, sites }) =>
        sites === 0
          ? `${exemption}: matches no call site — delete it`
          : `${exemption}: matches ${sites} call sites — give each its own id`,
      );

    expect(miscounted).toEqual([]);
  });
});
