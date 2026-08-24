/**
 * Running two writers at the same moment, for the `db` Vitest project
 * (`YEO-85`). See "Racing two writers" in docs/testing.md.
 *
 * ## Why this is a helper and not four private copies
 *
 * It was four private copies. `lib/save-page.db.test.ts` wrote the original
 * and explained it; `lib/create-page.db.test.ts`, `lib/restore-revision.db.test.ts`
 * and `lib/link-person-entry.db.test.ts` each pasted it in under a comment
 * saying "copied from" whichever file they had read first.
 *
 * That is a cost worth naming, because it is not the duplication itself. A
 * race is the one kind of bug this codebase has shipped that no fixture value
 * can express — `setPersonEntry` checked whether another person had already
 * claimed an entry without locking the row, and the check was correct, the
 * types were correct, and every existing test passed. What was missing was any
 * way to *say* "two writers, at once" without first knowing that postgres.js
 * opens connections lazily and that a cold pool silently serialises the very
 * thing you are trying to overlap. A test nobody can write without that
 * knowledge is a test nobody writes.
 *
 * ## Why the pool has to be warmed
 *
 * postgres.js opens connections on demand, and opening one costs an order of
 * magnitude more than a whole transaction against a local Postgres. Two calls
 * fired at a cold pool therefore do not overlap at all: the first finishes
 * while the second is still shaking hands, and the race test then passes
 * whether or not the code under test locks anything. Deliberately slow queries
 * run in parallel leave that many connections open and idle, after which
 * concurrency in the test is concurrency in the database.
 *
 * ## Why there is a barrier as well
 *
 * `Promise.all([a(), b()])` — what the four copies did — is not quite what it
 * looks like. `a()` is *called* first and runs synchronously up to its first
 * `await`, so it reaches Postgres with a head start that varies with whatever
 * each function does before its first query. The gate below removes that: each
 * writer is invoked, immediately parks, and none of them proceeds until every
 * one has arrived. The overlap stops depending on how much synchronous
 * validation happens to sit at the top of the function under test.
 *
 * ## What a passing result does and does not prove
 *
 * It demonstrates the lock rather than enforcing it. Two transactions can
 * interleave in more ways than one run will show, so a green race test is
 * evidence, not proof. **The way to check that a race test is real is to
 * remove the lock it is about and watch it fail** — that is how the
 * `setPersonEntry` fix was verified, and a race test whose subject nobody has
 * ever broken on purpose is a test that may be asserting nothing at all.
 */
import { sql } from "drizzle-orm";

import { db } from "@/db";

/**
 * How long each warm-up query holds its connection.
 *
 * Long enough that the queries genuinely overlap and postgres.js has to open a
 * second socket rather than reusing the first, short enough to be invisible in
 * a suite that runs in seconds.
 */
const WARM_UP_SECONDS = 0.05;

/**
 * Run every writer at once, and return what each of them returned.
 *
 * Results come back in the order the writers were given, whatever order they
 * finished in, so a caller can name them by position.
 *
 * Nothing is caught: a writer that throws rejects the whole call, exactly as
 * `Promise.all` would. A race whose *expected* outcome includes a failure —
 * a deadlock, a serialisation error — should say so by catching inside its own
 * writer, where the assertion can see which one failed and why.
 *
 * @param writers one function per concurrent writer, each starting its own
 *   transaction; called once each, at the same moment
 * @returns each writer's result, positionally
 */
export async function raceWriters<T>(
  writers: readonly (() => Promise<T>)[],
): Promise<T[]> {
  await warmPool(writers.length);

  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  return Promise.all(
    writers.map(async (write) => {
      // The last writer to arrive is the one that opens the gate, so this
      // resolves exactly once and never before every writer is parked on it.
      if (++arrived === writers.length) open();
      await gate;
      return write();
    }),
  );
}

/**
 * Hold `count` connections open at once, so the pool has that many idle and
 * ready before the writers need them.
 */
async function warmPool(count: number): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, () =>
      db.execute(sql`select pg_sleep(${WARM_UP_SECONDS})`),
    ),
  );
}
