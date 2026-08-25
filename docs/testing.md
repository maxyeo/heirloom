# Testing

Vitest, run directly against the TypeScript sources. No build step, no
transpile config to keep in sync — the `@/*` alias is read straight out of
`tsconfig.json`, so the test runner and the compiler cannot disagree about what
`@/lib/tree-layout` means.

| Script               | Runs                                         | In CI                      |
| -------------------- | -------------------------------------------- | -------------------------- |
| `npm test`           | Every test that does **not** need a database | Yes, in the `check` job    |
| `npm run test:watch` | The same suite, in watch mode                | No                         |
| `npm run test:db`    | Only the tests that **do** need a database   | Yes, in the `database` job |

**Both suites gate a merge.** A red `test:db` blocks a pull request exactly as
a red `npm test` does. See "`test:db` in CI" at the end of this document for
how, and docs/architecture.md ("What gates a merge") for the full list.

## The rule everything else follows

**`npm test` must never need a database.**

CI's `check` job runs `npm test` in the same deliberately empty environment as
`npm run build` — no `DATABASE_URL`, no `AUTH_*`. That is an enforced property
of the build step, and the test step inherits it. A test that reaches for
Postgres in the default suite does not fail loudly and locally; it fails on
every commit anyone pushes, for reasons unrelated to their commit.

The database tests run in CI too, but in a **separate** job with a Postgres of
its own, which is what keeps the rule above intact rather than negotiable. The
split is not "checked versus unchecked" — both halves are checked — it is
about which environment each one is entitled to assume.

So the suite is split in two, and the split is a filename:

- `something.test.ts` — pure. Runs under `npm test`, in CI's `check` job.
- `something.db.test.ts` — needs Postgres. Runs under `npm run test:db`, in
  CI's `database` job.

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

**The network is not a module boundary — it is the boundary itself.**
`components/SearchBox.test.tsx` (E8-T3) replaces `globalThis.fetch` with a
`vi.fn()`, and that is not the rule above being widened. There is no module to
mock: the component calls the platform's `fetch`, and no arrangement of this
suite could ever cross to the other side of it. Handing it a `fetch` that
resolves a literal is the same act as handing `PersonRemoval` a stub server
action — the seam is stubbed, and everything on this side of it is real. That
file mocks nothing else: `lib/suggestion-state.ts`, `lib/search-shortcut.ts`
and `components/surface-stack.ts` all run for real, which is what two of its
tests are about.

Two assertions there exist only because the UI is asynchronous, and nothing
else in this suite does either. **That the previous request's `AbortSignal` was
aborted** — otherwise every keystroke leaves a round trip running. And **that
an `AbortError` produces no error state** — which is the bug this pattern
almost always ships with, because every keystroke aborts the request before it
and every abort rejects that request's promise, so an unguarded `catch` paints
an error banner over results that are correct and already on screen.

Fake timers are what make the debounce assertable (`vi.useFakeTimers()`, then
advance past it), and the thing worth copying is the shape of the stub: it
records each call's `signal` alongside a `respond`/`fail` pair, so a test can
answer requests **out of order** on purpose. That is the only way to check the
staleness rule, and the rule is where the real bug would be.

**Two jsdom gaps this file ran into**, both of which would have made a test
pass for the wrong reason rather than fail: jsdom implements no `CSS.escape`
(use `getElementById`, which takes an id verbatim — `useId` produces ids
holding characters a selector would have to escape), and it parses
`contenteditable` without implementing `isContentEditable`, so an element that
should read as a text editor reads as an ordinary div. The contenteditable test
defines the property itself, and says why.

**A third, and the one that throws rather than lies.** jsdom implements no
`document.elementFromPoint`, and ProseMirror's `posAtCoords` — how a dropped
photograph finds the place it was aimed at — calls it unguarded.
`components/EntryEditor.test.tsx` defines it as `() => null` for E5-T3's tests,
which is a truthful stub rather than a convenient one: there is no layout in
jsdom, so there is genuinely no element under a coordinate, and `null` is what
a real browser answers for a drop outside the text.

**`XMLHttpRequest` is a seam like `fetch`.** The same file stubs it, for the
same reason `SearchBox` stubs `fetch` — "the network is not a module boundary,
it is the boundary itself" — and it is XHR rather than `fetch` because the
upload path has to report how far the request body has got, which `fetch`
cannot do. The fake is thirty lines: it records the method, the URL and the
`FormData`, and exposes `progress()` and `respond()` so a test can hold an
upload half-finished and assert on the bar. Everything on this side of it is
real, including the queue that serialises a batch and the editor the picture
lands in. What is _not_ stubbed is the canvas: the resize path is only reached
by a file over the 4 MB cap, so the decisions around it (`needsDownscale`,
`scaleToFit`, the quality ladder) are asserted in `lib/image-insert.test.ts`
with no browser at all, which is where they belong.

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

