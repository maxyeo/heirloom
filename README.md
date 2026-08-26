# Heirloom

A private family wiki and family tree. A few named people sign in with Google;
everyone else gets a locked door. Entries are written in a normal WYSIWYG
editor, and the family tree is generated from structured records rather than
drawn by hand.

Built for Vercel + Supabase, but it runs on any Node host with any Postgres.

- [Product overview](docs/product.md) — what it is and who it is for
- [Architecture](docs/architecture.md) — the data model and the security model
- [Deploying](docs/deploying.md) — the production runbook, written for someone
  who did not build it
- [Backups](docs/backups.md) — what is taken nightly, how long it is kept, and
  how to restore it on the day that matters
- [Design tokens](docs/design-tokens.md) — the Wikipedia type, colour and
  layout values, and the one rule that keeps them in one place
- [Testing](docs/testing.md) — how the suite is split, and how to test
  something that needs Postgres
- [GEDCOM](docs/gedcom.md) — the import format, why the parser imports nothing,
  and what it reports rather than drops
- [Export](docs/export.md) — what the family can take with them, what is in the
  archive, and how to read it back

## Status

Early. Auth, the schema, and the read-only family tree work. The wiki and the
tree editor are next — see [Status](docs/product.md#status).

## Setup

### 1. Database

Develop against a local Postgres, not the deployed one:

```bash
createdb heirloom
```

That's it — `.env.example`'s `DATABASE_URL` already points at
`postgresql://localhost:5432/heirloom`, postgres.js defaults the connection
user to your OS user, and a local install accepts local connections with no
password.

Heirloom _deploys_ to Supabase. If you're setting up a deployment, create a
project and copy the **pooler** connection string — Connect → Transaction
pooler, port `6543`. Do not use the direct connection there; serverless
functions will exhaust its connection limit. See [Reaching production
deliberately](#reaching-production-deliberately) for pointing your own
machine at it without touching `DATABASE_URL`.

### 2. Google OAuth

In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services
→ Credentials, create an **OAuth client ID** of type _Web application_ and add
these authorised redirect URIs:

```
http://localhost:3001/api/auth/callback/google
https://<your-domain>/api/auth/callback/google
```

Only the `openid`, `email`, and `profile` scopes are used, so the app never
needs Google's verification review. Leaving the consent screen in **Testing**
mode and adding your users as test users gives you a second access gate for
free.

### 3. Environment

```bash
cp .env.example .env.local
npx auth secret          # writes AUTH_SECRET
```

`DATABASE_URL` is already filled in for the local Postgres from step 1. Fill
in `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `ALLOWED_EMAILS`.

`ALLOWED_EMAILS` is the entire membership model. Google sign-in proves who
someone is; it has no opinion on whether they are allowed in. Anyone not on
that comma-separated list is rejected.

### 4. Migrate and run

```bash
npm install
npm run db:migrate       # apply migrations to the local database
npm run db:seed          # optional: reset it and load the example family
npm run dev            # http://localhost:3001
```

The seed fixture is a deliberately awkward family — two widowings and three
marriages across four adults and eleven children. It exists to prove the tree
renders the hard cases. See
[the worked example](docs/architecture.md#the-worked-example).

**`npm run db:seed` deletes every row first, with no confirmation and nothing
to undo it**, before inserting the fixture. It refuses to run at all against
anything other than a local host (`localhost`, `127.0.0.1`, `::1`) unless
`SEED_ALLOW_DESTRUCTIVE` names the exact target it's about to wipe — the
`user@host` pair the connection string uses, or just the host if the URL
carries no username. Hostname alone isn't enough to identify a project on
Supabase's shared pooler, where every project behind a region resolves to
the same hostname and the project only shows up in the username
(`postgres.<project-ref>`) — see
[Reaching production deliberately](#reaching-production-deliberately). The
refusal message prints the exact value to set, so you copy it rather than
guess at the format.

## Which database you're pointing at

By default, and after following Setup above, `DATABASE_URL` is your local
`heirloom` Postgres database. That's the database every script in this README
talks to unless you say otherwise.

### Reaching production deliberately

Sometimes you genuinely need the deployed database from your own machine —
checking something migrations changed, running a one-off read. Set
`PRODUCTION_DATABASE_URL` in `.env.local` once (see `.env.example`), then
select it per-command with `DATABASE_TARGET`:

```bash
DATABASE_TARGET=production npm run db:studio
```

`DATABASE_URL` itself is never edited to do this — `DATABASE_TARGET` swaps
which variable it resolves from for that one command. The same switch has a
`test` value, which `npm run test:db` sets for you; see
[Testing](docs/testing.md) and `lib/database-target.ts`.

## Tests

```bash
npm test                 # everything that needs no database
npm run test:watch
npm run test:db          # only the tests that do need one, against heirloom_test
```

The suite is split on a filename: `*.test.ts` is pure, `*.db.test.ts` needs
Postgres and runs only under `npm run test:db`, which points at a separate
local `heirloom_test` database via `DATABASE_TARGET=test` — your everyday
`DATABASE_URL` is never touched by it.

**Both halves run in CI and both gate a merge**, in two jobs: `check` runs
`npm test` with no `DATABASE_URL` and no `AUTH_*` at all, which is what keeps
that boundary honest, and `database` runs `npm run test:db` against a
throwaway Postgres service container of its own. See
[Testing](docs/testing.md) before writing a test that needs a database.

## Deploying

Push to GitHub, import the repo in Vercel, set the environment variables in
the project settings, and add your production callback URL to the Google OAuth
client. Migrations run as the first half of Vercel's build command, so a merge
to `main` migrates production before the code that depends on the new schema
is ever served.

Two things are easy to get wrong and hard to diagnose from the symptom.
`MIGRATE_DATABASE_URL` has to be Supabase's _session_ pooler (port `5432`),
not the transaction pooler `DATABASE_URL` uses — unset, it falls back to
`DATABASE_URL` and fails quietly, much later. And a database whose tables came
from `db:push` has no migration ledger, so it needs baselining once before the
first build or that build replays `0000` and dies on "already exists".

**[Deploying](docs/deploying.md) is the full runbook**: every environment
variable and where to get it, the Google OAuth setup and what Testing versus
Published mode implies, the `ALLOWED_EMAILS` membership model, that one-time
baseline check, and the steps that verify a deploy actually works.

**Keep the database awake.** Supabase pauses free projects after about a week
of inactivity, which will find a family wiki that gets visited monthly. The
`Keep database awake` workflow (`.github/workflows/keep-alive.yml`) runs a
trivial query once a day to avoid it. It needs a repository secret named
`DATABASE_URL` before it will pass — see [Keep the database
awake](docs/deploying.md#8-keep-the-database-awake).

**Back it up.** The Supabase free tier has no backups at all, so until this is
set up the deployed database is the only copy of the family's history. The
`Back up the database` workflow (`.github/workflows/backup.yml`) dumps it
nightly, encrypts it, and — every single night — restores it into a throwaway
PostgreSQL and checks that every row came back, because an untested backup is
a hypothesis. It needs two repository secrets, `BACKUP_DATABASE_URL` and
`BACKUP_PASSPHRASE`. The retention policy, what is deliberately not covered,
and the restore procedure are in [Backups](docs/backups.md).

### Other hosts

`output: "standalone"` is set for every build except Vercel's, so `next build`
produces a self-contained server bundle that runs under plain Node or in a
container. Nothing outside image storage is tied to Vercel, and environment
variables are named generically so any Postgres provider works. See [Another
host](docs/deploying.md#another-host) for the two things that differ.

Image storage is the one exception, and it is confined to `lib/storage.ts` —
four functions (`put`, `get`, `delete`, `list`), one vendor import, one
`STORAGE_TOKEN` to point somewhere else. `lib/storage.call-sites.test.ts` turns the suite red if a
second file ever imports the vendor directly, which is the only reason that
sentence stays true.

## Scripts

| Script                      | Does                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`               | Development server                                                                               |
| `npm run build`             | Production build                                                                                 |
| `npm run typecheck`         | `tsc --noEmit`                                                                                   |
| `npm test`                  | Tests that need no database — CI's `check` job                                                   |
| `npm run test:watch`        | The same suite, in watch mode                                                                    |
| `npm run test:db`           | Tests that need a database, against `heirloom_test` — CI's `database` job                        |
| `npm run db:generate`       | Generate a migration from schema changes                                                         |
| `npm run db:migrate`        | Apply migrations to `DATABASE_URL`                                                               |
| `npm run db:migrate:test`   | Apply migrations to `heirloom_test`                                                              |
| `npm run db:migrate:deploy` | Apply migrations the way the deploy does                                                         |
| `npm run db:seed`           | Reset and load the example family — refuses on a non-local host without `SEED_ALLOW_DESTRUCTIVE` |
| `npm run db:keep-alive`     | Ping the database so Supabase does not pause it                                                  |
| `npm run db:studio`         | Drizzle Studio                                                                                   |

## Licence

MIT, with one exception — and it is a test fixture rather than any of the code.

`test/fixtures/gedcom/TGC55C.ged` is the published GEDCOM 5.5 Torture Test,
committed unmodified so that a real third-party file, and not only ones written
here, has to survive the GEDCOM round trip. Its authors permit use "for any
non-commercial purpose", which is narrower than the licence above, so that one
path is not covered by it. Nothing under `app/` or `lib/` imports the file, it
is read only by `lib/gedcom-round-trip.test.ts`, and it is in no build output.
`test/fixtures/gedcom/README.md` records where it came from, when, and on what
terms; anybody building something commercial on this repository should delete
it and the `describe` block that reads it.
