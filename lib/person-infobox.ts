import type { FamilyGraph, GraphPerson, GraphUnion } from "./family-graph";
import { formatQualifiedYear } from "./format-date";
import {
  compareByBirth,
  compareUnions,
  derivePersonDetail,
  type SpouseLink,
} from "./person-detail";
import { formatPersonName } from "./person-format";

/**
 * The person infobox (E11-T5, `YEO-75`): the bordered summary box top right of
 * an article about somebody.
 *
 * ## It is generated, never typed
 *
 * This is the single biggest departure from Wikipedia in the project. On
 * Wikipedia an infobox is hand-written template markup — `{{Infobox person}}`
 * and thirty parameters — that the author maintains by hand and that drifts
 * out of step with the article above it within a few edits.
 *
 * Here every fact in the box already exists as a record: who partnered with
 * whom is `unions`, who was born into which union is `union_children`, and
 * when somebody lived is `individuals`. So the box is *derived at render
 * time* from those tables and nothing about it is stored. The author never
 * sees infobox markup, it cannot contradict the tree, and it updates itself
 * the moment somebody adds a spouse in E3-T4.
 *
 * That is a straight consequence of the No-Markdown principle in
 * docs/product.md: asking a non-technical author to maintain template syntax
 * would undo that principle in one step.
 *
 * ## Omit the row, never say "unknown"
 *
 * Every row here is absent when there is nothing to put in it. Rose has no
 * parents in the fixture, so the box has no Parents row at all — not "Parents:
 * unknown". In older generations most fields are missing, and a box that
 * rendered every absence would be mostly blanks with a name on top. The same
 * rule `formatQualifiedDate` states for a null date, applied to whole rows.
 *
 * ## Why the stepchild row is the argument in miniature
 *
 * Edward is Rose's stepchild because he belongs to Thomas's *earlier*
 * marriage. Nothing in the schema records that word anywhere — it falls out of
 * "a child of a union my spouse belongs to that I do not". No author would
 * maintain that by hand, and it changes the moment somebody edits a union.
 *
 * ## Why it is a plain function over a plain value
 *
 * The model docs/testing.md points at, and the one `lib/person-detail.ts`
 * already follows: take a `FamilyGraph`, return a value, and a test hands it a
 * literal. Half-siblings, a spouse's earlier marriage and a person whose birth
 * is known only to the year are exactly the cases that are hard to get right
 * and trivial to assert on. `components/PersonInfobox.tsx` then renders a
 * value it did no reasoning to produce, and `lib/entry-infobox.ts` is the one
 * piece that touches the database.
 *
 * ## What it reuses rather than rebuilds
 *
 * `derivePersonDetail` already reads spouses, children and parents out of the
 * graph for the tree's detail panel, in the order a life happened. This calls
 * it rather than walking the same edges a second time, and adds only the two
 * things the panel has no use for: the stepchild pass above, and each named
 * person's entry address so the box can link to them.
 */

/**
 * A person named in the box, and how to reach them.
 *
 * `slug` is null when the person has no entry — `individuals.page_id` is
 * empty, so no address for them has ever been written down. That is the
 * purest red link there is, and `entryLinkProps` in `lib/red-links.ts` takes
 * exactly this shape (see `EntryLinkTarget.slug`, which is nullable for this
 * reason).
 */
export type InfoboxPerson = {
  id: string;
  name: string;
  slug: string | null;
};

/** A birth or a death: whichever of the date and the place is recorded. */
export type InfoboxEvent = {
  /** Already qualified and cut to its precision — "about 1890", or null. */
  date: string | null;
  place: string | null;
};

/**
 * One marriage or partnership, from the subject's side of it.
 *
 * `detail` is the line under the name — "m. 1933; died 1947" — or null when
 * the union carries no date at all, which is common in the generations where
 * only the *order* of two marriages survives.
 */
export type InfoboxSpouse = {
  unionId: string;
  person: InfoboxPerson;
  detail: string | null;
};

/**
 * Everything the box shows, in the order it shows it.
 *
 * Empty arrays and null events are the "omit the row" instruction: the
 * component renders a row only where there is something in it, so this type
 * has no notion of a blank row to render.
 */
export type PersonInfobox = {
  /** The subject's `individuals.id`, for E2-T4's deep link back to the tree. */
  id: string;
  name: string;
  birth: InfoboxEvent | null;
  death: InfoboxEvent | null;
  spouses: InfoboxSpouse[];
  /**
   * The subject's own children, grouped by the union they arrived through in
   * the order those unions happened, and by birth within each — which is what
   * makes half-siblings read as the separate families they are.
   */
  children: InfoboxPerson[];
  /**
   * Derived, never stored — see the header.
   *
   * Ordered the way the Children row is, one level further out: by the spouse
   * they come through, then by that spouse's earlier families in the order
   * those happened, then by birth. A person with two spouses who each brought
   * children from an earlier marriage has two families here, not one list
   * interleaved by birthday.
   */
  stepchildren: InfoboxPerson[];
  parents: InfoboxPerson[];
};

