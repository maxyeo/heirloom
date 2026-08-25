import type { ZipMember } from "@/lib/zip-stream";

/**
 * What is in a full export, and in what order (E7-T4, `YEO-54`).
 *
 * ## The split, and why it is the same one E7-T1 drew
 *
 * `lib/export-tree.ts` is five lines of `select` and one call, and its
 * docblock explains why that is worth a file: the reading half and the
 * writing half of an export belong on opposite sides of a line, so the
 * writing half can be driven by `npm test` with no database (docs/testing.md).
 * The same line runs through this feature, in the same place. **This module
 * decides what an archive contains** — the members, their names, the manifest,
 * the restore document — as a function from a value to a stream of members,
 * and imports neither `@/db` nor `@/lib/storage`. **`lib/export-full.ts` reads
 * the rows** and hands them here.
 *
 * ## Why the manifest is written last
 *
 * It is the only member whose contents depend on every member before it: how
 * many rows each table actually carried, and which photographs actually made
 * it into the file. Written first it could only state intentions, and an
 * intention recorded as a fact is how a manifest becomes something nobody
 * checks. A ZIP's table of contents is at the end of the file anyway, so
 * order costs a reader nothing — `unzip -p archive manifest.json` reads it
 * without unpacking anything else.
 *
 * The mechanism this rests on is stated in `zipChunks`: the writer consumes
 * one member's body **completely** before asking the generator for the next,
 * so by the time this generator reaches the manifest, the counting it did on
 * the way past is finished.
 *
 * ## Why the restore document is written first
 *
 * `RESTORE.md` is the archive's answer to *"documented, restorable format"*,
 * and it is inside the archive rather than only in `docs/export.md` because
 * the day it is needed is the day the repository, the site and the
 * documentation may all be gone — which is the entire premise of
 * docs/product.md's *"a family history trapped in someone's side project is a
 * family history with an expiry date."* A restore procedure that lives only
 * where the software lives is a procedure that expires with it.
 */

/** What the manifest calls this kind of file, so a reader can recognise one. */
export const EXPORT_FORMAT = "heirloom-export";

/**
 * The version of the *layout*, not of the application.
 *
 * A reader — a future importer, a person with a script — needs to know
 * whether the member names and row shapes it expects are the ones in front of
 * it. Bump this when a member is renamed, removed, or changes meaning; adding
 * a member is additive and does not.
 */
export const EXPORT_FORMAT_VERSION = 1;

/** The GEDCOM, under the same name the standalone download uses. */
export const GEDCOM_MEMBER = "family-tree.ged";

/** The manifest, at a name a person would guess. */
export const MANIFEST_MEMBER = "manifest.json";

/** The restore procedure, travelling with the thing it describes. */
export const RESTORE_MEMBER = "RESTORE.md";

/** Where the row data lives, so it does not sit among the photographs. */
export const DATA_PREFIX = "data/";

/**
 * One database table, as rows already read.
 *
 * `rows` are plain objects whose keys are the **SQL column names**, which is
 * `lib/export-full.ts`'s doing and is the decision that makes the restore
 * mechanical: a line of `data/pages.jsonl` is the argument list of an
 * `INSERT INTO pages`, with no mapping table for anyone to consult or get
 * wrong.
 */
export type ExportTable = {
  /** The table's name in Postgres, e.g. `union_children`. */
  table: string;
  /** Its rows, in the order they should be written. */
  rows: readonly Readonly<Record<string, unknown>>[];
};

/** One image the wiki refers to, and where it will sit in the archive. */
export type ExportImage = {
  /** The storage key — also, deliberately, its path inside the archive. */
  key: string;
  /**
   * The address the entry bodies actually carry: `/api/images/ab/….jpg`.
   *
   * Site-relative, because that is the durable reference
   * (docs/architecture.md#the-storage-seam) — a signed storage URL would be
   * a credential with a fifteen-minute timer written into a file meant to
   * outlive the site.
   */
  url: string;
};

