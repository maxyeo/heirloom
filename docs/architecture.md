# Architecture

## Stack

| Layer          | Choice                        | Why                                                                          |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Framework      | Next.js (App Router)          | Server components mean the database is reachable without a separate API tier |
| Host           | Vercel                        | Free tier is sufficient; `output: "standalone"` keeps other hosts open       |
| Auth           | Auth.js v5, Google provider   | One-click sign-in for people who already live in Gmail                       |
| Database       | Postgres (Supabase free tier) | Used as _plain Postgres_, not as a backend-as-a-service                      |
| Query layer    | Drizzle + `postgres.js`       | Typed SQL, no ORM ceremony, no vendor client                                 |
| Tree layout    | dagre                         | Family trees are layered DAGs; dagre lays out layered DAGs                   |
| Tree rendering | React Flow (`@xyflow/react`)  | Pan, zoom, and edge routing for free                                         |
| Editor         | TipTap                        | WYSIWYG, because the primary author does not write Markdown                  |

## The security model

The single most important decision: **Supabase is used as hosted Postgres, not
as a backend-as-a-service.** The browser never talks to it, never sees a
project URL, and never holds an API key. All database access happens in server
components and route handlers, using a connection string held in Vercel's
environment.

This has a direct consequence: **there is no row-level security.** The app
connects to Postgres as a single role rather than as the signed-in user, so
RLS policies would have no JWT to act on. That is the correct trade for this
architecture, not an oversight — but it means the application layer is the
_only_ boundary.

So there is exactly one boundary, and it is `lib/session.ts`:

```ts
const session = await requireSession(); // throws if not signed in
```

Everything that touches the database goes through it. `proxy.ts` provides a
second, coarser layer: every route is private by default, and the matcher
enumerates the handful of public exceptions rather than the private ones. A new
page is therefore protected the moment it exists.

### Access control

Google sign-in establishes _identity_, not _authorisation_ — anyone with a
Google account can complete the handshake. `ALLOWED_EMAILS` is the entire
membership model, checked in the `signIn` callback. Anyone not on the list is
rejected at the door.

Optionally, leaving the Google OAuth app in **Testing** mode in Google Cloud
Console adds a second gate: only listed test users can complete the flow at
all. Because the app requests only `openid`/`email`/`profile`, it never needs
Google's app verification. The 7-day refresh-token expiry that Testing mode
imposes is irrelevant here — Google is used for identity only, never to call
Google APIs on a user's behalf.

### Entry HTML

Entry bodies are the one place authored markup reaches the browser. TipTap
writes them into a `text` column and the read route (E1-T1) will render them
through `dangerouslySetInnerHTML`, so `lib/sanitize-html.ts` reduces them to an
allowlist — the E1-T2 toolbar and nothing wider — on **write and on read**.

Both ends, not one. Sanitising only on write trusts every row already in the
table, including whatever a seed script or a SQL console put there.
Sanitising only on read leaves the stored value hostile, so the next consumer
— search indexing, diffs, export — inherits the same bug. The function is
idempotent, so the second pass costs a parse and nothing else.

This matters more here than it would elsewhere. With no RLS underneath and no
CSP over the top, the allowlist is the whole defence.

### Links between entries

A link from one entry to another is stored as a plain, **site-relative**
`<a href="/wiki/rose-hall">` — no origin, no scheme, and no marker of any
kind. That is not a simplification; it is the only shape available. The
allowlist above permits exactly one attribute on an `a`, and it is `href`, so
a `class` or a `data-` attribute saying "this one is internal" would be
stripped on the next save. The href is the marker.

Two things follow, and both are deliberate:

- **Bodies outlive the domain they were written on.** An absolute href would
  keep resolving after a move, pointing at somebody else's server, and it
  would do it silently.
