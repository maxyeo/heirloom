import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";

import { db, schema } from "@/db";
import type { GedcomMapping } from "@/lib/gedcom-map";
import type { PriorImport } from "@/lib/import-endpoint";
import { batchesOf } from "@/lib/import-batches";
import { priorImportFrom } from "@/lib/import-ledger";
import { rowsFromMapping } from "@/lib/import-rows";

/**
 * Mapped rows in, three tables written or nothing written (E6-T4, `YEO-49`;
 * refused rather than duplicated on a repeat, `YEO-89`).
 *
 * ## All or nothing — but of the *write*
 *
 * The ticket's reason for existing is that "a half-imported tree is worse than
 * no import: it looks like data, so nobody re-runs it, and the gaps are
 * discovered one at a time over months." One transaction is the whole answer
 * to that: every row lands or none does, and a tree is never left in a state
 * nobody chose.
 *
 * `docs/gedcom.md` left this ticket a question it could not answer on its own
 * — whether a record `validateIndividual` refused should fail the entire file,
 * in which case E6-T2's per-record skipping was "cleverness that never runs".
 * **It should not, and the distinction is that all-or-nothing is a property of
 * the write rather than of the reading.** The transaction exists so that a
 * tree is never half-*written*. A tree that is fully written and honestly
 * described as missing one person whose death date preceded their birth is
 * not half-anything: it is the whole of what the file could be read as, with
 * a report saying what the rest was. Failing the file on one unreadable date
 * would make dirty files unimportable, and E6 exists precisely because real
 * GEDCOM files are dirty — a rule that refuses every real file is not a
 * safety property.
 *
 * So there is nothing here that decides what to *include*. `mapGedcom`
 * already ran the three validators and already dropped what they refused; by
 * the time a `GedcomMapping` arrives, every remaining row is one this
 * application has agreed to store. What this module decides — since `YEO-89`
 * — is only whether to write that mapping at all, and it decides that once,
 * against the ledger below, before a single row of it lands.
 *
 * ## Why a `GedcomMapping` and not a file
 *
 * Because the mapping *is* the rows. `lib/gedcom-map.ts` mints the ids in
 * memory and resolves every foreign key before returning — its own docblock
 * promises that "E6-T4 can then be one bulk insert inside one transaction,
 * with nothing left to resolve" — so taking anything earlier in the pipeline
 * would mean re-deciding something already decided. It also keeps the read
 * half testable with no database, which `lib/gedcom.purity.test.ts` enforces
 * and three tickets depend on.
 *
 * Counting what the file contained but this did not write is a question about
 * the *file*, not about the rows, and it is answered upstream where the file
 * still is (E6-T3, `YEO-48`) rather than re-derived here from a mapping that
 * no longer remembers.
 *
 * ## The ledger, and why the unique index is the guard
 *
 * `mapGedcom` mints a fresh id for every record on every parse, so nothing
 * about a `GedcomMapping` says whether the bytes it came from have been
 * written before — a second import of one file used to be a second complete
 * copy of the tree. `gedcomImports` (`db/schema.ts`) is the fix: one row per
 * digest, written inside the same transaction as the three tables, before
 * any of them.
 *
 * The insert into `gedcomImports` is written with `onConflictDoNothing`, and
 * it is the **only** place in this function that appears. Everywhere else —
 * `individuals`, `unions`, `union_children` — a duplicate key is unreachable
 * by construction (`mapGedcom` mints a fresh id per record and de-duplicates
 * repeated `CHIL` pointers within a family), so a conflict there would be a
 * genuine fault and is left to throw. The ledger is different on purpose: a
 * conflict on `digest` is not a fault, it is the ordinary shape of a second
 * upload of a file already recorded, and what happens to it is a decision —
 * refuse — rather than a crash. That does not weaken the claim the rest of
 * this module rests on, that the written counts equal the array lengths
 * because nothing was silently skipped: the ledger's row count is never used
 * as the answer to "how many landed", and `onConflictDoNothing` never once
 * touches a table this module actually counts.
 *
 * `.unique()` on `gedcomImports.digest` is what actually stops a second
 * import, not a `select` beforehand. A check-then-insert has a race in the
 * middle — two requests can both see no prior row — and a second browser
 * tab, a retried request, or a back button landing on a stale preview is
 * exactly the caller shape that finds it. The unique index has no such gap:
 * whichever transaction's insert loses is told so by Postgres, inside the
 * same transaction that would otherwise have gone on to write the three
 * tables, and the loser's entire write — ledger row included — rolls back
 * with it. See `db/schema.ts`'s `gedcomImports` docblock for why refusing
 * beat merging or replacing the prior import.
 *
 * ## Releasing a prior claim, and why it rides on the import (`YEO-95`)
 *
 * The refusal above had no override, which made it a one-way door: a reader
 * who imported a file, decided the result was wrong and deleted the rows was
 * left with a digest nothing in the product could release. {@link
 * ImportOptions.releasePrior} is the way back out, and three things about its
 * shape are decisions rather than convenience.
 *
 * **It releases rather than deletes.** The prior ledger row is marked
 * `released_at` and keeps everything else — its id, its counts, its date, and
 * every `individuals.import_id` still pointing at it. Deleting it is the
 * obvious manual fix and it is the destructive one: the foreign key is `ON
 * DELETE set null`, so dropping the row silently strips the provenance from
 * every row of that import that survived. See `gedcomImports` in
 * `db/schema.ts` for the partial index this rests on.
 *
 * **It happens inside the writing transaction, not before it.** A release is
 * only ever asked for in order to import, so making it a step of its own —
 * its own endpoint, its own button — would create a state nobody wants: a
 * digest freed with nothing written, which is a guard turned off and left
 * off. Here the release and the import commit together or neither does, so
 * the guard is never down except for the write it was let down for.
 *
 * **It removes nothing the earlier import wrote.** That is the honest
 * behaviour and not a missing half. This module knows which rows an import
 * created; it does not know which of them somebody has since edited by hand,
 * and deleting a person's corrected dates to make room for the bytes they
 * were corrected from is the exact failure "replace" was rejected for above.
 * So releasing frees the claim and nothing else, and if the earlier import's
 * people are still in the tree, importing again does produce a second copy —
 * which `components/GedcomImport.tsx` says in as many words before the
 * override can be reached.
 *
 * **The override is single-use, and nothing has to remember that it was
 * used.** {@link ImportOptions.release} names one ledger row rather than
 * asserting a mood, so releasing it a second time releases nothing, and the
 * unique index meets the replay with the ordinary refusal — naming the import
 * that has just happened. A retried request, a second tab and a back button
 * are therefore no more dangerous on this path than on the ordinary one,
 * which is the property that lets the door exist at all.
 *
 * A release that matches no live row updates nothing and is not an error in
 * its own right: the caller wanted this file imported, and whether it lands
 * is then the same question it always was, asked of the same index. Two
 * callers racing to release the same row are settled there too — see
 * `lib/gedcom-import.db.test.ts`.
 *
 * ## Faults propagate; a refusal is not one
 *
 * Until `YEO-89` there was no `try` here and no result union, because every
 * refusal this flow had was made before the transaction opened, and
 * everything that could go wrong inside it was a genuine fault. That is no
 * longer quite true: a digest collision is discovered *inside* the
 * transaction, against a row another request may have committed only
 * moments before, so it is the one decision that has to be made from within
 * the write. It is still not a fault, and it is not reported as one — see
 * {@link ImportOutcome} and the hazard below for how it is threaded out
 * without ever returning normally from a transaction that has already
 * written something.
 *
 * Every other exception this function can raise remains exactly what it was:
 * a dropped connection, a statement timeout, a constraint added after this
 * was written. Throwing is what rolls the transaction back, and it is also
 * the honest answer — the caller gets an exception whose existence means, by
 * construction, that nothing was written.
 *
 * The route that calls this owns the sentence a reader sees, the same way it
 * already owns every other refusal in the import flow.
 *
 * ## The hazard, now in use rather than merely named
 *
 * **postgres.js commits a transaction callback that returns normally.**
 * `db.transaction` is its `begin`, which issues `commit` when the callback
 * resolves and `rollback` only when it *throws*. So the refusal below
 * `throw`s rather than `return`s a `{ status: "already-imported" }` value —
 * returning it after the ledger's own insert had already run inside the same
 * transaction would report a refusal and commit the ledger row anyway,
 * leaving a `gedcom_imports` row with no `individuals` behind it.
 *
 * That is not hypothetical: it is the bug `lib/reorder-unions.ts` shipped and
 * then fixed, and `lib/reorder-unions.db.test.ts` pins the semantics against a
 * real database under "the transaction semantics reorderUnions relies on".
 * The idiom for doing it correctly is `refuse` in `lib/set-parents.ts` — a
 * private error carrying the typed result, thrown inside and unwrapped
 * outside — and this module now uses exactly it, rather than merely naming it
 * as something absent. `YEO-89` is the ticket that gave this module its first
 * thing to refuse.
 */

