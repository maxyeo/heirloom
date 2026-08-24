# Testing

Vitest, run directly against the TypeScript sources. No build step, no
transpile config to keep in sync — the `@/*` alias is read straight out of
`tsconfig.json`, so the test runner and the compiler cannot disagree about what
`@/lib/tree-layout` means.

| Script               | Runs                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `npm test`           | Every test that does **not** need a database. This is what CI runs. |
| `npm run test:watch` | The same suite, in watch mode                                       |
| `npm run test:db`    | Only the tests that **do** need a database                          |

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
selects _both_ projects, so with no `DATABASE_URL` it fails on the database
half — including when an editor's Vitest integration runs it for you.

## Tests that need no database

Put them next to the module they cover: `lib/tree-layout.ts` is tested by
`lib/tree-layout.test.ts`. Import through `@/` the way application code does.

`lib/tree-layout.ts` is the model for what makes a module testable this way —
it takes a plain `FamilyGraph` value and returns nodes and edges, so a test
hands it a literal and inspects the result. Anything shaped like that needs no
fixtures and no mocking.

One trap worth knowing. `lib/family-graph.ts` exports both the `FamilyGraph`
_type_ and a function that queries the database. Importing the type with a
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
test:db` against the _same_ `heirloom_test` database at the same time will
collide. A database of your own is the simplest way not to think about it,
which a local `createdb heirloom_test` already gives you.

## What this does not cover yet

The harness is deliberately small, and one thing is simply not set up:

- **Nothing calls an action and checks what it _did_.** E10-T2 settled how an
  action is driven at all — see "The auth boundary" below — but it drives them
  to prove they refuse an anonymous caller, which needs no database. Asserting
  what a signed-in call _wrote_ is still open, and would need the `db` project
  rather than the `unit` one.

  E3-T4 met the same wall from the component side and went around it rather
  than through it. A Client Component that _imports_ a server action pulls
  `app/tree/actions.ts` — and with it Auth.js and `@/db` — into its import
  graph, so it cannot be mounted in a suite that has no `AUTH_*` and no
  `DATABASE_URL`. Worse, the failure spreads: the moment
  `components/FamilyTree.tsx` rendered the add-spouse form, the canvas's own
  suite went down with it.

  So the action arrives as a **prop** instead
  (`AddSpouseFormAction` in `lib/spouse-form-state.ts`), passed from
  `app/tree/page.tsx` — a Server Component that was reaching the database
  regardless. That is the framework's own pattern for handing an action to a
  client component, and it leaves `components/AddSpouseForm.test.tsx` able to
  submit the form for real against a stub that records the `FormData`. Nothing
  is mocked, because nothing had to be.

  The rule that falls out: **a Client Component that a test may want to mount
  should take its action, not import it.** `NewEntryForm` and `EntryEditForm`
  predate this and still import theirs; neither is mounted by anything.

  E2-T4 hit the same wall from a third direction, and the rule generalises:
  **take it, do not import it** — whatever "it" is. There the module that
  cannot be loaded is `next/navigation`. It imports fine, which is worse:
  `useSearchParams` simply returns `null` when nothing above it is the App
  Router, so a canvas that read the URL itself would have taken every
  assertion in `components/FamilyTree.test.tsx` down with the first
  `searchParams.get`. So `FamilyTree` takes a `PersonLink` — the id in the URL,
  and a callback for the URL to follow — and `components/DeepLinkedFamilyTree.tsx`
  is the ten unmounted lines that know about routing. A changed prop is what
  both arriving on a link and pressing Back look like from inside the canvas,
  which is how both are asserted with no router anywhere.

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
that are _about_ unmounting, such as whether a component removed a
document-level listener. Everything mounted is torn down after each test, by an
`afterEach` the module registers when a test file imports it.

That helper is eight lines of `react-dom/client` and React's own `act`, and it
stays that way on purpose — no queries, no `user-event`, no auto-wrapping.
Tests reach into the returned host with plain DOM calls, which is what keeps
"prefer no DOM" below an easy rule to follow: nothing here is _nicer_ than
testing a plain module, so nothing here tempts anyone into mounting a component
to check a decision that could have been a function.

**Third-party canvases need their browser APIs stubbed.**
`components/FamilyTree.test.tsx` mounts a real React Flow canvas, and React
Flow measures nodes with a `ResizeObserver` and reads the zoom out of a
`DOMMatrixReadOnly` — neither of which jsdom implements. Two no-op classes in a
`beforeAll` are enough; nothing in that file depends on a measurement, only on
clicks landing on the right elements.

**Mocking: only for a module that cannot be loaded.**
`components/PersonRemoval.test.tsx` is the one file that calls `vi.mock`, and
the reason is narrow enough to be worth stating as the rule. That component
imports `app/tree/actions.ts` in order to hand its form a server action; that
module reaches `@/auth`, which loads next-auth, which cannot be imported
outside the Next.js runtime — the import fails outright, in CI and locally
alike.

So the mock replaces a module boundary Vitest cannot cross, and nothing else.
Everything on the test's side of it is the real component, the real preview
logic and the real DOM. That is the bar for reaching for `vi.mock` here:
**the import does not work**, not "the real thing is inconvenient". A stub
that stands in for logic you could have called is a test that asserts the stub
returns what the stub was told to return.

The stubs are `vi.fn()`, which makes them do double duty: they are also how
that file asserts _which_ action each removal reaches and _what_ it sends —
the one part of the wiring that could silently invert without any other test
noticing.

**A form with more than one button needs the submitter asserted.**
`components/UnionOrder.test.tsx` (E3-T7) is the case: one form carries an up
and a down button for every union, and which one was pressed travels in that
button's own `name`/`value` — a pair the browser sends _only_ for the
submitter. React reproduces that for a form with a function action, but
nothing in the component says so, and a control that lost it would post the
same move for every arrow on the panel and look entirely correct doing it.

Pressing the button is enough to check it. `button.click()` inside `act` runs
jsdom's real submission algorithm, React builds the `FormData` from the form
and its submitter, and the stub action records what arrived — so the assertion
is `reorderInputFromFormData(submissions[0])`, the same reader the server
action uses. Nothing is mocked, and the seam that could silently invert is the
only thing being tested.

**Prefer no DOM.** Most of what looks like component behaviour is a decision
that can be moved into a plain module and checked in Node —
`lib/editor-extensions.ts` holds the editor's toolbar and extension
configuration for exactly that reason, and `lib/editor-extensions.test.ts`
checks it without a document. Reach for jsdom only for what genuinely needs
one: mounting, and the behaviour of a live editor.

The person detail panel (E2-T1) is the fullest worked example of the split.
Everything it _says_ — who counts as a spouse, which union a child arrived
through, how a qualified date reads — is derived in `lib/person-detail.ts` and
asserted against a literal `FamilyGraph` with no document in sight. What is
left for jsdom is only what cannot exist without one: Escape closing the panel,
focus returning to the node, and a click on a canvas node opening it at all.

## The auth boundary

`app/auth-boundary.test.ts` is the one test in here that is not about a
feature. `docs/architecture.md`: _"a route handler that forgets
`requireSession()` has nothing underneath it to fail safe."_ The app connects
to Postgres as a single role rather than as the signed-in person, so there is
no row-level security beneath a missing guard. The guard is the whole of it.

**Why it enumerates the filesystem.** A test that lists the routes it checks
covers exactly the routes somebody remembered to add to the list — which is
the same act of remembering that calling `requireSession()` needs in the first
place. It would be green on the day it mattered. So the routes come from
`test/route-inventory.ts`, which walks the same `app/` tree Next routes from:
a new route is in the test the moment the file exists, whether or not anyone
thinks about the test.

The one hand-written list is `PUBLIC_ROUTES`, and it is the safe polarity of
one. Forgetting to add a route to it turns the suite red; it can only ever be
used to _widen_ what is public, which is an edit that shows up in a diff.

**What it checks.**

1. Every route file calls `requireSession()` or `requireSessionOr401()`, and
   imports it from `@/lib/session`. Pages are `async` Server Components, which
   cannot be rendered under Vitest, so this half is checked statically — but
   from the **syntax tree**, not the source text.

   That distinction is the difference between a guard and a tripwire. This
   repository explains itself in long docblocks, several of which name
   `requireSession()` in prose, and `// await requireSession();` is exactly
   what a half-finished edit leaves behind — a regex counts both as a guard.
   `typescript` is already a devDependency, so `test/route-inventory.ts` uses
   the compiler's own scanner and counts neither. Asserting the import as well
   as the call is the other half: a local function of the same name is not the
   boundary.

   This is the one place the auth boundary goes further than the tripwire
   idiom of `lib/sanitize-html.call-sites.test.ts` and `app/globals.test.ts`,
   and the reason is what is underneath it — nothing.

