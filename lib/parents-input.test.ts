import { describe, expect, it } from "vitest";

import {
  parentsFieldErrorsFrom,
  type SetParentsInput,
  setParentsInputFromFormData,
  validateSetParents,
} from "@/lib/parents-input";

/**
 * The set-parents validator (E3-T6, `YEO-34`).
 *
 * Pure in, pure out: no database, no request, no form. What is asserted here
 * is only what can be settled from the submission itself — that the references
 * are shaped like row ids, that a family is named one way or the other, and
 * that nobody is recorded as their own parent. Whether those rows exist, and
 * whether a link would put a cycle in the graph, are database questions and
 * live in `lib/set-parents.db.test.ts`.
 */

// Real UUIDs, because `isRowId` checks the shape and a readable stand-in like
// "child" would be refused for reasons that have nothing to do with the case
// under test.
const CHILD = "11111111-1111-4111-8111-111111111111";
const UNION = "22222222-2222-4222-8222-222222222222";
const OTHER_UNION = "33333333-3333-4333-8333-333333333333";
const MOTHER = "44444444-4444-4444-8444-444444444444";
const FATHER = "55555555-5555-4555-8555-555555555555";

function submission(overrides: Partial<SetParentsInput> = {}): SetParentsInput {
  return {
    childId: CHILD,
    familyMode: "existing",
    unionId: UNION,
    fromUnionId: null,
    relation: "biological",
    parentAId: null,
    parentBId: null,
    ...overrides,
  };
}

function issuesOf(input: SetParentsInput) {
  const checked = validateSetParents(input);
  if (checked.ok) throw new Error("expected the submission to be refused");
  return parentsFieldErrorsFrom(checked.issues);
}

function valueOf(input: SetParentsInput) {
  const checked = validateSetParents(input);
  if (!checked.ok) {
    throw new Error(
      `expected the submission to pass: ${JSON.stringify(checked.issues)}`,
    );
  }
  return checked;
}

describe("attaching a child to a family already on the tree", () => {
  it("accepts a child, a union, and a relation", () => {
    const checked = valueOf(submission());

    expect(checked.mode).toBe("existing");
    expect(checked.value).toEqual({
      childId: CHILD,
      unionId: UNION,
      fromUnionId: null,
      relation: "biological",
      parentAId: null,
      parentBId: null,
    });
  });

  it("defaults the relation, because every enum here has a member meaning nothing was said", () => {
    expect(valueOf(submission({ relation: null })).value.relation).toBe(
      "biological",
    );
  });

  it("refuses a relation it does not recognise rather than defaulting it", () => {
    // A value present but unrecognised can only come from a hand-made POST or
    // a bug, and quietly writing `biological` would record a fact nobody
    // asserted — which looks fine right up until somebody exports it.
    expect(issuesOf(submission({ relation: "stepchild" })).relation).toMatch(
      /biological, adopted, step, or foster/,
    );
  });

  it("asks which family when none was chosen", () => {
    expect(issuesOf(submission({ unionId: "" })).unionId).toMatch(
      /which family/i,
    );
  });

  it("refuses a union id that could never have come from this application", () => {
    expect(issuesOf(submission({ unionId: "not-a-uuid" })).unionId).toMatch(
      /not a family/i,
    );
  });

  it("ignores parents named alongside an existing family", () => {
    // The mode decides which answer is read, so a submission carrying both
    // cannot use one field to contradict the other — the same rule
    // `validateAddChild` applies to `childId`.
    const checked = valueOf(submission({ parentAId: MOTHER }));

    expect(checked.value.parentAId).toBeNull();
    expect(checked.value.unionId).toBe(UNION);
  });
});

