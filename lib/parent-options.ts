import { unionsWithoutCycle } from "@/lib/ancestry";
import type { FamilyGraph, GraphUnion } from "@/lib/family-graph";
import { formatLifespan, formatPersonName } from "@/lib/person-format";

/**
 * The two lists the set-parents form is built out of (E3-T6, `YEO-34`).
 *
 * `lib/tree-layout.ts` is the model docs/testing.md points at: take a
 * `FamilyGraph`, return a value, and a test hands it a literal. Everything the
 * form *decides* is here — which families it may offer, which it must not, how
 * each one reads, and which one the person is currently recorded in — so the
 * component renders a value it did no reasoning to produce, and the interesting
 * cases are asserted with no document in sight.
 *
 * The graph is already in the browser for the layout, so this costs one pass
 * over it and no request. That is only true because the graph is small — a
 * family tree is hundreds of people at most (docs/architecture.md).
 *
 * ## Why the impossible families are left out rather than refused
 *
 * A picker that offers a family and then rejects it teaches the author nothing
 * except that the form is unreliable. Leaving it out is better, and it is the
 * same choice `AddChildForm` makes when it keeps a union's own partners out of
 * its child picker.
 *
 * It is emphatically *not* the enforcement. This runs against a graph the
 * browser loaded some time ago, and a union whose partner changed in another
 * tab in the meantime would walk straight through it. `lib/save-child.ts`
 * re-checks inside the transaction against a fresh read, which is the repo's
 * existing precedent (`lib/remove-from-tree.ts`, `lib/save-union.ts`) and the
 * only check that is load-bearing.
 */

/** One family, as it reads in a list of families to choose between. */
export type FamilyOption = {
  unionId: string;
  /**
   * Who the family is, in words: both parents, or the one who is recorded and
   * the honest fact that the other is not.
   */
  label: string;
};

export type ParentOptions = {
  /**
   * Families this person could be recorded as a child of — sorted by label,
   * because a list to search by eye is a list in an order the eye can use.
   */
  available: FamilyOption[];
  /**
   * Families that already record them as a child, which is what makes a move
   * possible rather than a delete followed by an add. More than one is a real
   * record — adopted into one family, born into another — so this is a list.
   */
  current: FamilyOption[];
};

/**
 * Read the set-parents form's two lists out of the graph.
 *
 * @param graph the whole tree, as the canvas already holds it
 * @param childId the person whose parents are being set
 * @returns the families they may be given, and the ones they already have
 */
export function parentOptions(
  graph: FamilyGraph,
  childId: string,
): ParentOptions {
  const names = new Map(
    graph.people.map((person) => [
      person.id,
      formatPersonName(person.givenName, person.surname),
    ]),
  );

  const lifespans = new Map(
    graph.people.map((person) => [
      person.id,
      formatLifespan(person.birthDate, person.deathDate),
    ]),
  );

  const label = (union: GraphUnion) =>
    familyLabel(union, (id) => {
      const name = names.get(id);
      if (name === undefined) return null;
      const lifespan = lifespans.get(id);
      return lifespan ? `${name} (${lifespan})` : name;
    });

  /**
   * Which families already hold them as a child. Read once into a set rather
   * than searched per union, and it does double duty: it is the `current` list,
   * and it is what keeps a family the author is already in out of the list of
   * families to move them into — where choosing it could only ever be refused
   * as `already-recorded`.
   */
  const recorded = new Set(
    graph.childLinks
      .filter((link) => link.childId === childId)
      .map((link) => link.unionId),
  );

  // One walk of the tree for the whole list; see `unionsWithoutCycle`. It also
  // rules out the families this person is a *partner* in, since somebody's own
  // union stands at or below them.
  const safe = unionsWithoutCycle(graph, childId);

  const available: FamilyOption[] = [];
  const current: FamilyOption[] = [];

  for (const union of graph.unions) {
    const option = { unionId: union.id, label: label(union) };
    if (recorded.has(union.id)) {
      current.push(option);
    } else if (safe.has(union.id)) {
      available.push(option);
    }
  }

  /**
   * Sorted by the words on screen rather than by `sequence`. Sequence orders
   * one person's marriages, which is exactly the question this list is not
   * asking — these are every family on the tree, and the only useful order for
   * that is the one somebody can scan.
   *
   * `localeCompare` so that accented names sort where a reader expects rather
   * than after Z, which is where a plain `<` puts them.
   */
  available.sort((a, b) => a.label.localeCompare(b.label));

  return { available, current };
}

/**
 * How one family reads: its parents, named.
 *
 * "and an unrecorded partner" rather than dropping the union or printing an
 * empty half. Both partner columns are nullable so that an unknown parent
 * never has to be invented as a placeholder person (docs/architecture.md), and
 * a family recording one parent is a perfectly good family to be a child of —
 * it is the ticket's own "one known parent and one unknown". A label that hid
 * that would make the case unenterable through the very flow that supports it.
 *
 * A union recording nobody keeps its own sentence. Such rows exist — E3-T8
 * clears partner columns, and `db/seed.ts` and E6-T2's import may write them —
 * and "an unrecorded family" is at least true, where "and" between two blanks
 * is not.
 *
 * @param union the family to describe
 * @param nameOf a person's name and years, or null if the graph lost them
 */
function familyLabel(
  union: GraphUnion,
  nameOf: (id: string) => string | null,
): string {
  const named = [union.partnerAId, union.partnerBId]
    .filter((id): id is string => id !== null)
    .map((id) => nameOf(id))
    .filter((name): name is string => name !== null);

  if (named.length === 0) return "An unrecorded family";
  if (named.length === 1) return `${named[0]} and an unrecorded partner`;
  return `${named[0]} and ${named[1]}`;
}