## Relationships are derived, never stored

`lib/relationship-derivation.test.ts` is the second test in here that is not
about a feature. `docs/architecture.md` rests the data model on one claim — a
union is a first-class entity, so "spouse", "half-sibling" and "step-mother"
are read back out of `unions` and `union_children` rather than written into a
third table — and this is where that claim is cashed.

**What is actually at stake.** The claim's sharp edge is that you never have to
_anticipate_ a relationship type, because you never store one. So the file asks
four questions the application has never been asked — half-sibling,
step-parent, step-sibling, blood relation — over `db/seed.ts`'s family, and
answers all four with no new column, no new enum member and no migration. That
is the property, and it is one that erodes silently: the first `mother_id`
somebody adds would not break a single existing test.

**Where the walks live.** In `test/relationship-kinds.ts`, not in `lib/`, and
the distinction is not "derivation belongs in tests" — `lib/person-detail.ts`
and `lib/person-infobox.ts` are both derivation and both ship. It is that
nothing in the application asks these four questions: no panel shows a kinship
degree, no box lists step-siblings. A `lib/relationships.ts` would be exported
API with no caller, and a taxonomy of relationship kinds is precisely the
speculative surface that not storing a label exists to make unnecessary. This
is the `test/route-inventory.ts` arrangement — logic a test needs and the
application does not — and like that one it gets its own unit test, because the
suite that uses it runs over one family and one family cannot reach every
branch.

**Two sources, on purpose.** Parents come from `derivePersonDetail`, so the
matrix asserts what a reader actually sees rather than what a second private
walk over `childLinks` computes; a derivation that broke identically in both
would otherwise stay green. The _union_ a person was born into comes from the
rows, because a union with neither partner recorded still holds its children
together and `PersonDetail.parents` has no parent in it to report. That case is
also why `siblingKind` is union-first rather than a count of shared parents:
Thomas's own union records his mother and leaves his father unknown, and
"shares one parent" would demote a sibling of his to a half-sibling on the
strength of a blank column. Union-first alone is not quite enough either,
because `lib/save-union.ts` deliberately allows a couple to hold two unions —
divorced and remarried each other — so a shared _pair_ of fully recorded
parents answers "full" as well. That second rule is restricted to the case
where both partners are recorded on both sides, which is the blank column
again from the other end: Agnes in two half-known unions has two children who
share every parent anybody wrote down, and "full" would be inventing that the
unknown partner was the same man.

**The one exception, pinned rather than swept past.** Three `child_relation`
values say how a child _arrived_ — born, adopted, fostered — and none of them
may move anything derived; that is asserted by sweeping the enum out of
`db/schema.ts` rather than listing it, so a fifth value arrives inside the
sweep. `step` is different in kind: it records a relationship, and
`lib/person-infobox.ts` reads it as one. A stored label sitting beside the
derivation without replacing it is exactly the arrangement the rest of the
model avoids by not having one.

Because it is a relationship rather than an arrival, `step` is the one value
the walks must _subtract_: a link marked `step` is not a birth, and the person
on the other end of it is not a parent. `test/relationship-kinds.ts` takes it
out of `birthUnionsOf` and `parentsOf`, which is the same line
`lib/person-infobox.ts` draws from the parent's end when it keeps `step` links
out of `ownChildren`.

That subtraction has to be there, and the interesting case is the one where a
`step` link sits _beside_ a birth link rather than replacing it — a child
attached to a parent's second marriage, which `lib/child-input.ts` allows by
letting an existing person be added to another union. Read as a birth, the
step-parent joins the parents; that then hides them from the step-parents
(already a parent) and makes their own children full siblings rather than
half. All three are asserted in `test/relationship-kinds.test.ts`, and all
three were confirmed to fail without the subtraction.

The subtraction is also why `step` is read from both ends. Taking it out of
the parents means a person whose _only_ link is `step` has no parents — which
is correct, they were not born into that union — but it would leave them
somebody's stepchild in the infobox and with no step-parent of their own.
`stepParentsOf` therefore reads the stated link as well as deriving from a
parent's remarriage, and the two directions are asserted against each other.