/**
 * How many bind parameters one row of each table can produce.
 *
 * Taken from the table rather than from the row objects, because drizzle
 * builds an insert by walking every column of the table and can bind a
 * parameter for a key the row never had — see `batchSize` in
 * `lib/import-batches.ts` for the `$defaultFn` case that makes counting keys
 * unsafe. The table's column count is an upper bound under every path.
 *
 * Exported so `lib/gedcom-import.db.test.ts` can size its fixture from the
 * same numbers this uses, rather than hard-coding a row count that quietly
 * stops spanning more than one batch when the schema widens. `import_id`
 * (`YEO-89`) widened every one of these tables by one column; these constants
 * are read from `getTableColumns` rather than written as literals, so they
 * picked it up without an edit here.
 */
export const INDIVIDUAL_COLUMNS = Object.keys(
  getTableColumns(schema.individuals),
).length;
export const UNION_COLUMNS = Object.keys(getTableColumns(schema.unions)).length;
export const UNION_CHILD_COLUMNS = Object.keys(
  getTableColumns(schema.unionChildren),
).length;

/** How many rows reached each table. */
export type ImportedCounts = {
  individuals: number;
  unions: number;
  unionChildren: number;
};

/**
 * What identifies *this* file, for the ledger (`YEO-89`).
 *
 * Everything here is either recomputed by the caller from bytes it already
 * has (`digest`, `byteCount`) or read off the request that is confirming the
 * import (`fileName`, `importedBy`) — nothing is decided in this module.
 * `app/api/import/route.ts` is the one caller and assembles this from the
 * multipart form and the session `requireSessionOr401` already checked.
 */
