import type { RetirementPreview } from "@/lib/retirement-preview";

/**
 * What the retirement confirmation *says* (E1-T10, `YEO-122`), as plain
 * strings.
 *
 * ## Why the sentences are a module and not JSX
 *
 * The split `lib/hatnote.ts`, `lib/person-infobox.ts` and
 * `lib/recent-changes-feed.ts` already draw, and here it is load-bearing
 * rather than tidy. The ticket says in as many words that **the copy is the
 * safety mechanism**: a reader decides whether to press the button on the
 * strength of these sentences, and every one of them is a claim about the
 * database that has to stay true as the code around it changes. "All 31 of its
 * saved versions are kept" is a promise; "The 3 photographs in it stay exactly
 * where they are" is a promise that `lib/image-references.ts` has to go on
 * keeping.
 *
 * Claims like that want assertions, and `components/EntryRetirement.tsx`
 * cannot carry them. It imports `retireEntryAction`, so mounting it drags a
 * `"use server"` module — and behind it Auth.js and `@/db` — into a suite that
 * has no `AUTH_*` and no `DATABASE_URL`. docs/testing.md names that trap and
 * names these components as the ones that still fall into it
 * (`NewEntryForm`, `EntryEditForm`, and `CategoryRemoval` beside them).
 *
 * Rather than restructure three components to fix it, the decision here is the
 * one this codebase makes everywhere else: the part worth testing is not the
 * markup, it is the *wording*, and the wording is a function of a plain value.
 * So it lives here, `lib/retirement-copy.test.ts` asserts it under `npm test`
 * where CI's `check` job can see it, and the component is left with a
 * paragraph and a button.
 *
 * ## The counting problem, in one place
 *
 * Five of these sentences change shape on a count — no entries link here, one
 * does, four do — and English does not let a template handle that. Written
 * inline they would be five nested ternaries in JSX, which is exactly where
 * "the 1 entries link to it" comes from. Here each is one function with its
 * cases side by side.
 */

/**
 * What retiring this entry takes it out of — the predicate only, without a
 * subject.
 *
 * The sentence it belongs to is "Retiring **Rose Hall** takes it out of…", and
 * the title is rendered in bold by the component, so returning the completed
 * sentence would mean either handing back markup or having the component cut
 * the subject back off a string. Neither is worth it for a phrase whose
 * interesting half is the ending anyway.
 *
 * The index and search are unconditional — they are what "retired" means — and
 * the categories are named as a count, because the listings themselves are
 * elsewhere and a reader cannot see them from the confirmation.
 */
export function describeDeparture(preview: RetirementPreview): string {
  const leaves =
    "takes it out of the index, out of search, and out of the recently-changed list";

  if (preview.categories.length === 0) {
    return `${leaves}.`;
  }

  if (preview.categories.length === 1) {
    return `${leaves}, and off the one category it is filed under.`;
  }

  return `${leaves}, and off the ${preview.categories.length} categories it is filed under.`;
}

/**
 * The consequence a reader cannot see from here, and the one worth putting
 * first.
 *
 * Returns the sentence *without* the names, which the component renders as
 * links — a list of titles in a string could not be clicked, and the whole
 * value of naming them rather than counting them is that somebody can go and
 * fix the prose. So this is the lead-in, and it ends in a colon when there is
 * a list to follow.
 */
export function describeIncomingLinks(preview: RetirementPreview): string {
  const count = preview.incomingLinks.length;

  if (count === 0) {
    return "No other entry links to it, so no link changes.";
  }

  if (count === 1) {
    return "One entry links to it, and that link will turn red:";
  }

  return `${count} entries link to it, and those links will turn red:`;
}

/**
 * The half that makes the button safe to press.
 *
 * Every clause is a fact about the write rather than a reassurance:
 * `lib/retire-page.ts` issues one `UPDATE` against two columns, so the
 * revisions, the photographs and `individuals.page_id` are untouched by
 * construction. The photographs clause in particular is the visible end of
 * §2 of the ticket — `lib/image-references.ts` keeps counting a retired
 * entry's body, so the sweep has nothing new to reclaim.
 *
 * The subject's name is included only when there is one: most entries in a
 * family wiki are about a place, an heirloom or a story, and a sentence about
 * somebody's place in the family tree would be a sentence about nobody.
 */
export function describeWhatIsKept(preview: RetirementPreview): string {
  const parts = ["Nothing is deleted."];

  parts.push(
    preview.revisionCount === 1
      ? "Its one saved version is kept, and its history stays readable."
      : `All ${preview.revisionCount} of its saved versions are kept, and its history stays readable.`,
  );

  if (preview.imageCount === 1) {
    parts.push("The photograph in it stays exactly where it is.");
  } else if (preview.imageCount > 1) {
    parts.push(
      `The ${preview.imageCount} photographs in it stay exactly where they are.`,
    );
  }

  if (preview.subjectName !== null) {
    parts.push(
      `${preview.subjectName}’s place in the family tree keeps its link to this entry, and gets it back with it.`,
    );
  }

  parts.push("It can be restored at any time, at this same address.");

  return parts.join(" ");
}
