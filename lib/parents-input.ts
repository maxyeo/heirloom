import { type ChildRelation, CHILD_RELATIONS } from "./child-input";
import { readEnum, readText } from "./field-input";
import { isRowId } from "./row-id";

/**
 * The one place a set-parents submission is checked before it becomes rows
 * (E3-T6, `YEO-34`).
 *
 * ## What this flow is, and why it is not add-child again
 *
 * The ticket's case is "I added them standalone and now want to connect
 * them", and it is the *child's* end of a link `lib/child-input.ts` already
 * describes from the union's end. The row written is the same
 * `union_children` row, and `lib/save-child.ts` still writes it — nothing here
 * duplicates that.
 *
 * What is genuinely new is the three things the add-child form never has to
 * answer, all of which are questions about *which* family rather than about
 * the child:
 *
 * - the family may not exist yet, and naming two people who have never been
 *   recorded as a couple has to create the union as part of the same write;
 * - one parent may be known and the other not, which is a `null` partner
 *   column rather than a placeholder person (docs/architecture.md);
 * - the child may already be recorded in some *other* family, and correcting
 *   that is a move rather than a delete followed by an add.
 *
 * ## The same shape as `lib/child-input.ts`, for the same reason
 *
 * Pure. Nothing here may touch `headers()`, `cookies()`, `@/db`, or any other
 * ambient state — its imports are `lib/child-input.ts`, `lib/field-input.ts`
 * and `lib/row-id.ts`, which are themselves pure. The set-parents form comes
 * through `app/tree/actions.ts`, and E6-T2's GEDCOM import will reach the same
 * rows with no session, no `FormData` and no request scope at all.
 *
 * ## What is deliberately *not* checked here
 *
 * Cycles, beyond the one case that is visible in the submission itself: a
 * person named as their own parent. Everything deeper — a grandmother
 * attached under her own grandson — is a question about the shape of the
 * graph, and the graph is a database read. `lib/ancestry.ts` answers it and
 * `lib/save-child.ts` enforces it inside the transaction, against a read taken
 * there rather than against whatever the browser last loaded.
 */

/**
 * How the author answered "which family".
 *
 * `existing` picks a union already on the tree, which is the ordinary case and
 * the one the ticket leads with. `new` names the parents instead, and the
 * union is created as part of the same write.
 *
 * An explicit mode rather than inferring one from which fields arrived,
 * matching `CHILD_MODES`: a form posts every input it contains, so "the parent
 * pickers are empty" and "the author chose a union from the list" are
 * indistinguishable by presence alone.
 */
export const PARENT_FAMILY_MODES = ["existing", "new"] as const;

export type ParentFamilyMode = (typeof PARENT_FAMILY_MODES)[number];

/**
 * A set-parents submission, cleaned and ready to be acted on.
 *
 * `unionId` is null in `new` mode and `parentAId` / `parentBId` are null in
 * `existing` mode, which is the same split `AddChildValidation` makes: only
 * one of the two answers is meaningful, and the other is cleared here rather
 * than left for the writer to remember to ignore.
 */
export type SetParentsFields = {
  /** The person whose parents are being set. */
  childId: string;
  /** The family to record them in, or null when one is being created. */
  unionId: string | null;
  /**
   * The family they are being moved *out* of, or null to leave every link
   * they already have in place.
   *
   * Nullable rather than absent because "add a second family" is a real
   * record — adopted into one, born into another — and the difference between
   * that and a correction is exactly what this field carries.
   */
  fromUnionId: string | null;
  relation: ChildRelation;
  /**
   * The parents, when the family is being created. Either may be null, and
   * that nullability is the ticket's "one known parent and one unknown": both
   * partner columns on `unions` are nullable precisely so that an unrecorded
   * parent never has to be invented as a placeholder person.
   */
  parentAId: string | null;
  parentBId: string | null;
};

/** The name of a field a problem can be attached to. */
export type ParentsField = keyof SetParentsFields;

