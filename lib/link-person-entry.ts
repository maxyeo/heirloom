import { and, eq, ne } from "drizzle-orm";

import { db, schema } from "@/db";
import { createPageIn } from "@/lib/create-page";
import { formatPersonName } from "@/lib/person-format";
import { isRowId } from "@/lib/row-id";
import type { Transaction } from "@/lib/save-page";

/**
 * The write half of "open entry" / "create entry" (E2-T2, `YEO-25`): the one
 * place `individuals.page_id` is ever set or cleared.
 *
 * ## Why this is not in `app/tree/actions.ts`
 *
 * The same reason `lib/save-child.ts` and `lib/reorder-unions.ts` are not: a
 * `"use server"` module is a request handler, and what happens here is a
 * transaction. Keeping it in plain TypeScript over Drizzle is also what makes
 * it testable — `lib/link-person-entry.db.test.ts` calls these functions
 * directly against a real Postgres, with no session to fake and no Next.js
 * request scope to stand up. See docs/testing.md.
 *
 * ## Why creating and linking are one transaction
 *
 * `createEntryForPerson` writes three rows — the page, its first revision, and
 * the person's `page_id` — and the whole point is that they land together.
 * Creating the entry and then linking it as two statements leaves a window in
 * which an entry about Rose exists and Rose's panel still says nobody has
 * written about her; the author presses the button again and gets "Rose
 * Hale (2)". Inside one transaction there is no window, which is why
 * `lib/create-page.ts` grew `createPageIn`: the entry is still created by
 * E1-T8's code, joined to this transaction rather than opening its own, so
 * history starts exactly as it does for an entry begun from `/wiki/new`.
 *
 * ## Why the person's row is locked
 *
 * `for("update")` on the individual, held until commit, is what makes "does
 * this person already have an entry?" a question worth asking. Two clicks of
 * "Write about this person" — a double-press, or the same panel open in two
 * tabs — both read a null `page_id` without it, and both create an entry.
 * With it the second transaction blocks, re-reads the row the first committed
 * (READ COMMITTED re-evaluates after the lock is granted) and reports
 * `already-linked` instead. That is the same pattern `lib/save-page.ts` uses
 * for its no-op check, and it matters more here because the duplicate is not a
 * redundant history row but a whole second entry with its own address.
 *
 * ## Two locks, two different races
 *
 * The person's row orders two writes to the *same person*; the entry's row
 * orders two people reaching for the *same entry*. Both are needed and
 * neither substitutes for the other — see `setPersonEntry`, where the second
 * is taken. They are always acquired in that order, so nothing here can
 * deadlock against itself.
 *
 * ## Why unlinking is not a delete
 *
 * The ticket is explicit, and the schema already models it: `page_id` is
 * `on delete set null`, so the entry outliving the link is the shape the
 * column was designed for. Unlinking therefore writes exactly one null and
 * touches `pages` not at all — the entry keeps its address, its content and
 * its whole history, and `setPersonEntry` can put it back.
 */

/** Which person, and which entry — references, never content. */
export type SetPersonEntryInput = {
  personId: string;
  /** The entry to link, or null to unlink without touching it. */
  pageId: string | null;
};

/**
 * How linking or unlinking ends.
 *
 * `unchanged` is an ordinary outcome rather than a fault: it is the author
 * pressing a button twice, or asking to unlink a person who is already
 * unlinked. Every refusal names *which* reference failed, because the panel
 * can say something useful about each — the person is gone, the entry is
 * gone, or somebody else already has it.
 */
export type SetPersonEntryResult =
  | { status: "linked"; slug: string; title: string }
  | { status: "unlinked" }
  | { status: "unchanged" }
  | { status: "person-not-found" }
  | { status: "entry-not-found" }
  | { status: "entry-taken"; personName: string };

/**
 * How starting an entry for a person ends.
 *
 * `already-linked` carries the slug, so the action can send the author to the
 * entry that already exists rather than reporting a race they did not cause.
 */
export type CreateEntryForPersonResult =
  | { status: "created"; pageId: string; slug: string; revisionId: string }
  | { status: "already-linked"; slug: string }
  | { status: "person-not-found" }
  | { status: "no-name" };

/**
 * The person's row, as both operations need to read it.
 *
 * `for("update")` rather than a plain select, for the reason the module header
 * gives: the check that follows is only trustworthy if nothing can change the
 * row between reading it and writing it.
 */
async function lockPerson(tx: Transaction, personId: string) {
  const [person] = await tx
    .select({
      id: schema.individuals.id,
      givenName: schema.individuals.givenName,
      surname: schema.individuals.surname,
      pageId: schema.individuals.pageId,
    })
    .from(schema.individuals)
    .where(eq(schema.individuals.id, personId))
    .for("update");

  return person;
}

/**
 * Start an entry about somebody, pre-titled with their name.
 *
 * The title is not a parameter, and that is the point of the flow: the entry
 * is about this person, so it is titled from the row rather than from anything
 * the browser sent. A direct POST can name a person; it cannot name what the
 * entry about them is called. The address follows from the title inside
 * `createPageIn`, so it cannot be chosen here either.
 *
 * @param input the person, plus the email to attribute the entry to
 * @returns the outcome, including the slug to send the author to
 */
