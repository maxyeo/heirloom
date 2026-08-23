# Heirloom

A private family wiki and family tree. A few named people sign in with Google;
everyone else gets a locked door. Entries are written in a normal WYSIWYG
editor, and the family tree is generated from structured records rather than
drawn by hand.

Built for Vercel + Supabase, but it runs on any Node host with any Postgres.

- [Product overview](docs/product.md) — what it is and who it is for
- [Architecture](docs/architecture.md) — the data model and the security model
- [Design tokens](docs/design-tokens.md) — the Wikipedia type, colour and
  layout values, and the one rule that keeps them in one place
- [Testing](docs/testing.md) — how the suite is split, and how to test
  something that needs Postgres

## Status

Early. Auth, the schema, and the read-only family tree work. The wiki and the
tree editor are next — see [Status](docs/product.md#status).

## Setup

### 1. Database

Any Postgres works. On Supabase, create a project and copy the **pooler**
connection string — Connect → Transaction pooler, port `6543`. Do not use the
direct connection; serverless functions will exhaust its connection limit.

### 2. Google OAuth

In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services
→ Credentials, create an **OAuth client ID** of type *Web application* and add
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

Then fill in `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and
`ALLOWED_EMAILS`.

`ALLOWED_EMAILS` is the entire membership model. Google sign-in proves who
someone is; it has no opinion on whether they are allowed in. Anyone not on
that comma-separated list is rejected.

### 4. Migrate and run

```bash
npm install
npm run db:migrate       # apply migrations
npm run db:seed          # optional: load the example family
npm run dev            # http://localhost:3001
```

The seed fixture is a deliberately awkward family — two widowings and three
marriages across four adults and eleven children. It exists to prove the tree
renders the hard cases. See
[the worked example](docs/architecture.md#the-worked-example).

## Tests

```bash
npm test                 # everything that needs no database
npm run test:watch
npm run test:db          # only the tests that do need one
```

The suite is split on a filename: `*.test.ts` is pure and runs in CI,
`*.db.test.ts` needs Postgres and runs only under `npm run test:db`. CI runs
`npm test` with no `DATABASE_URL` and no `AUTH_*` at all, which is what keeps
that boundary honest. See [Testing](docs/testing.md) before writing a test that
needs a database.

## Deploying

Push to GitHub, import the repo in Vercel, and set the same environment
variables in the project settings. Add your production callback URL to the
Google OAuth client.

**Keep the database awake.** Supabase pauses free projects after about a week
of inactivity, which will find a family wiki that gets visited monthly. The
`Keep database awake` workflow (`.github/workflows/keep-alive.yml`) runs a
trivial query once a day to avoid it.

It needs one thing from you: add the same pooler connection string as a
repository secret named `DATABASE_URL`, under **Settings → Secrets and
variables → Actions**. Until that exists every run fails. Once it is set, run
the workflow manually from the Actions tab to confirm it passes rather than
waiting a day to find out.

If the keep-alive ever breaks it opens an issue labelled `keep-alive`, and
closes it again on the next successful run — a silently broken keep-alive
would be no better than not having one. Note that GitHub disables scheduled
workflows in repositories with no activity for 60 days, and emails the owner
when it does.

The scheduled run is skipped in forks, since a fork does not inherit the
secret and would otherwise file itself a daily bug report about a Supabase
workaround it never asked for. If you forked this and are on Supabase, run the
workflow manually or edit the repository name in its `if:` condition. If you
are on any other Postgres, you do not need this workflow at all — delete it.

### Other hosts

`output: "standalone"` is set, so `next build` produces a self-contained server
bundle that runs under plain Node or in a container. Nothing outside image
storage is tied to Vercel, and environment variables are named generically so
any Postgres provider works.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Tests that need no database — what CI runs |
| `npm run test:watch` | The same suite, in watch mode |
| `npm run test:db` | Tests that need a database |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Reset and load the example family |
| `npm run db:keep-alive` | Ping the database so Supabase does not pause it |
| `npm run db:studio` | Drizzle Studio |

## Licence

MIT.
