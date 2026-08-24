import { eq } from "drizzle-orm";

import { db, schema } from "@/db";
import {
  type IndividualFields,
  type IndividualInput,
  type ValidationIssue,
  validateIndividual,
} from "@/lib/individual-input";
import { isRowId } from "@/lib/row-id";

/**
 * The write half of tree editing for people (E3-T1, `YEO-29`): raw input
 * becomes a validated `individuals` row, or it becomes a list of problems.
 *
 * ## Why validation happens in here rather than in the caller
 *
 * `app/tree/actions.ts` is the `"use server"` entry point — it authenticates
 * and revalidates, and it is one of several doors onto this operation. The
 * others are E3-T4's add-spouse flow, E3-T5's add-child flow, and E6-T2's
 * GEDCOM import, none of which go through that action. A check that lives on
 * one door is a check somebody forgets to fit to the next one, which is the
 * same argument `lib/restore-revision.ts` makes for keeping its guards out of
 * the wiki action. So these functions take *untrusted* input and validate it
 * themselves: there is no way to reach the insert without passing the rules.
 *
 * ## Why this is not in the server action either
 *
 * The same reason `lib/save-page.ts` is not: everything below is plain
 * TypeScript over Drizzle, so `lib/save-individual.db.test.ts` calls it
 * directly against a real Postgres with no session to fake and no request
 * scope to stand up. See docs/testing.md.
 *
 * ## Why there is no revision history here
 *
 * Entries have revisions because their content is *prose*, which someone
 * spends an evening writing and can lose. A person's record is ten short
 * fields, and E3-T8 (`YEO-36`) is where deletion — the operation actually
 * worth confirming — gets its treatment. Adding a history table for a
 * birthplace typo would be a schema nobody asked for; if it is wanted later,
 * it is an additive migration, not a change to this shape.
 */

/** Every way creating a person can end. */
export type CreateIndividualResult =
  | { status: "created"; id: string }
  | { status: "invalid"; issues: ValidationIssue[] };

/**
 * Every way updating a person can end.
 *
 * `unchanged` is not a failure and `not-found` is not an exception — the
 * first is somebody pressing save twice, the second is a person deleted in
 * another tab (E3-T8 makes that reachable). Both are states a form renders.
 * A genuine fault — the database unreachable, a constraint violated — still
 * throws, exactly as in `lib/save-page.ts`.
 */
export type UpdateIndividualResult =
  | { status: "updated"; id: string }
  | { status: "unchanged"; id: string }
  | { status: "not-found" }
  | { status: "invalid"; issues: ValidationIssue[] };

/**
 * Every field a person's record consists of, for the no-op check below.
 *
 * Written as the keys of a `Record` rather than as a bare array so that it is
 * exhaustive *by construction*: the object literal cannot omit a field of
 * `IndividualFields` and cannot invent one, both of which `satisfies`
 * reports as type errors here. A plain list would compile perfectly well
 * while quietly no longer looking at a column somebody added — and the
 * symptom would be an edit that reports "nothing changed" and discards itself.
 *
 * The cast is `Object.keys` returning `string[]` — a known gap in its
 * signature, since TypeScript cannot promise a value has no extra keys at
 * runtime. Here the literal is right above it, so the narrower type is a fact
 * rather than a hope.
 */
const FIELD_NAMES = Object.keys({
  givenName: true,
  surname: true,
  sex: true,
  birthDate: true,
  birthDateQualifier: true,
  birthPlace: true,
  deathDate: true,
  deathDateQualifier: true,
  deathPlace: true,
  notes: true,
} satisfies Record<keyof IndividualFields, true>) as (keyof IndividualFields)[];

/**
 * Create a person.
 *
 * @param input the details as they arrived, untrusted and untyped
 * @returns the new person's id, or every problem with the input
 */
export async function createIndividual(
  input: IndividualInput,
): Promise<CreateIndividualResult> {
  const checked = validateIndividual(input);
  if (!checked.ok) return { status: "invalid", issues: checked.issues };

  /**
   * No uniqueness check, deliberately. Two people in one family really can
   * share a name — a son named for his father is the most ordinary thing in
   * genealogy — so a name collision is not evidence of a duplicate, and
   * refusing the second one would make the common case unrepresentable.
   * Merging genuine duplicates is out of scope for this epic by name (see
   * docs/epics.md, "Not in this epic").
   */
  const [created] = await db
    .insert(schema.individuals)
    .values(checked.value)
    .returning({ id: schema.individuals.id });

  return { status: "created", id: created.id };
}

/**
 * Update a person.
 *
 * The id is a *reference* the caller is entitled to name; every other field
 * is the caller's change. That split is what the Next.js server-actions guide
 * asks for, and here it is also all the authorisation there is to do: every
 * signed-in user may edit every person, because `ALLOWED_EMAILS` is the whole
 * membership model (see `lib/session.ts`) and there is no per-row ownership
 * to check against.
 *
 * @param id the person to update, as it arrived — checked, not trusted
 * @param input the new details, untrusted and untyped
 * @returns what happened, including whether anything actually changed
 */
export async function updateIndividual(
  id: string,
  input: IndividualInput,
): Promise<UpdateIndividualResult> {
  /**
   * `individuals.id` is a `uuid` column, and this id came from a hidden form
   * field or a direct POST. Handing a non-UUID to `eq` reaches Postgres,
   * which raises `invalid input syntax for type uuid` — a thrown error rather
   * than a query returning no rows. Checking the shape first turns a bad id
   * into the ordinary `not-found` the caller already handles. See
   * `lib/row-id.ts`.
   */
  if (!isRowId(id)) return { status: "not-found" };

  const checked = validateIndividual(input);
  if (!checked.ok) return { status: "invalid", issues: checked.issues };

  const [existing] = await db
    .select({
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      sex: schema.individuals.sex,
      birthDate: schema.individuals.birthDate,
      birthDateQualifier: schema.individuals.birthDateQualifier,
      birthPlace: schema.individuals.birthPlace,
      deathDate: schema.individuals.deathDate,
      deathDateQualifier: schema.individuals.deathDateQualifier,
      deathPlace: schema.individuals.deathPlace,
      notes: schema.individuals.notes,
    })
    .from(schema.individuals)
    .where(eq(schema.individuals.id, id));

  // Creating a person is `createIndividual`'s job. No row for this id means it
  // was deleted, or that somebody POSTed here directly.
  if (!existing) return { status: "not-found" };

  /**
   * Compared against the values that would actually be written — after
   * trimming and normalising — so `unchanged` means "the row would not move"
   * rather than "the author retyped the same thing". A blank place field that
   * was already null therefore counts as unchanged, which is what stops an
   * edit form that was opened and closed from reporting a save.
   *
   * No `FOR UPDATE` here, unlike `lib/save-page.ts`. That lock exists there to
   * stop two concurrent saves of identical content from both writing a
   * *revision* — an extra row in an append-only history that nothing can
   * remove. There is no history table under this one, so the worst a lost
   * race can do is issue a redundant `UPDATE` that sets a row to the values
   * it already holds. Taking a row lock to avoid that would cost every edit a
   * lock for a saving nobody can observe.
   *
   * The select above is checked by this loop rather than by inspection: a
   * column left out of it makes `existing[field]` a type error, so the query
   * and the field set cannot drift apart.
   */
  const unchanged = FIELD_NAMES.every(
    (field) => existing[field] === checked.value[field],
  );
  if (unchanged) return { status: "unchanged", id };

  await db
    .update(schema.individuals)
    .set(checked.value)
    .where(eq(schema.individuals.id, id));

  return { status: "updated", id };
}