export async function createEntryForPerson(input: {
  personId: string;
  createdBy: string;
}): Promise<CreateEntryForPersonResult> {
  // A malformed id reaches Postgres as `invalid input syntax for type uuid`,
  // which throws rather than returning no rows. See `lib/row-id.ts`.
  if (!isRowId(input.personId)) return { status: "person-not-found" };

  return db.transaction(async (tx): Promise<CreateEntryForPersonResult> => {
    const person = await lockPerson(tx, input.personId);
    if (!person) return { status: "person-not-found" };

    if (person.pageId) {
      /**
       * Somebody linked this person while the panel was open — the other tab,
       * or the other half of a double-press. Read the address back rather than
       * reporting a failure: what the author asked for is an entry about this
       * person, and there is one.
       */
      const [existing] = await tx
        .select({ slug: schema.pages.slug })
        .from(schema.pages)
        .where(eq(schema.pages.id, person.pageId));

      // A `page_id` pointing at nothing cannot survive `on delete set null`,
      // so this is unreachable short of a manual `UPDATE`. Falling through to
      // create the entry is the recovery, not an error.
      if (existing) return { status: "already-linked", slug: existing.slug };
    }

    /**
     * `given_name` is `not null` and `validateIndividual` refuses a blank one,
     * so a person with no name at all is not a state this application can
     * write. Checked anyway rather than assumed, because the alternative is
     * `createPageIn` returning `empty-title` and this function having to
     * explain an outcome about titles for a flow with no title field.
     */
    const title = formatPersonName(person.givenName, person.surname);
    if (!title.trim()) return { status: "no-name" };

    const page = await createPageIn(tx, { title, createdBy: input.createdBy });

    // Unreachable: the title is non-empty by the check above, and that is the
    // only refusal `createPageIn` has. The branch is here so the compiler can
    // narrow, rather than because there is a case to handle.
    if (page.status === "empty-title") return { status: "no-name" };

    await tx
      .update(schema.individuals)
      .set({ pageId: page.pageId })
      .where(eq(schema.individuals.id, person.id));

    return {
      status: "created",
      pageId: page.pageId,
      slug: page.slug,
      revisionId: page.revisionId,
    };
  });
}

/**
 * Point a person at an existing entry, or at none.
 *
 * Both directions are one function because they are one column and one rule:
 * the value is either an entry's id or null. Two endpoints call it
 * (`app/tree/actions.ts`), so that a form can never post its way from one
 * meaning to the other by leaving a field out.
 *
 * @param input which person, and which entry — or null to unlink
 * @returns the outcome, including the entry's address when one was linked
 */
export async function setPersonEntry(
  input: SetPersonEntryInput,
): Promise<SetPersonEntryResult> {
  if (!isRowId(input.personId)) return { status: "person-not-found" };
  if (input.pageId !== null && !isRowId(input.pageId)) {
    return { status: "entry-not-found" };
  }

  return db.transaction(async (tx): Promise<SetPersonEntryResult> => {
    const person = await lockPerson(tx, input.personId);
    if (!person) return { status: "person-not-found" };

    if (person.pageId === input.pageId) return { status: "unchanged" };

    if (input.pageId === null) {
      await tx
        .update(schema.individuals)
        .set({ pageId: null })
        .where(eq(schema.individuals.id, person.id));

      return { status: "unlinked" };
    }

    /**
     * `for("update")` on the *entry*, and this is the lock that makes the
     * one-entry-one-person check below mean anything.
     *
     * `lockPerson` above holds the acting person's row, which orders two
     * writes to the same person and nothing else. The race that matters here
     * is a different shape: Rose's panel and Thomas's panel, each linking to
     * the same entry at the same moment. Those are two transactions holding
     * two *different* individual rows, so without a lock on something they
     * share they both read "nobody has this entry" and both write it —
     * producing exactly the state this check exists to prevent. Postgres runs
     * at READ COMMITTED, so a plain `SELECT` is no defence: neither
     * transaction can see the other's uncommitted row.
     *
     * The entry is the thing they share, so it is the thing to lock. The
     * second transaction blocks here, then re-reads after the lock is granted
     * (READ COMMITTED re-evaluates once the lock is held) and correctly finds
     * the entry taken. Locks are always taken person-first then entry, in both
     * of this module's functions, so there is no cycle to deadlock on.
     */
    const [entry] = await tx
      .select({ slug: schema.pages.slug, title: schema.pages.title })
      .from(schema.pages)
      .where(eq(schema.pages.id, input.pageId))
      .for("update");

    if (!entry) return { status: "entry-not-found" };

    /**
     * One entry, one person — the rule lives here, in the only code that
     * writes the column, rather than in `db/schema.ts`.
     *
     * A unique index on `individuals.page_id` would express it in the database
     * and would apply cleanly: Postgres treats every `NULL` as distinct, so a
     * column that is null on every existing row cannot violate it. It is not
     * in this ticket because a migration is a deploy-ordering commitment
     * (docs/architecture.md) and the lock above already closes the race — but
     * it is the right home for the rule, and E2-T3 is the ticket that reads
     * this link from the other end and will care most.
     *
     * It is worth having rather than pedantry: an entry two people claim has
     * no single answer to "view in tree".
     */
    const [taken] = await tx
      .select({
        givenName: schema.individuals.givenName,
        surname: schema.individuals.surname,
      })
      .from(schema.individuals)
      .where(
        and(
          eq(schema.individuals.pageId, input.pageId),
          ne(schema.individuals.id, person.id),
        ),
      )
      .limit(1);

    if (taken) {
      return {
        status: "entry-taken",
        personName: formatPersonName(taken.givenName, taken.surname),
      };
    }

    await tx
      .update(schema.individuals)
      .set({ pageId: input.pageId })
      .where(eq(schema.individuals.id, person.id));

    return { status: "linked", slug: entry.slug, title: entry.title };
  });
}
