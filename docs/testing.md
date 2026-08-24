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
   the compiler's own scanner and counts neither.

   Three things have to line up, and no two of them are enough: the **import**
   (so a bare call is not an unresolved name), the **call** (an import with no
   call is what a guard leaves behind when someone deletes the line but not
   the line above it), and **no shadowing**. The last is the subtle one.
   Matching a call by name cannot see scope, so a local
   `async function requireSession() {}` _inside_ the component satisfies the
   first two while never reaching `@/lib/session` — the import is right there,
   the call is right there, and neither is the boundary. Resolving scopes
   properly means building a whole `ts.Program` and a type checker to answer
   one question, so instead the name is simply not available to be
   redeclared: there is no legitimate reason to call a local binding
   `requireSession`, and forbidding it closes the hole outright.

   Aliases and namespace imports both resolve, so
   `import { requireSession as guard }` and `session.requireSession()` are
   guards. Reporting either as unguarded would be a baffling failure.

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
source text and then handed to `unstable_doesMiddlewareMatch`, Next's own
testing helper for exactly this question — so the patterns come from the file
that ships, but what they _mean_ is decided by Next rather than approximated
here. Next cannot be given the patterns from a shared module either: it reads
them statically at build time and ignores variables.

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

| Mutation                                          | Caught by                              |
| ------------------------------------------------- | -------------------------------------- |
| A new unguarded page                              | `every route demands a session`        |
| A new unguarded `route.ts` handler                | `every route demands a session`        |
| A page in a route group, unguarded                | `every route demands a session`        |
| A guard that is commented out                     | `every route demands a session`        |
| A guard named only in a docblock                  | `every route demands a session`        |
| A local declaration shadowing the guard           | `every route demands a session`        |
| The guard's name imported from elsewhere          | `every route demands a session`        |
| A page named `/signin-help`                       | `the proxy matcher …`                  |
| An action with its `requireSession()` removed     | `every server action rejects …`        |
| A new unguarded `actions.ts`, in `app/` or `lib/` | `every server action rejects …`        |
| A new inline `"use server"` action                | `no action hides from the check above` |

And two that must _not_ fail, checked as deliberately as the rest: a guard
reached through an alias, and one reached through a namespace import. A test
that is merely stricter is not the same as a test that is correct.

The shadowing rows are why this reads the syntax tree rather than the source.
A boundary test that cannot fail is worse than none, because it is also
reassuring.

**The checker has its own test.** `test/route-inventory.boundary-usage.test.ts`
runs `boundaryUsageOfSource` over literal fixtures, because the suite over the
real tree cannot reach every branch: no route aliases the guard or imports it
as a namespace, so those paths would otherwise be code only a mutation run had
ever executed — and they exist to _prevent_ a false failure, which is the kind
of bug that gets an assertion deleted rather than the code fixed. The
`shadowed` fixtures pin the other direction: each was a real false green at
some point while this was being written.

**Where it looks.** Routes come from `app/`, because that is where Next routes
from. `"use server"` modules are looked for across `app`, `components` and
`lib` — the directories `lib/sanitize-html.call-sites.test.ts` already scans —
because the directive is legal in any module, and an action module outside
`app/` would otherwise be invisible to every check above it.

## Fixtures carry the awkward value

**A fixture that only ever carries a column's default is not coverage of that
column.** It is the strongest rule in this document that no tool enforces, and
it is written down because ignoring it shipped three bugs through a green CI in
a single run (`YEO-85`).

All three had one shape. A field has a benign default — `date_precision` is
`day`, `date_qualifier` is `exact`, `page_id` is null — and every fixture in the
suite carries that default. The branch that handles the other value is then
unreachable by construction, and no amount of running those tests will say so.

- `formatQualifiedDate` grew a third `precision` argument. Two read-path callers
  never passed it, and a person recorded as born `1890` read back as **"1
  January 1890"** — the invented day the column exists to prevent. Every fixture
  used `precision: "day"`, so nothing disagreed.
- `lib/person-detail.test.ts` asserted Thomas's lifespan as `"1898–1947"` when
  his birth is recorded as `about`. The expectation _was_ the bug, and the test
  defended it. It now reads `"about 1898–1947"`.
