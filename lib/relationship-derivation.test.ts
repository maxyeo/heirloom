import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { seedFamily, seedPerson, seedUnion } from "@/db/seed-family";
import * as schema from "@/db/schema";
// `import type` matters: lib/family-graph.ts imports @/db, and taking only the
// type erases the import entirely, which is what keeps this file runnable with
// no database and therefore runnable in CI. See docs/testing.md.
import type { FamilyGraph, GraphChildLink } from "@/lib/family-graph";
import { derivePersonDetail } from "@/lib/person-detail";
import { derivePersonInfobox } from "@/lib/person-infobox";
import {
  bloodOnly,
  parentsOf,
  relativesOf,
  siblingKind,
  type SiblingKind,
  stepParentsOf,
} from "@/test/relationship-kinds";

/**
 * Relationship derivation (E10-T4, `YEO-68`).
 *
 * ## The claim being tested
 *
 * docs/architecture.md rests the whole data model on one sentence: a *union*
 * is a first-class entity, so "spouse", "parent", "half-sibling" and
 * "step-mother" are **read back out of** two tables rather than written into a
 * third. `db/schema.ts` states the consequence — `person.parent_id` collapses
 * on real families — and `lib/person-detail.ts` and `lib/person-infobox.ts`
 * both open by repeating it.
 *
 * That claim has an edge no other test in here touches: it says you never
 * have to *anticipate* a relationship type, because you never store one. A
 * model that stored labels would need a migration the first time somebody
 * asked who Edward's step-siblings are. This file asks four questions the
 * application has never been asked — half-sibling, step-parent, step-sibling,
 * blood relation — and answers all four from the seeded rows with no new
 * column, no new enum member, and no change to the schema at all.
 *
 * The four walks are `test/relationship-kinds.ts`, which explains why they
 * live in `test/` rather than in `lib/`. Where the application already
 * derives one of them for real — `derivePersonDetail`'s per-union grouping,
 * `derivePersonInfobox`'s stepchild pass, `descendantsOrSelf` — the walk is
 * built on that code rather than on a private copy of it, so this stays a
 * guard on query code as it accumulates rather than a proof about itself.
 *
 * ## The fixture is the seed
 *
 * `db/seed.ts`, rebuilt as a literal, because it is the shape that breaks
 * naive models:
 *
 *              [Agnes]══(u0)══[ ? ]
 *                         │
 *   [Mary]══(u1)══[Thomas]══(u2)══[Rose]══(u3)══[Walter]
 *             │              │              │
 *          Edward     Clara*, Arthur    8 Shaw children     (* adopted)
 *
 * Every criterion in the ticket is a question about that diagram:
 *
 * - Edward and Clara are half-siblings through Thomas; Clara and Ruth are
 *   half-siblings through Rose — **both sides of the chain**.
 * - Rose is Edward's step-mother and Thomas is the Shaws' step-father, and no
 *   row anywhere says so.
 * - Edward and the eight Shaws **share no parent at all** and are no blood
 *   relation; the only thing joining them is u2, two remarriages away.
 * - Clara and Arthur are the only people related to both ends.
 * - Clara is adopted, and none of the above changes because of it.
 *
 * It is a third seed-shaped literal, after `lib/person-detail.test.ts` and
 * `lib/person-infobox.test.ts`, and it follows those two rather than sharing
 * with them: each of the three carries the fields its own subject reads, and
 * this one is the only one that needs all eleven children present at once.
 */

/** Mary and Thomas's only child. */
const FIRST_HALE = ["edward"];

/** Rose and Thomas's children — the pair in the middle of the chain. */
const SECOND_HALE = ["clara", "arthur"];

/** Rose and Walter's eight. */
const SHAWS = [
  "ruth",
  "harold",
  "doris",
  "frank",
  "vera",
  "leonard",
  "joyce",
  "stanley",
];

