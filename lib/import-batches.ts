/**
 * How many rows go in one `insert` (E6-T4, `YEO-49`).
 *
 * ## Why this is arithmetic in a module of its own
 *
 * The acceptance criterion is that "a file with several hundred people should
 * not be several hundred round trips", and that is a claim about a number.
 * Kept here, it is a pure function CI can assert against; folded into
 * `lib/gedcom-import.ts`, it would be a property of a transaction and could
 * only be checked by `npm run test:db`, which CI does not run — so the commit
 * that broke it would go green. That is the same split
 * `lib/union-order.ts` / `lib/reorder-unions.ts` and
 * `lib/removal-preview.ts` / `lib/remove-from-tree.ts` already draw, on the
 * same line and for the same reason.
 *
 * ## The two ceilings, which are not the same kind of thing
 *
 * `MAX_BIND_PARAMETERS` is **correctness**. Exceed it and the driver refuses
 * the statement outright.
 *
 * `MAX_ROWS_PER_STATEMENT` is **prudence**, and it is the one that actually
 * binds for this schema — the widest table here is 19 columns, so the
 * parameter ceiling would not be reached until 3,449 rows. It exists because
 * a single enormous `insert` is one statement whose duration nothing bounds:
 * Postgres's `statement_timeout` is a per-statement budget, not a per-import
 * one, so 50,000 rows in one statement is a single timer that either fits or
 * fails the whole file, where fifty statements of 1,000 are each cheap and
 * each safely inside it. It also bounds how long this holds a pooled
 * connection — Supabase's pooler runs in transaction mode and pins a backend
 * for the duration of the transaction (see `db/index.ts`), so an import is
 * occupying one of a small pool the entire time it runs.
 *
 * The parameter ceiling is therefore a guard rather than a working limit, and
 * it is kept because this schema has already been widened once for exactly
 * this kind of expressiveness — `YEO-88` turned every event into five columns
 * — and the next widening should not be able to overflow the wire protocol in
 * silence.
 */

/**
 * The most bind parameters one statement may carry.
 *
 * The protocol limit is a `int16` count of parameters in `Bind`, so 65,535 is
 * the number usually quoted. The number that matters is the driver's, and
 * postgres.js refuses one lower than you would expect — `connection.js`:
 *
 * ```js
 * if (q.parameters.length >= 65534)
 *   throw Errors.generic('MAX_PARAMETERS_EXCEEDED', ...)
 * ```
 *
 * `>=`, so 65,534 itself is already refused and 65,533 is the largest count
 * that reaches Postgres. Quoting the protocol's 65,535 here would put the
 * constant one past the first value that actually throws, which is precisely
 * the boundary it exists to keep us off.
 */
export const MAX_BIND_PARAMETERS = 65533;

/**
 * The most rows one statement may carry, whatever the parameter count allows.
 *
 * 1,000 is chosen so that the criterion this module exists for is met with
 * room to spare — a "several hundred people" file is **one** statement per
 * table, three round trips for the whole import — while staying small enough
 * that no single statement is long-running. See the module docblock for why
 * that second half is a `statement_timeout` and connection-pool concern
 * rather than a memory one.
 */
export const MAX_ROWS_PER_STATEMENT = 1000;

/**
 * How many rows fit in one statement, for a row of `columnsPerRow` values.
 *
 * `columnsPerRow` is a parameter rather than something this module works out
 * from the rows, and that is deliberate. The obvious implementation —
 * `Object.keys(row).length` — is right today and wrong in the unsafe
 * direction. Drizzle builds an insert by walking *every* column of the table,
 * not the keys of the object: a column the row omits is emitted as the
 * `default` keyword, costing no parameter, **unless** it carries a
 * `$defaultFn`, in which case drizzle evaluates it and binds a parameter for
 * a key that was never in the object. No column in `db/schema.ts` has one
 * (`defaultRandom()` and `defaultNow()` are `default` clauses in DDL, not
 * `$defaultFn`), so counting keys agrees with reality — until somebody adds
 * one, at which point it under-counts, and under-counting is the direction
 * that overflows.
 *
 * So the caller passes the table's own column count, which is an upper bound
 * under every drizzle code path. `lib/gedcom-import.ts` takes it from
 * `getTableColumns`, which keeps the schema knowledge in the module that
 * already imports the schema and leaves this one holding nothing but
 * arithmetic.
 *
 * @param columnsPerRow an upper bound on bind parameters one row can produce
 * @returns at least 1, however wide the row
 */
export function batchSize(columnsPerRow: number): number {
  /**
   * `Math.max(1, …)` is not defensive tidiness. A table wider than the
   * parameter ceiling floors to zero, and a zero batch size makes `batchesOf`
   * append an empty batch forever without consuming a row — so the failure
   * mode of the missing clamp is a hung import rather than an error. One is
   * diagnosable; the other is a function that never returns. Clamped, the
   * statement reaches the driver and fails by name.
   */
  return Math.max(
    1,
    Math.min(
      MAX_ROWS_PER_STATEMENT,
      Math.floor(MAX_BIND_PARAMETERS / columnsPerRow),
    ),
  );
}

/**
 * Split rows into the statements that will carry them, in order.
 *
 * Order is preserved across the batches and within them, which is what lets
 * the caller treat the concatenation of the batches as the original list —
 * and what keeps a failure legible, since the rows that reached Postgres are
 * a prefix of what was handed over rather than an arbitrary subset.
 *
 * **An empty list gives an empty list, and that is load-bearing.** Drizzle's
 * `values()` throws on an empty array (`insert.js`: "values() must be called
 * with at least one value"), so a GEDCOM file with individuals but no
 * families would fail the whole import at the second statement if the caller
 * looped over the arrays instead of over these batches. Returning `[]` makes
 * that loop body run zero times and the landmine unreachable, rather than
 * asking every caller to remember a guard.
 *
 * @param rows every row destined for one table
 * @param columnsPerRow an upper bound on bind parameters one row can produce
 */
export function batchesOf<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const size = batchSize(columnsPerRow);
  const batches: T[][] = [];

  for (let start = 0; start < rows.length; start += size) {
    batches.push(rows.slice(start, start + size));
  }

  return batches;
}