2. Every server action is imported and **called** with no session in place,
   and has to throw `UnauthorizedError`. These can be driven, so they are.
3. No action hides from (2) by being declared inline, where it would have no
   importable name. The two exemptions are `signIn` and `signOut` — the
   session-lifecycle pair, which cannot require a session without
   contradicting themselves.
4. `proxy.ts`'s matcher does not exempt a private route.

**Mocking, and where the line is.** `@/auth` is mocked, and nothing else is.
It qualifies under the rule in "Mocking" above — `auth.ts` calls `NextAuth()`
at module scope and next-auth does not load outside the Next.js runtime, so
the import fails outright. `@/lib/session` is deliberately **not** mocked: it
is the thing under test, so `requireSession` runs for real and throws the real
error. Stubbing it would leave the suite asserting that actions call a
function a test told to throw.

That is the answer to the question this document used to leave open. Drive the
real boundary; mock only the module underneath it that cannot load.

The assertion is `rejects.toBeInstanceOf(UnauthorizedError)` rather than a
message match, and the distinction earns its keep: the actions are called with
junk arguments, and an action that validated its input _before_ checking the
session throws a `TypeError`, which would satisfy "it threw" while proving the
opposite of what is claimed. Reaching the boundary first is part of what is
being asserted.

**`ALLOWED_EMAILS` is the other half.** A boundary that faithfully rejects
everyone without a session, and then hands one to anybody who can click
"Continue with Google", is not a boundary. Google sign-in establishes identity,
not authorisation. That decision lives in `lib/allowed-emails.ts` rather than
in `auth.ts`, for the same import reason as above — a rule inside `auth.ts`
cannot be tested at all — and `lib/allowed-emails.test.ts` covers it,
including the case that matters: a real, verified Google identity that is not
on the list is refused.