export type ImportProvenance = {
  /** Lowercase-hex SHA-256 of the file's bytes. See `gedcomDigest`. */
  digest: string;
  /** The uploaded filename, or null — see `gedcomImports.fileName`. */
  fileName: string | null;
  byteCount: number;
  /** The signed-in email running the import, or null. */
  importedBy: string | null;
};

/**
 * What to do about a prior import of these same bytes (`YEO-95`).
 *
 * An options object with one field rather than a bare boolean parameter, so
 * that the call site reads `{ releasePrior: true }` instead of a `true`
 * floating after the provenance with nothing on it to say what it means. The
 * shape also leaves room for a second decision about a prior import without
 * changing the arity of {@link importGedcom} again.
 */
export type ImportOptions = {
  /**
   * The `gedcom_imports.id` whose claim on this digest to give up before
   * writing, or `null` to be refused by it as usual.
   *
   * **An id rather than a boolean, and that is the safety property.** A
   * boolean would mean *let this file through whatever is in the way*, which
   * stays true however many times the request is sent: a retry or a second
   * tab would release the import that had just succeeded and write a second
   * complete copy of the tree — the exact duplication `YEO-89` exists to
   * prevent, reached through the door built to escape it. Naming the row
   * makes the override single-use with no bookkeeping at all, because the
   * second attempt names a row that is no longer live and releases nothing.
   *
   * Not trusted on its own. The `where` below requires it to be a row for
   * *this* digest as well, so a release can never retire some unrelated
   * file's claim, whatever the caller sends.
   *
   * `app/api/import/route.ts` reads it from a request field of its own, which
   * the screen fills in from the prior import it has just shown the reader
   * and sends only after a second, separate press.
   */
  release: string | null;
};