/** Everything an archive is assembled from. */
export type ExportArchiveInput = {
  /**
   * The moment the export was taken, passed in rather than read.
   *
   * The same discipline `lib/export-endpoint.ts` applies to the filename and
   * for the same reason: it makes every byte of this archive a function of
   * its inputs, so a test can assert on the manifest against a literal.
   */
  generatedAt: Date;
  /** The tree, as `lib/gedcom-export.ts` wrote it. */
  gedcom: string;
  /** The tables, in the order they must be restored — parents before children. */
  tables: readonly ExportTable[];
  /** Every image the bodies refer to. */
  images: readonly ExportImage[];
  /**
   * The state of the migration ledger when the rows were read, or `null` if
   * it could not be read.
   *
   * The single most useful thing a restorer can be told, and the one nothing
   * else in the archive records: rows restored into a schema older or newer
   * than the one they were taken from fail in ways that look like data
   * corruption. `docs/deploying.md` has an operator check the same ledger by
   * hand — *"check that the newest row corresponds to the newest file in
   * `drizzle/`"* — and this is that check, recorded at the moment it was
   * still knowable.
   */
  schema: ExportSchema | null;
  /**
   * The bytes of one image, or a reason there are none.
   *
   * An answer rather than a throw, because a photograph that is not there is
   * an ordinary state of affairs: revisions are append-only and E5-T5 sweeps
   * orphans, so a body pointing at an image that has been deleted is expected
   * rather than broken. An export that aborted on one would be an export that
   * stops working as the wiki ages.
   *
   * The *reason* is carried through to the manifest rather than flattened
   * into a boolean, and that is the half that matters: "this file was deleted
   * years ago" and "the image store could not be reached" produce the same
   * gap in the archive and call for completely different responses from
   * whoever is holding it.
   */
  openImage: (key: string) => Promise<OpenedImage>;
};

/**
 * Which migrations had been applied when the export was taken.
 *
 * A **count**, not a name, because a name is not there to be read: Drizzle's
 * ledger records a hash of each migration's SQL and the moment it ran, and
 * nothing that maps back to `0005_date_ranges` without the repository in
 * hand. A count is what the restorer can actually act on — apply that many
 * migrations from `drizzle/`, in filename order — and it is checkable
 * afterwards with one `select count(*)`.
 */
export type ExportSchema = {
  /** How many migrations the database had applied. */
  migrationsApplied: number;
  /** When the newest of them ran, ISO 8601, or `null` if it was not recorded. */
  latestMigrationAt: string | null;
};

/** What {@link ExportArchiveInput.openImage} answers with. */
export type OpenedImage =
  | { found: true; body: ReadableStream<Uint8Array> }
  | { found: false; reason: string };

/** What the manifest says about one image. */
export type ManifestImage = ExportImage & {
  /** Where its bytes are in this archive, or `null` if they are not. */
  member: string | null;
  /**
   * Whether the file itself is here.
   *
   * This is the acceptance criterion *"included **or** listed with their
   * URLs"* answered with both halves rather than as a choice: every image is
   * listed with the address the wiki refers to it by, and the ones the store
   * still had are also here in full.
   */
  included: boolean;
  /** Why the bytes are absent, when they are; `null` when they are here. */
  note: string | null;
};

/**
 * The archive, member by member, in the order they are written.
 *
 * @param input everything to be archived, and a way to fetch image bytes
 * @yields each member; bodies are lazy, and the caller must consume one
 *   before requesting the next
 */
export async function* archiveMembers(
  input: ExportArchiveInput,
): AsyncGenerator<ZipMember> {
  const rows: Record<string, number> = {};
  const images: ManifestImage[] = [];

  yield { name: RESTORE_MEMBER, body: restoreDocument(input) };
  yield { name: GEDCOM_MEMBER, body: input.gedcom };

  for (const table of input.tables) {
    rows[table.table] = table.rows.length;
    yield { name: dataMember(table.table), body: jsonLines(table.rows) };
  }

  for (const image of input.images) {
    const opened = await input.openImage(image.key);
    if (!opened.found) {
      images.push({
        ...image,
        member: null,
        included: false,
        note: opened.reason,
      });
      continue;
    }
    images.push({ ...image, member: image.key, included: true, note: null });
    yield { name: image.key, body: opened.body };
  }

  yield {
    name: MANIFEST_MEMBER,
    body: `${JSON.stringify(manifest(input, rows, images), null, 2)}\n`,
  };
}

/** Where a table's rows live: `data/pages.jsonl`. */
export function dataMember(table: string): string {
  return `${DATA_PREFIX}${table}.jsonl`;
}

