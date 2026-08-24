"use client";

import { useActionState } from "react";

import type { SpouseLink } from "@/lib/person-detail";
import {
  formatMove,
  MOVE_FIELD,
  ORDER_FIELD,
} from "@/lib/union-order";
import {
  idleUnionOrderState,
  type ReorderUnionsFormAction,
} from "@/lib/union-order-state";

/**
 * Putting a person's unions in the right order when the dates cannot
 * (E3-T7, `YEO-35`).
 *
 * ## Why this exists at all
 *
 * `unions.sequence` has been in `db/schema.ts` since the beginning and
 * `lib/family-graph.ts` has always sorted on it, because in older generations
 * the year of a marriage is routinely lost while the order is remembered
 * perfectly well — "she remarried after he died" (docs/architecture.md).
 * Without a control the column was unreachable, so every undated union fell
 * back on the tie-break and the story quietly scrambled itself. These two
 * buttons are the whole feature; the reasoning is in `lib/union-order.ts`.
 *
 * ## Why it renders the spouse list a second time
 *
 * Because it is an editor, and an editor needs a row to put its buttons on.
 * The alternative was to grow arrows inside `components/PersonPanel.tsx`'s
 * `SpouseRow`, which would make the panel — a deliberately read-only record,
 * as its own header says — carry a write. The panel's `footer` slot exists for
 * exactly this, and E3-T8 already uses it for the same reason.
 *
 * Hidden entirely below two unions, which is most people: there is no order to
 * state when there is only one thing in it, and a lone disabled pair of arrows
 * would just be noise on the panel of everybody who married once.
 *
 * ## Why one form and a named submit button
 *
 * The order the browser is showing goes up as one hidden input per union, and
 * the button that was pressed identifies itself through its own `name`/`value`
 * — which the browser sends only for the submitter. That is what lets a single
 * form carry every row's controls, and it is what makes the whole control work
 * as a plain POST before any JavaScript has loaded. React builds the action's
 * `FormData` from the form *and its submitter*, so the same thing is true
 * after hydration.
 *
 * Sending the order rather than only the move is not redundancy: it is how
 * `lib/reorder-unions.ts` can tell that the list on screen still describes the
 * person's unions, and refuse the move rather than write it into a list that
 * has changed underneath.
 *
 * ## Why nothing here is held in state
 *
 * E3-T2's lesson was that inputs in a form with an action must be controlled,
 * because React resets the form on every submission before the action runs.
 * There is nothing to preserve here: every input is hidden and its value comes
 * from the `spouses` prop, and React keeps an input's `defaultValue` in step
 * with its value, so the reset restores what was already there. The new order
 * arrives the same way it does everywhere else in E3 — the action revalidates
 * `/tree`, a fresh graph reaches the canvas, and this list re-renders in the
 * order it just asked for. That is the ticket's "visible in the tree
 * immediately", and it costs no optimistic state to get.
 *
 * ## Why the action arrives as a prop
 *
 * `app/tree/actions.ts` reaches Auth.js and `@/db`, and `npm test` runs with
 * no `AUTH_*` and no `DATABASE_URL` (docs/testing.md) — so a Client Component
 * that imports it cannot be mounted, and neither can the canvas that renders
 * it. See `ReorderUnionsFormAction`.
 */