/**
 * The default: import, and be refused if this file is already in the ledger.
 *
 * Named and exported rather than written inline as a parameter default,
 * because it is the thing every caller that has not thought about `YEO-95`
 * gets — the guard intact — and a reader of a two-argument call deserves to
 * be able to find out what the third one was.
 */
export const REFUSE_IF_IMPORTED: ImportOptions = { release: null };

/**
 * How an import ends: written, or refused because this exact file already
 * was (`YEO-89`).
 *
 * Two variants rather than a boolean and a nullable field, because the two
 * carry disjoint information — `counts` describes rows this call wrote and
 * would be meaningless zeros on a refusal, `previous` describes a different
 * call's rows entirely and would be meaningless on success. A caller that
 * reads `counts` off a refused outcome, or `previous` off a written one, is a
 * bug the type system can catch instead of a reader having to remember which
 * fields are live in which case.
 */
export type ImportOutcome =
  | {
      status: "imported";
      /** The ledger row this write created — see `gedcomImports.id`. */
      importId: string;
      counts: ImportedCounts;
    }
  | {
      status: "already-imported";
      /** What the earlier import of this file wrote, and when. */
      previous: PriorImport;
    };

/**
 * Write a mapped GEDCOM file into the three tables, all of it or none of it —
 * refusing outright if this exact file has already been imported (`YEO-89`).
 *
 * The three inserts run in table order — individuals, then unions, then the
 * child links — and that is required even though every foreign key was
 * resolved in memory before this was called. Postgres checks a foreign key at
 * the moment the row is inserted unless the constraint was declared
 * `DEFERRABLE`, and none of the ones in `db/schema.ts` were. Pre-resolved ids
 * remove the need to *read anything back* mid-write, which is what made one
 * bulk insert possible; they do not make a union insertable before its
 * partners exist.
 *
 * The written counts come from the arrays rather than from `returning`.
 * Nothing that inserts `individuals`, `unions` or `union_children` uses
 * `onConflictDoNothing` — see the module docblock for why the one place it
 * does appear, the ledger, does not weaken this — so a statement that did not
 * throw inserted every row it was given, which means the length is already
 * the answer, and `returning` would be a round trip's worth of data fetched
 * to re-derive a number this function had in hand before it opened the
 * connection. `mapGedcom` earns the absence of a duplicate key by minting a
 * fresh id per record and de-duplicating repeated `CHIL` pointers within a
 * family itself.
 *
 * @param mapping rows to write, with every id minted and every key resolved
 * @param provenance what to record about this file if it is written
 * @param options which prior ledger row, if any, to release its claim on this
 *   digest before writing (`YEO-95`); defaults to {@link REFUSE_IF_IMPORTED},
 *   which is the guard as `YEO-89` left it
 * @returns the ledger id and per-table counts, or the prior import this file
 *   already has
 * @throws whatever the driver raises, having rolled the whole import back
 */
