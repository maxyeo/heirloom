import { asc, getTableColumns, getTableName, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { db, schema } from "@/db";
import {
  archiveMembers,
  type ExportArchiveInput,
  type ExportSchema,
  type ExportTable,
  type OpenedImage,
} from "@/lib/export-archive";
import { exportTreeAsGedcom } from "@/lib/export-tree";
import { collectImageReferences } from "@/lib/image-references";
import { isPortraitKey } from "@/lib/portrait";
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
 * `gedcom_imports` points at nothing, `individuals` point at both `pages` and
 * `gedcom_imports`, `unions` point at `individuals` and `gedcom_imports`, and
 * `union_children` point at `unions`, `individuals` and `gedcom_imports`, and
 * `page_categories` (`YEO-78`) points at `pages` and `categories`.
 * Loading them in this order means a restore never has to defer a constraint.
 *
 * `gedcom_imports` (`YEO-89`) sits **ahead of** `individuals` for exactly that
 * reason: `individuals.import_id`, `unions.import_id` and
 * `union_children.import_id` all reference it, so a restore that loaded any
 * of the three first would be inserting rows whose foreign key names a table
 * that does not exist yet. Missing this is the trap this ticket sets for
 * whoever forgets it — a full backup would silently omit the ledger, and a
 * restore of it would fail that constraint on the very first `individuals`
 * row with a non-null `import_id`.
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
  schema.gedcomImports,
  schema.individuals,
  schema.unions,
  schema.unionChildren,
  // E11-T8 (`YEO-78`). `categories` references nothing, so it could sit
  // anywhere; `page_categories` references both `pages` and `categories`, so
  // it has to come after them. Appended rather than slotted in beside `pages`
  // where they read most naturally, because `lib/export-full.db.test.ts`
  // indexes this list positionally — inserting in the middle would renumber
  // every table after it.
  schema.categories,
  schema.pageCategories,
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
  if (table === schema.gedcomImports) return [asc(schema.gedcomImports.id)];
  if (table === schema.individuals) return [asc(schema.individuals.id)];
  if (table === schema.unions) return [asc(schema.unions.id)];
  if (table === schema.unionChildren) {
    return [
      asc(schema.unionChildren.unionId),
      asc(schema.unionChildren.childId),
    ];
  }
  if (table === schema.categories) return [asc(schema.categories.id)];
  return [
    asc(schema.pageCategories.pageId),
    asc(schema.pageCategories.categoryId),
  ];
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
 *
 * ## The refused response is cancelled, not dropped
 *
 * An error response has a body too — a blob store answers a `403` with a
 * paragraph of XML — and on Node's `fetch` a body that is never read holds
 * its socket out of the connection pool until a finaliser gets to it. One of
 * those is nothing; one per referenced photograph, on an export that runs
 * into an expired credential, is a connection leak that scales with the size
 * of the family album. `bodyChunks` in `lib/zip-stream.ts` takes the same
 * care for the same reason, and this is the path that skips it.
 *
 * Exported for `lib/export-full.test.ts`: every branch here is a failure the
 * archive has to survive, and none of them can be reached from a test that
 * has a working image store.
 */
export async function openImage(key: string): Promise<OpenedImage> {
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
    // Cancelling releases the connection. Its own failure is ignored: the
    // answer to this call is already decided, and a store that cannot even
    // be hung up on has nothing further to tell us.
    await response.body?.cancel().catch(() => {});
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
 * The two columns on `individuals` that hold a storage key (E5-T4, `YEO-44`).
 *
 * Snake case, because these are the raw rows as `readTables` selected them
 * rather than Drizzle's camel-cased view of them.
 */
const PORTRAIT_COLUMNS = ["portrait_key", "portrait_thumb_key"] as const;

/**
 * Every image the wiki refers to, from the rows just read.
 *
 * Two kinds of reference, and they are found in two different ways because
 * they are two different things:
 *
 * - **Entry bodies.** Current entries *and* every revision of them, because a
 *   photograph taken out of an entry last year is still in the revision that
 *   had it and revisions are append-only — see `lib/entry-images.ts`, which
 *   explains why the store is asked nothing and the bodies are asked instead.
 *   A reference here is an `<img src>` inside authored HTML, so it has to be
 *   parsed back out.
 * - **Portraits.** A column rather than a body, so there is nothing to parse:
 *   `individuals.portrait_key` and its thumbnail *are* keys. Both are
 *   collected, not just the original — a backup that restored the portraits
 *   and left every thumbnail behind would come back with a tree that fetches
 *   several hundred full-resolution photographs to draw itself, which is the
 *   failure E5-T4 exists to avoid, reintroduced by the recovery.
 *
 * Adding the second kind here rather than teaching `scanEntryImages` about it
 * is deliberate: that function answers "which images does this HTML use", and
 * a portrait is not in any HTML. What the two share is the *question* — which
 * keys are still referenced — and that question now lives in
 * `lib/image-references.ts`, which this function and E5-T5's orphan sweep
 * both go through so the two cannot come to disagree. A sweep that knew only
 * about bodies would delete every portrait in the wiki as unreferenced; a
 * sweep that disagreed with *this* function about anything else would leave
 * holes in a backup that nobody notices until the restore.
 *
 * A key that is not a well-formed image key is skipped rather than exported.
 * These columns are written through `validateIndividual`, so a bad one means
 * something reached the row another way — and an export must not refuse to
 * run over one dubious cell, for the reason `lib/entry-images.ts` gives.
 *
 * Sorted by key so that two exports of an unchanged wiki list them in the
 * same order, for the same reason `lib/export-tree.ts` orders its `select`s:
 * an order nothing imposes is an order that can change between two runs and
 * make a diff of two manifests unreadable.
 */
function referencedImages(
  tables: readonly ExportTable[],
): { key: string; url: string }[] {
  const html: string[] = [];
  const portraitKeys: string[] = [];

  for (const table of tables) {
    if (table.table === "individuals") {
      for (const row of table.rows) {
        for (const column of PORTRAIT_COLUMNS) {
          const key = row[column];
          // Filtered here rather than inside `collectImageReferences`,
          // because the export and E5-T5's sweep want opposite tie-breaks on
          // exactly this value and only the call sites can know which. The
          // archive is about to *fetch* each key, so a malformed one is a
          // request that cannot succeed; the sweep passes the same values in
          // raw, because there a value it does not recognise can only fail to
          // match an object and filtering it out is what could delete one.
          if (typeof key === "string" && isPortraitKey(key)) {
            portraitKeys.push(key);
          }
        }
      }
      continue;
    }

    if (table.table !== "pages" && table.table !== "revisions") continue;
    for (const row of table.rows) {
      // `hatnote` as well as `body_html`, and today that finds nothing:
      // `normaliseHatnote` flattens a hatnote to text and anchors, so no
      // `img` survives into the column. It is here so that the sentence
      // docs/export.md now prints — that the export and E5-T5's sweep ask
      // one question through one function — is true of the code rather than
      // true by accident of what hatnotes currently hold. The sweep scans
      // both columns; an export that scanned one would start quietly
      // omitting images on the day the hatnote allowlist widened.
      for (const column of ["body_html", "hatnote"]) {
        const value = row[column];
        if (typeof value === "string") html.push(value);
      }
    }
  }

  const keys = collectImageReferences({ html, keys: portraitKeys });

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