/**
 * How many relatives a row names before it gives a number instead.
 *
 * Wikipedia's own `{{Infobox person}}` guidance, and the reference mockup
 * follows it: Rose's ten children are "10" rather than ten links. A family
 * wiki makes that the ordinary case rather than the exception — ten and
 * fourteen children are normal in the generations this is built for — and a
 * summary box holding fourteen names is a directory, not a summary. The
 * article's own Children section lists them all, with the union each belongs
 * to, which is the place that reading belongs.
 */
export const NAMED_RELATIVE_LIMIT = 5;

/**
 * Build the box for one person.
 *
 * @param graph the whole family, as `getFamilyGraph` returns it
 * @param personId the subject — the individual this entry is about
 * @param slugByPageId `pages.id` to `pages.slug`, for the people who have an
 *   entry; anybody missing from it is linked as a red link
 * @returns the box, or null for an id the graph does not hold
 */
export function derivePersonInfobox(
  graph: FamilyGraph,
  personId: string,
  slugByPageId: ReadonlyMap<string, string>,
): PersonInfobox | null {
  const detail = derivePersonDetail(graph, personId);
  if (!detail) return null;

  const byId = new Map(graph.people.map((person) => [person.id, person]));
  const unionById = new Map(graph.unions.map((union) => [union.id, union]));

  const named = (id: string): InfoboxPerson => {
    const person = byId.get(id);
    const pageId = person?.pageId ?? null;
    return {
      id,
      // The graph is the only place a name comes from, so a person the detail
      // knows about is always in it; the fallback is for the unreachable case
      // rather than a real one.
      name: person ? formatPersonName(person.givenName, person.surname) : "",
      slug: pageId === null ? null : (slugByPageId.get(pageId) ?? null),
    };
  };

  /**
   * A partner nobody recorded is dropped rather than rendered as a blank.
   * Both partner columns are nullable on purpose ("we know the mother, the
   * father is unknown"), and the detail panel says so in words — but a
   * *summary* row whose whole job is to name somebody has nothing to say when
   * there is nobody to name, and "Spouse: unknown" is the sentence this box
   * exists not to write.
   */
  const spouses: InfoboxSpouse[] = detail.spouses.flatMap((spouse) => {
    if (!spouse.person) return [];
    const union = unionById.get(spouse.unionId);
    return [
      {
        unionId: spouse.unionId,
        person: named(spouse.person.id),
        detail: union ? describeUnion(union) : null,
      },
    ];
  });

  /**
   * A child link recorded as `step` is a stepchild by the record itself,
   * rather than by the walk below — the author said so on the link. Both
   * arrive in the same row, which is what keeps "stepchild" one idea on the
   * page instead of two that happen to be spelled the same.
   */
  const ownChildren = detail.children.filter(
    (child) => child.relation !== "step",
  );
  const statedStepchildren = detail.children.filter(
    (child) => child.relation === "step",
  );

  const children = dedupe(
    ownChildren.map((child) => named(child.person.id)),
    new Set(),
  );
  const claimed = new Set(children.map((child) => child.id));
  // The subject is not their own stepchild, however the rows are arranged.
  claimed.add(personId);

  const stepchildren = dedupe(
    [
      ...statedStepchildren.map((child) => named(child.person.id)),
      ...derivedStepchildren(graph, detail.spouses, byId).map((child) =>
        named(child.id),
      ),
    ],
    claimed,
  );

  const parents = dedupe(
    detail.parents.map((parent) => named(parent.person.id)),
    new Set(),
  );

  return {
    id: detail.id,
    name: detail.name,
    birth: detail.birth,
    death: detail.death,
    spouses,
    children,
    stepchildren,
    parents,
  };
}

/**
 * Every entry the box links to.
 *
 * Handed to the article route so the infobox's slugs join the body's in the
 * **one** `findExistingSlugs` call that render already makes, rather than
 * adding a second query. `entryLinkProps` then decides blue or red for the
 * body and the box from the same set, so the two cannot disagree about
 * whether an entry exists.
 *
 * @param infobox the box, or null when the entry is not about a person
 * @returns the slugs it names, each once; empty when there is no box
 */
export function infoboxEntrySlugs(
  infobox: PersonInfobox | null | undefined,
): Set<string> {
  const slugs = new Set<string>();
  if (!infobox) return slugs;

  for (const person of namedPeople(infobox)) {
    if (person.slug !== null) slugs.add(person.slug);
  }

  return slugs;
}

