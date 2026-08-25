import { describe, expect, it } from "vitest";

import type { FamilyGraph, GraphChildLink } from "@/lib/family-graph";
import {
  bloodOnly,
  parentsOf,
  relativesOf,
  siblingKind,
  stepParentsOf,
} from "@/test/relationship-kinds";

/**
 * The classifiers' own tests, for the reason
 * `test/route-inventory.boundary-usage.test.ts` gives about the auth
 * boundary's checker: the suite that uses them
 * (`lib/relationship-derivation.test.ts`) runs them over one family, and one
 * family cannot reach every branch.
 *
 * Two branches in particular exist to *prevent* a wrong answer rather than to
 * produce one, and both are invisible in the seeded family: a union with a
 * single recorded partner, and a union with none. Left untested they would be
 * code only a mutation run had ever executed — and the failure they guard
 * against is a false "half-sibling", which reads plausibly enough that it
 * would be believed.
 *
 * The graphs here are four or five people each, built to isolate one question.
 */

describe("siblingKind", () => {
  it("calls two children of the same union full siblings", () => {
    const graph = family({
      unions: [["u", "ann", "bob"]],
      children: [
        ["u", "kim"],
        ["u", "lee"],
      ],
    });

    expect(siblingKind(graph, "kim", "lee")).toBe("full");
  });

  /**
   * The branch counting shared parents gets wrong. `db/schema.ts` calls a
   * union with one partner recorded and the other unknown extremely common,
   * and `db/seed.ts` has one: these two share every parent anybody wrote
   * down, and "shares one parent" would demote them on the strength of a
   * blank column.
   */
  it("calls them full siblings although only one parent is recorded", () => {
    const graph = family({
      unions: [["u", "ann", null]],
      children: [
        ["u", "kim"],
        ["u", "lee"],
      ],
    });

    expect(parentsOf(graph, "kim")).toEqual(new Set(["ann"]));
    expect(siblingKind(graph, "kim", "lee")).toBe("full");
  });

  /** And with neither recorded, which is why the union is read from the rows. */
  it("calls them full siblings although neither parent is recorded", () => {
    const graph = family({
      unions: [["u", null, null]],
      children: [
        ["u", "kim"],
        ["u", "lee"],
      ],
    });

    expect(parentsOf(graph, "kim")).toEqual(new Set());
    expect(siblingKind(graph, "kim", "lee")).toBe("full");
  });

  /**
   * The couple who married each other twice, which `lib/save-union.ts`
   * deliberately allows: "couples who divorced and remarried each other are a
   * real and unremarkable genealogical case". One child from each union has
   * the same two parents and is nobody's half-sibling, so union-first cannot
   * be the only rule.
   */
  it("calls children of a couple's two unions full siblings", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "ann", "bob"],
      ],
      children: [
        ["u1", "kim"],
        ["u2", "lee"],
      ],
    });

    expect(siblingKind(graph, "kim", "lee")).toBe("full");
  });

  /**
   * The same shape with the other partner unknown both times, which is the
   * one that must *not* answer "full". Agnes's two children share every
   * parent anybody wrote down; whether the man was the same man is exactly
   * what nobody recorded, and answering "full" would invent it.
   */
  it("keeps them half-siblings when the shared parent is the only one recorded", () => {
    const graph = family({
      unions: [
        ["u1", "ann", null],
        ["u2", "ann", null],
      ],
      children: [
        ["u1", "kim"],
        ["u2", "lee"],
      ],
    });

    expect(parentsOf(graph, "kim")).toEqual(new Set(["ann"]));
    expect(siblingKind(graph, "kim", "lee")).toBe("half");
  });

  it("calls children of two unions sharing a partner half-siblings", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "bob", "cate"],
      ],
      children: [
        ["u1", "kim"],
        ["u2", "lee"],
      ],
    });

    expect(siblingKind(graph, "kim", "lee")).toBe("half");
  });

  it("calls children joined only by their parents' marriage step-siblings", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "cate", "dan"],
        // The remarriage that is the only thing joining the two families.
        ["u3", "bob", "cate"],
      ],
      children: [
        ["u1", "kim"],
        ["u2", "lee"],
      ],
    });

    expect(parentsOf(graph, "kim")).toEqual(new Set(["ann", "bob"]));
    expect(parentsOf(graph, "lee")).toEqual(new Set(["cate", "dan"]));
    expect(siblingKind(graph, "kim", "lee")).toBe("step");
  });

  /**
   * A pair can satisfy both rules at once — the union that makes them
   * half-siblings also joins a parent of each — and the shared parent is the
   * stronger fact. Answering "step" here would be true and useless.
   */
  it("prefers the shared parent when a pair is both", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "bob", "cate"],
      ],
      children: [
        ["u1", "kim"],
        ["u2", "lee"],
      ],
    });

    // u1 holds a parent of each of them, so the step branch would fire too.
    expect(siblingKind(graph, "kim", "lee")).toBe("half");
  });

  it("makes strangers, parents and children no siblings at all", () => {
    const graph = family({
      unions: [["u", "ann", "bob"]],
      children: [["u", "kim"]],
      extras: ["zed"],
    });

    expect(siblingKind(graph, "kim", "zed")).toBe("none");
    expect(siblingKind(graph, "kim", "ann")).toBe("none");
    expect(siblingKind(graph, "ann", "bob")).toBe("none");
  });

  it("refuses to compare somebody with themselves", () => {
    const graph = family({ extras: ["kim"] });

    expect(() => siblingKind(graph, "kim", "kim")).toThrow(/itself/);
  });
});