- `setPersonEntry` checked whether another person had already claimed an entry
  without locking the row, so two people both won it. No test ran two writers,
  because nothing in the harness could express two writers.

Note what a coverage threshold would have said about all three: green. Every
one of those lines executed. The problem was never which lines the fixtures
reach, it is which **values** they carry, and a percentage cannot see the
difference. That is why there is no coverage gate here and no mutation-testing
dependency — neither one asks the question this rule asks.

### Prefer making it impossible to adding a test

When the wrong thing can be made unbuildable, do that instead. The reference is
`formatQualifiedDate`: `precision` briefly had a `day` default, and requiring it
moved a whole class of omission from something a reviewer has to notice to
something `tsc` refuses. `QualifiedDate` in `lib/field-input.ts` was the same
shape and went the same way.

The test is worth adding too, but it is the weaker half. A required parameter
holds for call sites nobody has written yet.

### The rule for a new column

**A new enum or nullable column needs a fixture for its awkward value in the
same change that introduces it.** Not a follow-up ticket — the same diff. A
column's first migration is the only moment when every reader of it is in one
person's head, and it is also the moment when every existing row is, by
definition, at the default. That combination is exactly what makes the gap
invisible later.

"Awkward" means: a nullable column that is not null, an enum member that is not
the default, a date that is not a full day, a qualifier that is not `exact`.

### Where the awkward values live

Two fixtures carry them deliberately, so most modules inherit the coverage
rather than each restating it:

- **`db/seed.ts`** — the seeded family includes a year-only birth, a
  month-precision death, a `before` qualifier, an adopted child, a union with
  one partner unrecorded and neither its type nor its ending known, and one
  individual linked to an entry. A developer running `npm run db:seed` sees
  every one of those branches drawn, which is how two of the three bugs above
  would have been noticed by eye.
- **`lib/family-graph.db.test.ts`** — `getFamilyGraph` copies twenty-six columns
  into the graph by hand, and the four date columns on a person share one type
  with each other. `birthDatePrecision: p.deathDatePrecision` compiles, and
  against all-`day` fixtures it also passes. So Maud's four date columns each
  carry a _different_ value, which is what turns a swapped pair into a failed
  assertion instead of a coincidence.

Adding a non-default value to a fixture for a module that never reads that field
is noise, not coverage. Put the awkward value where the branch is.

### Racing two writers

Some bugs no fixture value can express, because they are about two transactions
rather than one row. `test/db-concurrency.ts` exports the one helper for those:

```ts
const [first, second] = await raceWriters([
  () => setPersonEntry({ personId: ROSE, pageId: LOOSE_PAGE }),
  () => setPersonEntry({ personId: THOMAS, pageId: LOOSE_PAGE }),
]);
```

It warms the pool before starting — postgres.js opens connections on demand,
and opening one costs more than a whole transaction against a local Postgres,
so two calls fired at a cold pool do not overlap at all and the test passes
whether or not anything is locked. It then holds every writer at a barrier so
none of them starts before the rest.

It was four private copies of that warm-up, three of them commented "copied
from" whichever file the author had read first. That is worth naming as the
reason instance three above was never tested: writing it required knowing about
lazy connections first, and a test nobody can write without that knowledge is a
test nobody writes.

**Break the lock on purpose.** A race test demonstrates a lock rather than
enforcing one — two transactions can interleave in more ways than one run will
show, so a green race test is evidence, not proof. The way to find out whether
it is asserting anything is to remove the `for("update")` it is about and watch
it fail. A race test whose subject nobody has ever broken deliberately may be
asserting nothing at all.

## Why `test:db` is not in CI

It could be — a `services: postgres` container in the workflow plus
`npm run db:migrate` is the standard shape. It is left out for now because the
CI job's value right now is proving that the app builds and its pure logic
holds with **no** environment at all, and adding a database service to that job
would quietly erode the property the build step exists to enforce. When enough
database tests exist to be worth it, they belong in a **separate job**, so the
bare one stays bare.
