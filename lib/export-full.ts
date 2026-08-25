import { asc, getTableColumns, getTableName, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db, schema } from "@/db";
import { scanEntryImages } from "@/lib/entry-images";
import {
  archiveMembers,
  type ExportArchiveInput,
  type ExportSchema,
  type ExportTable,
  type OpenedImage,
} from "@/lib/export-archive";
import { exportTreeAsGedcom } from "@/lib/export-tree";
import * as storage from "@/lib/storage";
import { imagePath } from "@/lib/storage-key";
import { zipChunks } from "@/lib/zip-stream";

/**
 * The full export, read out of the database and written as a ZIP (E7-T4,
 * `YEO-54`).
 *
 * The database-aware half of the feature, and the only half that knows `@/db`
 * or `@/lib/storage` exists — the same line `lib/export-tree.ts` draws
 * between the reading of an export and the writing of one, and for the same
 * reason: `lib/export-archive.ts` and `lib/zip-stream.ts` are pure, so what
 * an archive *contains* is checkable by `npm test` with no database
 * (docs/testing.md).
 *
 * ## The transaction covers the reads and stops there
 *
 * This is the decision in this file worth arguing about, so it is written
 * down rather than left in the shape of the code.
 *
 * `exportTreeAsGedcom` takes a reader precisely so that this ticket could
 * pass it a transaction and get an archive consistent with itself. It does —
 * every `select` below runs inside one `db.transaction`, so the GEDCOM, the
 * entries and the revisions all describe the same instant, and an edit
 * landing halfway through cannot produce an archive whose tree and whose
 * entries disagree.
 *
 * What the transaction deliberately does **not** span is the rest of the
 * response. The obvious design — hold the transaction open and stream rows
 * out of it — recreates, inside the application, exactly the failure
 * `docs/backups.md` routes `pg_dump` around:
 *
 * > *"`pg_dump` opens one transaction and holds it for the whole run.
 * > Supabase's transaction pooler (port 6543) hands out a different backend
 * > per transaction, so a dump taken through it fails, or worse, is
 * > inconsistent."*
 *
 * `DATABASE_URL` — the string every route including this one connects with
 * (`db/index.ts`) — is that transaction pooler. A transaction held open for
 * the life of a download is a pooled backend pinned for as long as the
 * *client* takes to receive it, plus one network round trip per photograph.
 * That is unbounded, it is a small shared pool, and the cost of exhausting it
 * is the whole site going down while somebody takes a backup. The
 * inconsistency it would buy protection against is a family wiki's rows
 * changing during the few milliseconds these `select`s take.
 *
 * So the rows are read, whole, inside a short transaction, and the archive is
 * assembled from them afterwards. **The archive still streams**: what is held
 * in memory is a family's rows — the same thing `writeGedcom` already builds
 * in full before the GEDCOM download sends a byte — while the photographs,
 * which are the only part with no bound on its size, go from the store to the
 * client without ever being whole in this process.
 *
 * ## Why the tree is read twice
 *
 * `exportTreeAsGedcom` runs its own `select` over individuals, unions and
 * children, ordered for the serialiser; the JSONL members below read the same
 * three tables ordered by primary key, because a restore wants rows in a
 * stable order and a GEDCOM wants them in a sorted one. Both reads are inside
 * the one transaction, so they cannot disagree. The alternative — reading
 * once here and calling `writeGedcom` directly — would put a second copy of
 * that query in this file and reintroduce exactly the drift
 * `lib/export-tree.ts` exists to prevent.
 */

/**
 * The tables the archive carries, in the order a restore must load them.
 *
 * The order is a foreign-key topological sort, and it is data rather than a
 * comment because `RESTORE.md` prints it: `revisions` point at `pages`,
 * `individuals` point at `pages`, `unions` point at `individuals`, and
 * `union_children` point at both. Loading them in this order means a restore
 * never has to defer a constraint.
 *
 * `revisions` has one further subtlety, which is why it is ordered by
 * `created_at` below rather than by id: `restored_from_id` points at another
 * row of the same table. Causality settles it — a revision can only ever have
 * been restored from one that already existed — so oldest-first is an order
 * in which every self-reference is already present.
 */
