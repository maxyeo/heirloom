import { readEnum, readText, withoutPrefix } from "./field-input";
import {
  type IndividualFields,
  type IndividualInput,
  individualInputFromFormData,
  type ValidationIssue,
  validateIndividual,
} from "./individual-input";
import { isRowId } from "./row-id";

/**
 * The one place a child↔union link is checked before it becomes a row
 * (E3-T5, `YEO-33`).
 *
 * ## The same shape as `lib/union-input.ts`, for the same reason
 *
 * `union_children` is the third table the app writes to, and it has the same
 * problem the first two had: several doors lead to the insert and only one of
 * them is a request. The add-child form comes through `app/tree/actions.ts`;
 * E3-T6's set-parents attaches an existing person to an existing union from
 * its own flow; and **E6-T2's GEDCOM import** maps every `CHIL` line onto one
 * of these rows with no session, no `FormData`, and no request scope at all.
 *
 * So nothing in this file may touch `headers()`, `cookies()`, `@/db`, or any
 * other ambient state. Its imports are `lib/field-input.ts`,
 * `lib/individual-input.ts` and `lib/row-id.ts`, which are themselves pure —
 * the whole chain can be called from a loop, a script, a test, or a server
 * action and behave identically in all four.
 *
 * ## Why the relation is a field of the link
 *
 * `union_children.relation` says how this child came into *this* family, not
 * what kind of person they are. That is the distinction the whole data model
 * rests on (docs/architecture.md): a boy adopted by his stepfather is
 * biological to one union and adopted into another, and the two facts are two
 * rows rather than one contradictory column on `individuals`. Anything that
 * put `relation` on the person would make the second row unrecordable and the
 * first one a lie.
 *
 * ## Why "half-sibling" is not in this file
 *
 * Because it is not a fact anybody enters. Two children of two unions sharing
 * one partner *are* half-siblings, and `lib/person-detail.ts` reads that back
 * out of the rows written here without either of them being marked. There is
 * no relationship type to store, no flag to set, and nothing in this validator
 * that has to know the difference — which is exactly the property the union
 * model was chosen for.
 */

/**
 * The values `union_children.relation` accepts, mirroring the `child_relation`
 * enum in `db/schema.ts`.
 *
 * Re-declared rather than derived from the Drizzle table for the reason
 * `UNION_TYPES` gives: importing the schema, even for a type, drags
 * postgres.js into every consumer — including a form component and a test with
 * no `DATABASE_URL`.
 *
 * `biological` is first and is the fallback for an absent value, matching the
 * column's own default. It is nonetheless a *field* on the form rather than a
 * default left to the database, for the reason the add-spouse form gives about
 * `type`: a link silently recorded as biological looks exactly like one
 * somebody chose, right up until it is exported.
 */
export const CHILD_RELATIONS = [
  "biological",
  "adopted",
  "step",
  "foster",
] as const;

export type ChildRelation = (typeof CHILD_RELATIONS)[number];

/**
 * A child↔union link, cleaned and ready to be written.
 *
 * The field names are the Drizzle column names, so the value goes straight
 * into `db.insert(schema.unionChildren).values(...)` with nothing to map.
 *
 * `childId` is nullable here and `not null` in the database, and the gap is
 * deliberate: in `new` mode the person does not exist yet, so the only honest
 * value at validation time is "not yet known". `lib/save-child.ts` fills it in
 * from the insert it does first, inside the same transaction. This is the same
 * split `UnionFields.partnerBId` makes for an inline partner.
 */
export type ChildLinkFields = {
  /** The `unions.id` this child was born, adopted, or fostered into. */
  unionId: string;
  /** An `individuals.id`, or null when the child is created with the link. */
  childId: string | null;
  relation: ChildRelation;
};

/** The name of a field a problem can be attached to. */
export type ChildLinkField = keyof ChildLinkFields;

/**
 * A child↔union link as it arrives: one property per field, every value
 * `unknown`.
 *
 * `unknown` rather than `string` for the reason `UnionInput` gives: the values
 * come from a `FormData` entry (`string | File | null`), from a GEDCOM record,
 * or from a POST somebody hand-crafted, so "it is a string" is a conclusion
 * `validateChildLink` reaches rather than a premise a caller may assert.
 */
export type ChildLinkInput = {
  [Field in ChildLinkField]?: unknown;
};

/**
 * One problem with one field, in words meant for the person who typed it.
 *
 * Separate from `ValidationIssue` and from `UnionValidationIssue` rather than
 * generic over the field name, because the add-child flow validates a person
 * and a link in the same submission and the form has to render each message
 * beside the right control.
 */
export type ChildValidationIssue = {
  field: ChildLinkField;
  /** A complete sentence, safe to render directly. */
  message: string;
};

/**
 * Problems keyed by field, which is the shape a form actually renders. At most
 * one message per field — the first one found.
 */
