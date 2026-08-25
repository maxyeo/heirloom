/**
 * Backdating a fixture, for the `db` Vitest project (`YEO-90`). See
 * "Asserting on timestamps" in docs/testing.md.
 *
 * ## The trap
 *
 * Postgres `now()` is the *transaction's* start time, recorded to microsecond
 * precision. postgres.js hands JavaScript a `Date`, which only carries
 * milliseconds. So two writes in separate transactions can land a few hundred
 * microseconds apart — genuinely ordered in the database — and arrive in a
 * test as two `Date`s that compare equal.
 *
 * That is what made `lib/save-page.db.test.ts` and
 * `lib/restore-revision.db.test.ts` intermittently red. Both assert that a
 * write moves `pages.updated_at` *forward*, both built their fixture moments
 * earlier, and the gap being measured was one insert, one select and a
 * `BEGIN` — comfortably inside a millisecond against a local Postgres.
 *
 * ## Why this is a helper and not a looser assertion
 *
 * `toBeGreaterThanOrEqual` would make both tests green and would throw away
 * the only thing they check: that a save moves `updated_at` forward at all,
 * which is what E8-T4's recently-changed feed orders on. An assertion that
 * cannot fail is not a weaker test, it is not a test.
 *
 * Backdating the fixture instead keeps the assertion strict and removes the
 * clock from it entirely — the interval being compared becomes a year rather
 * than a scheduling accident. It also survives the move into CI, where the
 * runner is a different speed than any developer's machine and "fast enough
 * to collide" stops being a property anyone can reason about locally.
 *
 * ## Why it is not four private copies
 *
 * `test/db-concurrency.ts` makes the argument at length and it applies here
 * for the same reason: the knowledge required to write the test correctly —
 * that `Date` truncates what Postgres stored — is not visible from the
 * assertion that needs it. Two files needed it, both got it wrong, and
 * neither author could have known to. That is the kind of duplication worth
 * removing early rather than at the fourth copy.
 */
import { inArray } from "drizzle-orm";

import { db, schema } from "@/db";

/**
 * When a backdated fixture claims to have last been written.
 *
 * Fixed rather than relative to the current time, so a failure reproduces with
 * the same numbers a year from now; and far enough in the past that it cannot
 * collide with a `now()` from any run, on any runner.
 */
export const LAST_WRITTEN = new Date("2024-01-01T00:00:00.000Z");

/**
 * Move a fixture page's `updated_at` back to {@link LAST_WRITTEN}.
 *
 * Call it at the end of `beforeEach`, after the fixture exists — including
 * when the fixture was built by calling application code, which is the case
 * a pinned `INSERT` cannot cover: `lib/restore-revision.db.test.ts` builds its
 * history through two real `savePage` calls, so the timestamp to correct is
 * one the code under test wrote.
 *
 * Deliberately only `pages.updated_at`. Revision rows are ordered by
 * `created_at` and several files read their history back in that order, so
 * rewriting those would replace a flake with a fixture whose order depends on
 * how the rows happened to be updated. Postgres compares them at full
 * precision, so their ordering was never at risk — it is only the trip
 * through `Date` that loses anything.
 */
export async function backdatePages(...pageIds: string[]): Promise<void> {
  await db
    .update(schema.pages)
    .set({ updatedAt: LAST_WRITTEN })
    .where(inArray(schema.pages.id, pageIds));
}