- **Resolution happens at render time, against `pages.slug`.** Nothing is
  denormalised, so renaming or deleting an entry needs no sweep over stored
  HTML. A link to an entry that no longer exists is simply one that does not
  resolve — which is what E11-T6 renders red. The editor's link panel reads
  the same hrefs back the same way (`lib/entry-links.ts`, E2-T5), so an author
  who opens a broken link is told it is broken rather than shown an address.

`lib/red-links.ts` is that resolution (E11-T6). It scans a body **once** for
internal links, asks `findExistingSlugs` **once** which of them exist, and
rewrites only the anchors that lead nowhere — red, tooltipped, and pointing at
the create flow pre-titled with the link's own text. The query count is a
property of the shape rather than a rule to remember: the scan is separate
from the lookup, the lookup takes a set, and the rewrite is synchronous, so
there is no `await` inside it for a per-link query to hide in. A body with no
internal links reaches the database not at all.

Three consequences worth stating, because each is load-bearing:

- **It runs after the sanitiser, never before.** The rewrite adds `class` and
  `title`, which the allowlist strips. Sanitising afterwards would undo the
  feature silently, so `lib/red-links.test.ts` asserts it.
- **Nothing is stored.** An entry that gets written turns every link to it
  blue on the next render, with no sweep over stored HTML and no edit to the
  linking entry. Renames and deletions run the same way in reverse.
- **`entryLinkProps` is the shared decision.** Callers that render links as
  React elements rather than as a chunk of HTML — the person infobox (E11-T5)
  — go through it too, and collect their slugs into the same one query. What a
  red link _is_ has one description.

### Secrets

`DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, and `STORAGE_TOKEN` live
in Vercel's environment and never in the repository. `AUTH_SECRET` deserves particular
care: it signs session cookies, so anyone holding it can forge a session as
any allowed user and bypass Google entirely.

The repository is public. That is safe because nothing sensitive is in it —
and because everything personal (the allowlist, the site title) is
configuration rather than code, which is the same property that makes the
project deployable by someone else.

## Data model

A family tree is not a tree. `person.parent_id` collapses immediately on real
families: two parents, remarriage, half-siblings, adoption, step-parents,
unknown parents. The model here follows GEDCOM's core insight — **the union is
a first-class entity**, and children belong to a union rather than to
individuals.

```
individuals ──┬─< unions >─┬── union_children >── individuals
              │            │
        partner_a_id  partner_b_id
