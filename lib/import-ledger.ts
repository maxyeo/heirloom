import { eq } from "drizzle-orm";

import { db, schema } from "@/db";
import type { PriorImport } from "@/lib/import-endpoint";

/**
 * Reads of the GEDCOM import ledger (`YEO-89`).
 *
 * `db/schema.ts`'s `gedcomImports` docblock has the argument for why the
 * table exists and why its unique index on `digest`, not a check here, is
 * what actually stops a file being imported twice. This module is the read
 * side of that ledger: turning a digest into what the preview screen and the
 * write path both need to say about a prior import, in one place so the two
 * cannot describe it differently.
 *
 * `PriorImport` itself is declared in `lib/import-endpoint.ts` rather than
 * here, because it crosses the wire to a client component and that module is
 * the one the client is allowed to import — it reaches no `@/db`. This
 * module reaches `@/db` on every call, so nothing on the client side may ever
 * import it; `findImportByDigest` is called only from
 * `app/api/import/route.ts` and `priorImportFrom` only from here and from
 * `lib/gedcom-import.ts`'s conflict path.
 */

/** The row shape both callers below build a {@link PriorImport} from. */
type LedgerRow = {
  fileName: string | null;
  importedAt: Date;
  individualCount: number;
  unionCount: number;
  unionChildCount: number;
};

/**
 * A ledger row, shaped for the wire.
 *
 * Shared between {@link findImportByDigest} — the preview-stage lookup — and
 * the refusal `lib/gedcom-import.ts` raises when its own insert loses the
 * race at the unique index, so the sentence a reader sees is built the same
 * way whichever path found the row.
 *
 * @param row the ledger row, as either caller reads it out of `gedcom_imports`
 */
export function priorImportFrom(row: LedgerRow): PriorImport {
  return {
    // `importedAt` is a `timestamp with time zone`, which postgres.js already
    // hands back as a `Date` — `toISOString()` is what makes it travel over
    // JSON, the same discipline `lib/export-archive.ts` applies to its own
    // dates.
    importedAt: row.importedAt.toISOString(),
    fileName: row.fileName,
    counts: {
      people: row.individualCount,
      unions: row.unionCount,
      children: row.unionChildCount,
    },
  };
}

/**
 * Whether this exact file has been imported before.
 *
 * A database read on the preview path, which is otherwise required to write
 * nothing and — under `lib/gedcom.purity.test.ts` — to be incapable of it;
 * that rule is about `lib/import-preview.ts`'s own closure, not about this
 * route. Reading whether a digest is already in the ledger tells a reader
 * something true before they press Import; it commits nothing on its own,
 * and the promise "cancelling leaves the database untouched" still holds
 * because a `select` that finds a row changes nothing about that row.
 *
 * @param digest lowercase-hex SHA-256 of the uploaded bytes, from
 *   {@link import("./import-preview").gedcomDigest}
 * @returns what that import wrote, or `null` if this digest has never been
 *   imported
 */
export async function findImportByDigest(
  digest: string,
): Promise<PriorImport | null> {
  const [row] = await db
    .select({
      fileName: schema.gedcomImports.fileName,
      importedAt: schema.gedcomImports.importedAt,
      individualCount: schema.gedcomImports.individualCount,
      unionCount: schema.gedcomImports.unionCount,
      unionChildCount: schema.gedcomImports.unionChildCount,
    })
    .from(schema.gedcomImports)
    .where(eq(schema.gedcomImports.digest, digest));

  return row === undefined ? null : priorImportFrom(row);
}
