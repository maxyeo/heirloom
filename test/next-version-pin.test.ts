import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The exact-version pin two test files reason from, asserted rather than
 * assumed (`YEO-133`).
 *
 * ## What rests on it
 *
 * `lib/wiki-paths.cache-tags.test.ts` imports seven modules out of
 * `next/dist`, which is not a supported entry point, and its header makes the
 * case for doing so. The case is explicitly conditional:
 *
 * > The package is pinned to an exact version (`next: "16.3.2"`, no caret),
 * > so the import paths cannot move underneath this without a deliberate bump
 * > — and on that bump, a module-not-found here is the intended alarm rather
 * > than a flake to route around.
 *
 * `test/route-inventory.ts` reaches into
 * `next/dist/experimental/testing/server` on the same terms, and everything
 * that imports it inherits the bargain.
 *
 * ## Why the pin needs a check and not a mention
 *
 * Because the sentence above is true of `package.json` today and nothing
 * anywhere holds it there. Widening the specifier to `^16.3.2` is a
 * one-character edit somebody makes for a reason that has nothing to do with
 * either file — an advisory on a patch release, a bot's bump, a tidy-up that
 * makes the manifest look like its neighbours — and it removes the foundation
 * of that argument without touching the file that makes it.
 *
 * What that leaves is worse than an undefended deep import. The header
 * promises that a module-not-found here means "the rule moved, go and look".
 * Under a range, the same failure also arrives on a patch release nobody
 * chose, in a job nobody was watching, and the two are indistinguishable from
 * each other — so the honest reading of the alarm becomes "flake", which is
 * the one reading it must never have. The alarm is the whole value of the
 * deep imports, and a range is what makes it unreadable.
 *
 * So the widening fails here, next to the argument it invalidates, rather
 * than months later in a file its author was not editing.
 *
 * ## What this does not say
 *
 * Nothing about *which* version. Upgrading Next is a decision this file has
 * no opinion on, and the upgrade is exactly when the deep imports are meant
 * to be re-checked — pinning the number here would make this the file that
 * goes red on a bump instead of the ones that have something to say about it.
 * Only the shape of the specifier is asserted: one version, chosen on
 * purpose, rather than a range resolved at install time.
 *
 * ## Why `node:fs` and not `read` from `@/test/route-inventory`
 *
 * Because `test/route-inventory.ts` is one of the two files this pin defends.
 * Reaching the manifest through it would mean that a Next release which moved
 * `next/dist/experimental/testing/server` takes this file down on import —
 * so the run that widened the pin would report a module-not-found rather than
 * the widened pin, which is precisely the confusion above.
 */

/** The manifest, read straight off disk for the reason in the header. */
const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * A specifier naming exactly one version: bare semver, with an optional
 * prerelease or build tag.
 *
 * Everything npm accepts that can resolve to more than one version fails it —
 * `^16.3.2`, `~16.3.2`, `>=16.3.2`, `16.x`, `*`, `latest`, a `||` union, a
 * hyphen range. So does anything resolved somewhere other than the registry
 * (`file:`, `link:`, `npm:`, a git URL), which is a moving target wearing a
 * pin's clothes: the argument is about the import paths being fixed, and a
 * branch name fixes nothing.
 */
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * What a widening meets. It names the file whose argument depends on the pin,
 * because whoever reads this failure is not whoever wrote that argument and
 * has no reason to have read it.
 */
const WHY =
  "`next` must stay pinned to an exact version. " +
  "`lib/wiki-paths.cache-tags.test.ts` imports seven modules out of " +
  "`next/dist` and `test/route-inventory.ts` reaches into one more; the " +
  "argument for those unsupported entry points is that an exact pin means " +
  "the import paths cannot move without a deliberate bump, so a " +
  "module-not-found there means the rule moved and is worth stopping for. " +
  "Under a range the same failure also arrives on any patch release, where " +
  "it reads as a flake to route around. Bump the pin if you mean to upgrade " +
  "— and re-check those deep imports when you do — but do not widen it.";

describe("the next version in package.json", () => {
  it("is a dependency, which is where the deep imports resolve from", () => {
    // The premise of the assertion below, and not a formality: a `next` moved
    // to `devDependencies`, or dropped for a workspace alias, would leave
    // `dependencies.next` undefined and the pin check reporting something
    // other than what it is about.
    expect(Object.keys(manifest.dependencies ?? {})).toContain("next");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("next");
  });

  it("is pinned to an exact version, not a range", () => {
    expect(manifest.dependencies?.next, WHY).toMatch(EXACT_VERSION);
  });
});

/**
 * The rule against specifiers, rather than against the manifest (`YEO-133`).
 *
 * The assertion above runs over a manifest that is already pinned, so its
 * finding branch is unreachable from the tree and will stay that way for as
 * long as the guard is working. A rule in that state is indistinguishable
 * from one that accepts everything — the same shape of hole
 * `lib/pages.call-sites.test.ts` keeps fixtures for — so the shapes it has to
 * reject are written down here instead of waited for.
 */
describe("a specifier that is not a pin", () => {
  it.each([
    ["^16.3.2", "the caret this ticket is actually about"],
    ["~16.3.2", "a patch range, which moves the import paths just as far"],
    [">=16.3.2", "an open upper bound"],
    ["16.3.x", "a wildcard patch"],
    ["16", "a major on its own"],
    ["*", "anything at all"],
    ["latest", "a dist-tag, which moves without a commit"],
    ["16.3.2 || 16.4.0", "a union of two pins is not a pin"],
    ["16.3.2 - 16.4.0", "a hyphen range"],
    ["npm:next@16.3.2", "an alias, whose target the manifest does not fix"],
    ["file:../next", "a path, which no version fixes"],
    ["github:vercel/next.js#canary", "a branch, which moves under the name"],
  ])("rejects %s — %s", (specifier) => {
    expect(specifier).not.toMatch(EXACT_VERSION);
  });

  it.each([
    ["16.3.2", "the pin as it stands"],
    ["17.0.0", "a bump, which this file has no opinion on"],
    ["16.4.0-canary.3", "a prerelease, still exactly one version"],
    ["16.3.2+build.1", "build metadata, likewise"],
  ])("accepts %s — %s", (specifier) => {
    expect(specifier).toMatch(EXACT_VERSION);
  });
});