/** One problem with one field, in words meant for the person who typed it. */
export type ParentsValidationIssue = {
  field: ParentsField;
  /** A complete sentence, safe to render directly. */
  message: string;
};

/** Problems keyed by field, which is the shape a form actually renders. */
export type ParentsFieldErrors = Partial<Record<ParentsField, string>>;

/** Either a clean submission or the reasons there isn't one. Never both. */
export type ParentsValidation =
  | { ok: true; mode: ParentFamilyMode; value: SetParentsFields }
  | { ok: false; issues: ParentsValidationIssue[] };

/**
 * One set-parents submission, still untrusted.
 *
 * Every value is `unknown` for the reason `ChildLinkInput` gives: they come
 * from a `FormData` entry (`string | File | null`), from a GEDCOM record, or
 * from a POST somebody hand-crafted, so "it is a string" is a conclusion
 * `validateSetParents` reaches rather than a premise a caller may assert.
 */
export type SetParentsInput = {
  childId: unknown;
  familyMode: unknown;
  unionId: unknown;
  fromUnionId: unknown;
  relation: unknown;
  parentAId: unknown;
  parentBId: unknown;
};

/**
 * Check and clean one set-parents submission.
 *
 * Pure: no database, no session, no request. Every field is examined even
 * after one has failed, so an author fixing a form sees everything that is
 * wrong with it in one pass — the same rule `validateAddChild` follows.
 *
 * @param input the submission as it arrived, untrusted and untyped
 * @returns the cleaned submission, or every problem found
 */
