import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";

// `import type` matters here, as it does in lib/tree-layout.test.ts:
// lib/family-graph.ts imports @/db and pulls postgres.js in behind it, and
// taking only the type erases the import entirely.
import type { FamilyGraph } from "@/lib/family-graph";
import {
  PERSON_PARAM,
  linkedPersonId,
  personSearch,
  treeHref,
  withSelection,
} from "@/lib/tree-selection";

/**
 * The deep link (E2-T4) asserted where it is arithmetic rather than
 * rendering — which is nearly all of it. What is left for
 * `components/FamilyTree.test.tsx` is the two joins that need a canvas: that
 * an id arriving as a prop opens the panel, and that selecting somebody
 * reports the change back for the URL to follow.
 */

function graph(): FamilyGraph {
  return {
    people: [
      {
        id: "rose",
        givenName: "Rose",
        surname: "Hale",
        sex: "female",
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
      },
    ],
    unions: [],
    childLinks: [],
  };
}

function selectedIds(nodes: Node[]): string[] {
  return nodes.filter((node) => node.selected).map((node) => node.id);
}

function nodes(selectedId?: string): Node[] {
  return ["rose", "walter", "u1"].map((id) => ({
    id,
    type: id === "u1" ? "union" : "person",
    position: { x: 0, y: 0 },
    data: {},
    ...(selectedId === id ? { selected: true } : {}),
  }));
}

describe("linkedPersonId", () => {
  it("takes an id the tree has", () => {
    expect(linkedPersonId(graph(), "rose")).toBe("rose");
  });

  it("has nobody to open when the parameter is absent", () => {
    expect(linkedPersonId(graph(), null)).toBeNull();
  });

  it("treats an empty parameter as no parameter", () => {
    // `/tree?person=` is what an over-eager link builder produces, and it is
    // asking for nothing rather than for somebody called "".
    expect(linkedPersonId(graph(), "")).toBeNull();
  });

  it("falls back when the id names nobody on this tree", () => {
    // A well-formed uuid for somebody who was deleted last week: the shape is
    // perfect and there is still nothing to open.
    expect(
      linkedPersonId(graph(), "3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    ).toBeNull();
  });

  it("falls back on an id that is not an id at all", () => {
    expect(linkedPersonId(graph(), "<script>alert(1)</script>")).toBeNull();
  });
});

describe("personSearch", () => {
  it("names a person on a URL that had no query string", () => {
    expect(personSearch("", "rose")).toBe(`?${PERSON_PARAM}=rose`);
  });

  it("replaces the person already named", () => {
    expect(personSearch("?person=rose", "walter")).toBe("?person=walter");
  });

  it("removes the parameter rather than emptying it", () => {
    // `?person=` would come back as an id of "" — indistinguishable from an
    // unknown person, but still a URL with a dangling parameter in it.
    expect(personSearch("?person=rose", null)).toBe("");
  });

  it("leaves every other parameter where it was", () => {
    expect(personSearch("?view=list&person=rose", "walter")).toBe(
      "?view=list&person=walter",
    );
    expect(personSearch("?view=list&person=rose", null)).toBe("?view=list");
  });

  it("accepts the search string with or without its question mark", () => {
    expect(personSearch("person=rose", "walter")).toBe("?person=walter");
  });
});

describe("treeHref", () => {
  it("builds the deep link off the one parameter contract", () => {
    expect(treeHref("rose")).toBe(`/tree?${PERSON_PARAM}=rose`);
  });

  it("encodes an id that needs escaping", () => {
    // Not a shape any id in the schema takes, but the point of routing this
    // through `personSearch` — and, underneath it, `URLSearchParams` — is
    // that this function never has to know that: whatever the id is, the
    // query string it produces is well-formed.
    expect(treeHref("a b&c")).toBe(`/tree?${PERSON_PARAM}=a+b%26c`);
  });
});

describe("withSelection", () => {
  it("selects the person named and nobody else", () => {
    expect(selectedIds(withSelection(nodes(), "rose"))).toEqual(["rose"]);
  });

  it("moves the selection off whoever had it", () => {
    expect(selectedIds(withSelection(nodes("walter"), "rose"))).toEqual([
      "rose",
    ]);
  });

  it("clears the selection when given nobody", () => {
    expect(selectedIds(withSelection(nodes("rose"), null))).toEqual([]);
  });

  it("selects nobody when the id matches no node", () => {
    // The component resolves an id against the graph before it ever gets
    // here, so this is the belt to that braces: an unrecognised id is not an
    // error, it is an empty selection.
    expect(selectedIds(withSelection(nodes("rose"), "nobody"))).toEqual([]);
  });

  it("returns the very same array when the selection is already right", () => {
    // Load-bearing: this runs from an effect that watches the URL, and a new
    // array on every navigation would hand React Flow a new `nodes` prop each
    // time a parameter it does not care about changed.
    const current = nodes("rose");

    expect(withSelection(current, "rose")).toBe(current);
    expect(withSelection(current, "walter")).not.toBe(current);
  });

  it("keeps the identity of every node it did not have to change", () => {
    const current = nodes("rose");
    const next = withSelection(current, "walter");

    expect(next[2]).toBe(current[2]);
    expect(next[0]).not.toBe(current[0]);
  });
});
