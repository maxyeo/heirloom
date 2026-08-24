import { describe, expect, it } from "vitest";

import {
  type AddChildInput,
  addChildInputFromFormData,
  CHILD_FIELD_PREFIX,
  type ChildLinkInput,
  childFieldErrorsFrom,
  childLinkInputFromFormData,
  validateAddChild,
  validateChildLink,
} from "@/lib/child-input";

/**
 * The rules a child↔union link is judged by (E3-T5, `YEO-33`), asserted
 * without a database and without a document.
 *
 * That is possible because `lib/child-input.ts` is a pure function over a
 * plain value, which is the property docs/testing.md names as the thing worth
 * designing for. What is *not* here is anything the value alone cannot answer:
 * whether the union exists, whether the child is one of its partners, and
 * whether the link is already recorded are all questions for
 * `lib/save-child.db.test.ts`.
 */

const UNION = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

function link(overrides: ChildLinkInput = {}): ChildLinkInput {
  return {
    unionId: UNION,
    childId: CHILD,
    relation: "biological",
    ...overrides,
  };
}

function submission(overrides: Partial<AddChildInput> = {}): AddChildInput {
  return {
    childMode: "existing",
    childId: CHILD,
    child: {},
    link: link(),
    ...overrides,
  };
}

/** The issues a refusal reported, keyed by field. */
function refusal(input: ChildLinkInput) {
  const result = validateChildLink(input);
  if (result.ok) throw new Error("expected the link to be refused");
  return childFieldErrorsFrom(result.issues);
}

