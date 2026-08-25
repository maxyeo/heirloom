# Export

This is what the family can take with them, and how to read it back.

It is the counterpart to [Backups](backups.md), and the two are deliberately
not the same thing. **Backups** are the operator's copy of the database: taken
nightly whether anybody remembers or not, encrypted, kept ninety days, and
restored every night to prove they work. **Export** is a feature: somebody
signs in, clicks a button, and gets a file. Both matter, and neither
substitutes for the other — which is why the settings page says _export_ and
never _backup_, and why this document is next to that one rather than inside
it.

There are two downloads, on **Settings → Download your data**.

| Download             | What it is                                            | When to use it                                           |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Family tree (GEDCOM) | The tree, in the format every genealogy program opens | Moving the family tree into Ancestry, Gramps, RootsMagic |
| Full export          | Everything on the site, as a ZIP                      | Keeping a copy of the wiki that does not need this site  |

The GEDCOM is [GEDCOM](gedcom.md). The rest of this page is the full export.

## What the archive holds

A `.zip`, named `family-export-<date>.zip`. Uncompressed — the photographs
inside it are already compressed, and storing the members plainly means every
tool that has ever read a ZIP can read this one.

```
RESTORE.md            how to read and restore this archive
family-tree.ged       the tree, byte for byte the same file the GEDCOM download gives
data/pages.jsonl      every wiki entry, one JSON object per line
data/revisions.jsonl  every past version of every entry
data/individuals.jsonl
data/unions.jsonl
data/union_children.jsonl
images/…              the photographs, each under the key the entries refer to it by
manifest.json         what this archive contains, and what it could not fetch
```

**The rule for the row data is the whole of it: every line is one row, and
every key is the name of a column in `db/schema.ts`.** Nothing is encoded and
nothing has to be looked up elsewhere, which is what makes a restore a loop
rather than a project. One computed column is deliberately left out —
`pages.search_vector`, which Postgres derives from the title and body on every
write and refuses to have inserted.

`RESTORE.md` travels **inside** the archive, saying all of this again. That is
not duplication for its own sake: the day this file is needed is the day the
repository, the site and this documentation may all be gone, which is the
entire premise of _"a family history trapped in someone's side project is a
family history with an expiry date"_ ([Product](product.md)).

### The manifest

```jsonc
{
  "format": "heirloom-export",
  "formatVersion": 1,
  "generatedAt": "2026-08-25T12:00:00.000Z",
  // how far through the migrations the database was
  "schema": { "migrationsApplied": 6, "latestMigrationAt": "2026-05-22T…" },
  "restore": "See RESTORE.md in this archive.",
  "gedcom": { "member": "family-tree.ged" },
  "tables": [{ "table": "pages", "member": "data/pages.jsonl", "rows": 12 }],
  "images": [
    {
      "key": "images/ab/….jpg",
      "url": "/api/images/ab/….jpg", // what an entry body asks for
      "member": "images/ab/….jpg", // where it is in this archive, or null
      "included": true,
      "note": null, // why it is absent, when it is
    },
  ],
  "counts": {
    "rows": 40,
    "images": 3,
    "imagesIncluded": 3,
    "imagesMissing": 0,
  },
}
```

It is written **last**, because it is the only member whose contents depend on
every member before it: how many rows each table actually carried, and which
photographs actually made it in. A manifest written first could only record
intentions, and an intention recorded as a fact is how a manifest becomes
something nobody checks. Order costs a reader nothing — a ZIP's own table of
contents is at the end of the file anyway, and `unzip -p` reads one member
without unpacking the rest.

`formatVersion` describes the _layout_, not the application. It goes up when a
member is renamed, removed, or changes meaning; adding one is additive and
does not.

## Checking one before trusting it

```bash
unzip -t family-export-2026-08-25.zip           # every member's checksum
unzip -p family-export-2026-08-25.zip manifest.json | jq '.counts'
```

Every file in a ZIP carries a CRC-32 and `unzip -t` verifies all of them, so
that is the integrity check for this archive. There is no separate digest to
find, deliberately: a second checksum would be a second thing to keep in step
and the one nobody would actually run.

The archive itself was checked against readers that are not ours before this
shipped, because a container format written by hand is worth exactly as much
as the tools that will open it:

| Date (UTC) | Checked with                                       | Result                                              |
| ---------- | -------------------------------------------------- | --------------------------------------------------- |
| 2026-08-25 | Info-ZIP `unzip -t`, Python `zipfile`, `ditto`     | Opened, every CRC verified, extracted intact        |
| 2026-08-25 | The restore procedure below, on a scratch database | Rows, foreign keys and the computed column all back |

