# Deploying

This is the runbook for putting Heirloom into production, written for someone
who did not build it. It assumes you can use a terminal and a SQL console, and
nothing else about you.

The target is Vercel plus Supabase, because that is what the repository is
configured for and what `vercel.json` describes. Nothing here is
Vercel-specific in the application itself — see [Another host](#another-host)
at the end for the two things that change.

Read [The security model](architecture.md#the-security-model) first if you
have not. Two facts from it shape most of this document: `ALLOWED_EMAILS` is
the entire membership model, and there is no row-level security underneath the
application to catch a mistake in it.

## What you will need

- A GitHub account, with this repository forked or copied into it
- A [Vercel](https://vercel.com) account, connected to that GitHub account
- A [Supabase](https://supabase.com) account (the free tier is enough)
- A [Google Cloud Console](https://console.cloud.google.com/) project
- The list of email addresses that are allowed to sign in

Do the steps in order. Step 4 in particular has to happen **before** the first
deploy, and is the one thing in here that cannot be fixed afterwards without
reading a stack trace first.

## 1. Create the database

In Supabase, create a project. Choose a region near the people who will use
it, and keep the database password it generates — it is part of every
connection string below and Supabase will not show it again.

Then open **Connect** on the project and copy **two** different strings. They
are not interchangeable, and which is which matters:

| Supabase calls it  | Port   | Goes in                | Used by                      |
| ------------------ | ------ | ---------------------- | ---------------------------- |
| Transaction pooler | `6543` | `DATABASE_URL`         | Every request the app serves |
| Session pooler     | `5432` | `MIGRATE_DATABASE_URL` | Migrations, during the build |
| Direct connection  | `5432` | Nothing                | —                            |

**The transaction pooler is right for the app.** Serverless functions come and
go constantly, and a pooler in transaction mode is what stops them exhausting
Postgres's connection limit. It hands out a different backend per transaction
and does not support prepared statements, which is why `db/index.ts` sets
`prepare: false` unconditionally.

**The transaction pooler is wrong for migrations**, for exactly the same
reasons. DDL wants one backend, in order, for the whole run. That is the
session pooler, and it is why there is a second variable at all — see
[`MIGRATE_DATABASE_URL`](#migrate_database_url) below.

**The direct connection is not an option here.** It is IPv6-only on Supabase's
free tier, and Vercel's builders do not resolve it. It would look correct and
fail at connect time.

Both pooler strings carry the password in them, and on Supabase's shared
pooler the project lives in the _username_ (`postgres.<project-ref>`), not the
hostname. Treat both like passwords.

## 2. Set up Google sign-in

Google establishes _who_ someone is. It has no opinion on whether they belong
here — that is step 3.

In Google Cloud Console, under **APIs & Services**:

1. **OAuth consent screen.** User type **External**. Fill in the app name and
   support email. Add only the `openid`, `email`, and `profile` scopes. Those
   three are all the application requests, and they are all non-sensitive, so
   the app never needs Google's verification review.

2. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Add these authorised redirect URIs:

   ```
   http://localhost:3001/api/auth/callback/google
   https://<your-domain>/api/auth/callback/google
   ```

   The path is not configurable here. Auth.js defaults its base path to
   `/api/auth`, and `google` is the provider id, so the callback is exactly
   that. Google matches redirect URIs by exact string — a trailing slash, or
   `http` where you meant `https`, is a `redirect_uri_mismatch` at sign-in and
   nothing earlier.

3. Copy the client ID and client secret. They become `AUTH_GOOGLE_ID` and
   `AUTH_GOOGLE_SECRET` — Auth.js reads `AUTH_<PROVIDER>_ID` and
   `AUTH_<PROVIDER>_SECRET` by convention, which is why `auth.ts` passes
   `Google` with no configuration of its own.

You do not need a redirect URI per preview deployment: `vercel.json` disables
git deployments for every branch except `main`, so there are no preview URLs
to register.

### Testing mode versus Published

The consent screen is in one of two publishing states, and the choice is a
real one.

**Testing** (the default) means only accounts you list as test users can
complete the OAuth flow at all — up to 100 of them. Everyone else is refused
by Google, before the application ever sees a request. That is a **second
gate** in front of `ALLOWED_EMAILS`, for free, and for a private family wiki
it is the recommended state.

Its usual drawback does not apply here. Testing mode expires refresh tokens
after seven days, which would be painful for an app that calls Google APIs on
a user's behalf. This one never does — Google is used for identity only, at
sign-in, and the session afterwards is a JWT cookie this application signs
itself. There is no refresh token in play to expire.

The cost is bookkeeping: every allowed person has to be added in **two**
places, the Google test-user list and `ALLOWED_EMAILS`. A person added to only
the second gets a Google error page rather than the application's "not allowed"
page, which is a confusing way to find out.

**Published** ("In production") means anyone with a Google account can
complete the handshake. Because the app requests only non-sensitive scopes it
does not trigger verification review, so publishing is a single click and does
not involve Google in any further way. It removes the double bookkeeping — and
it removes the second gate, leaving `ALLOWED_EMAILS` as the only thing between
a stranger and the wiki.

Either is defensible. What is not defensible is publishing and then being
casual about `ALLOWED_EMAILS`, because after publishing that list is the whole
boundary.

## 3. Set the environment variables

In Vercel, under **Settings → Environment Variables**. Every variable below is
needed in the **Production** scope; add them to Preview and Development too
only if you intend to deploy those, which by default this repository does not.

| Variable                 | Required | What it is, and where it comes from                                                                                              |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Yes      | Supabase **transaction** pooler string, port `6543` (step 1). Every request the app serves goes through it                       |
| `MIGRATE_DATABASE_URL`   | Yes      | Supabase **session** pooler string, port `5432` (step 1). Used only by the migration step of the build                           |
| `AUTH_SECRET`            | Yes      | Generate it yourself: `npx auth secret`. Signs the session cookie                                                                |
| `AUTH_GOOGLE_ID`         | Yes      | OAuth client ID from step 2                                                                                                      |
| `AUTH_GOOGLE_SECRET`     | Yes      | OAuth client secret from step 2                                                                                                  |
| `ALLOWED_EMAILS`         | Yes      | Comma-separated addresses of everyone allowed in. You write this one                                                             |
| `STORAGE_TOKEN`          | Not yet  | Read-write token for a **private** Blob store. Nothing reads it until image upload ships — see [`STORAGE_TOKEN`](#storage_token) |
| `NEXT_PUBLIC_SITE_TITLE` | No       | The name in the header and page titles. Defaults to `Heirloom` (`lib/site.ts`). This is the one thing an install renames         |

`VERCEL` is set by the platform, not by you. `next.config.ts` reads it to drop
`output: "standalone"`, which Vercel's own builder does not want.

The rest of the variables in `.env.example` — `TEST_DATABASE_URL`,
`PRODUCTION_DATABASE_URL`, `DATABASE_TARGET`, `SEED_ALLOW_DESTRUCTIVE`,
`BACKUP_DATABASE_URL`, `RESTORE_DATABASE_URL`, and
`RESTORE_ALLOW_DESTRUCTIVE` — do not belong in Vercel. They exist so a
_developer's_ machine can point at a database other than the local one on
purpose (and, for `BACKUP_DATABASE_URL`, so GitHub Actions can — it is a
repository secret, set in [step 9](#9-set-up-backups), not a Vercel
variable); see
[Reaching production deliberately](../README.md#reaching-production-deliberately).
Setting `DATABASE_TARGET` in a deploy environment in particular would only
break it.

### `ALLOWED_EMAILS`

This is the entire membership model. There is no admin UI, no invite flow, and
no users table — sessions are JWTs and there is no database adapter. Adding a
person is editing this variable; removing a person is editing this variable.

```
ALLOWED_EMAILS="rose@example.com,walter@example.com"
```

Comma-separated. Whitespace around entries is trimmed and comparison is
case-insensitive on both sides, so a trailing comma or `Rose@Example.com` is
fine. The rules are in `lib/allowed-emails.ts` and asserted in
`lib/allowed-emails.test.ts`; three things get you turned away, in order: no
email address at all, an address the provider explicitly says it did not
verify, and an address that is not on the list.

Two consequences worth being clear about:

- **Changes need a redeploy to take effect.** `lib/allowed-emails.ts` reads
  the variable at call time rather than capturing it at module load, but that
  only settles the application's half. Vercel binds environment variables to a
  deployment, so editing one leaves the deployment already serving traffic on
  the old value. After editing the list, redeploy — Vercel's **Redeploy**
  button on the latest deployment is enough, and no commit is needed.
- **Removing someone does not end their session.** The check runs at sign-in.
  An existing session cookie stays valid until it expires. To cut someone off
  immediately, remove them from the list _and_ rotate `AUTH_SECRET`, which
  invalidates every session at once — see below.

### `AUTH_SECRET`

Generate it with `npx auth secret`, or any 32+ bytes of randomness.

**Anyone holding this value can forge a session as any allowed user and bypass
Google entirely.** It signs the session cookie, and the application trusts a
correctly signed cookie completely — there is no second check against Google
once a session exists, and no row-level security underneath to fall back on.
It is stated in [Secrets](architecture.md#secrets) and it is worth repeating
here because it is the one value in this document whose exposure is not
recoverable by fixing a setting.

So: never paste it into an issue, a pull request, a chat message, or a log
line. It lives in Vercel's environment and nowhere else. Use a different value
in production from the one in your `.env.local`.

Rotating it is safe and cheap — set a new value and redeploy. The only effect
is that everyone is signed out and signs in again with Google. Do it if the
value was ever exposed, and whenever you remove somebody from
`ALLOWED_EMAILS` for a reason that could not wait.

### `MIGRATE_DATABASE_URL`

Migrations run during the build (step 5), and they need a different connection
from the one the application uses. `db/migrate.ts` reads this variable, and
falls back to `DATABASE_URL` when it is unset.

That fallback is the reason this needs saying out loud. It is correct
locally and on any plain Postgres, where there is only one connection string
and it is already the right kind. On Supabase it is wrong, and **it is wrong
quietly**: with `prepare: false` and `max: 1`, ordinary additive DDL usually
succeeds over the transaction pooler anyway. The misconfiguration then sits
unnoticed until some later migration needs something the transaction pooler
cannot do — and the build that breaks is not the build that introduced the
mistake.

`db/migrate.ts` logs which variable it used and against which host, precisely
so a missing variable shows up in the first build log. Checking that line is
step 7.

### `STORAGE_TOKEN`

Image upload is not built yet (`E5-T2`), so this one can wait. When you do get
to it, one choice is made at store-creation time and is awkward to revisit.

**Create the Blob store with its access set to Private.** In Vercel:
**Storage → Create Database → Blob**, and set access to **Private** before
creating it. Copy the read-write token into `STORAGE_TOKEN` — not into
`BLOB_READ_WRITE_TOKEN`, which Vercel's integration also injects and which
this application deliberately ignores, so that the deploy configuration goes
on naming what the app needs rather than who is providing it.

Private is not a preference here. Photographs are family material and belong
behind the same `ALLOWED_EMAILS` boundary as everything else, so
`lib/storage.ts` writes with `access: "private"` and serves each image through
a signed URL that expires fifteen minutes after it is minted. In a public
store every photograph would instead sit at a permanent URL that needs no
session — readable by anyone the link ever reaches, whether that is a browser
history on a shared laptop, a message forwarded to a relative who is not on
the list, or a bookmark synced to somebody else's phone. Nobody finds out, and
there is no way to revoke it short of deleting the file. The reasoning is in
[Images](architecture.md#images).

Public and private are properties of the _store_ rather than of each upload,
so this is not a mistake you can make halfway: a store created public makes
the first upload fail rather than quietly publishing what it was given. That
is the right way round, but it does mean fixing it means creating a second
store and moving whatever is in the first.

Like `AUTH_SECRET`, the token is a password — it grants write and delete on
the store. Leaving it unset until you need it costs a readable error at the
first upload and nothing before that.

## 4. Baseline the migration ledger

**Do this before the first build.** It is a one-time check, and it is the step
that has no forgiving failure mode later.

Drizzle records applied migrations in a table it owns,
`drizzle.__drizzle_migrations`. On each run it compares the newest row there
against the migrations in `drizzle/` and applies whatever is newer. A database
whose tables were created by `npm run db:push` — which writes the schema
directly and records nothing — has no such table. The first build would then
find an empty ledger, conclude that nothing has ever been applied, replay
`0000` from the beginning, and die on `relation "individuals" already exists`.

Open the Supabase SQL editor and run:

```sql
select * from drizzle.__drizzle_migrations order by created_at;
```

Three possible answers.

**Rows come back.** The ledger exists and is populated. Nothing to do — check
that the newest row corresponds to the newest file in `drizzle/`, and move on.

**The database is empty** — no `individuals` table, no `drizzle` schema, the
query errors with `relation "drizzle.__drizzle_migrations" does not exist`.
This is the ordinary case for a Supabase project you created ten minutes ago,
and there is also nothing to do. The migrator creates the schema and the table
itself and applies every migration in order, which is exactly right against an
empty database.

**The application's tables exist but the ledger does not.** This is the one
that needs work: the schema got there by hand or by `db:push`, and you have to
tell Drizzle so. Baseline it — insert the ledger rows for the migrations whose
effects are already present, without running them.

First create the table, in the same shape the migrator would:

```sql
create schema if not exists drizzle;
create table if not exists drizzle.__drizzle_migrations (
  id serial primary key,
  hash text not null,
  created_at bigint
);
```

Then generate the rows. `created_at` is the millisecond timestamp from
`drizzle/meta/_journal.json` — not a date — and `hash` is the SHA-256 of the
migration file, so do not type these by hand. From a checkout of the
repository, at the same commit you are about to deploy:

```bash
node <<'EOF'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));

console.log("insert into drizzle.__drizzle_migrations (hash, created_at) values");
console.log(
  journal.entries
    .map((entry, i) => {
      const sql = readFileSync(`drizzle/${entry.tag}.sql`, "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const end = i === journal.entries.length - 1 ? ";" : ",";
      return `  ('${hash}', ${entry.when})${end} -- ${entry.tag}`;
    })
    .join("\n"),
);
EOF
```

It prints an `insert` covering every migration in the repository. Run it in
the SQL editor **only if the live schema really does reflect all of them** — a
`db:push` from this repository's current `db/schema.ts` does, since `db:push`
writes the state the migrations add up to. If your database is at some earlier
point, delete the lines for migrations that have not actually been applied,
keeping the earlier ones, and let the build apply the rest.

Then re-run the `select` above and confirm the rows are there.

## 5. Deploy

Import the repository in Vercel. There is nothing to configure in the build
settings: `vercel.json` is committed and carries both of the decisions that
matter.

```json
"buildCommand": "npm run db:migrate:deploy && npm run build"
```

Migrations run first, and `&&` short-circuits, so a migration that fails fails
the build and a failed build is never promoted. There is no deploy that
assumes a migration which did not happen — and, the other way round, **a
failed migration presents to you as a failed build, not as a broken site.**
That is the whole reason step 7 tells you to read the build log.

```json
"git": { "deploymentEnabled": { "**": false, "main": true } }
```

Only `main` deploys. A production build is therefore only ever a merge.

Deploy. Then add the deployment's real domain to the Google OAuth client's
redirect URIs if you have not already — you need the final hostname, so this
is the point where a custom domain is worth setting up rather than after.

## 6. Load the example family (optional)

`npm run db:seed` writes the seed fixture — eleven children, three marriages,
two widowings — described in
[The worked example](architecture.md#the-worked-example). It is useful for
confirming the tree renders before you put a real family in, and useless
afterwards.

**It deletes every row first**, with no confirmation and nothing to undo it.
Run it against the deployed database only if that database is genuinely
empty, and never again after that.

There is no way to run it from the deploy — it is a local script, pointed at
production deliberately. Set `PRODUCTION_DATABASE_URL` in your `.env.local` to
the transaction pooler string, then name the target on the command line:

```bash
DATABASE_TARGET=production npm run db:seed
```

`DATABASE_TARGET` is what makes `DATABASE_URL` resolve to that variable for
this one command, so your everyday `DATABASE_URL` is never edited to reach
production — the same switch [Reaching production
deliberately](../README.md#reaching-production-deliberately) describes. Plain
`npm run db:seed` would wipe whatever your `.env.local` currently points at,
which for most people is their own development database.

The first attempt will refuse. Against anything other than a local host the
script requires `SEED_ALLOW_DESTRUCTIVE` to name the exact `user@host` pair
the connection uses — hostname alone is not enough on Supabase's shared
pooler, where the project is in the username. The refusal message prints the
exact value to set, so copy it from there rather than guessing at the format,
and prefix the command with it:

```bash
SEED_ALLOW_DESTRUCTIVE=postgres.<project-ref>@<pooler-host> \
  DATABASE_TARGET=production npm run db:seed
```

`db/seed-guard.ts` has the reasoning, including why the override names a
target rather than being a boolean flag.

Most deployments should skip this step entirely and start with an empty wiki.

## 7. Verify the deploy

A deploy that produced a green tick in Vercel has not been verified. Work down
this list; each item fails differently, and the first two fail in a place you
would not otherwise look.

1. **Read the migration step in the build log.** Open the deployment →
   **Building**. Near the top you want two lines from `db/migrate.ts`:

   ```
   Migrating: MIGRATE_DATABASE_URL -> aws-0-<region>.pooler.supabase.com:5432
   Migrations up to date in 412ms.
   ```

   Check the variable name in that first line. If it says `DATABASE_URL`, the
   fallback happened — `MIGRATE_DATABASE_URL` is missing from the Production
   scope, or was added after this build started. The build may well have
   succeeded anyway; fix it now rather than at some future migration. The port
   should be `5432`. No password is ever printed.

2. **Confirm the ledger moved.** Re-run the `select` from step 4. The newest
   row should match the newest file in `drizzle/`.

3. **Load the site signed out.** You should land on `/signin`, not on a page
   of content. Every route is private by default — `proxy.ts` enumerates the
   public exceptions rather than the private ones — so content visible without
   a session is a serious finding, not a cosmetic one.

4. **Sign in as an allowed address.** The Google consent screen appears, and
   you come back signed in. `redirect_uri_mismatch` here means step 2's URI
   does not exactly match your deployed origin.

5. **Sign in as an address that is _not_ in `ALLOWED_EMAILS`.** Use a personal
   Google account. You must be refused. This is the single most important
   check in the list: it is the only one that tests the boundary rather than
   the happy path, and a typo in `ALLOWED_EMAILS` — one that makes the list
   longer than you meant, or empty — fails only here. (If the consent screen
   is in Testing mode, Google may refuse the account before the app does.
   That is a pass, but test with a listed test user too, so you have exercised
   the application's own check.)

6. **Open `/tree`.** It reads the database through the transaction pooler.
   Rendering — even as an empty tree — is what proves `DATABASE_URL` works
   from a serverless function, which is a different connection and a different
   variable from anything steps 1 and 2 exercised.

7. **Create an entry and reload it.** Proves writes and the sanitiser path,
   not just reads.

## 8. Keep the database awake

Supabase pauses free projects after roughly a week of inactivity, and a family
wiki visited monthly will be found asleep. The `Keep database awake` workflow
(`.github/workflows/keep-alive.yml`) runs a trivial query once a day.

It needs one thing: add the same transaction pooler string as a repository
secret named `DATABASE_URL`, under **Settings → Secrets and variables →
Actions**. Until that exists, every run fails. Set it, then run the workflow
manually from the Actions tab to confirm it passes rather than waiting a day
to find out.

The workflow opens an issue labelled `keep-alive` when it breaks and closes it
on the next success. Note that GitHub disables scheduled workflows in
repositories with no activity for 60 days. The scheduled run is skipped in
forks, which do not inherit the secret; if you forked this and are on
Supabase, edit the repository name in its `if:` condition. If you are on any
other Postgres, delete the workflow.

## 9. Set up backups

The Supabase free tier has no backups. Not "limited" backups — none that
survive the project being paused past its grace period, deleted, or lost with
the account. Whatever is in that database is the only copy until you do this
step.

The `Back up the database` workflow (`.github/workflows/backup.yml`) dumps the
whole database nightly, encrypts it, restores it into a throwaway PostgreSQL
to prove that it can be, and keeps it as a run artifact for 90 days. It needs
two repository secrets alongside the keep-alive's:

| Secret                | What it is                                                                            |
| --------------------- | ------------------------------------------------------------------------------------- |
| `BACKUP_DATABASE_URL` | The **session** pooler string from step 1 — the same one `MIGRATE_DATABASE_URL` holds |
| `BACKUP_PASSPHRASE`   | Any long random string (`openssl rand -base64 32`). It encrypts every dump            |

The passphrase is not optional. This repository is public, and artifacts on a
public repository are downloadable by anyone — an unencrypted dump would put
the family's names, dates and notes at a URL that needs no account. The
workflow refuses to dump anything if the secret is missing.

Set both, then run the workflow by hand from the Actions tab. Because it
verifies its own restore, a green run means a restorable backup rather than a
file of about the right size.

**[Backups](backups.md) is the full runbook**: the retention policy, what is
and is not covered, how to restore into production on the day it matters, and
the drill log. Read it now rather than then — in particular the part about
keeping `BACKUP_PASSPHRASE` somewhere other than GitHub, since the day you
need it may be a day you cannot ask GitHub for it.

## Operating it afterwards

Five properties of this setup that are cheaper to know than to discover.

**Rolling back a deployment does not roll back the database.** Vercel's
instant rollback restores code only. So migrations have to stay additive — add
a column, backfill it, stop reading the old one, drop it a release later — or
a rollback lands the previous build on a schema it cannot use. This is a
constraint on how you write migrations, not something to remember at rollback
time, when it is already too late.

**Undoing damage to the data is a restore, and it costs up to a day.** There
is nothing finer-grained than the nightly backup — no point-in-time recovery
on the free tier — so a migration that destroys a column, or a script pointed
at the wrong database, is recovered by restoring last night's dump and losing
whatever was written since. That asymmetry is worth holding in mind before
running anything destructive against production: the code is reversible in
seconds, and the data is not. See [Backups](backups.md).

**Two merges inside a minute build concurrently.** Drizzle's migrator takes no
advisory lock, so overlapping builds could in principle race on the same
migration. `db/migrate.ts` sets `lock_timeout` to 30 seconds so the loser
fails fast and says why, rather than burning until the platform's build
timeout reports a timeout instead. At this project's rate of change the honest
mitigation is to let one merge finish before starting the next.

**`CREATE INDEX CONCURRENTLY` will fail.** Drizzle applies all pending
migrations inside one transaction, and that statement cannot run in a
transaction block. An index on a table large enough to care about locking has
to be applied by hand, outside the deploy.

**Adding or removing a person is an environment variable and a redeploy.**
Covered under [`ALLOWED_EMAILS`](#allowed_emails) above. If you published the
Google consent screen, that list is the entire boundary.

## Another host

Nothing above is load-bearing on Vercel except `vercel.json` itself.
`output: "standalone"` is set for every build that is not Vercel's, so
`next build` produces a self-contained server bundle for plain Node or a
container, and `db:migrate:deploy` is an ordinary npm script with no host in
it — another host calls the same script from its own build or release step,
before starting the new code.

Two things change:

- **Connection strings.** On a plain Postgres there is no pooler split, so
  `DATABASE_URL` is already the right kind of connection for DDL and you can
  leave `MIGRATE_DATABASE_URL` unset. That is what the fallback is for.
- **Auth.js host trust.** On Vercel, Auth.js trusts the incoming host
  automatically because the platform sets `VERCEL`. Anywhere else in
  production it does not, and you must set either `AUTH_URL` to your full
  origin or `AUTH_TRUST_HOST=true`. Without one of them, sign-in fails behind
  the proxy.

Image storage is the one genuinely Vercel-shaped dependency, and it sits
behind a single module so it can be swapped in one file. That file also mints
the expiring URLs images are served through, so the requirement on another
host is private objects plus presigned reads — which S3, GCS and R2 all have,
and which a directory on disk can be given. See
[Portability](architecture.md#portability).