**`proxy.ts` is read, not imported.** It re-exports Auth.js's `auth`, so
importing it loads next-auth. The matcher patterns are extracted from its
source text and compiled with `tryToParsePath` — Next's own path-to-regexp
call, the same one `getMiddlewareMatchers` makes — so the semantics of that
negative lookahead are Next's rather than a reimplementation. Next cannot be
given the patterns from a shared module either: it reads them statically at
build time and ignores variables.

This is where the interesting failure lives. The exemptions are **prefixes,
not whole segments**, so `/signin` being public also makes `/signin-help`
public, and `.*\.svg$` is not anchored to the top level, so `/wiki/anything.svg`
is waved straight past the proxy. Neither is a live bug — no such route
exists, and no slug can contain a dot — but neither would be noticed, either.
The enumeration is what catches it: a route named that way fails "runs on
%s". The `.svg` case is left as a passing test with a comment, because what
stops it in production is the page's own `requireSession()`, which is the
defence in depth architecture.md describes, demonstrated rather than asserted.

**If you change it, break it first.** The suite was validated by mutation
rather than by inspection. Each of these turns it red, naming the specific
route or action at fault:

| Mutation                                      | Caught by                              |
| --------------------------------------------- | -------------------------------------- |
| A new unguarded page                          | `every route demands a session`        |
| A new unguarded `route.ts` handler            | `every route demands a session`        |
| A guard that is commented out                 | `every route demands a session`        |
| A guard named only in a docblock              | `every route demands a session`        |
| A local function shadowing the guard's name   | `every route demands a session`        |
| A page named `/signin-help`                   | `the proxy matcher …`                  |
| An action with its `requireSession()` removed | `every server action rejects …`        |
| A new inline `"use server"` action            | `no action hides from the check above` |

The middle three are why this reads the syntax tree. A boundary test that
cannot fail is worse than none, because it is also reassuring.

## Why `test:db` is not in CI

It could be — a `services: postgres` container in the workflow plus
`npm run db:migrate` is the standard shape. It is left out for now because the
CI job's value right now is proving that the app builds and its pure logic
holds with **no** environment at all, and adding a database service to that job
would quietly erode the property the build step exists to enforce. When enough
database tests exist to be worth it, they belong in a **separate job**, so the
bare one stays bare.