Add a row when the writer changes. The suite checks the same properties on
every run (`lib/zip-stream.test.ts` reads its own output back the way the
format specifies), but a suite that only ever talks to itself is not the
question this table answers.

Two things in the manifest are worth a glance:

- **`counts.imagesMissing`.** Anything above zero means a photograph an entry
  refers to was not in the store when the export ran. Each one carries a
  `note` saying which kind of absence it was — a file deleted long ago, which
  is ordinary, or a store that could not be reached, which means take the
  export again.
- **`schema.migrationsApplied`.** How far through `drizzle/` the database was
  when the rows were read. A restore into an older or newer schema fails in
  ways that look like damaged data. It is a count rather than a migration
  name because Drizzle's ledger records a hash of each migration's SQL and
  nothing that maps back to `0005_date_ranges` without this repository in
  hand — and a count is the more useful half anyway, since it is what you
  apply and what you check afterwards with one `select count(*)`.

## Restoring one

`RESTORE.md` inside the archive is the procedure, written for somebody who has
the file and none of this. In outline:

1. Create the database and apply the first `schema.migrationsApplied`
   migrations from `drizzle/`, in filename order.
2. Load the tables in the order `RESTORE.md` lists — `pages`, `revisions`,
   `individuals`, `unions`, `union_children`. It is a foreign-key
   topological sort, so a restore in that order never has to defer a
   constraint. `revisions` are written oldest-first for the same reason:
   `restored_from_id` points at another revision, and a revision can only ever
   have been restored from one that already existed.
3. Upload each file under `images/` back to the image store **under exactly
   its path in the archive** — that path is the key the entry bodies refer to,
   so nothing in any body needs editing.

You do not have to restore anything to read it. `family-tree.ged` opens in any
genealogy program, and the entries are plain HTML inside the JSON.

## How it is built

Four modules, split on one line — what an archive _is_ on one side, and what
touches a database or a network on the other. That is the same split
[E7-T1](../lib/export-tree.ts) drew, for the same reason: everything on the
pure side is checked by `npm test`, which runs with no database
([Testing](testing.md)).

| Module                  | What it decides                                          |
| ----------------------- | -------------------------------------------------------- |
| `lib/zip-stream.ts`     | The container format. Pure: bytes in, bytes out          |
| `lib/export-archive.ts` | Which members, in what order, and what the manifest says |
| `lib/entry-images.ts`   | Which photographs the wiki refers to                     |
| `lib/export-full.ts`    | The queries, the image store, and the response stream    |

Three decisions inside them are worth naming here, because each is a default
that would have been wrong.

**It streams, and that is a property rather than a claim.** The response
begins before the archive exists. `lib/export-full.ts` hands the route a
pull-driven `ReadableStream`, so a chunk is produced only when the client asks
for one, and the photographs go from the image store to the browser without
ever being whole in this process. The consequence to know about is that a
failure halfway through cannot be a `500` — the status line is long gone — so
it is a broken connection and a failed download instead. That is the right
outcome and a visible one: a ZIP's table of contents is the last thing
written, so an archive cut short has no end record and no tool will open it.
An unfinished export can never be one somebody trusts.

**The transaction covers the reads and stops there.** Every `select` runs
inside one transaction, so the tree, the entries and the revisions all
describe the same instant. It is closed before a byte is written. Holding it
open for the life of the download would pin a pooled backend for as long as
the _client_ takes to receive the file, on the transaction pooler that
[Backups](backups.md#setting-it-up) explains at length is the wrong connection
for exactly this shape of work — and the cost of exhausting that pool is the
whole site, in exchange for protection against a family wiki's rows changing
during a few milliseconds of `select`s.

**The photographs are found by asking the entries, not the store.**
`lib/storage.ts` exports exactly `put`, `get` and `delete`, and
[the storage seam](architecture.md#the-storage-seam) is explicit that adding a
`list` would narrow the set of hosts that can implement it. So the archive
carries the images that some body — current or historical — refers to. Both
`pages` and `revisions` are scanned, because revisions are append-only and a
photograph taken out of an entry last year is still in the version that had
it.

One consequence of that is worth stating plainly rather than discovering:
**today the archive contains no images at all**, because `img` is not yet in
[the sanitiser's allowlist](architecture.md#entry-html) — E5-T3 enables the
editor's image button and widens it. The scan is written against the reference
shape the architecture fixes rather than against today's emptiness, so the
export starts carrying photographs on the day entries start having them,
rather than quietly not doing so until somebody checks.
