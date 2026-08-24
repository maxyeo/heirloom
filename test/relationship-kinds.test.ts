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
      birthPlace: null,
      deathDate: null,
      deathDateQualifier: "exact",
      deathDatePrecision: "day",
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
      endDate: null,
      endDateQualifier: "exact",
      endDatePrecision: "day",
    })),
    childLinks: children.map(([unionId, childId, relation]) => ({
      unionId,
      childId,
      relation: relation ?? "biological",
    })),
  };
}