**The tripwire underneath.** Every walk above is only _possible_ because a
person row points at no other person: people meet through a union and nowhere
else. So the schema is enumerated the way `app/auth-boundary.test.ts`
enumerates routes — the only foreign keys reaching `individuals` are
`unions.partner_a_id`, `unions.partner_b_id` and `union_children.child_id`, and
the only one leaving it is `page_id`. A `mother_id`, or a `siblings` table, is
the first stored relationship in the model, and turns this red in the change
that adds it.

**If you change it, break it first.** Validated by mutation, like the auth
boundary:

| Mutation                                         | Caught by                                |
| ------------------------------------------------ | ---------------------------------------- |
| `derivePersonDetail` lists only `partner_a_id`   | 16 tests, across all four criteria       |
| `descendantsOrSelf` stops including self         | `names the line each end does belong to` |
| A child link loses its `otherParent`             | `is legible in the panel …`              |
| `individuals` gains a `mother_id`                | `the schema stores no relationship`      |
| `siblingKind` stops checking for a shared parent | 5 tests, incl. the pairwise matrix       |

The first row is the one worth noticing. Every union in the fixture records a
partner A, so a walk that reads only that column still finds a parent for
every child and still fills every panel — the family it produces looks
entirely plausible and is wrong about every relationship in it. That is the
failure the pairwise matrix exists to catch, and the one a spot check of a
few named pairs would sail past.

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

- **`db/seed-family.ts`** — the seeded family includes a year-only birth, a
  month-precision death, `about` and `before` qualifiers, an adopted child, a
  union with one partner unrecorded and neither its type nor its ending known,
  and one individual linked to an entry. A developer running `npm run db:seed`
  sees every one of those branches drawn, which is how two of the three bugs
  above would have been noticed by eye. It is a plain value with fixed ids and
  no database import, so a test can have the same coverage by importing it —
  see "Inherit the seeded family, do not retype it" below.
- **`lib/family-graph.db.test.ts`** — `getFamilyGraph` copies twenty-six columns
  into the graph by hand, and the four date columns on a person share one type
  with each other. `birthDatePrecision: p.deathDatePrecision` compiles, and
  against all-`day` fixtures it also passes. So Maud's four date columns each
  carry a _different_ value, which is what turns a swapped pair into a failed
  assertion instead of a coincidence.

Adding a non-default value to a fixture for a module that never reads that field
is noise, not coverage. Put the awkward value where the branch is.

### Inherit the seeded family, do not retype it

The rule above says most modules inherit the seed's coverage rather than
restating it. Taken literally that needs the seed to be **importable**, which
until E10-T3 (`YEO-67`) it was not: the family lived inside `db/seed.ts`'s
`main()`, reachable only by running the script against a database. So every
test that wanted the hard case retyped it, and a retyped fixture is a copy that
agrees on the day it is written and stops agreeing silently on any day after.

That is not a hypothesis. `lib/tree-layout.test.ts` carried a fixture
documented as "the seed fixture from docs/architecture.md, trimmed" whose
names, dates and child counts were none of the seed's — one child where the
seed has eight, `marriage`/`ongoing` where the seed's half-known union carries
`unknown`/`unknown`. The tests passed. They were testing an invented family
under a comment claiming otherwise, and no run could say so.

The family is now `db/seed-family.ts`: a `FamilyGraph` of plain values, with
fixed ids so that the foreign keys can be expressed in a literal at all —
`db/seed.ts` writes it and decides nothing about it. The split follows
`db/seed-guard.ts`, which left that script for the same reason: what needs no
database should not be trapped in something that does.

```ts
import { seedFamily, seedPerson } from "@/db/seed-family";
```

Two consequences worth knowing.

**Ids are fixed rather than `defaultRandom()`.** A `?person=` deep link into a
seeded tree now survives the next `npm run db:seed`, where before it quietly
addressed nobody.

**Order is still not a promise.** `getFamilyGraph` puts no `ORDER BY` on
`individuals`, and orders unions by `sequence` then `start_date` — so the array
order in `db/seed-family.ts` is the order the seed _writes_, not the order a
reader gets back. Assert properties that hold whatever order the rows arrive
in. `lib/tree-layout.seed.test.ts` is the worked example: it checks who exists
and how many times, which rank each generation lands on relative to the others,
and how each edge is styled — and deliberately asserts no coordinate, because
dagre breaks ties within a rank by insertion order.