/**
 * The seeded family, with its uuids swapped for the names this file reads by.
 *
 * The rows come from `db/seed-family.ts` — the same value `db/seed.ts` writes
 * and `lib/tree-layout.seed.test.ts` lays out — so there is no second copy of
 * the family here to drift away from the first. That mattered enough to
 * extract: `db/seed-family.ts` exists because `lib/tree-layout.test.ts` had
 * been asserting over a literal that called itself the seed and had quietly
 * stopped being it, and "nothing was wrong with the test; it was simply not
 * testing what it said it was, and no run could report that" is the failure
 * this file would otherwise be the fourth instance of.
 *
 * Only the identifiers are rewritten. Every date, qualifier, precision, sex,
 * union type, end reason, sequence and child relation is the seed's own, so a
 * change to the seeded family reaches these assertions rather than passing
 * them by. The names are worth the remap because the questions here are about
 * people rather than about rows: `siblingKind(graph, "edward", "clara")` is
 * the claim being made, and the uuid spelling of it is not.
 */
function seedGraph(): FamilyGraph {
  const named = new Map<string, string>([
    ...Object.entries(seedPerson).map(
      ([name, person]) => [person.id, name] as const,
    ),
    ...Object.entries(seedUnion).map(
      ([name, union]) => [union.id, name] as const,
    ),
  ]);

  /** Every id in the fixture is one of the two maps above; a miss is a bug. */
  const rename = (id: string): string => {
    const name = named.get(id);
    if (name === undefined) throw new Error(`seedGraph: unnamed id "${id}"`);
    return name;
  };
  const renameOrNull = (id: string | null) => (id === null ? null : rename(id));

  return {
    people: seedFamily.people.map((person) => ({
      ...person,
      id: rename(person.id),
      // The entry id is a page, not a person, and nothing here reads it.
      pageId: person.pageId === null ? null : "page-thomas",
    })),
    unions: seedFamily.unions.map((union) => ({
      ...union,
      id: rename(union.id),
      partnerAId: renameOrNull(union.partnerAId),
      partnerBId: renameOrNull(union.partnerBId),
    })),
    childLinks: seedFamily.childLinks.map((link) => ({
      unionId: rename(link.unionId),
      childId: rename(link.childId),
      relation: link.relation,
    })),
  };
}

// ---------------------------------------------------------------------------
// Half-siblings, both sides of the chain
// ---------------------------------------------------------------------------