/** The value a clean link produced. */
function accepted(input: ChildLinkInput) {
  const result = validateChildLink(input);
  if (!result.ok) {
    throw new Error(
      `expected the link to be accepted: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.value;
}

describe("the union a child belongs to", () => {
  it("is required, because it is the whole answer to whose child this is", () => {
    expect(refusal(link({ unionId: "" })).unionId).toContain("which family");
    expect(refusal(link({ unionId: null })).unionId).toContain("which family");
  });

  it("is refused when it is not shaped like a row id", () => {
    // Otherwise Postgres raises `invalid input syntax for type uuid` and the
    // author gets an error boundary instead of a sentence.
    expect(refusal(link({ unionId: "the Hales" })).unionId).toBeDefined();
  });

  it("is kept exactly as given when it is a row id", () => {
    expect(accepted(link()).unionId).toBe(UNION);
  });
});

describe("the child", () => {
  it("may be absent, because the person can be created with the link", () => {
    // `union_children.child_id` is `not null`; null here means "the id does
    // not exist yet", and `lib/save-child.ts` fills it in from the insert it
    // does first, inside the same transaction.
    expect(accepted(link({ childId: null })).childId).toBeNull();
  });

  it("is refused when it is present but not a row id", () => {
    expect(refusal(link({ childId: "someone" })).childId).toBeDefined();
  });
});

describe("the relation", () => {
  it("defaults to biological when nothing was said", () => {
    expect(accepted(link({ relation: null })).relation).toBe("biological");
  });

  it("keeps each of the four the schema holds", () => {
    for (const relation of ["biological", "adopted", "step", "foster"]) {
      expect(accepted(link({ relation })).relation).toBe(relation);
    }
  });

  it("refuses a word the enum does not have", () => {
    // Silently defaulting would write a relation nobody chose, which on this
    // column is the difference between a birth and an adoption.
    expect(refusal(link({ relation: "half" })).relation).toBeDefined();
  });

  /**
   * The ticket's note, as a test: adoption is an attribute of the link. There
   * is no field on this value that belongs to a person, and nothing in it
   * that a caller could put on `individuals` by mistake.
   */
  it("belongs to the link and nothing else does", () => {
    expect(Object.keys(accepted(link())).sort()).toEqual([
      "childId",
      "relation",
      "unionId",
    ]);
  });
});

describe("collapsing issues for a form", () => {
  it("keeps the first message per field", () => {
    expect(
      childFieldErrorsFrom([
        { field: "unionId", message: "first" },
        { field: "unionId", message: "second" },
        { field: "relation", message: "other" },
      ]),
    ).toEqual({ unionId: "first", relation: "other" });
  });
});

describe("one add-child submission", () => {
  it("accepts an existing person chosen from the picker", () => {
    const result = validateAddChild(submission());
    if (!result.ok) throw new Error("expected the submission to be accepted");

    expect(result.mode).toBe("existing");
    expect(result.child).toBeNull();
    expect(result.link).toEqual({
      unionId: UNION,
      childId: CHILD,
      relation: "biological",
    });
  });

  it("refuses an existing-person submission that names nobody", () => {
    // Without this the link would validate as an inline creation and quietly
    // write a nameless person.
    const result = validateAddChild(
      submission({ childId: "", link: link({ childId: "" }) }),
    );
    if (result.ok) throw new Error("expected the submission to be refused");

    expect(childFieldErrorsFrom(result.linkIssues).childId).toContain(
      "Choose the child",
    );
  });

  it("validates a child being created inline and leaves the id for the insert", () => {
    const result = validateAddChild(
      submission({
        childMode: "new",
        childId: "",
        child: { givenName: "Dora", surname: "Hale" },
      }),
    );
    if (!result.ok) throw new Error("expected the submission to be accepted");

    expect(result.mode).toBe("new");
    expect(result.child?.givenName).toBe("Dora");
    expect(result.link.childId).toBeNull();
  });

  it("reports what is wrong with the link and the new person together", () => {
    // An author who forgot the family and left the name blank should see both
    // in one pass, rather than discovering the second after fixing the first.
    const result = validateAddChild(
      submission({
        childMode: "new",
        childId: "",
        child: { givenName: "" },
        link: link({ unionId: "" }),
      }),
    );
    if (result.ok) throw new Error("expected the submission to be refused");

    expect(childFieldErrorsFrom(result.linkIssues).unionId).toBeDefined();
    expect(
      result.childIssues.some((issue) => issue.field === "givenName"),
    ).toBe(true);
  });

  /**
   * Which person the link points at is decided by the mode and the picker, so
   * a submission carrying a `link.childId` as well cannot use one field to
   * contradict the other.
   */
  it("ignores a child id smuggled into the link's own fields", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const result = validateAddChild(
      submission({
        childMode: "new",
        childId: "",
        child: { givenName: "Dora" },
        link: link({ childId: other }),
      }),
    );
    if (!result.ok) throw new Error("expected the submission to be accepted");

    expect(result.link.childId).toBeNull();
  });

  it("refuses a mode it does not recognise", () => {
    const result = validateAddChild(submission({ childMode: "unknown" }));
    if (result.ok) throw new Error("expected the submission to be refused");

    expect(childFieldErrorsFrom(result.linkIssues).childId).toBeDefined();
  });
});

describe("reading a submission out of a form", () => {
  it("takes the link's fields by their column names", () => {
    const form = new FormData();
    form.set("unionId", UNION);
    form.set("childId", CHILD);
    form.set("relation", "adopted");

    expect(childLinkInputFromFormData(form)).toEqual({
      unionId: UNION,
      childId: CHILD,
      relation: "adopted",
    });
  });

  it("keeps the inline child's fields out of the link's", () => {
    const form = new FormData();
    form.set("unionId", UNION);
    form.set("childMode", "new");
    form.set("childId", "");
    form.set("relation", "foster");
    form.set(`${CHILD_FIELD_PREFIX}givenName`, "Dora");
    form.set(`${CHILD_FIELD_PREFIX}notes`, "from the parish register");

    const input = addChildInputFromFormData(form);

    expect(input.childMode).toBe("new");
    expect(input.child.givenName).toBe("Dora");
    expect(input.child.notes).toBe("from the parish register");
    // The prefix is what keeps the person's fields from reaching the link's.
    expect(input.link.relation).toBe("foster");
  });
});