describe("stepParentsOf", () => {
  it("finds the parent's other spouse, and never the parent", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "bob", "cate"],
      ],
      children: [["u1", "kim"]],
    });

    expect(stepParentsOf(graph, "kim")).toEqual(new Set(["cate"]));
  });

  it("finds one on each side when both parents remarried", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "ann", "dan"],
        ["u3", "bob", "cate"],
      ],
      children: [["u1", "kim"]],
    });

    expect(stepParentsOf(graph, "kim")).toEqual(new Set(["cate", "dan"]));
  });

  it("skips the partner nobody recorded", () => {
    const graph = family({
      unions: [
        ["u1", "ann", null],
        ["u2", "ann", null],
      ],
      children: [["u1", "kim"]],
    });

    expect(stepParentsOf(graph, "kim")).toEqual(new Set());
  });

  it("gives nobody a step-parent for a marriage of their own", () => {
    // Kim is a child of u1 and a partner in u2, which is the shape a walk
    // that forgot whose unions it was looking at turns into "Kim is her own
    // step-parent" or "Kim's husband is her step-parent".
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "kim", "zed"],
      ],
      children: [["u1", "kim"]],
    });

    expect(stepParentsOf(graph, "kim")).toEqual(new Set());
  });

  it("gives a person with no recorded parents no step-parents", () => {
    const graph = family({
      unions: [["u", "ann", "bob"]],
      extras: ["kim"],
    });

    expect(stepParentsOf(graph, "kim")).toEqual(new Set());
  });
});

describe("relativesOf", () => {
  it("reaches up, down and sideways, and stops at the marriage", () => {
    const graph = family({
      unions: [
        ["u1", "ann", "bob"],
        ["u2", "kim", "zed"],
      ],
      children: [
        ["u1", "kim"],
        ["u1", "lee"],
        ["u2", "sam"],
      ],
    });

    // Kim's: both parents, her sibling, her child — and not the man she
    // married, who is related to her by a union rather than by descent.
    expect(relativesOf(graph, "kim")).toEqual(
      new Set(["ann", "bob", "lee", "sam"]),
    );
    // From the other side of that marriage, only his own child.
    expect(relativesOf(graph, "zed")).toEqual(new Set(["sam"]));
  });
});

describe("bloodOnly", () => {
  it("keeps the people and drops every link that is not a birth", () => {
    const graph = family({
      unions: [["u", "ann", "bob"]],
      children: [
        ["u", "kim"],
        ["u", "lee", "adopted"],
      ],
    });

    const blood = bloodOnly(graph);

    expect(blood.people).toEqual(graph.people);
    expect(blood.unions).toEqual(graph.unions);
    expect(blood.childLinks.map((link) => link.childId)).toEqual(["kim"]);
    expect(relativesOf(blood, "lee")).toEqual(new Set());
    expect(siblingKind(blood, "kim", "lee")).toBe("none");
  });
});

/**
 * A `step` link recorded *alongside* a person's birth link, which is the way
 * the application actually produces one and the way the seeded family does
 * not.
 *
 * `lib/child-input.ts`'s `CHILD_MODES` lets an **existing** person be
 * attached to a second union, and `CHILD_RELATIONS` offers `step` on that new
 * link — the same "two ordinary rows" arrangement `db/schema.ts` uses to
 * justify `adopted`: "a boy adopted by his stepfather is biological to one
 * union and adopted into another". So Edward can hold a biological link to
 * his parents' union and a `step` link to his father's second marriage, and
 * both rows are ordinary.
 *
 * These are separate from the `step`-exception test in
 * `lib/relationship-derivation.test.ts`, which *changes* a birth link's
 * relation to `step`. That is a person with no birth union at all, and it
 * cannot reach any of the three wrong answers below — the case only appears
 * when a real birth link and a `step` link are held at once.
 */