const EXPORT_TABLES = [
  schema.pages,
  schema.revisions,
  schema.individuals,
  schema.unions,
  schema.unionChildren,
] as const;

/** Anything that can run a `select` — the pool, or a transaction. */
type Reader = Pick<typeof db, "select">;

/**
 * The columns of `table` that belong in an export, keyed by their JS names.
 *
 * Generated columns are dropped, and `pages.search_vector` is the one that
 * exists: Postgres computes it from the title and the body on every write
 * (`db/schema.ts`), so it is not data, it cannot be inserted, and carrying it
 * would put a `tsvector` on the wire and a column in the file that makes a
 * restore fail. Detected from the column definition rather than named here,
 * so a second generated column added later is excluded without anyone
 * remembering this line.
 */
function exportedColumns(table: PgTable): Record<string, PgColumn> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).filter(
      ([, column]) => !column.generated,
    ),
  );
}

/** `{ bodyHtml: … }` becomes `{ body_html: … }`. See {@link ExportTable}. */
function toColumnNames(
  table: PgTable,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const names = new Map(
    Object.entries(getTableColumns(table)).map(([property, column]) => [
      property,
      column.name,
    ]),
  );

  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([property, value]) => [
        names.get(property) ?? property,
        value,
      ]),
    ),
  );
}

/** How each table is ordered on the way out. See {@link EXPORT_TABLES}. */
function orderFor(table: PgTable) {
  if (table === schema.pages) return [asc(schema.pages.id)];
  // Oldest first, so `restored_from_id` always points at a row already loaded.
  if (table === schema.revisions) {
    return [asc(schema.revisions.createdAt), asc(schema.revisions.id)];
  }
  if (table === schema.individuals) return [asc(schema.individuals.id)];
  if (table === schema.unions) return [asc(schema.unions.id)];
  return [asc(schema.unionChildren.unionId), asc(schema.unionChildren.childId)];
}

/** Every row of every exported table, in restore order. */
async function readTables(reader: Reader): Promise<ExportTable[]> {
  const read = EXPORT_TABLES.map(async (table) => {
    const rows = await reader
      .select(exportedColumns(table))
      .from(table)
      .orderBy(...orderFor(table));

    return {
      table: getTableName(table),
      rows: toColumnNames(table, rows as Record<string, unknown>[]),
    };
  });

  return Promise.all(read);
}

/**
 * How far through the migrations the database is, or `null`.
 *
 * ## Why a count and not a name
 *
 * Drizzle's ledger has three columns — an id, a **hash** of the migration's
 * SQL, and when it ran. There is no `0005_date_ranges` in there to read: the
 * mapping from hash to filename lives in `drizzle/meta/_journal.json`, in the
 * repository, which is exactly the thing a restorer may not have. So the
 * manifest records the number applied, which is what
 * `docs/deploying.md`'s own ledger check compares against the files in
 * `drizzle/`, and which a restorer can verify afterwards with one
 * `select count(*)`.
 *
 * ## Why it is read outside the transaction
 *
 * A failing statement inside a Postgres transaction aborts the whole
 * transaction, so a database with no `drizzle` schema — one restored without
 * the ledger, a scratch fixture — would take the entire export down with it
 * rather than costing one field in the manifest. This is metadata about the
 * schema rather than part of the snapshot, so asking separately loses
 * nothing.
 */