export type ChildFieldErrors = Partial<Record<ChildLinkField, string>>;

/**
 * Either a clean link or the reasons there isn't one. Never both.
 *
 * A discriminated union rather than `{ value, issues }` with one of them
 * empty, so a caller cannot write the value without having checked.
 */
export type ChildValidation =
  | { ok: true; value: ChildLinkFields }
  | { ok: false; issues: ChildValidationIssue[] };

/**
 * Check and clean one child↔union link.
 *
 * Pure: no database, no session, no request. Every field is examined even
 * after one has failed, so an author fixing a form sees everything that is
 * wrong with it in one pass.
 *
 * Whether the union and the child are rows that exist — and whether the child
 * is already one of that union's partners — are database questions, and they
 * live in `lib/save-child.ts`. What is settled here is only what can be
 * settled from the value itself.
 *
 * @param input the link as it arrived, untrusted and untyped
 * @returns the cleaned link, or every problem found
 */
export function validateChildLink(input: ChildLinkInput): ChildValidation {
  const issues: ChildValidationIssue[] = [];

  /**
   * The union is the *whole* answer to "whose child is this", so an absent one
   * is not a field left blank — it is the question unanswered. This is the
   * ticket's "choose which union the child belongs to", and it is required
   * unconditionally rather than only when the parent has more than one: a form
   * that fills it in for you when there is exactly one union is doing the
   * author a favour, but a validator that guessed would attach a child to
   * whichever union happened to sort first.
   */
  const unionId = readText(input.unionId);
  if (unionId === null || unionId === undefined) {
    issues.push({
      field: "unionId",
      message: "Choose which family this child belongs to.",
    });
  } else if (!isRowId(unionId)) {
    issues.push({
      field: "unionId",
      message: "That is not a family this tree can add a child to.",
    });
  }

  /**
   * Null is legal and means "created alongside this link". Anything present
   * but not shaped like a row id is checked here so that it becomes a message
   * beside the picker rather than `invalid input syntax for type uuid` thrown
   * out of the driver.
   */
  const childId = readText(input.childId);
  if (childId === undefined || (childId !== null && !isRowId(childId))) {
    issues.push({
      field: "childId",
      message: "That is not a person this tree can record as a child.",
    });
  }

  const relation = readEnum(input.relation, CHILD_RELATIONS, "biological");
  if (relation === undefined) {
    issues.push({
      field: "relation",
      message: "Say whether this child is biological, adopted, step, or foster.",
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  /**
   * Every branch that could leave one of these unusable pushed an issue and
   * was caught by the check above, but TypeScript cannot see that across a
   * length comparison. Narrowing rather than casting; none of the three throws
   * is reachable, and all three are cheaper than an `as`.
   */
  if (unionId === null || unionId === undefined) {
    throw new Error("unreachable: a missing union is an issue");
  }
  if (childId === undefined) {
    throw new Error("unreachable: an unusable child id is an issue");
  }
  if (relation === undefined) {
    throw new Error("unreachable: an unknown relation is an issue");
  }

  return { ok: true, value: { unionId, childId, relation } };
}

/**
 * Collapse a list of issues into one message per field.
 *
 * The list is what an importer wants (every problem, in order, for a report);
 * this is what a form wants (a message to hang under each control). First
 * issue wins per field, matching the order `validateChildLink` finds them in.
 *
 * Named for children rather than exported as `fieldErrorsFrom` because
 * `lib/individual-input.ts` already exports that name, and the add-child
 * action calls both in the same breath.
 */
export function childFieldErrorsFrom(
  issues: readonly ChildValidationIssue[],
): ChildFieldErrors {
  const errors: ChildFieldErrors = {};
  for (const issue of issues) {
    errors[issue.field] ??= issue.message;
  }
  return errors;
}

/**
 * Pull a link's fields out of a submitted form.
 *
 * The input names are the property names of `ChildLinkFields`, so a form
 * writes `name="unionId"` and nothing has to be mapped or renamed.
 *
 * A web API, not a Next.js one: `FormData` is a global in Node 18+, so this is
 * callable from a script or a test with no request in sight.
 */
export function childLinkInputFromFormData(form: FormData): ChildLinkInput {
  return {
    unionId: form.get("unionId"),
    childId: form.get("childId"),
    relation: form.get("relation"),
  };
}

/**
 * How the add-child flow says who the child is.
 *
 * Two answers rather than the partner picker's three, and the missing one is
 * `unknown`. A union may legitimately record only one partner — that is what
 * both nullable partner columns are for — but a child link with no child is
 * not a row `union_children` can hold, and "somebody was born and we do not
 * know who" records nothing that anybody could later correct.
 *
 * An explicit mode rather than inferring one from which fields arrived: a form
 * posts every input it contains, so "the new-person fields are blank" and "the
 * author chose somebody from the list" are indistinguishable by presence.
 */
export const CHILD_MODES = ["existing", "new"] as const;

export type ChildMode = (typeof CHILD_MODES)[number];

/** The prefix the add-child form gives its inline-child inputs. */
export const CHILD_FIELD_PREFIX = "child.";

/**
 * One submission of the add-child form, still untrusted.
 *
 * Note what is *not* here: the parent. A child belongs to a union, and the
 * union names its own partners — so the flow needs no `personId`, and a
 * submission cannot disagree with itself about who the parents are. That is
 * also what makes this input reusable by E3-T6's set-parents, which attaches
 * an existing person to an existing union from the other end entirely.
 */
export type AddChildInput = {
  /** Which of the two answers the picker gave. */
  childMode: unknown;
  /** An existing person's id, read only when the mode is `existing`. */
  childId: unknown;
  /** Details for a person to create, read only when the mode is `new`. */
  child: IndividualInput;
  /**
   * The link's own fields. Its `childId` is ignored — it is decided by the
   * mode above, so a hand-made POST cannot use one field to contradict the
   * other.
   */
  link: ChildLinkInput;
};

/**
 * Pull one add-child submission out of a form.
 */
export function addChildInputFromFormData(form: FormData): AddChildInput {
  return {
    childMode: form.get("childMode"),
    childId: form.get("childId"),
    child: individualInputFromFormData(withoutPrefix(form, CHILD_FIELD_PREFIX)),
    link: childLinkInputFromFormData(form),
  };
}

/**
 * Either everything the add-child flow needs to write, or every problem with
 * it. Never both.
 *
 * `child` is the person to create and is non-null only in `new` mode.
 * `link.childId` is null in `new` mode too, because the id does not exist yet;
 * `lib/save-child.ts` fills it in from the insert it does first.
 */
export type AddChildValidation =
  | {
      ok: true;
      mode: ChildMode;
      child: IndividualFields | null;
      link: ChildLinkFields;
    }
  | {
      ok: false;
      linkIssues: ChildValidationIssue[];
      childIssues: ValidationIssue[];
    };

/**
 * Check one add-child submission: the link, and the child if one is being
 * created with it.
 *
 * Pure, and both halves are checked even when the first has already failed —
 * the same rule `validateAddSpouse` follows, and for the same reason: an
 * author who forgot to choose a union *and* left the new child's name blank
 * should see both, not discover the second after fixing the first.
 *
 * The two issue lists stay separate all the way to the form, because both
 * records have a `notes` field and a single keyed map could not say which one
 * a message belonged to.
 */
export function validateAddChild(input: AddChildInput): AddChildValidation {
  const linkIssues: ChildValidationIssue[] = [];
  const childIssues: ValidationIssue[] = [];

  const mode = readEnum(input.childMode, CHILD_MODES, "existing");

  /**
   * Reported against `childId` because that is the control the author touched.
   * A mode this module does not recognise cannot come from the form — it is a
   * hand-made POST or a bug — so the message says what a valid submission
   * looks like rather than trying to explain the value.
   */
  if (mode === undefined) {
    linkIssues.push({
      field: "childId",
      message: "Choose a child from the tree, or add them as a new person.",
    });
  }

  /**
   * In `existing` mode the id is the whole answer, so a blank one is the
   * author having opened the picker and chosen nobody. Without this the link
   * would validate as an inline creation and quietly write a nameless person.
   */
  if (mode === "existing" && readText(input.childId) === null) {
    linkIssues.push({
      field: "childId",
      message: "Choose the child from the list, or add them as a new person.",
    });
  }

  const childChecked = mode === "new" ? validateIndividual(input.child) : null;
  if (childChecked && !childChecked.ok) childIssues.push(...childChecked.issues);

  /**
   * `childId` is overwritten rather than read from `input.link`. Which person
   * the link points at is decided by the picker and the mode, so a submission
   * carrying both cannot use one to contradict the other.
   */
  const linkChecked = validateChildLink({
    ...input.link,
    childId: mode === "existing" ? input.childId : null,
  });
  if (!linkChecked.ok) linkIssues.push(...linkChecked.issues);

  if (linkIssues.length > 0 || childIssues.length > 0) {
    return { ok: false, linkIssues, childIssues };
  }

  /**
   * Both `ok` branches were taken above, but TypeScript cannot see that across
   * the length checks, so this narrows rather than casts. Neither throw is
   * reachable; both are cheaper than an `as`.
   */
  if (!linkChecked.ok) throw new Error("unreachable: link issues were empty");
  if (childChecked && !childChecked.ok) {
    throw new Error("unreachable: child issues were empty");
  }

  return {
    ok: true,
    mode: mode ?? "existing",
    child: childChecked ? childChecked.value : null,
    link: linkChecked.value,
  };
}