describe("a step link beside a birth link", () => {
  const remarriage = () =>
    family({
      unions: [
        ["u1", "mary", "thomas"],
        ["u2", "thomas", "rose"],
      ],
      children: [
        ["u1", "edward"],
        ["u2", "clara"],
        // Edward is his stepmother's stepchild by the record, and still his
        // own parents' son by the row above.
        ["u2", "edward", "step"],
      ],
    });

  it("does not count the step-parent among the parents", () => {
    expect(parentsOf(remarriage(), "edward")).toEqual(
      new Set(["mary", "thomas"]),
    );
  });

  /**
   * The wrong answer this guards is "full", reached by reading the `step`
   * link as a birth: Edward and Clara would share union u2 and the union-first
   * branch would answer before anything looked at a parent. They share Thomas
   * and nobody else.
   */
  it("calls the stepmother's own child a half-sibling", () => {
    expect(siblingKind(remarriage(), "edward", "clara")).toBe("half");
  });

  /**
   * And the step-parent is still reported as one. Counting Rose as a parent
   * does not merely add her to the wrong list — it deletes her from this one,
   * because `stepParentsOf` skips anybody who is already a parent.
   */
  it("still names the stepmother a step-parent", () => {
    expect(stepParentsOf(remarriage(), "edward")).toEqual(new Set(["rose"]));
  });

  /**
   * The neighbouring values are untouched, which is the criterion "adoption
   * and fostering do not alter the derived structural relationships" — they
   * record how a child arrived at a union that did raise them, where `step`
   * records that the union did not.
   */
  it.each(["adopted", "foster"] as const)(
    "reads a %s link as a birth, unlike step",
    (relation) => {
      const graph = family({
        unions: [
          ["u1", "mary", "thomas"],
          ["u2", "thomas", "rose"],
        ],
        children: [
          ["u1", "edward"],
          ["u2", "clara"],
          ["u2", "edward", relation],
        ],
      });

      expect(parentsOf(graph, "edward")).toEqual(
        new Set(["mary", "thomas", "rose"]),
      );
      expect(siblingKind(graph, "edward", "clara")).toBe("full");
    },
  );
});

/**
 * A whole graph from the three facts these tests are about: who is partnered
 * with whom, who was born into which union, and who is on the page without
 * being either. Everybody is female, born on no recorded date, because
 * nothing here reads a name, a sex or a date.
 */
function family(spec: {
  unions?: [id: string, a: string | null, b: string | null][];
  children?: [
    unionId: string,
    childId: string,
    relation?: GraphChildLink["relation"],
  ][];
  extras?: string[];
}): FamilyGraph {
  const unions = spec.unions ?? [];
  const children = spec.children ?? [];

  const ids = new Set<string>(spec.extras ?? []);
  for (const [, a, b] of unions) {
    if (a !== null) ids.add(a);
    if (b !== null) ids.add(b);
  }
  for (const [, childId] of children) ids.add(childId);

  return {
    people: [...ids].map((id) => ({
      id,
      givenName: id,
      surname: null,
      sex: "unknown",
      birthDate: null,
      birthDateQualifier: "exact",
      birthDatePrecision: "day",
      birthDateUpper: null,
      birthDateUpperPrecision: "day",
      birthPlace: null,
      deathDate: null,
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
      deathDateUpper: null,
      deathDateUpperPrecision: "day",
      deathPlace: null,
      notes: null,
      pageId: null,
    })),
    unions: unions.map(([id, partnerAId, partnerBId], index) => ({
      id,
      partnerAId,
      partnerBId,
      type: "marriage",
      endReason: "ongoing",
      sequence: index + 1,
      startDate: null,
      startDateQualifier: "exact",
      startDatePrecision: "day",
      startDateUpper: null,
      startDateUpperPrecision: "day",
      endDate: null,
      endDateQualifier: "exact",
      endDatePrecision: "day",
      endDateUpper: null,
      endDateUpperPrecision: "day",
    })),
    childLinks: children.map(([unionId, childId, relation]) => ({
      unionId,
      childId,
      relation: relation ?? "biological",
    })),
  };
}
