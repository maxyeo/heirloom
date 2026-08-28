import type { RetirementPreview } from "@/lib/retirement-preview";

/**
 * The sentences retirement makes true or false (E1-T10, `YEO-122`;
 * `YEO-126`), as plain strings.
 *
 * Most of them are the retirement confirmation's, which is where this module
 * started and what the reasoning below is about. The last of them belongs to a
 * page that outlives the retirement rather than to the button that causes it,
 * and it is here for the same reason the rest are: see
 * {@link describeDivergenceFromCurrent}.
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
 * keeps the list of components that fall into it; this one and
 * `EntryRestoration` are on it, with `NewEntryForm`, `EntryEditForm` and
 * `CategoryRemoval` beside them.
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

  /**
   * Silent at zero, the same way the photographs clause below is silent at
   * zero. "All 0 of its saved versions are kept" is ungrammatical, and "its
   * history stays readable" would be a promise about an empty tab; "Nothing is
   * deleted." already says the whole of what is true of a row with no history.
   *
   * No path through this application produces one — `createPageIn` writes the
   * first revision in the same transaction as the entry, and `db/seed.ts`
   * deliberately does the same so that the seeded database keeps the invariant
   * the application maintains. The case is handled anyway because this module
   * renders whatever the read hands it: a row can arrive another way (a
   * hand-run `INSERT`, a restore that brought `pages` back without
   * `revisions`, and every `.db.test.ts` fixture here that inserts `pages`
   * directly), and `readRetirementPreviewIn` already defaults its aggregate to
   * `0`. A count this sentence assumed rather than checked is the exact drift
   * the copy exists to prevent. See {@link RetirementPreview.revisionCount}.
   */
  if (preview.revisionCount === 1) {
    parts.push(
      "Its one saved version is kept, and its history stays readable.",
    );
  } else if (preview.revisionCount > 1) {
    parts.push(
      `All ${preview.revisionCount} of its saved versions are kept, and its history stays readable.`,
    );
  }

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

/**
 * What the historical banner on `/wiki/[slug]/history/[revisionId]` says about
 * the version this one is not (`YEO-126`) — or nothing, when there is no such
 * version.
 *
 * The one sentence here that belongs to a page rather than to the button.
 * Retiring an entry does not only change what the confirmation has to promise;
 * it changes what the three pages that outlive the retirement are entitled to
 * say. Most of that is `components/RetiredEntryNotice.tsx`'s job — markup with
 * a slot for one sentence. This is the remainder: a claim already written into
 * a page, which retirement quietly turns into a lie.
 *
 * The sentence is MediaWiki's, and it is the one `YEO-123` was filed over:
 * "It may differ significantly from the current version", above a retired
 * entry, promises an article at an address that now answers with a tombstone.
 * `YEO-123` put the retirement notice above the banner and stopped the link
 * below it calling that tombstone a version, and left the sentence between
 * them saying what it had always said — three panels, two of which knew about
 * the retirement.
 *
 * ## Why it is dropped rather than reworded
 *
 * Because the banner's first sentence is still exactly true — this *is* an old
 * revision, saved then, by them — and it is the whole of what the banner has
 * to say once there is no current version to be measured against. Any
 * replacement clause would be a third statement of the retirement on one page,
 * directly under a panel that has just made it and directly above a link that
 * was renamed for it. Returning `null` is the difference between a banner that
 * has stopped promising something and a banner that has started explaining
 * itself.
 *
 * ## Why it is a function here rather than a ternary there
 *
 * For the reason the rest of this module gives. The claim is about the
 * database, the route rendering it is an async Server Component that nothing
 * in `npm test` can mount, and docs/testing.md's "prefer no DOM" says a
 * decision that can be a plain value should be one.
 * `lib/pages.route-decisions.test.ts` can see that the route reads
 * `deletedAt`; only an assertion on this can see what it then says.
 *
 * `app/wiki/[slug]/history/compare/page.tsx` was checked for the same sentence
 * and has none: it names its two ends and makes no claim about a third
 * version, so `YEO-123`'s relabelled link was the whole of what it said about
 * the live address.
 */
export function describeDivergenceFromCurrent(
  deletedAt: Date | null,
): string | null {
  if (deletedAt !== null) return null;

  return "It may differ significantly from the current version.";
}