async function readSchema(): Promise<ExportSchema | null> {
  try {
    const rows = await db.execute<{
      applied: number;
      latest: string | null;
    }>(
      sql`select count(*)::int as applied, max(created_at) as latest from drizzle.__drizzle_migrations`,
    );

    const row = rows[0];
    if (!row || row.applied === 0) return null;

    // `created_at` is a `bigint` holding milliseconds, and postgres.js hands
    // a bigint back as a string rather than losing precision on a number it
    // cannot promise to represent.
    const latest = row.latest === null ? null : Number(row.latest);

    return {
      migrationsApplied: row.applied,
      latestMigrationAt:
        latest === null || !Number.isFinite(latest)
          ? null
          : new Date(latest).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * The bytes of one stored image, or the reason there are none.
 *
 * Two failures are told apart because they mean opposite things to whoever
 * ends up holding the archive. `storage.get` answering `null` is an image
 * that is genuinely gone — swept as an orphan, or deleted — and an archive
 * missing it is complete. Anything else is the store being unreachable, and
 * an archive missing photographs for *that* reason is one to take again.
 * Both are recorded rather than thrown, so a store outage costs the family
 * the pictures rather than the backup.
 *
 * A plain `fetch` of the URL `storage.get` returns, rather than a second
 * vendor call: that URL is exactly what the seam hands back for a caller to
 * fetch (`lib/storage.ts`), and reaching for an SDK here is what
 * `lib/storage.call-sites.test.ts` exists to catch.
 */
async function openImage(key: string): Promise<OpenedImage> {
  let url: string;
  try {
    const stored = await storage.get(key);
    if (stored === null) {
      return {
        found: false,
        reason: "The image store no longer has this file.",
      };
    }
    url = stored.url;
  } catch (error) {
    return {
      found: false,
      reason: `The image store could not be reached: ${message(error)}`,
    };
  }

  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    return {
      found: false,
      reason: `The image store answered ${response.status} for this file.`,
    };
  }

  return { found: true, body: response.body };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Everything the archive is made of, read in one transaction.
 *
 * Exported so that `lib/export-full.db.test.ts` can assert on the *value* —
 * which tables, in which order, with which images — without going through a
 * ZIP to do it.
 *
 * @param generatedAt the moment to stamp the archive with, passed in rather
 *   than read so the whole export is a function of its inputs
 */
export async function readFullExport(
  generatedAt: Date,
): Promise<ExportArchiveInput> {
  const schema = await readSchema();

  const { gedcom, tables } = await db.transaction(async (tx) => {
    const [gedcom, tables] = await Promise.all([
      exportTreeAsGedcom(tx),
      readTables(tx),
    ]);
    return { gedcom, tables };
  });

  return {
    generatedAt,
    gedcom,
    tables,
    images: referencedImages(tables),
    schema,
    openImage,
  };
}

/**
 * Every image the wiki refers to, from the bodies just read.
 *
 * Current entries *and* every revision of them, because a photograph taken
 * out of an entry last year is still in the revision that had it and
 * revisions are append-only — see `lib/entry-images.ts`, which explains why
 * the store is asked nothing and the bodies are asked instead.
 *
 * Sorted by key so that two exports of an unchanged wiki list them in the
 * same order, for the same reason `lib/export-tree.ts` orders its `select`s:
 * an order nothing imposes is an order that can change between two runs and
 * make a diff of two manifests unreadable.
 */
function referencedImages(
  tables: readonly ExportTable[],
): { key: string; url: string }[] {
  const keys = new Set<string>();

  for (const table of tables) {
    if (table.table !== "pages" && table.table !== "revisions") continue;
    for (const row of table.rows) {
      const body = row.body_html;
      if (typeof body !== "string") continue;
      for (const key of scanEntryImages(body)) keys.add(key);
    }
  }

  return [...keys].sort().map((key) => ({ key, url: imagePath(key) }));
}

/**
 * The whole export as a stream of bytes, ready to be a `Response` body.
 *
 * A `ReadableStream` because that is what a route handler returns to stream a
 * download (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`), and
 * a **pull-driven** one because that is what makes the criterion true rather
 * than merely claimed: the generator underneath produces the next chunk only
 * when the consumer asks for it, so a slow client slows the archive down
 * instead of filling a queue with it. A cancelled download — a closed tab, a
 * lost connection — returns the generator, which closes the image response it
 * was reading and stops the export where it stood.
 *
 * @param generatedAt the moment to stamp the archive and its members with
 */
export function fullExportStream(
  generatedAt: Date,
): ReadableStream<Uint8Array> {
  const chunks = zipChunks(
    (async function* () {
      yield* archiveMembers(await readFullExport(generatedAt));
    })(),
    generatedAt,
  );

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await chunks.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
