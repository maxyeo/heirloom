import { isRowId } from "./row-id";
import { MAX_UNION_SEQUENCE } from "./union-input";

/**
 * The arithmetic behind reordering one person's unions (E3-T7, `YEO-35`).
 *
 * ## What is actually being decided here
 *
 * `unions.sequence` exists because in older generations the exact year of a
 * marriage is routinely lost while the *order* is remembered perfectly well —
 * "she remarried after he died" (docs/architecture.md). `getFamilyGraph`
 * already sorts on it before `start_date`, and `compareUnions` in
 * `lib/person-detail.ts` does the same in TypeScript. The column was simply
 * unreachable: `lib/save-union.ts` picks a number for a *new* union and
 * nothing has ever changed one.
 *
 * ## The awkward part: one column, two owners
 *
 * A union has two partners, so the same row takes part in two people's
 * orderings. There is exactly one `sequence` column to express both. That is
 * a property of the schema, not of this module — a *private* order per person
 * would need a second table (`union_id`, `person_id`, `sequence`), which this
 * ticket does not add and `lib/family-graph.ts` does not read.
 *
 * So reordering from Rose's panel can move a shared union within Thomas's
 * order too, and no arithmetic here can prevent that. What this module does
 * instead is keep the disturbance as small as it can possibly be:
 *
 * - **Only the person's own unions are written.** Nobody else's rows move.
 * - **Only the numbers those rows already hold between them are used.** Where
 *   those numbers already differ, the unions simply permute among them and
 *   the set of `sequence` values in the table is unchanged — so a partner's
 *   other unions keep every gap they had, and can only be re-sorted against
 *   the *shared* union. (Where two of them are equal the set does change, by
 *   necessity; see the next section.)
 *
 * That second rule is why this is not simply "write 0, 1, 2…". `nextSequence`
 * in `lib/save-union.ts` numbers a new union one past the highest either
 * partner holds, so a person's unions are commonly `1, 2` rather than `0, 1` —
 * renumbering them from zero would drag them underneath somebody else's
 * marriage that was deliberately placed above.
 *
 * ## Why ties are broken upward
 *
 * `sequence` is `not null default 0`, so a tree that predates any reorder has
 * every union at 0 and the displayed order comes entirely from the tie-break
 * on `start_date` and then id. Permuting three zeroes among three unions
 * expresses nothing. `resequenceUnions` therefore returns a *strictly*
 * increasing run, pushing duplicates upward — which is also what makes the
 * order the author was already looking at durable rather than incidental.
 *
 * This is the one place the "no new numbers" rule has to give, and it is worth
 * being plain about the cost: a lifted duplicate can land on a number the
 * shared union's *other* partner was already using, making an order that was
 * unambiguous for them ambiguous again. Nudging past their occupied values
 * too was considered and rejected — it would mean reading and reasoning about
 * every partner's unions to place one person's, and each nudge could collide
 * with a third person in turn. The bounded version is preferred: a tie that
 * was already being settled by `start_date` and id goes on being settled by
 * them, for one person, rather than a reorder walking the graph. Two equal
 * numbers were never an order in the first place.
 *
 * ## Purity
 *
 * No database, no session, no `FormData` beyond the one reader at the bottom,
 * which takes a plain web `FormData`. The same rule `lib/union-input.ts`
 * states: E6-T2's GEDCOM import and a test both have to be able to call this.
 */

/** Which way a move button sends a union. */
export const MOVE_DIRECTIONS = ["up", "down"] as const;

export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** One press of one button: send this union one place that way. */
export type UnionMove = {
  direction: MoveDirection;
  unionId: string;
};

/** The form field carrying the order as the browser rendered it. */
export const ORDER_FIELD = "unionIds";

/** The form field carrying the button that was pressed. */
export const MOVE_FIELD = "move";

/**
 * How a move button spells itself.
 *
 * A submit button's `name`/`value` pair is sent only for the button that was
 * actually pressed, which is what lets one form hold every row's controls and
 * still know which one the author clicked — with no JavaScript involved. The
 * direction and the union travel together in that single value because there
 * is only one pair to spend.
 */
export function formatMove(direction: MoveDirection, unionId: string): string {
  return `${direction}:${unionId}`;
}

/**
 * Read a move back.
 *
 * @returns the move, or null when the value did not come from one of these
 *   buttons — a hand-made POST rather than something to show an author
 */
