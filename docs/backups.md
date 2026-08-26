# Backups

This is the runbook for the operator's copy of the database: what is taken,
where it is kept, how long it lasts, how it is proven to work, and what to do
on the day it is needed. Like [Deploying](deploying.md), it is written for
someone who did not build this.

It is the counterpart to [the family's own export](export.md), and the two are
not substitutes. Export is a feature: the people in the wiki can take their
data with them, by clicking a button, whenever they think of it. This is the
thing that means the data is still there after an accident nobody noticed at
the time — a migration that dropped the wrong column, a `db:seed` pointed at
the wrong database, a Supabase project deleted along with the account it was
on.

The distinction is kept in the words as well as in the runbooks: the settings
page offers a **Full export** and never calls it a backup, because a reader
who believed the file they had just downloaded was this would stop worrying
about the thing that actually protects them.

## What actually protects the data

| Thing                      | Protects against                                      |
| -------------------------- | ----------------------------------------------------- |
| The nightly backup, below  | Anything that damages or loses the database           |
| The nightly restore, below | The backup being unreadable when it is finally needed |
| Supabase's own free tier   | Nothing. It has no backups on the free plan           |

That last row is the reason this exists. The free tier has no point-in-time
recovery and nothing that survives a project being paused past its grace
period, deleted, or lost with the account. A backup that lives inside the
thing it is backing up is not a backup.

## What runs, and when

`.github/workflows/backup.yml` — **Back up the database** — runs at 03:37 UTC
every day, and can be run by hand from the Actions tab. Each run:

1. Dumps the whole database with `npm run db:backup` (`pg_dump`, plain SQL,
   gzipped). Both schemas that matter are included: `public`, and the
   `drizzle` schema holding the migration ledger.
2. Refuses the dump if it is not whole — no completion footer, cut off inside
   a `COPY` block, or missing a table `db/schema.ts` says should exist. A
   truncated dump that looks fine is the failure mode backups actually have.
3. Writes a manifest beside it: table names, row counts, and the dump's
   SHA-256.
4. Encrypts it with AES-256 (`gpg --symmetric`).
5. **Restores it, from the encrypted copy, into a throwaway PostgreSQL 17**
   and checks that every table came back with exactly the row count the dump
   carried. See [Proving it works](#proving-it-works).
6. Deletes every plaintext copy and uploads the encrypted dump and the
   manifest as a run artifact.
7. Opens a GitHub issue labelled `backup` if any of that failed, and closes it
   on the next success.

The dump also touches the database, so it doubles as a keep-alive. That is not
a reason to delete the [keep-alive
workflow](deploying.md#8-keep-the-database-awake): it is trivial and
independent, and this one is allowed to fail — noisily — without the site
going to sleep as a consequence.

## Retention policy

**One backup a night. Each kept for 90 days. Nothing is kept longer than that
without somebody downloading it.**

| Question                            | Answer                                       |
| ----------------------------------- | -------------------------------------------- |
| How often                           | Daily, 03:37 UTC                             |
| How long each is kept               | 90 days                                      |
| How many recovery points that gives | ~90, one per night                           |
| Most data a failure can cost (RPO)  | Up to 24 hours of edits                      |
| How long a restore takes (RTO)      | Minutes — see [Restoring](#restoring)        |
| Where they live                     | GitHub Actions artifacts, on this repository |
| Encrypted                           | Yes, AES-256, with `BACKUP_PASSPHRASE`       |

Ninety days is not a preference — it is GitHub's maximum artifact retention
for a public repository. Anything longer has to leave GitHub, which is the
next section.

### The copy this policy does not make

Everything above lives in one GitHub account. That covers every failure of
Supabase and every mistake made against the database, and it does not cover
losing the GitHub account itself. Whether that matters is a judgement about
how much the wiki is worth, and the honest answer for most families is that it
does — a family tree is not reconstructible.

So: **once a quarter, download the newest backup and put it somewhere else.**
An external drive, another cloud account, a copy at a relative's house. It is
one command:

```bash
gh run download --repo maxyeo/heirloom \
  "$(gh run list --repo maxyeo/heirloom --workflow backup.yml \
     --status success --limit 1 --json databaseId --jq '.[0].databaseId')" \
  --dir ~/heirloom-backups
```

The file is already encrypted, so wherever it lands does not have to be
private — but the passphrase does. Keep `BACKUP_PASSPHRASE` with the Supabase
password, not only in GitHub's secret store: a backup you cannot decrypt is
not a backup, and the one time you need it is the time you cannot ask GitHub
for it either.

### What is not in these backups

- **Photographs.** Images live in Blob storage, not in Postgres
  (`lib/storage.ts`), so a dump carries the rows that reference them and not
  the files themselves. A restore brings back a wiki whose pictures are
  missing if the store went with it. The [full export](export.md) is the one
  copy that carries the image files themselves, which is a reason to take one
  occasionally even though it is a feature rather than a schedule.
- **Environment variables.** `AUTH_SECRET`, the OAuth client, `ALLOWED_EMAILS`
  and the connection strings live in Vercel. Losing those is recoverable —
  [Deploying](deploying.md) is the procedure for setting them again — but it
  is not automatic.
- **The Supabase project itself.** Region, extensions, and settings are not in
  a `pg_dump`. Restoring into a brand new project is the expected path anyway.

## Setting it up

Two repository secrets, under **Settings → Secrets and variables → Actions**.
Until both exist, every nightly run fails and files an issue.

| Secret                | What it is                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKUP_DATABASE_URL` | Supabase's **session** pooler string, port `5432` — the same kind of connection `MIGRATE_DATABASE_URL` holds, and **not** the transaction pooler |
| `BACKUP_PASSPHRASE`   | Any long random string, e.g. `openssl rand -base64 32`. It encrypts every dump                                                                   |

**Why the session pooler.** `pg_dump` opens one transaction and holds it for
the whole run. Supabase's transaction pooler (port 6543) hands out a different
backend per transaction, so a dump taken through it fails, or worse, is
inconsistent. It is the same distinction [Deploying](deploying.md#1-create-the-database)
draws for migrations, for the same reason. The existing `DATABASE_URL`
repository secret — the one the keep-alive uses — is the transaction pooler
and is deliberately not reused here.

**Why a passphrase at all.** This repository is public, and **artifacts on a
public repository can be downloaded by anyone**. An unencrypted dump would put
a family's names, dates and private notes at a URL that needs no account. The
workflow refuses to run before dumping anything if the passphrase is missing,
rather than discovering the problem with a plaintext file already on disk.

Once both are set, run the workflow by hand from the Actions tab. It verifies
its own restore, so a green run is a real answer rather than a promise.

## Proving it works

An untested backup is a hypothesis. Two things test this one.

**Every night, automatically.** The workflow decrypts the dump it just made,
restores it into a fresh PostgreSQL 17 service container, and compares the row
counts table by table against the manifest. The comparison is exact and it is
two-way: a table the restore did not create fails, and so does a table holding
rows the dump did not carry. The check runs against the _encrypted_ file, not
the plaintext still on disk, so it also proves the passphrase in the secret is
the one that will open it later.

It runs the same command an operator runs — `npm run db:restore` — for a
reason. A verification harness that is not the recovery procedure only tests
the harness.

**Once a year, by hand.** Do the deeper drill below. The nightly check proves
the rows come back; the drill proves the restored database is one the
application can actually use — constraints, cascades, the generated search
vector, ordering.

```bash
createdb heirloom_drill
gh run download --repo maxyeo/heirloom <run-id> --dir /tmp/drill

# Strip only the .gpg, so the decrypted dump keeps the name its manifest is
# paired with and db:restore finds it without being told where it is.
for f in /tmp/drill/*.sql.gz.gpg; do gpg --output "${f%.gpg}" --decrypt "$f"; done

DATABASE_URL=postgresql://localhost:5432/heirloom_drill \
  npm run db:restore -- --from /tmp/drill/heirloom-<timestamp>.sql.gz

TEST_DATABASE_URL=postgresql://localhost:5432/heirloom_drill npm run test:db
dropdb heirloom_drill
```

The database suite is pointed at the restored copy rather than at
`heirloom_test`, so what it exercises is the schema that came out of the
backup. (It writes and deletes fixture rows as it goes, which is why the drill
uses a scratch database and drops it afterwards.)

### Drill log

| Date (UTC) | Dump                  | What was done                                                                                                    | Result                                                                       |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 2026-08-25 | Local, seeded fixture | Dump → gzip → AES-256 → decrypt → restore into a separate database → `npm run test:db` against the restored copy | Pass. 40 rows across 6 tables, every count matched; 221 database tests green |

Add a row each time. A drill nobody wrote down is a drill nobody can point to
a year later.

Dates are UTC, matching the timestamps in the dump filenames, so a row here
can be lined up with the artifact it describes without anyone having to work
out which side of midnight a local clock was on.

## Restoring

`npm run db:restore` is the whole procedure. It is also the most destructive
command in this repository: **it drops the `public` and `drizzle` schemas and
replays the dump over them.** Everything in the target database is gone —
rows, schema, and migration history alike. `db/restore-guard.ts` is what stops
that happening to the wrong database, and it works the same way
`SEED_ALLOW_DESTRUCTIVE` does: a local database needs no ceremony, and
anything else has to be named exactly.

Before it changes anything, it checks the dump against its manifest — SHA-256
first, then row counts — and refuses a dump that is truncated or damaged.
Finding that out _after_ dropping the schemas would turn a bad day into an
unrecoverable one.

### 1. Get a backup

```bash
gh run list --repo maxyeo/heirloom --workflow backup.yml --status success --limit 10
gh run download --repo maxyeo/heirloom <run-id> --dir ./restore
```

Each artifact holds `heirloom-<timestamp>.sql.gz.gpg` and its manifest. The
manifest is not encrypted — it holds table names and row counts and no family
data — so you can read it first and confirm you have the night you meant.

### 2. Decrypt it

```bash
for f in ./restore/*.sql.gz.gpg; do gpg --output "${f%.gpg}" --decrypt "$f"; done
```

It asks for `BACKUP_PASSPHRASE`.

Strip only the `.gpg`, as above. `db/restore.ts` looks for the manifest beside
the dump under the dump's own name, so a decrypted
`heirloom-<timestamp>.sql.gz` is paired with its
`heirloom-<timestamp>.manifest.json` automatically. Decrypting to some other
name still works — the restore is checked against the dump's own contents
instead — but you lose the SHA-256 check, so pass `--manifest <file>`
explicitly if you do.

### 3. Restore

**Into a local database**, which is what you want for a drill or for reading
old data:

```bash
createdb heirloom_restore
DATABASE_URL=postgresql://localhost:5432/heirloom_restore \
  npm run db:restore -- --from ./restore/heirloom.sql.gz
```

**Into production**, which is what you want when the real database is gone.
Point `RESTORE_DATABASE_URL` at the **session** pooler (port 5432, as for
migrations — the transaction pooler cannot replay a dump), and run it once
without an override to have the exact token printed back at you:

```bash
RESTORE_DATABASE_URL="postgresql://postgres.<ref>:<pw>@<host>:5432/postgres" \
  npm run db:restore -- --from ./restore/heirloom.sql.gz
# Refused, and prints: set RESTORE_ALLOW_DESTRUCTIVE=postgres.<ref>@<host>

RESTORE_ALLOW_DESTRUCTIVE=postgres.<ref>@<host> \
  RESTORE_DATABASE_URL="postgresql://postgres.<ref>:<pw>@<host>:5432/postgres" \
  npm run db:restore -- --from ./restore/heirloom.sql.gz
```

Copy the token from the refusal rather than typing it: on Supabase's shared
pooler the project is identified by the _username_, not the hostname, so a
guess at the format is a guess at which project gets overwritten.

The command prints every table and its row count when it finishes, and fails
if any of them disagrees with the dump.

### 4. Afterwards

- **Check the migration ledger.** The dump carries `drizzle.__drizzle_migrations`,
  so a restored database is already at the commit the backup was taken from.
  Run the `select` from [step 4 of Deploying](deploying.md#4-baseline-the-migration-ledger)
  and confirm the newest row matches the newest file in `drizzle/`. If you
  restored an _older_ backup and the deployed code is newer, redeploy — the
  build applies the migrations in between.
- **Redeploy if the connection strings changed.** A new Supabase project means
  new `DATABASE_URL` and `MIGRATE_DATABASE_URL` values in Vercel, a new
  `BACKUP_DATABASE_URL` secret here, and a redeploy for any of it to take
  effect.
- **Work down [Verify the deploy](deploying.md#7-verify-the-deploy).** A
  restore is a deploy's worth of change to the thing underneath the site.
- **Add a row to the drill log** if this was a drill, or a note if it was not.

## Running it by hand

Both scripts work locally, against whatever `DATABASE_URL` resolves to — see
[Reaching production deliberately](../README.md#reaching-production-deliberately).
They need `pg_dump` and `psql` on your PATH (`brew install libpq`, or
`postgresql-client` on Debian and Ubuntu). Two version rules, both one-way:
`pg_dump` must be at least as new as the server it reads, and `psql` must be
at least as new as the `pg_dump` that wrote the file — recent versions emit a
`\restrict` line that older ones do not understand. Restoring a backup taken
by the workflow (PostgreSQL 17 client) with an older local `psql` fails on
that line rather than partway through the data.

```bash
npm run db:backup                      # writes to ./backups (gitignored)
npm run db:backup -- --out /tmp/x      # somewhere else
npm run db:restore -- --from backups/heirloom-<timestamp>.sql.gz
```

A locally taken backup is **not encrypted** — encryption happens in the
workflow, because that is where the file becomes public. A dump on your laptop
is the whole wiki in one readable file. `./backups` is gitignored so it cannot
be committed by accident, which is the mistake that would matter most.

## Reclaiming storage from orphaned images

An image can outlive every reference to it. The common way is ordinary: an
author picks a photograph, the browser uploads it straight away (`E5-T2`
uploads before the entry is saved), and the entry is then abandoned. The file
stays in the store, pointed at by nothing, forever.

```bash
npm run db:images-sweep              # report only — the default
npm run db:images-sweep -- --delete  # actually remove them
```

**The report is the default and deleting is a second decision**, because this
is the one operation on the deployed system that a restore cannot undo.
[What is not in these backups](#what-is-not-in-these-backups) is the reason:
the nightly dump carries the rows that point at photographs and never the
photographs. A wrong delete here is not recovered by restoring anything.

### Read this line before you type `--delete`

The report begins with the database it read its references from:

```
References read from: postgres.abcdefgh@aws-0-us-west-2.pooler.supabase.com/postgres
  12 from entry bodies, 47 from revisions, 8 from portrait columns
```

That line exists because of the one mistake nothing in the system can catch on
its own: **references come from `DATABASE_URL` and deletions go to
`STORAGE_TOKEN`'s store, and nothing relates the two.** A laptop ordinarily has
a local database in `DATABASE_URL`. If `STORAGE_TOKEN` names the deployed
store, every real photograph in it is unreferenced as far as that run is
concerned. Check that both name the same deployment; the sweep cannot.

Two refusals cover the rest, and both are decided on dry runs as well, so the
report tells you a delete would be refused rather than letting you find out:

- **The store holds objects and the database refers to none of them.** A wrong
  connection string, a half-applied migration, or a restore in progress all
  look like this. Overridable with `--allow-unreferenced-store`, which is only
  ever right for a store that really is nothing but abandoned uploads.
- **The run would remove more than a tenth of the store.** A wrong pairing
  does not look like a few extra orphans, it looks like most of the store at
  once. Raise it with `--max-orphan-fraction=0.4` once you have read the list
  and believe it.

### What is spared, and why

| Kept                      | Because                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In a current entry body   | Obviously in use.                                                                                                                                      |
| In **any revision**       | History is append-only and `E1-T7` can restore any revision. This is much stricter than "not in the current body", and it is the point of the feature. |
| In a **portrait column**  | `individuals.portrait_key` and `portrait_thumb_key` appear in no HTML. A sweep that read only bodies would delete every portrait in the wiki.          |
| Uploaded in the last day  | Uploads happen before saves, so a fresh image is legitimately unreferenced while its author is still typing. `--min-age-hours` changes the window.     |
| Not a key this app minted | The sweep's reference model says nothing about it, and not understanding something is not a reason to delete it.                                       |

### There is no schedule, deliberately

Nothing runs this on a cron. The acceptance criterion — never delete on a
schedule without a dry run — is met by there being no scheduled deleter at
all, and a scheduled _reporter_ was considered and left out: it would need
`STORAGE_TOKEN` as an Actions secret that nothing else in Actions needs, it
would file an issue every month saying much the same thing, and a recurring
issue that is usually "a few megabytes" is one people learn to close unread.
The reclaim on a family wiki is small and the judgement is the expensive part,
so this stays a thing a person runs and reads.
