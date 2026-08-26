import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `lib/storage.test.ts` proves the storage module behaves. This proves it is
 * the *only* thing that knows who stores the bytes — the property
 * `docs/architecture.md` sells as "swapping hosts is a one-file change", and
 * the one that cannot survive on convention alone.
 *
 * The shape is borrowed from `lib/sanitize-html.call-sites.test.ts`, which
 * guards its own invariant the same way, which in turn borrowed it from
 * `app/globals.test.ts`. Same genre: a rule that is obvious while there is one
 * call site and invisible by the time there are four.
 *
 * ## Why this exists rather than a note in a docblock
 *
 * The failure is not that somebody disagrees with the seam. It is that
 * `import { put } from "@vercel/blob"` inside a route handler is two
 * keystrokes shorter than routing through it, works immediately, and reviews
 * fine. Three of those and the portability claim is retroactively false —
 * and nothing goes red, because everything still works. On Vercel. Which is
 * exactly the condition the claim was about.
 *
 * ## What this can and cannot see
 *
 * It is a tripwire, not a proof. It reads source text, so a sufficiently
 * determined `await import("@vercel" + "/blob")` would walk past it. That is
 * not the realistic failure and it is not what this is for.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_DIRS = ["app", "components", "db", "lib", "test"];
/**
 * Every extension a module could hide in, not just the ones currently in use.
 * `postcss.config.mjs` and `eslint.config.mjs` have no business importing a
 * storage vendor and today they do not — but a scan whose blind spot is a
 * file extension is one rename away from being a scan of nothing.
 */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** The storage module itself, and the only file allowed to name a vendor. */
const STORAGE_MODULE = join("lib", "storage.ts");

/**
 * file -> the `@vercel/*` packages it is allowed to name, and why.
 *
 * A map rather than a set of files, so an exemption grants exactly the vendor
 * modules listed and not a blanket pass: `app/layout.tsx` reaching for
 * `@vercel/blob` tomorrow would still fail here.
 */
const ALLOWED: Record<string, readonly string[]> = {
  /**
   * The seam. This is the whole point — one file imports the storage vendor,
   * and swapping hosts rewrites this file and nothing else.
   */
  [STORAGE_MODULE]: ["@vercel/blob"],

  /**
   * Stubs the SDK so the unit tests never reach the network. It names the
   * package in a `vi.mock` specifier, which is the opposite of a dependency
   * on it.
   */
  [join("lib", "storage.test.ts")]: ["@vercel/blob"],

  /**
   * This file names both packages in order to search for them, and to
   * explain the exemption below.
   */
  [join("lib", "storage.call-sites.test.ts")]: [
    "@vercel/blob",
    "@vercel/analytics",
  ],

  /**
   * `@vercel/analytics`, and deliberately not covered by the storage seam.
   *
   * The portability claim is about the application's *data* — the images it
   * would lose on a move. Analytics is a script tag that measures page views
   * for whoever is hosting; on another host it is deleted, not
   * reimplemented, and there is no interface worth putting in front of one
   * import to say so. Storage is the opposite: something else has to be able
   * to hold the bytes.
   *
   * The exemption is narrow on purpose. It buys `@vercel/analytics` in this
   * one file, and nothing else anywhere.
   */
  [join("app", "layout.tsx")]: ["@vercel/analytics"],
};

function sourceFiles(): string[] {
  const fromDirs = SOURCE_DIRS.flatMap((dir) =>
    readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
      .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
      .map((entry) => join(dir, entry)),
  );

  // Root-level modules too — `auth.ts`, `proxy.ts`, `next.config.ts`. A seam
  // that only holds inside `app/` and `lib/` is not a seam, and the config
  // files are precisely where a host-specific import would look at home.
  const fromRoot = readdirSync(repoRoot, { encoding: "utf8" }).filter(
    (entry) =>
      SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) &&
      statSync(join(repoRoot, entry)).isFile(),
  );

  return [...fromDirs, ...fromRoot];
}

describe("Vercel imports", () => {
  const files = sourceFiles();

  const mentions = files
    .map((file) => ({
      file,
      packages: [
        ...new Set(
          [
            ...readFileSync(join(repoRoot, file), "utf8").matchAll(
              /@vercel\/[a-z0-9-]+/g,
            ),
          ].map((match) => match[0]),
        ),
      ],
    }))
    .filter(({ packages }) => packages.length > 0);

  it("scans the source tree", () => {
    // A guard that scans nothing passes for the wrong reason — a renamed
    // directory would otherwise turn this file green and useless.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join("app", "layout.tsx"));
    expect(files).toContain("next.config.ts");
  });

  it("finds the storage module, so the guard below is not vacuous", () => {
    // If this ever empties, the seam has been rewritten and the assertion
    // below has stopped meaning anything — look at it rather than delete it.
    expect(
      mentions.find(({ file }) => file === STORAGE_MODULE)?.packages,
    ).toContain("@vercel/blob");
  });

  it("keeps the blob SDK inside lib/storage.ts", () => {
    const offenders = mentions
      .filter(({ packages }) => packages.includes("@vercel/blob"))
      .map(({ file }) => file)
      .filter((file) => !ALLOWED[file]?.includes("@vercel/blob"));

    // Route the call through `lib/storage.ts` instead. If the module is
    // genuinely missing something you need, widen its four functions — that
    // is a decision about what every host must be able to do, which is the
    // decision worth making deliberately. E5-T5 (`YEO-45`) is the worked
    // example: it needed to enumerate the store, argued the case in
    // `lib/storage.ts`, added `list` there, and changed the count in
    // `lib/storage.test.ts`. What it did not do is import the SDK a second
    // time, which is the only thing this file is here to stop.
    expect(offenders).toEqual([]);
  });

  it("names no other Vercel package outside its one exemption", () => {
    const offenders = mentions.flatMap(({ file, packages }) =>
      packages
        .filter((name) => !ALLOWED[file]?.includes(name))
        .map((name) => `${file}: ${name}`),
    );

    expect(offenders).toEqual([]);
  });
});