That file is also the answer to "which test would notice". A tree that draws a
twice-married person once per marriage still looks like a family tree, and
looks like one for every family that never remarried. It was validated by
mutation rather than inspection — reversing `rankdir`, dropping the union
nodes, un-dashing an ended union or an adopted child, and duplicating a partner
each fail it, and each names the assertion at fault.

A fixture is still allowed to diverge from the seed **on purpose**, and two
do: `lib/person-infobox.test.ts` gives several people entries because a linked
relative beside an unlinked one is what it is testing, and
`lib/tree-layout.test.ts` keeps an invented graph for the cases the seed cannot
express — a person with no surname, a person whose death is recorded and whose
birth is not. Both say so. The rule is not "never write a literal"; it is that
a fixture claiming to be the seed has to actually be it.

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

### Asserting on timestamps

`test/db-timestamps.ts` is the helper; `backdatePages(...ids)` is the whole of
it.

Postgres `now()` is the _transaction's_ start time at microsecond precision,
and postgres.js hands JavaScript a `Date`, which only carries milliseconds. So
two writes in separate transactions can be a few hundred microseconds apart —
genuinely ordered in the database — and reach an assertion as two `Date`s that
compare equal.

That is not hypothetical. It is what made `lib/save-page.db.test.ts` and
`lib/restore-revision.db.test.ts` intermittently red: both assert that a write
moves `pages.updated_at` _forward_, both built their fixture moments earlier,
and the interval being measured was one insert, one select and a `BEGIN`.

**So backdate the fixture, do not loosen the assertion.**
`toBeGreaterThanOrEqual` turns both tests green and throws away the only thing
they check — that a save moves `updated_at` forward at all, which is what
E8-T4's recently-changed feed orders on. Call `backdatePages` at the end of
`beforeEach`, after the fixture exists, and the interval being compared becomes
a year rather than a scheduling accident.

Last in `beforeEach` rather than pinned at insert time, because a fixture is
often built by calling the application: `lib/restore-revision.db.test.ts` writes
its history with two real `savePage` calls, so the timestamp that needs to be
older is one the code under test wrote, and a pinned `INSERT` would not survive
it.

It touches `pages.updated_at` only. Revision rows are ordered by `created_at`
and several files read history back in that order, so rewriting those would
trade a flake for a fixture whose order depends on how the rows happened to be
updated. Their ordering was never at risk in the first place — Postgres
compares them at full precision, and only the trip through `Date` loses
anything.

## `test:db` in CI

It runs on every push and every pull request, in a job of its own
(`database`, in `.github/workflows/ci.yml`), against a `postgres:17` service
container that is created and thrown away with the run. The job does exactly
what the local setup above does — `npm run db:migrate:test`, then
`npm run test:db` — with `TEST_DATABASE_URL` pointed at the container instead
of at your `heirloom_test`. There is no CI-only code path, which is the point:
the commands in this document are the commands that gate the merge.

**A separate job, so the bare one stays bare.** This was the shape this
document argued for before the job existed, and the reasoning held. The
`check` job's `npm run build` step proves that a build needs no live database,
and it can only prove that while its environment has none. A Postgres service
attached to that job would put a reachable database in the build's
environment and the guarantee would be gone — silently, because the build
would keep passing either way.

**It costs a PR no extra waiting.** The two jobs run concurrently, so the run
is as long as its slowest job, which is still `check` with the build in it.
The database suite itself is around ten seconds: the files run one at a time
(`fileParallelism: false`, since they share one database), so that is already
the serial number rather than a best case. If it ever grows to where it is the
critical path, the fix is to shard the suite across jobs — not to move it to a
nightly run against `main`. Nightly is strictly better than never, but it is a
fallback, not the goal: a gate that reports after the merge does not stop the
merge.

**Why this was worth doing.** For a long time the suite ran nowhere, and the
cost was not the missing coverage — it was that an unrun suite starts shaping
the code written against it. Two tickets in the E6/E7 work extracted pure
modules (`lib/import-batches.ts`, `lib/import-rows.ts`) _specifically_ so the
logic would land in `npm test` and therefore in CI. Both are good modules and
both are staying, but the motivation was routing around this gap, and the next
person could as easily route around it by writing a weaker test instead of a
better module. The other half of the cost is that real signal stayed invisible:
the millisecond race in `lib/save-page.db.test.ts` was a genuine flake nobody
had to care about, because nothing was watching it go red. Turning the suite
on is what made fixing it necessary — see `LAST_WRITTEN` in that file for what
the fix was and why it is a fix rather than a loosened assertion.