/** Everyone the box puts a link on, in no particular order. */
function namedPeople(infobox: PersonInfobox): InfoboxPerson[] {
  return [
    ...infobox.spouses.map((spouse) => spouse.person),
    ...infobox.children,
    ...infobox.stepchildren,
    ...infobox.parents,
  ];
}

/**
 * The children of a spouse's *other* unions.
 *
 * The whole of the stepchild derivation, and the reason this box cannot be
 * hand-written: Edward belongs to Thomas's first marriage, Rose belongs to his
 * second, and nothing anywhere records the word "stepchild". Walk one edge
 * past the spouse and it falls out — and it stops being true the moment
 * somebody corrects the union, which is exactly what a stored copy could not
 * do.
 *
 * Unions the subject belongs to are skipped: those hold their own children,
 * which the Children row already has.
 *
 * ## Why it walks spouse by spouse rather than gathering and sorting
 *
 * A flat sort by birth date would be shorter, and it would interleave two
 * unrelated families for anyone who married twice and whose *both* spouses
 * brought children. That is the same mistake the Children row exists not to
 * make — half-siblings read as the separate families they are because they are
 * grouped by the union they arrived through. One hop further out the grouping
 * is the spouse, then that spouse's earlier families in the order they
 * happened, then birth order inside each. `dedupe` at the call site handles
 * the child who is reachable twice.
 */
function derivedStepchildren(
  graph: FamilyGraph,
  spouses: readonly SpouseLink[],
  byId: ReadonlyMap<string, GraphPerson>,
): GraphPerson[] {
  const ownUnionIds = new Set(spouses.map((spouse) => spouse.unionId));

  const childrenOfUnion = new Map<string, GraphPerson[]>();
  for (const link of graph.childLinks) {
    const child = byId.get(link.childId);
    if (!child) continue;
    const existing = childrenOfUnion.get(link.unionId);
    if (existing) existing.push(child);
    else childrenOfUnion.set(link.unionId, [child]);
  }

  return spouses.flatMap((spouse) => {
    if (!spouse.person) return [];
    const spouseId = spouse.person.id;

    return graph.unions
      .filter(
        (union) =>
          !ownUnionIds.has(union.id) &&
          (union.partnerAId === spouseId || union.partnerBId === spouseId),
      )
      .sort(compareUnions)
      .flatMap((union) =>
        [...(childrenOfUnion.get(union.id) ?? [])].sort(compareByBirth),
      );
  });
}

/**
 * The line under a spouse's name: when the union started, and how it ended.
 *
 * Years rather than full dates, which is Wikipedia's own form and what the
 * reference mockup shows — the row is a summary beside a name, and "m. 11
 * February 1933; died 11 June 1947" is a record. `formatQualifiedYear` keeps
 * the qualifier on the way down, so a marriage remembered as "about 1948"
 * does not quietly become a stated one.
 *
 * The end clause needs a year to say anything useful, so a union recorded as
 * ended with no end date shows only its start. "m. 1933; divorced" would be
 * true, but the row is a date line and a dateless clause reads as a formatting
 * fault rather than as a fact.
 */
function describeUnion(union: GraphUnion): string | null {
  const start = formatQualifiedYear(union.startDate, union.startDateQualifier);
  const end = formatQualifiedYear(union.endDate, union.endDateQualifier);

  const started = start === null ? null : `${UNION_PREFIX[union.type]}${start}`;
  const ended =
    end === null || union.endReason === "ongoing"
      ? null
      : `${END_VERB[union.endReason]} ${end}`;

  if (started && ended) return `${started}; ${ended}`;
  return started ?? ended ?? null;
}

/**
 * How a union's start year is introduced. `m.` is the abbreviation Wikipedia
 * uses and every reader of one already knows; a partnership was not a
 * marriage and should not borrow the word for it.
 */
const UNION_PREFIX: Record<GraphUnion["type"], string> = {
  marriage: "m. ",
  partnership: "from ",
  unknown: "from ",
};

/** How a union ended, in the fewest words that stay true. */
const END_VERB: Record<Exclude<GraphUnion["endReason"], "ongoing">, string> = {
  death: "died",
  divorce: "div.",
  separation: "sep.",
  unknown: "ended",
};

/**
 * Keep the first mention of each person and drop the rest.
 *
 * A person can appear twice honestly — adopted into one union and born into
 * another puts the same parent on two links — and a summary box that named
 * them twice would read as two people with the same name.
 */
function dedupe(
  people: InfoboxPerson[],
  exclude: ReadonlySet<string>,
): InfoboxPerson[] {
  const seen = new Set(exclude);
  return people.filter((person) => {
    if (seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
}