export function readMove(value: unknown): UnionMove | null {
  if (typeof value !== "string") return null;

  const separator = value.indexOf(":");
  if (separator === -1) return null;

  const direction = value.slice(0, separator);
  const unionId = value.slice(separator + 1);

  if (!isMoveDirection(direction) || !isRowId(unionId)) return null;
  return { direction, unionId };
}

function isMoveDirection(value: string): value is MoveDirection {
  return (MOVE_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * Move one union one place, in a copy.
 *
 * One place rather than an arbitrary index, because that is the whole
 * interaction: a pair of buttons per row. It also means a submission can only
 * ever express a single adjacent swap, so a stale list cannot be used to
 * scramble an order the author never saw.
 *
 * @returns the new order, or null when there is nothing to do — the union is
 *   not in the list, or it is already at the end it was asked to move towards.
 *   Both are ordinary: a double-click sends the second press against a list
 *   the first one already moved.
 */
export function applyMove(
  order: readonly string[],
  move: UnionMove,
): string[] | null {
  const from = order.indexOf(move.unionId);
  if (from === -1) return null;

  const to = move.direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) return null;

  const moved = [...order];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}

/**
 * The numbers to write, positionally, for a person's unions in their new
 * order.
 *
 * Takes the `sequence` values those unions hold *now*, in any order, and
 * returns as many values, ascending and strictly increasing. Assign the first
 * to the first union of the new order, and so on.
 *
 * The values are the caller's own, sorted — that is the "smallest possible
 * disturbance" rule from this module's header. Two adjustments are made to
 * them, in this order:
 *
 * 1. **A ceiling.** Each position is capped at `MAX_UNION_SEQUENCE` minus the
 *    number of unions that still have to fit above it, so the run always ends
 *    at or below the bound `validateUnion` enforces on an explicit sequence.
 *    Without it, breaking a tie at the very top would write a number the
 *    validator would then refuse.
 * 2. **A floor.** Each position is at least one above the previous, which is
 *    what turns duplicates into an order rather than leaving them a tie for
 *    `start_date` to settle.
 *
 * The floor wins where the two disagree, so the result is strictly increasing
 * for any input. (It can therefore exceed the ceiling for a person with more
 * than `MAX_UNION_SEQUENCE + 1` unions — a thousand and two marriages, which
 * the schema permits and nobody has had. A legal order is the more useful
 * failure than a refusal.)
 */
export function resequenceUnions(current: readonly number[]): number[] {
  const sorted = [...current].sort((a, b) => a - b);
  const assigned: number[] = [];

  for (const [index, value] of sorted.entries()) {
    const ceiling = MAX_UNION_SEQUENCE - (sorted.length - 1 - index);
    const floor = index === 0 ? 0 : assigned[index - 1] + 1;
    assigned.push(Math.max(Math.min(value, ceiling), floor));
  }

  return assigned;
}

/**
 * One submission of the reorder controls, still untrusted.
 *
 * Every field is a *reference* rather than content — which person, which
 * unions, which button — so this is the Next.js server-actions guide's
 * "send a reference plus the user's change" rule in the same pure form
 * `lib/remove-from-tree.ts` takes it: the client says *which*, never *what*.
 * The one thing that is not a reference is the `order`, and it is not content
 * either — it is what the browser was showing, sent so that
 * `lib/reorder-unions.ts` can tell whether that view is still true.
 */
export type ReorderUnionsInput = {
  /** The person whose order this is. Becomes the union filter. */
  personId: unknown;
  /** Their unions, in the order the browser rendered them. */
  order: unknown[];
  /** The button that was pressed. */
  move: unknown;
};

/**
 * Pull one reorder submission out of a form.
 *
 * `getAll` rather than `get`: the order arrives as one hidden input per union,
 * which is how a form sends a list and what keeps the whole control working
 * as a plain POST before any JavaScript has loaded.
 */
export function reorderInputFromFormData(form: FormData): ReorderUnionsInput {
  return {
    personId: form.get("personId"),
    order: form.getAll(ORDER_FIELD),
    move: form.get(MOVE_FIELD),
  };
}

/**
 * Check that the submitted order is a list of distinct row ids.
 *
 * Shape only. Whether these are *this person's* unions is a database question
 * and belongs in `lib/reorder-unions.ts`, which can see the rows.
 *
 * @returns the ids, or null when the list is not one — a duplicate, a `File`,
 *   or something that is not shaped like a primary key at all
 */
export function readOrder(order: readonly unknown[]): string[] | null {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of order) {
    if (typeof value !== "string" || !isRowId(value)) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    ids.push(value);
  }

  return ids;
}
