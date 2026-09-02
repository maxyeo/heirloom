import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { SLUG_FORMAT, slugFromTitle } from "@/lib/entry-slug";

/**
 * The evidence behind `db/schema.ts`'s decision not to constrain the `slug`
 * columns (`YEO-132`), re-derived against a real Postgres rather than recalled.
 *
 * ## Why this file exists
 *
 * `YEO-132` asked whether the slug format invariant should become a `CHECK`
 * constraint, a branded TypeScript type, or a documented deliberate omission.
 * The answer is the third, and the reason is not taste: **PostgreSQL cannot
 * express the invariant.** Its regex engine has no `\p{L}` and no `\p{N}`,
 * its nearest class is strictly narrower than they are, and how much narrower
 * depends on the locale and the ICU build of whichever server evaluates it.
 *
 * A decision that rests on what a dependency can do has to be checked against
 * the dependency, or it becomes folklore the moment the dependency moves.
 * `lib/wiki-paths.cache-tags.test.ts` makes the same move for Next's cache-key
 * canonicalisation — the docblock claims something about the runtime, and the
 * test asserts it against the runtime so the paragraph is checked rather than
 * believed. This is that, for Postgres.
 *
 * **If this file goes red, do not fix the assertion.** It is reporting that
 * the premise of a recorded decision has changed, and the decision on
 * `pages.slug` is then worth reopening on its merits.
 *
 * These assertions are about the engine and not about any row, so they insert
 * nothing and clean nothing up.
 */

/**
 * Titles an author could plausibly type into this wiki, and the slugs they
 * mint. Every one of these is a legal slug — `SLUG_FORMAT` says so below —
 * which is the whole point: they are the strings a constraint would have to
 * accept, not edge cases invented to embarrass one.
 */
const MINTED = {
  ascii: slugFromTitle("Rose Hall"),
  han: slugFromTitle("Gerard Yeo 楊"),
  cyrillic: slugFromTitle("Пётр Ильич"),
  /** `Ⅷ` is U+2167, a Number/Letter — a letter to Unicode, not to POSIX. */
  regnal: slugFromTitle("Henry Ⅷ"),
  /** `½` is U+00BD, a Number/Other — likewise. */
  vulgarFraction: slugFromTitle("½ Acre Farm"),
} as const;

/** One `~` test, run inside Postgres against a slug this repository minted. */
async function matches(value: string, pattern: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`select (${value} ~ ${sql.raw(`'${pattern}'`)}) as ok`,
  );
  return rows[0]!.ok;
}

/** The same, evaluated under an explicitly named collation. */
async function matchesUnder(
  value: string,
  collation: string,
  pattern: string,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`select (${value} collate ${sql.raw(`"${collation}"`)} ~ ${sql.raw(
      `'${pattern}'`,
    )}) as ok`,
  );
  return rows[0]!.ok;
}

describe("the slugs this repository mints", () => {
  it("all satisfy the invariant the schema documents", () => {
    // Stated first because everything below is only interesting if these are
    // genuinely valid slugs that Postgres nonetheless refuses.
    for (const slug of Object.values(MINTED)) {
      expect(slug, slug).toMatch(SLUG_FORMAT);
    }
  });
});

describe("what PostgreSQL can say about a slug", () => {
  it("rejects the invariant's own regex outright", async () => {
    // `SLUG_FORMAT` is `/^[\p{L}\p{N}-]+$/u`, and its source cannot be made
    // into a constraint: Postgres's regex engine has no `\p{...}` at all and
    // refuses to compile one, with SQLSTATE 2201B. Failing loudly is the good
    // case — a migration carrying this never applies.
    // Asserted on the SQLSTATE rather than on the message: Drizzle wraps the
    // driver error in a "Failed query" of its own, and the code is the part
    // Postgres promises.
    const raised = await matches(
      MINTED.ascii,
      String.raw`^[\p{L}\p{N}-]+$`,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(raised).not.toBeNull();
    expect((raised as { cause?: { code?: string } }).cause?.code).toBe("2201B");
  });

  it("silently accepts the same pattern once JavaScript has eaten the backslash", async () => {
    // The dangerous case, and it is dangerous specifically in this codebase's
    // toolchain. Drizzle's `check()` takes a `sql` tagged template, and a
    // tagged template is not a raw string: `\p` is not a recognised
    // JavaScript escape, so it collapses to a bare `p` before Postgres ever
    // sees it. Copying `SLUG_FORMAT`'s source into `db/schema.ts` would
    // therefore not raise the error above. It would compile, migrate and
    // deploy a character class of `p { L } N -` — a constraint that refuses
    // every real slug and accepts gibberish.
    const throughATemplateLiteral = `^[\p{L}\p{N}-]+$`;
    expect(throughATemplateLiteral).toBe("^[p{L}p{N}-]+$");

    expect(await matches(MINTED.ascii, throughATemplateLiteral)).toBe(false);
    expect(await matches("pLN", throughATemplateLiteral)).toBe(true);
  });

  it("has an [[:alnum:]] class that is narrower than letter-or-digit", async () => {
    // POSIX `alnum` is `alpha` + `digit`, i.e. `\p{L}` + `\p{Nd}`. It has no
    // member for `\p{Nl}` (`Ⅷ`) or `\p{No}` (`½`), so a constraint spelled
    // this way refuses titles the create path is required to accept — and
    // `lib/entry-slug.ts` has no way to report the refusal to an author,
    // because the product gives them no slug field to correct.
    const alnum = "^[[:alnum:]-]+$";

    expect(await matches(MINTED.ascii, alnum)).toBe(true);
    expect(await matches(MINTED.vulgarFraction, alnum)).toBe(false);

    // Under an explicitly pinned ICU collation too, so this is a property of
    // the class rather than of whichever locale this database happens to
    // carry. Naming the collation fixes the *ctype*; it does not widen
    // `alnum` into `\p{N}`.
    expect(await matchesUnder(MINTED.vulgarFraction, "und-x-icu", alnum)).toBe(
      false,
    );
  });

  it("answers the same pattern differently under different ctypes", async () => {
    // Two collations, one server, one pattern, two answers. This is why the
    // table on `pages.slug` shows the developer's `C`-locale database
    // refusing `gerard-yeo-楊` — a row that exists in production — while
    // production accepts it. A constraint carrying no collation inherits
    // whichever the database was created with, and so means a different thing
    // in each place it is applied.
    const alnum = "^[[:alnum:]-]+$";

    expect(await matchesUnder(MINTED.han, "C", alnum)).toBe(false);
    expect(await matchesUnder(MINTED.han, "und-x-icu", alnum)).toBe(true);
    expect(await matchesUnder(MINTED.cyrillic, "C", alnum)).toBe(false);
    expect(await matchesUnder(MINTED.cyrillic, "und-x-icu", alnum)).toBe(true);
  });
});

describe("the slug columns", () => {
  it("carry no CHECK constraint, which is a decision and not an oversight", async () => {
    // A tripwire, in the sense docs/architecture.md uses the word. Adding a
    // constraint here should be a deliberate act that begins by reading the
    // argument on `pages.slug` — including the measurement showing that the
    // same constraint text accepts `henry-ⅷ` in CI and refuses it in
    // production. This test is what makes that read unavoidable.
    const rows = await db.execute<{ table_name: string; definition: string }>(
      sql`
        select rel.relname as table_name,
               pg_get_constraintdef(con.oid) as definition
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
        where con.contype = 'c'
          and nsp.nspname = 'public'
          and rel.relname in ('pages', 'categories')
      `,
    );

    expect(rows).toEqual([]);
  });
});
