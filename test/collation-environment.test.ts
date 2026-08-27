import { describe, expect, it } from "vitest";

/**
 * The collation the suite is running under, checked before anything trusts it
 * (`YEO-120`).
 *
 * ## What this file is for
 *
 * Nothing in this repository asserted anything about the *ambient* locale
 * before this ticket, and nothing set one either: `.github/workflows/ci.yml`
 * named no `LANG` and no `LC_ALL`, so the whole suite ran in whichever
 * collation `ubuntu-latest` happened to resolve to. Every locale-dependent
 * assertion in the repository was therefore checked against exactly one
 * answer, forever, and a fixture that quietly encodes an `en-US` answer
 * passed.
 *
 * That is not hypothetical. `YEO-116` — a ticket whose entire subject was
 * that an unpinned collation looks pinned and is not — shipped a test
 * asserting `"Æsa".localeCompare("Zorro") < 0` with no locale named. CI was
 * green. It was green because the runner resolves to `en-US`; under
 * `LC_ALL=sv_SE.UTF-8` the assertion is false, because Swedish alphabetises
 * `Æ` after `Z`. One reviewer caught it by running a targeted second-locale
 * experiment; another approved the same commit after running all 3156 tests
 * green, under their own default locale — which is exactly what the bug
 * predicts. `lib/partner-search.test.ts` carried a second fixture of the same
 * kind, failing under Danish on `main` for as long as it existed.
 *
 * CI now runs the unit suite three times, under `en_US`, `sv_SE` and `da_DK`.
 * This file is what stops the extra two from passing *vacuously*.
 *
 * ## Why an environment variable is not evidence
 *
 * Setting `LC_ALL=sv_SE.UTF-8` *asks for* Swedish collation. Whether the
 * process got it is a separate question, and every way of not getting it is
 * silent:
 *
 * - A **`small-icu`** Node build carries collation data for one locale and
 *   answers every other request with the root collation. Nothing throws,
 *   every locale still "resolves", and a second-collation run passes while
 *   ordering strings exactly as the first one did.
 * - A locale the host cannot supply falls back the same quiet way.
 *
 * Either would leave CI with the appearance of a second collation axis and
 * none of the coverage. So the checks below ask ICU what it actually
 * resolved, rather than reading the variable back and believing it.
 */

/**
 * The BCP-47 tag a POSIX locale string names: `sv_SE.UTF-8` is `sv-SE`. The
 * codeset and any `@modifier` are dropped, because ICU does not carry either
 * into a locale tag.
 */
function bcp47Of(posixLocale: string): string {
  return posixLocale.replace(/[.@].*$/, "").replace(/_/g, "-");
}

/**
 * `C` and `POSIX` are not locales in ICU's sense — they name the *absence* of
 * one, and ICU answers a request for either with its own default rather than
 * with a tailoring. Somebody running under one has stated nothing about
 * collation, so this treats it as nothing stated rather than as a claim to go
 * red on.
 */
const NOT_A_COLLATION = new Set(["", "C", "POSIX"]);

/**
 * What was asked for, in the order ICU consults: `LC_ALL` overrides
 * everything and `LANG` is the fallback. `LC_COLLATE` sits between the two
 * for a C program calling `setlocale`, but ICU's own default-locale lookup
 * does not read it, so neither does this — asserting against a variable ICU
 * ignores would report failures nothing can act on.
 */
const requested: string | null = (() => {
  const tag = bcp47Of((process.env.LC_ALL ?? process.env.LANG ?? "").trim());
  return NOT_A_COLLATION.has(tag) ? null : tag;
})();

describe("the collation the suite runs under", () => {
  /**
   * In CI only, because it is a claim about the workflow rather than about
   * the code: a developer running `npm test` on a laptop has inherited a
   * collation from their own shell, and that is fine and even useful. A CI
   * run that inherits one is the exact hole this ticket closes. If this goes
   * red, somebody removed the `LANG`/`LC_ALL` pair from a job in
   * `.github/workflows/ci.yml`.
   *
   * `LC_ALL=C` counts as *not* naming one, which is deliberate rather than
   * pedantic: `C` asks for the absence of a locale, ICU answers it with the
   * root collation, and a suite about collation coverage run under the root
   * collation has none. It would also make the resolved-locale check below
   * uncheckable, since there is no tag to compare against.
   */
  it.runIf(Boolean(process.env.CI))(
    "names a real collation rather than inheriting one from the runner image",
    () => {
      expect(requested).not.toBeNull();
    },
  );

  it.runIf(requested !== null)(
    "is the collation that was asked for, and not a silent fallback",
    () => {
      const asked = new Intl.Locale(requested as string);
      const got = new Intl.Locale(new Intl.Collator().resolvedOptions().locale);

      // The language subtag is what catches a fallback, because a fallback
      // does not quietly drop a subtag — it answers `sv-SE` with `en-US`.
      expect(got.language).toBe(asked.language);

      // The region is checked only when both sides name one. ICU is entitled
      // to normalise a region away when it adds nothing to the collation
      // (an explicitly constructed `Intl.Collator("sv-SE")` reports plain
      // `sv`, since Swedish has one collation), and a run that asked for
      // Swedish and got Swedish should not go red over that. When ICU does
      // report a region, a mismatch is real — `en-US` against `en-GB` is a
      // different answer for dates and for numbers even where it is the same
      // answer for letters.
      if (asked.region && got.region) {
        expect(got.region).toBe(asked.region);
      }
    },
  );

  /**
   * Runs everywhere, in every job and on every laptop, because it is a
   * statement about the *build* rather than about the environment. Under a
   * `small-icu` Node the two extra CI runs would order strings exactly as the
   * first one does, and the second collation axis would be decorative — so
   * this fails loudly rather than letting three green runs mean one.
   *
   * It asserts the specific tailorings the fixtures elsewhere are built on,
   * not merely that a tag resolved. `lib/partner-search.test.ts` and
   * `lib/people-search.test.ts` both turn on `Æ` moving to the end of the
   * alphabet under Scandinavian collation; if ICU here cannot reproduce that,
   * those tests are not checking what they say they check, and this is the
   * file that says so.
   */
  it("has real collation data for the locales the suite names, not root-collation stubs", () => {
    for (const language of ["en", "sv", "da"]) {
      const resolved = new Intl.Collator(language).resolvedOptions().locale;
      expect(new Intl.Locale(resolved).language).toBe(language);
    }

    // Swedish and Danish alphabetise `Æ` after `Z`; English sorts it with
    // `A`. This is the disagreement `YEO-116`'s fixture fell into.
    expect(new Intl.Collator("en").compare("æsa", "zorro")).toBeLessThan(0);
    expect(new Intl.Collator("sv").compare("æsa", "zorro")).toBeGreaterThan(0);
    expect(new Intl.Collator("da").compare("æsa", "zorro")).toBeGreaterThan(0);

    // Danish alphabetises `aa` as `å`, also at the end, which no other
    // collation CI runs does. That is what made `lib/partner-search.test.ts`'s
    // "Aaron Rose" fixture an `en-US` answer written as a general one.
    expect(new Intl.Collator("en").compare("aaron", "rosalind")).toBeLessThan(
      0,
    );
    expect(
      new Intl.Collator("da").compare("aaron", "rosalind"),
    ).toBeGreaterThan(0);
  });
});