describe("half-siblings, on both sides of the remarriage chain", () => {
  it("derives Edward and the second Hales as half-siblings through Thomas", () => {
    const graph = seedGraph();

    for (const id of SECOND_HALE) {
      expect(siblingKind(graph, "edward", id)).toBe("half");
      expect(shared(parentsOf(graph, "edward"), parentsOf(graph, id))).toEqual([
        "thomas",
      ]);
    }
  });

  it("derives the Shaws and the second Hales as half-siblings through Rose", () => {
    const graph = seedGraph();

    for (const shawId of SHAWS) {
      for (const id of SECOND_HALE) {
        expect(siblingKind(graph, shawId, id)).toBe("half");
        expect(shared(parentsOf(graph, shawId), parentsOf(graph, id))).toEqual([
          "rose",
        ]);
      }
    }
  });

  it("keeps each marriage's own children full siblings", () => {
    const graph = seedGraph();

    expect(siblingKind(graph, "clara", "arthur")).toBe("full");
    expect(siblingKind(graph, "ruth", "stanley")).toBe("full");
  });

  /**
   * The enumerated form of the three tests above, in the idiom
   * `app/auth-boundary.test.ts` argues for: a relationship test that names its
   * pairs covers the pairs somebody thought of, and would be green on the day
   * it mattered. This classifies **every** pair in the family, so a derivation
   * that quietly promoted step-siblings to half-siblings — the plausible
   * failure, since both are a hop through a union — fails here on the pair
   * nobody listed.
   *
   * The expectation is generated from the three families rather than written
   * out as 120 lines, so what it says is "these are the families", which is
   * the claim a reader can check against the diagram at the top of the file.
   */
  it("classifies every pair in the family, and the matrix is the chain", () => {
    const graph = seedGraph();
    const ids = graph.people.map((p) => p.id);

    const found: Record<SiblingKind, string[]> = {
      full: [],
      half: [],
      step: [],
      none: [],
    };
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        found[siblingKind(graph, ids[i], ids[j])].push(pair(ids[i], ids[j]));
      }
    }

    expect(found.full.sort()).toEqual(
      [...within(SECOND_HALE), ...within(SHAWS)].sort(),
    );
    expect(found.half.sort()).toEqual(
      [
        ...across(FIRST_HALE, SECOND_HALE),
        ...across(SECOND_HALE, SHAWS),
      ].sort(),
    );
    expect(found.step.sort()).toEqual(across(FIRST_HALE, SHAWS).sort());

    // Nobody is quietly left out: the four buckets account for every pair.
    const pairs = (ids.length * (ids.length - 1)) / 2;
    expect(
      found.full.length +
        found.half.length +
        found.step.length +
        found.none.length,
    ).toBe(pairs);
  });

  /**
   * The production half of the same fact. Nothing in `PersonDetail` says
   * "half-sibling", and nothing needs to: the children are grouped by the
   * union they arrived through and carry the other parent, which is the only
   * thing that distinguishes eleven children from three families of them.
   */
  it("is legible in the panel, from both parents' sides", () => {
    const thomas = detailFor("thomas");
    expect(
      thomas.children.map((c) => [
        c.person.name,
        c.unionId,
        c.otherParent?.name,
      ]),
    ).toEqual([
      ["Edward Hale", "u1", "Mary Ellis"],
      ["Clara Hale", "u2", "Rose Bennett"],
      ["Arthur Hale", "u2", "Rose Bennett"],
    ]);

    const rose = detailFor("rose");
    expect(
      rose.children.map((c) => [c.person.name, c.unionId, c.otherParent?.name]),
    ).toEqual([
      ["Clara Hale", "u2", "Thomas Hale"],
      ["Arthur Hale", "u2", "Thomas Hale"],
      ["Ruth Shaw", "u3", "Walter Shaw"],
      ["Harold Shaw", "u3", "Walter Shaw"],
      ["Doris Shaw", "u3", "Walter Shaw"],
      ["Frank Shaw", "u3", "Walter Shaw"],
      ["Vera Shaw", "u3", "Walter Shaw"],
      ["Leonard Shaw", "u3", "Walter Shaw"],
      ["Joyce Shaw", "u3", "Walter Shaw"],
      ["Stanley Shaw", "u3", "Walter Shaw"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Step-parents
// ---------------------------------------------------------------------------

describe("step-parents, derived and never stored", () => {
  it("makes Rose Edward's step-mother and Thomas the Shaws' step-father", () => {
    const graph = seedGraph();

    expect(sorted(stepParentsOf(graph, "edward"))).toEqual(["rose"]);
    for (const shawId of SHAWS) {
      expect(sorted(stepParentsOf(graph, shawId))).toEqual(["thomas"]);
    }
  });

  it("gives the children in the middle a step-parent on each side", () => {
    const graph = seedGraph();

    for (const id of SECOND_HALE) {
      expect(sorted(stepParentsOf(graph, id))).toEqual(["mary", "walter"]);
    }
  });

  it("never mistakes a parent, or the person themselves, for a step-parent", () => {
    const graph = seedGraph();

    for (const person of graph.people) {
      const steps = stepParentsOf(graph, person.id);
      for (const parentId of parentsOf(graph, person.id)) {
        expect(steps.has(parentId)).toBe(false);
      }
      expect(steps.has(person.id)).toBe(false);
    }
  });

  /**
   * The "never stored" half, stated as a fact about the rows rather than
   * about the walk: Rose and Edward appear together in **no** row at all —
   * not a union, not a child link — and the label holds anyway.
   */
  it("holds although no row names the pair", () => {
    const graph = seedGraph();

    const unionsNamingBoth = graph.unions.filter((u) => {
      const partners = [u.partnerAId, u.partnerBId];
      return partners.includes("rose") && partners.includes("edward");
    });
    const rosesUnions = graph.unions
      .filter((u) => [u.partnerAId, u.partnerBId].includes("rose"))
      .map((u) => u.id);
    const linksNamingBoth = graph.childLinks.filter(
      (link) => link.childId === "edward" && rosesUnions.includes(link.unionId),
    );

    expect([...unionsNamingBoth, ...linksNamingBoth]).toEqual([]);
    expect(stepParentsOf(graph, "edward").has("rose")).toBe(true);
  });

  it("is not the `step` child relation in disguise", () => {
    const graph = seedGraph();

    // `child_relation` *can* record a stepchild directly, and the seeded
    // family never does. Every step-parent above comes out of remarriage
    // alone.
    expect(graph.childLinks.some((link) => link.relation === "step")).toBe(
      false,
    );
  });

  /**
   * The reciprocity check, and the only cross-check available for this one:
   * `derivePersonInfobox` derives *stepchildren*, walking the same
   * relationship from the parent's end — a child of a union my spouse belongs
   * to that I do not — and nothing in the application walks it from the
   * child's end at all. The two directions have to name the same pairs.
   */
  it("agrees with the infobox's stepchildren, in both directions", () => {
    const graph = seedGraph();

    for (const [parentId, expected] of [
      ["rose", FIRST_HALE],
      ["thomas", SHAWS],
      // Both ends of the chain have stepchildren too, and Mary's are
      // stepchildren of a marriage that began two years after she died. The
      // model has no opinion about that, which is the correct amount of
      // opinion for it to have: it records what was written down.
      ["mary", SECOND_HALE],
      ["walter", SECOND_HALE],
    ] as const) {
      const box = derivePersonInfobox(graph, parentId, new Map(), null);
      expect(box?.stepchildren.map((p) => p.id)).toEqual(expected);

      for (const stepchildId of expected) {
        expect(stepParentsOf(graph, stepchildId).has(parentId)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The two ends of the chain
// ---------------------------------------------------------------------------

describe("the two ends of the chain", () => {
  it("gives Edward and the Shaws no parent in common", () => {
    const graph = seedGraph();
    const edwardsParents = parentsOf(graph, "edward");

    expect(sorted(edwardsParents)).toEqual(["mary", "thomas"]);
    for (const shawId of SHAWS) {
      expect(sorted(parentsOf(graph, shawId))).toEqual(["rose", "walter"]);
      expect(shared(edwardsParents, parentsOf(graph, shawId))).toEqual([]);
    }
  });

  it("makes them no blood relation, only step-siblings", () => {
    const graph = seedGraph();
    const edwardsRelatives = relativesOf(graph, "edward");

    for (const shawId of SHAWS) {
      expect(edwardsRelatives.has(shawId)).toBe(false);
      expect(relativesOf(graph, shawId).has("edward")).toBe(false);
      expect(siblingKind(graph, "edward", shawId)).toBe("step");
    }
  });

  it("connects them anyway, through the chain of remarriages", () => {
    const graph = seedGraph();

    // Two hops and nothing else: Edward's step-mother is the Shaws' mother.
    const bridge = shared(
      stepParentsOf(graph, "edward"),
      new Set(SHAWS.flatMap((id) => [...parentsOf(graph, id)])),
    );
    expect(bridge).toEqual(["rose"]);
  });

  /**
   * "The only people related to both ends" is a claim about everybody, so it
   * is asked of everybody rather than of the two children it is expected to
   * name — and asked once per Shaw, because eight children of one union are
   * eight chances for a walk to reach the wrong end.
   */
  it("leaves the middle marriage's children the only relation of both ends", () => {
    const graph = seedGraph();
    const relatedToEdward = relativesOf(graph, "edward");

    for (const shawId of SHAWS) {
      const relatedToShaw = relativesOf(graph, shawId);
      const both = graph.people
        .map((p) => p.id)
        .filter((id) => relatedToEdward.has(id) && relatedToShaw.has(id));
      expect(both.sort()).toEqual([...SECOND_HALE].sort());
    }
  });

  it("names the line each end does belong to", () => {
    const graph = seedGraph();

    expect(sorted(relativesOf(graph, "edward"))).toEqual([
      "agnes",
      "arthur",
      "clara",
      "mary",
      "thomas",
    ]);
    expect(sorted(relativesOf(graph, "ruth"))).toEqual(
      [
        "arthur",
        "clara",
        "rose",
        "walter",
        ...SHAWS.filter((id) => id !== "ruth"),
      ].sort(),
    );
  });

  /**
   * The same question over birth links only. Clara joined u2 by adoption, so
   * she drops out of a *blood* answer and stays in every structural one — and
   * that took filtering rows, not storing a second kind of relation. This is
   * the whole ticket in one test: a question nobody anticipated, answered
   * without a migration.
   */
  it("narrows to Arthur alone when only birth links count", () => {
    const graph = bloodOnly(seedGraph());
    const relatedToEdward = relativesOf(graph, "edward");

    for (const shawId of SHAWS) {
      const relatedToShaw = relativesOf(graph, shawId);
      expect(
        graph.people
          .map((p) => p.id)
          .filter((id) => relatedToEdward.has(id) && relatedToShaw.has(id)),
      ).toEqual(["arthur"]);
    }

    expect(relatedToEdward.has("clara")).toBe(false);
    expect(siblingKind(graph, "clara", "arthur")).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Adoption and fostering
// ---------------------------------------------------------------------------

describe("adoption and fostering leave the structure alone", () => {
  /**
   * Everything this file derives, for everybody, as one comparable value.
   * Both the test's own walks and the application's are in it, so a
   * `relation` value that reached either one shows up here as a diff rather
   * than as a missing assertion.
   */
  function structure(graph: FamilyGraph) {
    const ids = graph.people.map((p) => p.id);
    return ids.map((id) => {
      const detail = derivePersonDetail(graph, id);
      return {
        id,
        parents: sorted(parentsOf(graph, id)),
        stepParents: sorted(stepParentsOf(graph, id)),
        relatives: sorted(relativesOf(graph, id)),
        siblings: ids
          .filter((other) => other !== id)
          .map((other) => [other, siblingKind(graph, id, other)]),
        // The application's own derivation, minus the relation itself.
        panelParents: detail?.parents.map((p) => [p.person.id, p.unionId]),
        panelChildren: detail?.children.map((c) => [c.person.id, c.unionId]),
        stepchildren: derivePersonInfobox(
          graph,
          id,
          new Map(),
          null,
        )?.stepchildren.map((p) => p.id),
      };
    });
  }

  /** The same family, with one child recorded as having arrived differently. */
  function withRelation(
    graph: FamilyGraph,
    childId: string,
    relation: GraphChildLink["relation"],
  ): FamilyGraph {
    return {
      ...graph,
      childLinks: graph.childLinks.map((link) =>
        link.childId === childId ? { ...link, relation } : link,
      ),
    };
  }

  /**
   * `child_relation`, split by what each value is actually saying.
   *
   * Three of them answer *how this child arrived in this family* — born,
   * adopted, fostered — and none of them is a relationship: they say nothing
   * about who anybody is to anybody else, so nothing derived may move when
   * one is edited. `step` is the odd one out and is handled below.
   *
   * Read from `db/schema.ts` rather than retyped, so a fifth value lands in
   * the sweep on the day it is added — and this assertion is what forces
   * somebody to decide which side of the split it belongs on rather than
   * letting it arrive silently.
   */
  it("has one enum, and two kinds of value in it", () => {
    expect(schema.childRelation.enumValues).toEqual([
      "biological",
      "adopted",
      "step",
      "foster",
    ]);
  });

  const arrivals = schema.childRelation.enumValues.filter(
    (relation) => relation !== "step",
  );

  /**
   * One link at a time rather than all of them at once: a graph in which
   * every link is `foster` is not a family anybody could record, and a test
   * that only ever asserts about impossible graphs has stopped describing the
   * application. The four children swept are four different positions in the
   * chain — an only child, both of the middle pair, and one of eight.
   */
  it.each(arrivals)(
    "derives the same family when a child arrived by `%s`",
    (relation) => {
      const baseline = structure(seedGraph());

      for (const childId of ["edward", "clara", "arthur", "ruth"]) {
        expect(structure(withRelation(seedGraph(), childId, relation))).toEqual(
          baseline,
        );
      }
    },
  );

  /**
   * `step` is the one value that records a *relationship* rather than an
   * arrival, and `lib/person-infobox.ts` reads it as one — a link marked
   * `step` is a stepchild by the record itself, without any remarriage to
   * derive it from.
   *
   * It is the single exception to this file's claim, and it does not behave
   * like the three above: those say a union raised this child, so nothing
   * derived may move. `step` says the union did *not*, so things must move.
   * Replacing Edward's only link with a `step` one does not annotate his
   * parentage, it removes it — he becomes Thomas and Mary's stepson and
   * nobody's son, which is what the record now says.
   *
   * Asserted in both directions, because a relationship that disagrees with
   * itself depending on which end it is read from is the failure worth
   * guarding here: the infobox calls him their stepchild, and the walk from
   * his end calls them his step-parents.
   */
  it("treats a `step` link as a record rather than as an arrival", () => {
    const stated = withRelation(seedGraph(), "edward", "step");

    expect(
      derivePersonInfobox(stated, "thomas", new Map(), null)?.stepchildren.map(
        (p) => p.id,
      ),
    ).toEqual(["edward", ...SHAWS]);
    expect(stepParentsOf(stated, "edward")).toEqual(
      new Set(["thomas", "mary"]),
    );

    // And the parentage the link no longer claims is gone with it.
    expect(parentsOf(stated, "edward")).toEqual(new Set());
    expect(siblingKind(stated, "edward", "clara")).toBe("none");
  });

  /**
   * The case the application actually produces, which the one above cannot
   * reach: `lib/child-input.ts` lets an *existing* person be attached to a
   * second union, so a `step` link normally sits *beside* a birth link rather
   * than replacing it. Edward keeps his parents and gains a stepmother.
   *
   * Read as an arrival, the added row would make Rose his parent — which
   * then hides her from his step-parents, because a parent cannot be one,
   * and makes her own children his full siblings rather than his half. All
   * three are checked here and in `test/relationship-kinds.test.ts`.
   */
  it("adds a stepmother without disturbing a parentage already recorded", () => {
    const base = seedGraph();
    const stated: FamilyGraph = {
      ...base,
      childLinks: [
        ...base.childLinks,
        { unionId: "u2", childId: "edward", relation: "step" },
      ],
    };

    expect(parentsOf(stated, "edward")).toEqual(new Set(["mary", "thomas"]));
    expect(stepParentsOf(stated, "edward")).toEqual(new Set(["rose"]));
    expect(siblingKind(stated, "edward", "clara")).toBe("half");
    expect(siblingKind(stated, "edward", "ruth")).toBe("step");
  });

  it("leaves the seeded family unchanged by Clara's adoption", () => {
    const asRecorded = structure(seedGraph());
    const asIfBorn = structure(
      withRelation(seedGraph(), "clara", "biological"),
    );

    expect(asRecorded).toEqual(asIfBorn);
  });

  /**
   * The other direction, so the sweep above cannot be satisfied by a
   * derivation that has stopped reading `relation` at all: the value is
   * recorded, it does reach the panel, and it is simply not what any of these
   * relationships are made of.
   */
  it("still reports how each child arrived", () => {
    const clara = detailFor("clara");
    expect(clara.parents.map((p) => [p.person.id, p.relation])).toEqual([
      ["rose", "adopted"],
      ["thomas", "adopted"],
    ]);

    const arthur = detailFor("arthur");
    expect(arthur.parents.map((p) => p.relation)).toEqual([
      "biological",
      "biological",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The schema itself
// ---------------------------------------------------------------------------

/**
 * The tripwire under all of the above, in the shape
 * `lib/sanitize-html.call-sites.test.ts` and `app/auth-boundary.test.ts` use:
 * enumerate rather than list, so the failure arrives with the change that
 * causes it rather than whenever somebody next remembers this file.
 *
 * Every derivation above is only *possible* because a person row points at no
 * other person — people meet through a union and nowhere else. A `mother_id`
 * on `individuals`, or a `siblings` table, would be the first stored
 * relationship in the model, and would give the schema a second answer to
 * every question this file asks. That is the edit this guards, and it is
 * exactly the edit that looks harmless in a diff.
 *
 * The three references it does allow are named rather than pattern-matched,
 * because each one is the model rather than an exception to it: a union names
 * its two partners, and a child link names the child. Widening the list is an
 * edit a reviewer sees.
 */
describe("the schema stores no relationship", () => {
  // `db/schema.ts` exports tables, enums and Drizzle `relations` side by side,
  // and only the tables answer this question. `is` is Drizzle's own guard, so
  // the filter narrows rather than asserts.
  const tables = Object.values(schema).flatMap((value) =>
    is(value, PgTable) ? [getTableConfig(value)] : [],
  );

  it("finds tables to check at all", () => {
    // Guards the enumeration itself: a `schema` that stopped exporting tables
    // the way this reads them would make every assertion below vacuously true.
    expect(tables.map((t) => t.name).sort()).toEqual([
      "gedcom_imports",
      "individuals",
      "pages",
      "revisions",
      "union_children",
      "unions",
    ]);
  });

  it("has every reference to a person coming from a union", () => {
    const references = tables.flatMap((table) =>
      table.foreignKeys.flatMap((fk) => {
        const ref = fk.reference();
        return getTableConfig(ref.foreignTable).name === "individuals"
          ? [`${table.name}.${ref.columns.map((c) => c.name).join("+")}`]
          : [];
      }),
    );

    expect(references.sort()).toEqual([
      "union_children.child_id",
      "unions.partner_a_id",
      "unions.partner_b_id",
    ]);
  });

  it("has a person pointing at nobody but their own entry and the import that wrote them", () => {
    // `import_id -> gedcom_imports` (`YEO-89`) is provenance, not a
    // relationship between people: it says *which file* wrote this row, never
    // who this person is related to. It is named here rather than left to
    // break this guard silently, the same way `page_id -> pages` already is —
    // a third reference that pointed at another `individuals` row, by
    // contrast, is exactly the edit this file exists to catch.
    const individuals = tables.find((t) => t.name === "individuals");

    expect(
      individuals?.foreignKeys.map((fk) => {
        const ref = fk.reference();
        const target = getTableConfig(ref.foreignTable).name;
        return `${ref.columns.map((c) => c.name).join("+")} -> ${target}`;
      }),
    ).toEqual(["page_id -> pages", "import_id -> gedcom_imports"]);
  });
});

// ---------------------------------------------------------------------------
// Fixture builders and small helpers
// ---------------------------------------------------------------------------

function detailFor(id: string) {
  const detail = derivePersonDetail(seedGraph(), id);
  if (detail === null) throw new Error(`no detail derived for "${id}"`);
  return detail;
}

const sorted = (ids: Set<string>) => [...ids].sort();

const shared = (a: Set<string>, b: Set<string>) =>
  [...a].filter((id) => b.has(id)).sort();

/** An unordered pair, written the same way whichever end it is asked from. */
const pair = (a: string, b: string) => [a, b].sort().join("|");

const within = (ids: string[]) =>
  ids.flatMap((a, i) => ids.slice(i + 1).map((b) => pair(a, b)));

const across = (left: string[], right: string[]) =>
  left.flatMap((a) => right.map((b) => pair(a, b)));