/**
 * Rows as JSON Lines — one object per line, newline-terminated.
 *
 * ## Why not one JSON array
 *
 * An array has to be closed, which means a reader has to hold the whole thing
 * before it can parse any of it, and a writer has to know it is at the last
 * row before it writes the separator. JSON Lines has neither property: each
 * line stands alone, so a restore can read a table of any size a line at a
 * time, `wc -l` counts the rows, and `head -1` shows the shape. It is the
 * same reason `db/dump-manifest.ts` reads a `pg_dump` line by line rather
 * than parsing it.
 *
 * ## Why the lines are batched
 *
 * Each `yield` here becomes a chunk on the wire. A wiki with several thousand
 * revisions would otherwise be several thousand chunks of a few hundred
 * bytes, which is a great deal of ceremony per byte for no gain — the point
 * of streaming is that the archive is never *whole* in memory, not that it is
 * emitted as finely as possible.
 */
async function* jsonLines(
  rows: readonly Readonly<Record<string, unknown>>[],
): AsyncGenerator<string> {
  let batch = "";
  for (const row of rows) {
    batch += `${JSON.stringify(row)}\n`;
    if (batch.length >= JSON_LINE_BATCH_CHARS) {
      yield batch;
      batch = "";
    }
  }
  if (batch.length > 0) yield batch;
}

/** Roughly 64 KiB of text per chunk. Not tuned; just not per-row. */
const JSON_LINE_BATCH_CHARS = 64 * 1024;

/** What the manifest records. Shaped as a type so a reader can rely on it. */
export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  /** ISO 8601, UTC. */
  generatedAt: string;
  /** The migration ledger's state, or `null` if it could not be read. */
  schema: ExportSchema | null;
  /** Where to look, and what to do — the archive explains itself. */
  restore: string;
  gedcom: { member: string };
  tables: { table: string; member: string; rows: number }[];
  images: ManifestImage[];
  counts: {
    rows: number;
    images: number;
    imagesIncluded: number;
    imagesMissing: number;
  };
};

function manifest(
  input: ExportArchiveInput,
  rows: Record<string, number>,
  images: readonly ManifestImage[],
): ExportManifest {
  const included = images.filter((image) => image.included).length;

  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    schema: input.schema,
    restore: `See ${RESTORE_MEMBER} in this archive.`,
    gedcom: { member: GEDCOM_MEMBER },
    tables: input.tables.map((table) => ({
      table: table.table,
      member: dataMember(table.table),
      rows: rows[table.table] ?? 0,
    })),
    images: [...images],
    counts: {
      rows: Object.values(rows).reduce((total, count) => total + count, 0),
      images: images.length,
      imagesIncluded: included,
      imagesMissing: images.length - included,
    },
  };
}

/**
 * The restore procedure, written for somebody who has this file and nothing
 * else.
 *
 * That is the bar the acceptance criterion sets — *"a backup nobody can
 * restore is a file, not a backup"* — and it is deliberately higher than
 * "document the manifest schema". A reader here is assumed to have the
 * archive and a Postgres, and **not** to have this repository, this
 * application, or any of its source. So the procedure names the tables, says
 * what each member is, and says in what order rows have to go back, rather
 * than pointing at an exporter for the details.
 *
 * It is generated rather than a static string for one reason: the counts and
 * the schema version belong in it, and a reader who has to cross-reference a
 * generic document against a manifest to find out what they are holding is a
 * reader who will not bother.
 */
function restoreDocument(input: ExportArchiveInput): string {
  const tables = input.tables.map((table) => table.table);

  return `# Restoring this export

This archive is a complete copy of a family wiki: the family tree, every
entry, every revision of every entry, and the photographs. It was written on
${input.generatedAt.toISOString()} in the \`${EXPORT_FORMAT}\` format, version
${EXPORT_FORMAT_VERSION}.

Everything below can be done with a ZIP tool, a text editor and Postgres.
Nothing here needs the software that wrote it.

## What is in here

| Member | What it is |
| --- | --- |
| \`${RESTORE_MEMBER}\` | This file. |
| \`${GEDCOM_MEMBER}\` | The family tree as GEDCOM 5.5.1 — individuals, families and their dates. Any genealogy program will open it. |
| \`${DATA_PREFIX}*.jsonl\` | The database, one file per table. Each **line** is one row as a JSON object, and the keys are the column names. |
| \`images/…\` | The photographs, each under the key the wiki stores it by. |
| \`${MANIFEST_MEMBER}\` | What this archive contains: row counts per table, every image with the address entries refer to it by, and which images are present. |

The tables, in the order they must be loaded — a row can only be inserted
after the rows it points at:

${tables.map((table) => `${tables.indexOf(table) + 1}. \`${table}\``).join("\n")}

