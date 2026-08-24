# Testing

Vitest, run directly against the TypeScript sources. No build step, no
transpile config to keep in sync — the `@/*` alias is read straight out of
`tsconfig.json`, so the test runner and the compiler cannot disagree about what
`@/lib/tree-layout` means.

| Script | Runs |
| --- | --- |
| `npm test` | Every test that does **not** need a database. This is what CI runs. |
| `npm run test:watch` | The same suite, in watch mode |
| `npm run test:db` | Only the tests that **do** need a database |

## The rule everything else follows

**`npm test` must never need a database.**

CI runs `npm test` in the same deliberately empty environment as `npm run
build` — no `DATABASE_URL`, no `AUTH_*`. That is an enforced property of the
build step, and the test step inherits it. A test that reaches for Postgres in
the default suite does not fail loudly and locally; it fails on every commit
anyone pushes, for reasons unrelated to their commit.

So the suite is split in two, and the split is a filename:

- `something.test.ts` — pure. Runs under `npm test` and in CI.
- `something.db.test.ts` — needs Postgres. Runs only under `npm run test:db`.

`vitest.config.mts` defines those as two Vitest projects; `npm test` passes
`--project unit`, which excludes `*.db.test.ts` outright. Nothing depends on
anyone remembering to tag a test — getting the suffix right is the whole
mechanism.

Use the npm scripts rather than calling Vitest directly. A bare `npx vitest`
selects *both* projects, so with no `DATABASE_URL` it fails on the database
half — including when an editor's Vitest integration runs it for you.

## Tests that need no database

Put them next to the module they cover: `lib/tree-layout.ts` is tested by
`lib/tree-layout.test.ts`. Import through `@/` the way application code does.

`lib/tree-layout.ts` is the model for what makes a module testable this way —
it takes a plain `FamilyGraph` value and returns nodes and edges, so a test
hands it a literal and inspects the result. Anything shaped like that needs no
fixtures and no mocking.

One trap worth knowing. `lib/family-graph.ts` exports both the `FamilyGraph`
*type* and a function that queries the database. Importing the type with a
plain `import` drags `@/db` — and postgres.js — into a test that had no
business loading it. Use `import type`, which erases entirely:

```ts
import type { FamilyGraph } from "@/lib/family-graph";
```

## Tests that need a database

`lib/family-graph.db.test.ts` is the worked example; copy its shape.

**When you actually need one.** Only when the behaviour under test lives in the
database rather than in TypeScript — an `ORDER BY`, a cascade, a constraint, a
default. `getFamilyGraph`'s ordering rule (`sequence` first, `start_date`
second) is the canonical case: it is expressed in SQL, so mocking the query
would only assert that the mock returns what the mock was told to return.

**Setup you get for free.** `test/db-setup.ts` runs before every
`*.db.test.ts` file and handles the three things each of them would otherwise
repeat:

1. Loads `.env.local` — Vitest is standalone tooling and gets no environment
   from Next.js, exactly like drizzle-kit and the `tsx` scripts.
2. Throws a readable error when `DATABASE_URL` is unset, instead of letting a
   connection refusal surface seconds later from an unrelated assertion.
3. Closes the connection pool afterwards. postgres.js holds its sockets open;
   without this the run passes and then hangs until Vitest's teardown timeout.

**Isolating your rows.** These tests run against a real database that already
has data in it, so:

- Insert fixture rows with **explicit, recognisable ids** rather than letting
  `defaultRandom()` choose. Teardown can then delete exactly what the file
  created, and assertions can filter the query result down to their own rows
  and ignore everything else.
- Clean up in `afterAll`. Deleting the individual is usually enough — both
  `unions.partner_a_id` and `partner_b_id` are `ON DELETE CASCADE`.
- Never `TRUNCATE`. Someone's local database is not yours to empty.

Files in the `db` project run one at a time (`fileParallelism: false`), because
they all share one database and would otherwise clear each other's rows
mid-assertion. Within a file, assume tests run in order.

**Pointing it at a database.** `npm run test:db` runs
`DATABASE_TARGET=test vitest run --project db`, and `lib/load-env.ts`
resolves `DATABASE_TARGET=test` to `TEST_DATABASE_URL` — see
`lib/database-target.ts`. `.env.local` is never edited to run these tests:
`DATABASE_URL` keeps meaning your everyday development database throughout.

