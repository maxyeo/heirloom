# Architecture

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js (App Router) | Server components mean the database is reachable without a separate API tier |
| Host | Vercel | Free tier is sufficient; `output: "standalone"` keeps other hosts open |
| Auth | Auth.js v5, Google provider | One-click sign-in for people who already live in Gmail |
| Database | Postgres (Supabase free tier) | Used as *plain Postgres*, not as a backend-as-a-service |
| Query layer | Drizzle + `postgres.js` | Typed SQL, no ORM ceremony, no vendor client |
| Tree layout | dagre | Family trees are layered DAGs; dagre lays out layered DAGs |
| Tree rendering | React Flow (`@xyflow/react`) | Pan, zoom, and edge routing for free |
| Editor | TipTap | WYSIWYG, because the primary author does not write Markdown |

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
*only* boundary.

So there is exactly one boundary, and it is `lib/session.ts`:

```ts
const session = await requireSession(); // throws if not signed in
```

Everything that touches the database goes through it. `proxy.ts` provides a
second, coarser layer: every route is private by default, and the matcher
enumerates the handful of public exceptions rather than the private ones. A new
page is therefore protected the moment it exists.

### Access control

Google sign-in establishes *identity*, not *authorisation* — anyone with a
Google account can complete the handshake. `ALLOWED_EMAILS` is the entire
membership model, checked in the `signIn` callback. Anyone not on the list is
rejected at the door.

Optionally, leaving the Google OAuth app in **Testing** mode in Google Cloud
Console adds a second gate: only listed test users can complete the flow at
all. Because the app requests only `openid`/`email`/`profile`, it never needs
Google's app verification. The 7-day refresh-token expiry that Testing mode
imposes is irrelevant here — Google is used for identity only, never to call
Google APIs on a user's behalf.

### Secrets

`DATABASE_URL`, `AUTH_SECRET`, and `AUTH_GOOGLE_SECRET` live in Vercel's
environment and never in the repository. `AUTH_SECRET` deserves particular
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

The seed fixture (`db/seed.ts`) is modelled on a real family, because invented
test data only exercises the easy cases. Names are placeholders; the shape is
the point.

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
- Half-siblings arise on *both* sides of the chain
- u1's child and u3's children **share no parent at all.** They are not blood
  relations; they are connected only by the chain of remarriages. u2's children
  are the only people related by blood to both ends

If the tree renders this correctly, the hard part works.

### Ordering

Unions sort by `sequence` first and `start_date` second. In older generations
exact marriage dates are often lost while the *order* is remembered perfectly
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

## Portability

The only Vercel-specific dependency is image storage, and it sits behind a
single module so it can be swapped in one file. Everything else runs on any
Node host with any Postgres:

- `output: "standalone"` produces a self-contained server bundle
- Environment variables are named generically (`DATABASE_URL`, not
  `SUPABASE_URL`)
- `prepare: false` is set unconditionally — required by Supabase's transaction
  pooler, harmless everywhere else
- The Supabase keep-alive cron belongs in GitHub Actions rather than Vercel
  Cron, since it is a Supabase concern and not an application one

## Known limitations

- **Date precision.** Dates are stored as `date`, which cannot express "about
  1890" or "before 1920" — both common in genealogy. The `notes` field is the
  current escape hatch. A proper fix would add a qualifier column.
- **No RLS.** By design (see above), but it means a route handler that forgets
  `requireSession()` has nothing underneath it to fail safe.
- **Free-tier pausing.** Supabase pauses free projects after roughly a week of
  inactivity. A family wiki visited monthly will be found asleep. A daily cron
  that touches the database avoids this.