export function UnionOrder({
  action,
  personId,
  spouses,
}: {
  action: ReorderUnionsFormAction;
  /** The person whose panel this is. Their unions are the ones being ordered. */
  personId: string;
  /**
   * Their unions, in the order the tree is currently showing them.
   *
   * `derivePersonDetail` has already sorted these by `sequence` and then by
   * date, which is the same rule `getFamilyGraph` queries by — so this list is
   * the order, rather than a list that needs sorting again here.
   */
  spouses: readonly SpouseLink[];
}) {
  const [state, formAction, pending] = useActionState(
    action,
    idleUnionOrderState,
  );

  // One union is not an order. Nought is not either.
  if (spouses.length < 2) return null;

  const last = spouses.length - 1;

  return (
    <section className="border-t border-rule-soft pt-3">
      <h3 className="text-note text-ink-muted">Order of unions</h3>
      <p className="text-caption text-ink-muted">
        For when the dates are unknown but the order is not.
      </p>

      <form action={formAction}>
        <input type="hidden" name="personId" value={personId} />
        {/*
          The order as rendered, one input per union. `lib/reorder-unions.ts`
          compares it against the rows it reads inside its own transaction, so
          a union added or removed in another tab is refused rather than
          silently reordered around.
        */}
        {spouses.map((spouse) => (
          <input
            key={spouse.unionId}
            type="hidden"
            name={ORDER_FIELD}
            value={spouse.unionId}
          />
        ))}

        <ol className="mt-2 space-y-1">
          {spouses.map((spouse, index) => {
            const name = spouse.person?.name ?? "an unrecorded partner";

            return (
              <li
                key={spouse.unionId}
                className="flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-caption">
                    {index + 1}. {spouse.person ? spouse.person.name : (
                      // Both partner columns are nullable so that an
                      // unrecorded partner never has to be invented as a
                      // placeholder person. The panel says so too.
                      <span className="text-ink-muted">Unknown partner</span>
                    )}
                  </p>
                  {describeSpan(spouse) ? (
                    <p className="text-note text-ink-muted">
                      {describeSpan(spouse)}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 gap-1">
                  <MoveButton
                    direction="up"
                    unionId={spouse.unionId}
                    label={`Move ${name} from position ${index + 1} earlier`}
                    glyph="↑"
                    disabled={pending || index === 0}
                  />
                  <MoveButton
                    direction="down"
                    unionId={spouse.unionId}
                    label={`Move ${name} from position ${index + 1} later`}
                    glyph="↓"
                    disabled={pending || index === last}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </form>

      {/*
        `role="alert"`, as `PersonRemoval` uses for the same job: this appears
        after a press the author is watching for, and it is the only thing on
        screen that changed — a refused move leaves the list exactly as it was.
      */}
      {state.status === "failed" ? (
        <p role="alert" className="mt-2 text-caption">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}

function MoveButton({
  direction,
  unionId,
  label,
  glyph,
  disabled,
}: {
  direction: "up" | "down";
  unionId: string;
  label: string;
  glyph: string;
  disabled: boolean;
}) {
  return (
    <button
      type="submit"
      name={MOVE_FIELD}
      value={formatMove(direction, unionId)}
      disabled={disabled}
      /*
        The arrow is decoration; the accessible name says which union moves,
        where it is now, and which way it goes. Without it a screen reader
        reads a column of "up, down, up, down" with nothing to distinguish one
        row's pair from the next.

        The position is in there rather than only the partner's name because
        the name does not always distinguish them: both partner columns are
        nullable, and a person with two unrecorded partners would otherwise
        get two buttons called "Move an unrecorded partner earlier". It is
        also the thing a reader most needs from a reorder control — where the
        row currently sits — and the visible list numbers each row for the
        same reason.
      */
      aria-label={label}
      className="rounded-panel border border-rule px-2 py-0.5 text-note hover:bg-wash disabled:opacity-40"
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

/**
 * The years, when there are any.
 *
 * Deliberately less than `PersonPanel`'s line about the same union: this is a
 * disambiguator for two rows in a reorder control, not a description of a
 * marriage. What identifies a union here is the partner, and the dates are
 * only there for the case the partner cannot settle — two unrecorded partners,
 * or the same person married twice.
 */
function describeSpan(spouse: SpouseLink): string {
  if (spouse.start && spouse.end) return `${spouse.start} – ${spouse.end}`;
  if (spouse.start) return spouse.start;
  return spouse.end ? `until ${spouse.end}` : "";
}