The expected setup is a second local Postgres database alongside the one you
develop against:

```bash
createdb heirloom_test
```

```
TEST_DATABASE_URL="postgresql://localhost:5432/heirloom_test"
```

```bash
npm run db:migrate:test    # create the schema in heirloom_test
npm run test:db
```

Any Postgres works for `TEST_DATABASE_URL` — it does not have to be local —
but a database on the same local server keeps this a one-command setup with
nothing to run in the background.

Note that these tests use fixed row ids, so two people running `npm run
test:db` against the *same* `heirloom_test` database at the same time will
collide. A database of your own is the simplest way not to think about it,
which a local `createdb heirloom_test` already gives you.

## What this does not cover yet

The harness is deliberately small, and one thing is simply not set up:

- **No mocking conventions.** Nothing has needed `vi.mock` yet. Route-handler
  and server-action tests (E10-T2) will be the first to decide whether to mock
  `@/lib/session` or drive real sessions, and whichever way that goes belongs
  back in this document.

Note also that `async` Server Components are not unit-testable — React and
Vitest do not support it yet — so treat those as end-to-end territory.

## Tests that need a DOM

`components/PersonPanel.test.tsx` is the worked example.

There is no third Vitest project for these and no `@testing-library/react`.
A file that needs a document says so on its first line:

```tsx
// @vitest-environment jsdom
```

Vitest reads that docblock per file, which is the `environment` override this
document used to describe as the thing to add "when the first component test
needs it". The editor was that first test. Everything else still runs in plain
Node and pays nothing for a DOM it does not use, and `npm test` picks these up
like any other file — no new script, no CI change.

Rendering is `test/render.tsx`:

```tsx
import { render, rerender, unmount } from "@/test/render";
```

`render(ui)` mounts into a fresh host and returns it; `rerender(host, ui)` is a
prop change rather than a remount, and `unmount(host)` is for the assertions
that are *about* unmounting, such as whether a component removed a
document-level listener. Everything mounted is torn down after each test, by an
`afterEach` the module registers when a test file imports it.

That helper is eight lines of `react-dom/client` and React's own `act`, and it
stays that way on purpose — no queries, no `user-event`, no auto-wrapping.
Tests reach into the returned host with plain DOM calls, which is what keeps
"prefer no DOM" below an easy rule to follow: nothing here is *nicer* than
testing a plain module, so nothing here tempts anyone into mounting a component
to check a decision that could have been a function.

**Third-party canvases need their browser APIs stubbed.**
`components/FamilyTree.test.tsx` mounts a real React Flow canvas, and React
Flow measures nodes with a `ResizeObserver` and reads the zoom out of a
`DOMMatrixReadOnly` — neither of which jsdom implements. Two no-op classes in a
`beforeAll` are enough; nothing in that file depends on a measurement, only on
clicks landing on the right elements.

**Prefer no DOM.** Most of what looks like component behaviour is a decision
that can be moved into a plain module and checked in Node —
`lib/editor-extensions.ts` holds the editor's toolbar and extension
configuration for exactly that reason, and `lib/editor-extensions.test.ts`
checks it without a document. Reach for jsdom only for what genuinely needs
one: mounting, and the behaviour of a live editor.

The person detail panel (E2-T1) is the fullest worked example of the split.
Everything it *says* — who counts as a spouse, which union a child arrived
through, how a qualified date reads — is derived in `lib/person-detail.ts` and
asserted against a literal `FamilyGraph` with no document in sight. What is
left for jsdom is only what cannot exist without one: Escape closing the panel,
focus returning to the node, and a click on a canvas node opening it at all.

## Why `test:db` is not in CI

It could be — a `services: postgres` container in the workflow plus
`npm run db:migrate` is the standard shape. It is left out for now because the
CI job's value right now is proving that the app builds and its pure logic
holds with **no** environment at all, and adding a database service to that job
would quietly erode the property the build step exists to enforce. When enough
database tests exist to be worth it, they belong in a **separate job**, so the
bare one stays bare.