export function validateSetParents(input: SetParentsInput): ParentsValidation {
  const issues: ParentsValidationIssue[] = [];

  /**
   * The child is the whole subject of the flow, so an unusable one is not a
   * field left blank — it is a submission that is about nobody. It arrives
   * from the panel the flow was opened from rather than from a control the
   * author touched, so the message describes the tree rather than the form.
   */
  const childId = readText(input.childId);
  if (childId === null || childId === undefined || !isRowId(childId)) {
    issues.push({
      field: "childId",
      message: "That is not a person this tree can record parents for.",
    });
  }

  const mode = readEnum(input.familyMode, PARENT_FAMILY_MODES, "existing");
  if (mode === undefined) {
    issues.push({
      field: "unionId",
      message: "Choose a family from the tree, or name the parents yourself.",
    });
  }

  const unionId = mode === "existing" ? readRowId(input.unionId) : null;
  if (mode === "existing") {
    if (unionId === null) {
      issues.push({
        field: "unionId",
        message: "Choose which family this person belongs to.",
      });
    } else if (unionId === undefined) {
      issues.push({
        field: "unionId",
        message: "That is not a family this tree can record a child in.",
      });
    }
  }

  /**
   * The two parents, read only when a family is being created. Each is
   * optional on its own — a union recording one parent and leaving the other
   * unknown is the case both nullable columns exist for — but a union naming
   * *neither* records nothing at all, which is the rule `validateUnion`
   * already applies from the add-spouse end.
   */
  const parentAId = mode === "new" ? readRowId(input.parentAId) : null;
  const parentBId = mode === "new" ? readRowId(input.parentBId) : null;

  if (mode === "new") {
    for (const [field, value] of [
      ["parentAId", parentAId],
      ["parentBId", parentBId],
    ] as const) {
      if (value === undefined) {
        issues.push({
          field,
          message: "That is not a person this tree can record as a parent.",
        });
      }
    }

    if (parentAId === null && parentBId === null) {
      issues.push({
        field: "parentAId",
        message:
          "Name at least one parent. The other can be left unrecorded, but a family with neither records nothing.",
      });
    }

    if (parentAId !== null && parentAId === parentBId) {
      issues.push({
        field: "parentBId",
        message: "The two parents must be different people.",
      });
    }

    /**
     * The one cycle this file can see. Anything deeper needs the graph and is
     * refused inside the transaction by `lib/save-child.ts`; this is here
     * because it costs a comparison and because it is the mistake somebody
     * actually makes — picking themselves out of a list of everyone.
     */
    if (childId !== null && childId !== undefined) {
      for (const [field, value] of [
        ["parentAId", parentAId],
        ["parentBId", parentBId],
      ] as const) {
        if (value === childId) {
          issues.push({
            field,
            message: "Nobody can be recorded as their own parent.",
          });
        }
      }
    }
  }

  /**
   * Which family they are being moved out of. Blank is the ordinary answer
   * and means "leave what is already recorded", so this is the one reference
   * in the submission whose absence is not a problem.
   */
  const fromUnionId = readRowId(input.fromUnionId);
  if (fromUnionId === undefined) {
    issues.push({
      field: "fromUnionId",
      message: "That is not a family this tree can move somebody out of.",
    });
  } else if (fromUnionId !== null && fromUnionId === unionId) {
    /**
     * Moving somebody out of the family they are being put into would delete
     * the link and write it straight back. Harmless in outcome and confusing
     * in intent, and much more likely to mean the author picked the wrong
     * family in one of the two controls.
     */
    issues.push({
      field: "fromUnionId",
      message: "That is the family you are recording them in.",
    });
  }

  const relation = readEnum(input.relation, CHILD_RELATIONS, "biological");
  if (relation === undefined) {
    issues.push({
      field: "relation",
      message:
        "Say whether this child is biological, adopted, step, or foster.",
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  /**
   * Every branch that could leave one of these unusable pushed an issue and
   * was caught above, but TypeScript cannot see that across a length
   * comparison. Narrowing rather than casting; none of these throws is
   * reachable, and all of them are cheaper than an `as`.
   */
  if (childId === null || childId === undefined) {
    throw new Error("unreachable: an unusable child is an issue");
  }
  if (mode === undefined) {
    throw new Error("unreachable: an unknown family mode is an issue");
  }
  if (unionId === undefined) {
    throw new Error("unreachable: an unusable union is an issue");
  }
  if (parentAId === undefined || parentBId === undefined) {
    throw new Error("unreachable: an unusable parent is an issue");
  }
  if (fromUnionId === undefined) {
    throw new Error("unreachable: an unusable move is an issue");
  }
  if (relation === undefined) {
    throw new Error("unreachable: an unknown relation is an issue");
  }

  return {
    ok: true,
    mode,
    value: {
      childId,
      unionId,
      fromUnionId,
      relation,
      parentAId,
      parentBId,
    },
  };
}

/**
 * Read an optional reference to a row.
 *
 * Three answers rather than two, matching `readText`: the value, `null` for
 * "not given", and `undefined` for "given, but not something this application
 * could ever have written". The third is what keeps `invalid input syntax for
 * type uuid` from arriving as a thrown driver error where a sentence beside
 * the control would do.
 */
function readRowId(value: unknown): string | null | undefined {
  const text = readText(value);
  if (text === null || text === undefined) return text;
  return isRowId(text) ? text : undefined;
}

/**
 * Collapse a list of issues into one message per field.
 *
 * The list is what an importer wants (every problem, in order, for a report);
 * this is what a form wants (a message to hang under each control). First
 * issue wins per field, matching the order `validateSetParents` finds them in.
 */
export function parentsFieldErrorsFrom(
  issues: readonly ParentsValidationIssue[],
): ParentsFieldErrors {
  const errors: ParentsFieldErrors = {};
  for (const issue of issues) {
    errors[issue.field] ??= issue.message;
  }
  return errors;
}

/**
 * Pull a set-parents submission out of a form.
 *
 * The input names are the property names above, so a form writes
 * `name="unionId"` and nothing has to be mapped or renamed.
 *
 * A web API, not a Next.js one: `FormData` is a global in Node 18+, so this is
 * callable from a script or a test with no request in sight.
 */
export function setParentsInputFromFormData(form: FormData): SetParentsInput {
  return {
    childId: form.get("childId"),
    familyMode: form.get("familyMode"),
    unionId: form.get("unionId"),
    fromUnionId: form.get("fromUnionId"),
    relation: form.get("relation"),
    parentAId: form.get("parentAId"),
    parentBId: form.get("parentBId"),
  };
}
