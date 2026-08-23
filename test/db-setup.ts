/**
 * Setup for the `db` Vitest project (`npm run test:db`) — every `*.db.test.ts`
 * file gets this before it runs. See docs/testing.md.
 *
 * Three jobs, all of them things every database test would otherwise repeat.
 */
import { afterAll } from "vitest";

// 1. Load `.env.local`. Vitest is standalone tooling, so it gets no more
//    environment from Next.js than drizzle-kit or a `tsx` script does.
import "@/lib/load-env";

import { db } from "@/db";

// 2. Fail immediately and legibly when there is no database, rather than
//    letting postgres.js report a connection refusal several seconds later
//    from inside whichever test happened to query first.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Database tests need DATABASE_URL. Copy .env.example to .env.local and " +
      "point it at a database you are willing to have written to — these " +
      "tests insert and delete rows. Run `npm test` for the suite that needs " +
      "no database.",
  );
}

// 3. Close the pool when the file is done. postgres.js keeps its sockets open,
//    which keeps the worker alive; without this, `npm run test:db` passes and
//    then hangs until Vitest's teardown timeout.
//
//    This has to run *after* each file's own cleanup, which it does because
//    Vitest stacks `afterAll` hooks innermost-first (`sequence.hooks: "stack"`,
//    the default). It also assumes each test file gets its own module registry
//    and so its own pool — also the default, via fork isolation. Turning either
//    of those off would leak fixture rows or hand a file a closed client.
afterAll(async () => {
  await db.$client.end();
});