describe("creating the family from the parents", () => {
  const inline = (overrides: Partial<SetParentsInput> = {}) =>
    submission({
      familyMode: "new",
      unionId: null,
      parentAId: MOTHER,
      parentBId: FATHER,
      ...overrides,
    });

  it("accepts two parents and leaves the union to be created", () => {
    const checked = valueOf(inline());

    expect(checked.mode).toBe("new");
    expect(checked.value.unionId).toBeNull();
    expect(checked.value.parentAId).toBe(MOTHER);
    expect(checked.value.parentBId).toBe(FATHER);
  });

  it("accepts one known parent and one unknown", () => {
    // The ticket's third criterion, and the reason there is no placeholder
    // person anywhere in this flow: both partner columns on `unions` are
    // nullable, so "we know the mother, the father is unknown" is an ordinary
    // row rather than an invented individual (docs/architecture.md).
    const checked = valueOf(inline({ parentBId: "" }));

    expect(checked.value.parentAId).toBe(MOTHER);
    expect(checked.value.parentBId).toBeNull();
  });

  it("accepts an unknown first parent just as readily as an unknown second", () => {
    expect(valueOf(inline({ parentAId: null })).value.parentBId).toBe(FATHER);
  });

  it("refuses a family that names neither parent, because it records nothing", () => {
    expect(
      issuesOf(inline({ parentAId: "", parentBId: "" })).parentAId,
    ).toMatch(/at least one parent/i);
  });

  it("refuses the same person in both slots", () => {
    expect(issuesOf(inline({ parentBId: MOTHER })).parentBId).toMatch(
      /different people/i,
    );
  });

  it("refuses a person recorded as their own parent", () => {
    // The one cycle visible in the submission itself. Everything deeper needs
    // the graph and is refused inside the transaction.
    expect(issuesOf(inline({ parentAId: CHILD })).parentAId).toMatch(
      /their own parent/i,
    );
  });

  it("refuses a parent id that could never have come from this application", () => {
    expect(issuesOf(inline({ parentBId: "nobody" })).parentBId).toMatch(
      /not a person/i,
    );
  });

  it("ignores a union named alongside inline parents", () => {
    expect(valueOf(inline({ unionId: UNION })).value.unionId).toBeNull();
  });
});

describe("moving a child from one family to another", () => {
  it("carries the family they are being taken out of", () => {
    const checked = valueOf(submission({ fromUnionId: OTHER_UNION }));

    expect(checked.value.fromUnionId).toBe(OTHER_UNION);
    expect(checked.value.unionId).toBe(UNION);
  });

  it("treats a blank as leaving every link they already have", () => {
    // The ordinary answer, and the reason this is the one reference in the
    // submission whose absence is not a problem: adopted into one family and
    // born into another is a real record rather than a mistake.
    expect(
      valueOf(submission({ fromUnionId: "" })).value.fromUnionId,
    ).toBeNull();
  });

  it("refuses a move out of the very family being recorded", () => {
    expect(issuesOf(submission({ fromUnionId: UNION })).fromUnionId).toMatch(
      /the family you are recording them in/i,
    );
  });

  it("refuses a source that could never have come from this application", () => {
    expect(
      issuesOf(submission({ fromUnionId: "elsewhere" })).fromUnionId,
    ).toMatch(/not a family/i);
  });

  it("allows a move while the destination family is being created", () => {
    // A union id of null in `new` mode must not collide with the "same
    // family" check above, which would otherwise refuse every inline move.
    const checked = valueOf(
      submission({
        familyMode: "new",
        unionId: null,
        parentAId: MOTHER,
        fromUnionId: OTHER_UNION,
      }),
    );

    expect(checked.value.fromUnionId).toBe(OTHER_UNION);
  });
});

describe("the submission as a whole", () => {
  it("reports every problem in one pass", () => {
    // An author who chose no family *and* named nobody should see both,
    // rather than discovering the second after fixing the first.
    const errors = issuesOf(
      submission({
        childId: "",
        familyMode: "new",
        unionId: null,
        relation: "cousin",
      }),
    );

    expect(Object.keys(errors).sort()).toEqual([
      "childId",
      "parentAId",
      "relation",
    ]);
  });

  it("refuses a family mode it does not recognise", () => {
    expect(issuesOf(submission({ familyMode: "guess" })).unionId).toMatch(
      /name the parents yourself/i,
    );
  });

  it("keeps the first message per field", () => {
    const errors = parentsFieldErrorsFrom([
      { field: "unionId", message: "First." },
      { field: "unionId", message: "Second." },
    ]);

    expect(errors.unionId).toBe("First.");
  });

  it("reads its fields out of a form by their own names", () => {
    const form = new FormData();
    form.set("childId", CHILD);
    form.set("familyMode", "new");
    form.set("parentAId", MOTHER);
    form.set("fromUnionId", OTHER_UNION);
    form.set("relation", "adopted");

    const checked = valueOf(setParentsInputFromFormData(form));

    expect(checked.mode).toBe("new");
    expect(checked.value).toEqual({
      childId: CHILD,
      unionId: null,
      fromUnionId: OTHER_UNION,
      relation: "adopted",
      parentAId: MOTHER,
      parentBId: null,
    });
  });
});