export async function importGedcom(
  mapping: GedcomMapping,
  provenance: ImportProvenance,
  options: ImportOptions = REFUSE_IF_IMPORTED,
): Promise<ImportOutcome> {
  /**
   * The rows themselves come from `lib/import-rows.ts`, and deliberately not
   * from three `map` calls here. E7-T2 (`YEO-52`) round-trips an export
   * through *this* import and compares the bytes, which it can only do if the
   * part that decides what the rows are is reachable without a database. See
   * that module's docblock; `lib/gedcom-round-trip.test.ts` asserts this call
   * still exists, because a copy of it inlined here is how the tested
   * pipeline and the real one quietly stop being the same pipeline.
   *
   * `import_id` is not among them. It is threaded onto each row below,
   * between this call and the batching, because the id it carries does not
   * exist until the ledger insert a few lines down has run — `rowsFromMapping`
   * has no transaction to ask for one, and threading it through that pure
   * function would only give it a database-shaped parameter for no reason.
   */
  const { individuals, unions, unionChildren } = rowsFromMapping(mapping);

  return db
    .transaction(async (tx): Promise<ImportOutcome> => {
      /**
       * The override, spent before the insert that would otherwise be refused
       * (`YEO-95`). An `update` rather than a `delete`, which is the whole
       * point — see the module docblock.
       *
       * Three conditions, and none of them is decoration:
       *
       * - **`id`**, so this retires the row the caller was actually shown and
       *   not whichever row happens to hold the digest when the request
       *   lands. That is what makes a replayed release harmless rather than a
       *   second copy of the tree; {@link ImportOptions.release} argues it in
       *   full.
       * - **`digest`**, so an id from somewhere else cannot retire an
       *   unrelated file's claim. The id crosses the wire, so it is a value
       *   the caller controls and nothing here treats it as more than a
       *   claim to check.
       * - **`released_at is null`**, so two callers racing to release the
       *   same row settle it here: the second wakes to find the predicate no
       *   longer true, skips, and meets the ordinary index below.
       *
       * Nothing is read back and nothing is asserted about how many rows it
       * touched, because every reason for touching none of them has the same
       * correct ending. A stale id, a foreign id, an id already released, a
       * caller who asked for the override and did not need it — in all four
       * the guard is simply left standing, and the insert below decides the
       * request under exactly the index it always has. There is no state in
       * which a release has happened and the import has not: they commit
       * together or neither does.
       */
      if (options.release !== null) {
        await tx
          .update(schema.gedcomImports)
          .set({ releasedAt: new Date(), releasedBy: provenance.importedBy })
          .where(
            and(
              eq(schema.gedcomImports.id, options.release),
              eq(schema.gedcomImports.digest, provenance.digest),
              isNull(schema.gedcomImports.releasedAt),
            ),
          );
      }

      /**
       * The ledger row, written first and the only insert in this function
       * that may legitimately conflict. See the module docblock for why
       * `onConflictDoNothing` belongs here and nowhere else in this write.
       *
       * The `where` repeats the partial index's predicate (`YEO-95`), and it
       * is not optional decoration: Postgres infers which unique index an `on
       * conflict (digest)` refers to, and it will only ever infer a *partial*
       * one from a statement that carries a predicate implying the index's
       * own. Without it this statement raises "there is no unique or
       * exclusion constraint matching the ON CONFLICT specification" — loudly
       * and on every import, rather than quietly and on the interesting ones.
       */
      const [ledger] = await tx
        .insert(schema.gedcomImports)
        .values({
          digest: provenance.digest,
          fileName: provenance.fileName,
          byteCount: provenance.byteCount,
          importedBy: provenance.importedBy,
          individualCount: individuals.length,
          unionCount: unions.length,
          unionChildCount: unionChildren.length,
        })
        .onConflictDoNothing({
          target: schema.gedcomImports.digest,
          where: sql`${schema.gedcomImports.releasedAt} is null`,
        })
        .returning({ id: schema.gedcomImports.id });

      if (ledger === undefined) {
        /**
         * The conflict itself doesn't say what the prior import was — only
         * that one exists — so it has to be read back. `priorImportFrom` is
         * the same shaping `lib/import-ledger.ts` uses for the preview-stage
         * lookup, so a reader is told the same facts about a prior import
         * whichever path found it.
         */
        const [existing] = await tx
          .select({
            id: schema.gedcomImports.id,
            fileName: schema.gedcomImports.fileName,
            importedAt: schema.gedcomImports.importedAt,
            individualCount: schema.gedcomImports.individualCount,
            unionCount: schema.gedcomImports.unionCount,
            unionChildCount: schema.gedcomImports.unionChildCount,
          })
          .from(schema.gedcomImports)
          .where(
            and(
              eq(schema.gedcomImports.digest, provenance.digest),
              // The row that refused this insert is by construction a live
              // one — the index the conflict came from covers no others —
              // so the same predicate that identifies it to Postgres is the
              // one that identifies it here (`YEO-95`).
              isNull(schema.gedcomImports.releasedAt),
            ),
          );

        if (existing === undefined) {
          /**
           * Unreachable under `read committed`, which is what this connection
           * runs at and what the reasoning rests on. `on conflict do nothing`
           * skips a row only once a conflicting row is *committed* — against
           * a concurrent inserter that later aborts, the insert proceeds
           * instead of skipping — and every statement in a `read committed`
           * transaction takes a fresh snapshot, so the select above sees
           * whatever the conflict saw.
           *
           * Named rather than assumed because it is the isolation level doing
           * the work: under `repeatable read` this select would run against
           * the snapshot the transaction opened with and could genuinely miss
           * a row committed since, and Postgres would raise a serialization
           * failure on the insert instead. Either way the answer here is the
           * same and is the safe one — throwing rolls the whole import back,
           * and the route says nothing was written, which is true.
           */
          throw new Error(
            "gedcom_imports conflicted but no row was found to read back",
          );
        }

        refuse({
          status: "already-imported",
          previous: priorImportFrom(existing),
        });
      }

      const importId = ledger.id;

      for (const batch of batchesOf(
        individuals.map((row) => ({ ...row, importId })),
        INDIVIDUAL_COLUMNS,
      )) {
        await tx.insert(schema.individuals).values(batch);
      }

      for (const batch of batchesOf(
        unions.map((row) => ({ ...row, importId })),
        UNION_COLUMNS,
      )) {
        await tx.insert(schema.unions).values(batch);
      }

      for (const batch of batchesOf(
        unionChildren.map((row) => ({ ...row, importId })),
        UNION_CHILD_COLUMNS,
      )) {
        await tx.insert(schema.unionChildren).values(batch);
      }

      return {
        status: "imported",
        importId,
        counts: {
          individuals: individuals.length,
          unions: unions.length,
          unionChildren: unionChildren.length,
        },
      };
    })
    .catch((error: unknown) => {
      if (error instanceof Refusal) return error.result;
      throw error;
    });
}

/**
 * Refuse, and take everything this transaction has already written with it.
 *
 * The one refusal this module has is discovered *after* the ledger insert has
 * run, so a plain `return` would report the refusal to the caller while
 * `db.transaction` — seeing a callback that returned rather than threw —
 * commits that insert anyway. See "The hazard, now in use" above.
 *
 * Returns `never`, so the compiler treats a call as an exit and the code
 * after it narrows as though the refusal had returned.
 *
 * @param result what {@link importGedcom} should resolve to
 */
function refuse(result: ImportOutcome): never {
  throw new Refusal(result);
}

/**
 * The carrier. Only ever thrown by `refuse` and only ever caught by
 * `importGedcom`, which unwraps it into an ordinary result; a real fault —
 * the database unreachable, a constraint violated — is not an instance of
 * this and goes on propagating untouched.
 */
class Refusal extends Error {
  constructor(readonly result: ImportOutcome) {
    super(`gedcom-import refused: ${result.status}`);
    this.name = "Refusal";
  }
}