```

Three tables (`individuals`, `unions`, `union_children`) cover every case
without special-casing:

- **Remarriage** — a person is a partner in more than one union
- **Half-siblings** — children of different unions sharing one partner
- **Adoption** — an attribute of the child↔union link, not a different shape
- **Unknown parent** — both partner columns are nullable, so you never have to
  invent a placeholder person

Crucially, **relationship labels are never stored.** "Half-sibling",
"step-mother", "cousin", and "in-law" are all derived from two recorded facts:
who partnered with whom, and who was born into which union. This is why the
model survives contact with a real family — you never have to anticipate a
relationship type, because you are not storing relationship types.

### The worked example

The seed fixture (`db/seed-family.ts`, written to the database by
`db/seed.ts`) is modelled on a real family, because invented test data only
exercises the easy cases. Names are placeholders; the shape is the point.

```
[Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
          │              │             │
       1 child      2 children    8 children
```

- Mary married Thomas; they had one child; Mary died
- Rose married Thomas; they had two children; Thomas died
- Rose married Walter; they had eight children

What this exercises:

- Two people (Thomas, Rose) each appear in two unions — the case `d3-tree`
  cannot draw, because it assumes one parent slot per node
- Half-siblings arise on _both_ sides of the chain
- u1's child and u3's children **share no parent at all.** They are not blood
  relations; they are connected only by the chain of remarriages. u2's children
  are the only people related by blood to both ends

If the tree renders this correctly, the hard part works. That sentence is
asserted rather than hoped for: the fixture is a plain value with no database
import, so `lib/tree-layout.seed.test.ts` lays out these very rows and checks
that nobody is duplicated and that generation still means rank.

### The one invariant the model does not enforce

Three tables and two nullable columns express every family shape without a
special case — but nothing in the schema stops `union_children` from being
given a row that makes somebody their own ancestor. There is no constraint
that could: the check is a walk over `unions` and `union_children` together,
and Postgres has no cheap way to state it.

That matters more than a normal data-quality rule, because the graph is walked
as though it were acyclic. `lib/tree-layout.ts` hands it to dagre, which ranks
a cycle by giving up on it, and `lib/person-detail.ts` and `lib/ancestry.ts`
walk it directly. So a single bad row is not a wrong-looking panel; it is
`/tree` failing to render, for everybody, with no way back through the
application.

The rule therefore lives in the application, in exactly one place:
`lib/save-child.ts`, which is the only code that writes a `union_children`
row. It runs `ancestryCycle` against a read taken **inside its own
transaction** rather than trusting whatever the browser last loaded — the same
re-read-and-re-check pattern `lib/remove-from-tree.ts` and `lib/save-union.ts`
follow. The forms filter their own pickers with the same function so the
impossible options never appear, but that is a courtesy and not the boundary.

The walk itself is pure — `FamilyGraph` in, a set of ids out — which is what
lets the cases that matter (a direct loop, a multi-generation one, and the
diamond where cousins marry and two lines of descent legitimately rejoin) be
asserted with no database at all.

### Date precision

A `date` column can only hold an exact day, and genealogical sources routinely
do not supply one — "about 1890", "before 1920", a year read off a headstone.
Every date column therefore has a `date_qualifier` sibling
(`exact` / `about` / `before` / `after`, defaulting to `exact`):
`individuals.birth_date`, `individuals.death_date`, `unions.start_date`, and
`unions.end_date`.

Two consequences worth naming. Imprecision no longer has to hide in `notes`,
where nothing can query or format it; and the four values are exactly GEDCOM
5.5.1's date modifiers, so `ABT`/`BEF`/`AFT` survive a round trip through
import and export instead of being silently discarded.

A qualifier answers only half the question, though, and E4-T2 (`YEO-39`) added
the other half. "How far can this be trusted" is not the same question as "how
much of a date did the source actually give" — a headstone gives a year, a
census gives a year, a parish register gives a day, and none of those is
`about`. So every date column has a **second** sibling, `date_precision`
(`day` / `month` / `year`, defaulting to `day`).

The storage convention it establishes: a coarse date is stored on the **first
day of the month or year it names**, and that day is an _anchor_, never an
assertion. Nothing reads it as a day on its own — `formatQualifiedDate` prints
`1890`, `isImpossibleOrder` widens it back out to the whole year before
comparing, and a GEDCOM export will emit `1890`. Without the column, a year off
a headstone had nowhere to go but 1 January, and every reader downstream then
repeated that invented day as though somebody had recorded it.

That pair is what lets the date field be a single text box. `lib/parse-date.ts`
turns `about 1890`, `c. 1890`, `before 1920` or `12 March 1890` into the three
columns; `formatQualifiedDate` turns them back into the same sentence, so the
round trip closes and an edit form can prefill free text without a second
formatter. An author never picks a qualifier from a dropdown before typing a
date — see `components/DateField.tsx`.

#### One formatter, and why it is one

`lib/format-date.ts` (E4-T3, `YEO-40`) is the only module that turns those
columns into words, and every surface that shows a date goes through it: the
tree node label, the detail panel, the removal dialogue, the date field's echo
and the edit form's prefill. Formatting a date is easy, which is exactly the
problem — easy things get rewritten locally, and the local rewrite is where
somebody reaches for `person.birthDate` alone and publishes the anchor day as
a birthday.

Two properties the module enforces rather than documents:

- **`precision` is a required parameter.** It briefly had a `day` default, and
  the cost was a bug that shipped green: call sites that forgot the third
  argument rendered a year off a headstone as "1 January 1890", in the voice
  of a recorded fact. Every fixture at the time used day precision, so no test
  disagreed. Requiring it moves the omission from something a reviewer has to
  catch to something the compiler will not build.
- **A missing date renders as nothing.** Not "unknown", not a dash.
  `formatQualifiedDate` returns `null` and `formatLifespan` returns `""`, so
  every caller omits the element. Most of a nineteenth-century record is
  missing; a column of em dashes reads as a defect in the tree rather than as
  the honest limit of what the source said.

`formatLifespan` lives there too — the years under a name, `1899–1960` or
`b. about 1890` — and carries the qualifier for the same reason the panel
does. `b. 1890` and `b. about 1890` are different claims, and the node is the
most-read surface in the application to be making the wrong one on. It takes
no precision, and that is not the same omission: the anchor convention puts
the year in the same four characters at every precision, so a year is the one
part of a stored date that reading back can never invent.

### Ordering

Unions sort by `sequence` first and `start_date` second. In older generations
exact marriage dates are often lost while the _order_ is remembered perfectly
well ("she remarried after he died"). Sorting on dates alone would silently
scramble the story whenever a year is missing.

## Rendering

Generation maps to dagre rank. Unions are laid out as their own small nodes,
which is what allows a twice-married person to sit between both of their
unions rather than being duplicated on the canvas.

**Layout is computed, never stored.** There are no x/y coordinates in the
database. This is a product decision as much as a technical one — see
`product.md` — and it also removes an entire class of work: no re-layout when
someone inserts a grandparent, no persistence, no drag state, no way for an
editor to shove the family off-screen with no undo.

Scale is small: a family tree is hundreds of people at most, so the entire
graph is loaded in one query and laid out client-side. No pagination, no
virtualisation.

## Deployment and migrations

`vercel.json` disables git deployments for every branch except `main`, so a
production build is only ever a merge. That build runs migrations first:

```
buildCommand: npm run db:migrate:deploy && npm run build
```

The ordering is the design. Applying migrations _after_ a deploy leaves a
window in which the new code queries columns that do not exist yet; applying
them before means the schema is always at or ahead of the code. And because
`&&` short-circuits, a migration that fails fails the build, and a failed
build is never promoted — so there is no deploy that assumes a migration
which did not happen.

Two consequences worth naming rather than discovering:

- **Rolling back a deployment does not roll back the database.** Vercel's
  instant rollback restores code only. Migrations should therefore be
  additive — add a column, backfill, stop reading the old one, drop it in a
  later release — so that the previous build still runs against the new
  schema.
- **Two merges in quick succession build concurrently.** Drizzle's migrator
  takes no advisory lock, so overlapping builds could in principle apply the
  same migration twice. At this project's rate of change the honest mitigation
  is to not merge twice in a minute.

Migrations use the _session_ pooler or direct connection (`MIGRATE_DATABASE_URL`,
port 5432), not the transaction pooler the app uses. A transaction pooler hands
out a different backend per transaction, which is right for serverless request
handlers and wrong for DDL.

`MIGRATE_DATABASE_URL` falls back to `DATABASE_URL` when unset, which is right
locally and wrong in production — and silently so, since ordinary additive DDL
usually succeeds over the transaction pooler anyway. `db/migrate.ts` therefore
logs which variable it used and against which host (never the password), so a
missing variable shows up in the first build log rather than in a later
migration that fails for reasons nobody connects to it.

Drizzle applies every pending migration inside **one** transaction. That is
what makes a half-applied migration impossible, and it also means
`CREATE INDEX CONCURRENTLY` — which cannot run in a transaction block — will
fail here. This is a property of the migrator rather than of this setup
(`drizzle-kit migrate` behaves the same), but it matters more now that
migrations gate every merge: an index on a table large enough to care about
locking needs applying by hand, outside the deploy.

`db/migrate.ts` uses `drizzle-orm`'s migrator rather than `drizzle-kit migrate`,
because drizzle-kit is a development tool that opens its own connection — there
is no way to give it `prepare: false` and `max: 1`. `npm run db:migrate` remains
the drizzle-kit path for local use.

## Portability

The only Vercel-specific dependency the application would have to _replace_
is image storage, and it sits behind a single module so it can be swapped in
one file. (`@vercel/analytics` is the one other vendor import in the tree, and
it is not an exception to this: on another host it is deleted rather than
reimplemented, so nothing is owed an interface.) Everything else runs on any
Node host with any Postgres:

- `output: "standalone"` produces a self-contained server bundle (it is switched
  off when `VERCEL` is set, since Vercel's builder emits its own output format
  and the standalone tracing step fails there)
- Environment variables are named generically (`DATABASE_URL`, not
  `SUPABASE_URL`; `STORAGE_TOKEN`, not `BLOB_READ_WRITE_TOKEN`)
- `prepare: false` is set unconditionally — required by Supabase's transaction
  pooler, harmless everywhere else
- The Supabase keep-alive cron belongs in GitHub Actions rather than Vercel
  Cron, since it is a Supabase concern and not an application one
- Migrations run through `npm run db:migrate:deploy`, an ordinary script with
  no host in it; only the line in `vercel.json` that calls it is Vercel-shaped,
  and another host would call the same script from its own build step

### The storage seam

That first bullet is the one that needs enforcing rather than asserting, and
`lib/storage.ts` (E5-T1) is the enforcement. It exports three functions —
`put`, `get`, `delete` — and it is the only file in the repository that
imports a storage vendor's SDK.

Both halves of that are checked. `lib/storage.test.ts` asserts the export list
is exactly those three names, and `lib/storage.call-sites.test.ts` scans the
source tree and fails if any other file names a `@vercel/*` package — the same
tripwire shape `lib/sanitize-html.call-sites.test.ts` uses, and for the same
reason. The claim above is not hard to keep true; it is hard to _notice_
becoming false, because `import { put } from "@vercel/blob"` in a route
handler works perfectly, reviews fine, and only costs anything on the day
somebody tries to leave.

The three functions are the intersection, not a subset chosen for now. Every
object store has `put`/`get`/`delete`; the moment a fourth appears — `list`,
`copy`, a presigned-URL helper — the set of hosts that can implement this
narrows to the ones that agree with Vercel, which is the seam leaking rather
than widening.

Four decisions inside the module are worth naming, because each is a default
that would have been wrong:

- **The credential is `STORAGE_TOKEN`**, read and passed explicitly. The SDK
  would happily pick up `BLOB_READ_WRITE_TOKEN` from the environment on its
  own, and leaning on that would put a vendor's variable name straight back
  into the deploy configuration this convention exists to keep generic. Same
  reasoning as `DATABASE_URL` over `SUPABASE_URL`.
- **The key you write is the key you read.** `addRandomSuffix` is pinned off;
  with it on, the stored path is something only the `put` response ever knew,
  and `get(key)` finds nothing.
- **`put` replaces.** Vercel's SDK defaults to refusing a write onto an
  existing path. S3, GCS, R2 and a filesystem do not. A seam whose semantics
  are one host's opinion is not a seam.
- **`get` returns a URL, not bytes.** Every host can produce one, and the
  alternative makes the application a proxy for its own static assets.

That last one carries a trade worth stating plainly: blobs are stored with
`access: "public"`, so an image URL is reachable by anyone holding it,
outside the `ALLOWED_EMAILS` boundary that guards everything else. The URL is
unguessable — a random store id plus the key — but a leaked one is a readable
image. It is a trade rather than a hole precisely because of the seam: moving
to short-lived signed URLs changes `put` and `get` in this one file and no
call site.

The credential itself belongs with `AUTH_SECRET` in the section above: it
grants write and delete on the store, and never appears in the repository.

## Known limitations

- **No RLS.** By design (see above), but it means a route handler that forgets
  `requireSession()` has nothing underneath it to fail safe.
- **Free-tier pausing.** Supabase pauses free projects after roughly a week of
  inactivity. A family wiki visited monthly will be found asleep. A daily cron
  that touches the database avoids this.