## If you only want to read it

You do not have to restore anything. \`${GEDCOM_MEMBER}\` opens in any
genealogy program, and the entries are readable as they are:

\`\`\`bash
unzip -o <this-file>.zip
# every entry's title and body, one per line
jq -r '.title + "\\n\\n" + .body_html' ${DATA_PREFIX}pages.jsonl
\`\`\`

The entry bodies are HTML. They contain only paragraphs, headings, bold,
italic, lists, links and images — nothing that needs a browser to make sense
of.

## Restoring it into a database

${
  input.schema === null
    ? `The export could not read the migration ledger, so which schema these
rows belong to is **unknown**. Load them into the newest schema you have and
check that every key in \`${DATA_PREFIX}pages.jsonl\` names a column that
exists.`
    : `These rows came out of a database with **${input.schema.migrationsApplied} migrations applied**${
        input.schema.latestMigrationAt === null
          ? ""
          : `, the newest of them on ${input.schema.latestMigrationAt}`
      }. Restore them into a schema at that same point — apply the first
${input.schema.migrationsApplied} migration files, in filename order — and
check afterwards with
\`select count(*) from drizzle.__drizzle_migrations\`. A schema older or
newer than the rows fails in ways that look like damaged data.`
}

1. Create the database and apply the migrations up to that version.
2. Load each table **in the order listed above**. The rule is the whole of it:
   *every line is one row, and every key is the name of a column.* Nothing is
   encoded and nothing has to be looked up elsewhere, so the smallest correct
   restore is one
   \`INSERT INTO <table> (<the keys on the line>) VALUES (<the values>)\` per
   line, in any language that can read JSON.

   With \`psql\` and \`jq\` it is a loop, and Postgres reads the row out of the
   JSON object itself, so the column list never has to be typed:

   \`\`\`bash
   for table in ${tables.join(" ")}; do
     columns=$(head -1 "${DATA_PREFIX}$table.jsonl" | jq -r 'keys_unsorted | join(", ")')
     [ -z "$columns" ] && continue   # a table with no rows
     psql "$DATABASE_URL" <<SQL
   create temporary table incoming (doc jsonb);
   -- A delimiter and a quote character that cannot occur unescaped inside
   -- JSON, so every line arrives as one value, byte for byte.
   \\copy incoming (doc) from '${DATA_PREFIX}$table.jsonl' with (format csv, delimiter e'\\x02', quote e'\\x01')
   insert into $table ($columns)
     select $columns
     from (select (jsonb_populate_record(null::$table, doc)).* from incoming) as loaded;
   SQL
   done
   \`\`\`

3. \`pages\` has one column these files deliberately leave out —
   \`search_vector\`, which Postgres computes from the title and the body. It
   is not missing data and it must not be inserted; naming the columns from
   the file, as above, is what keeps it out.
4. Put the photographs back. Each file under \`images/\` goes into the image
   store under **exactly its path in this archive** — that path is the key the
   entries refer to, and \`${MANIFEST_MEMBER}\` lists the address each one is
   asked for by. Restoring into a fresh install of the same application means
   uploading each with its key unchanged; the entries then find them with no
   edit to any body.

## Checking it before you trust it

\`\`\`bash
# every member's checksum, verified against the archive's own record
unzip -t <this-file>.zip

# the row counts this archive claims, to compare with what you loaded
jq '.counts, .tables' ${MANIFEST_MEMBER}
\`\`\`

Every file in a ZIP carries a CRC-32, and \`unzip -t\` checks all of them.
That is the integrity check for this archive; there is no separate digest to
find, because a checksum nobody runs is not one.

## What is not in here

- **Who signed in, and when.** The wiki has no user table — access is a list
  of allowed email addresses in the deployment's configuration.
- **The deployment itself.** Connection strings, secrets and the image store's
  credentials live with whoever runs the site, not in its data.
`;
}
