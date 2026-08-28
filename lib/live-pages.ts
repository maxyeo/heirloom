import { isNull, not } from "drizzle-orm";

import { schema } from "@/db";

/**
 * The one predicate that separates a live entry from a retired one (E1-T10,
 * `YEO-122`).
 *
 * ## Why a shared constant and not `isNull(schema.pages.deletedAt)` inline
 *
 * Because there are a dozen places that have to say it, and the failure of
 * saying it in eleven of them is invisible. A retired entry that goes on
 * appearing in search, in the index, in a category listing or in the tree's
 * entry links does not throw, does not log, and does not look wrong to anybody
 * who was not told the entry had been retired — it looks exactly like an entry
 * nobody retired. That is the shape of defect this repository already answers
 * with a tripwire rather than with care, and `lib/pages.call-sites.test.ts` is
 * this one's: no module may name `schema.pages` without naming this predicate,
 * bar two that are exempt for stated reasons.
 *
 * A tripwire needs something to look *for*, and that is the other half of why
 * this is a named export rather than a three-word expression. `LIVE_PAGES` is
 * a token a source scan can find; `isNull(schema.pages.deletedAt)` is a shape,
 * and a scan for a shape is a scan somebody defeats by reformatting.
 *
 * ## Why its own module rather than `lib/pages.ts`
 *
 * `lib/pages.ts` is the entry *reads* — it pulls in `lib/entry-search.ts`,
 * `lib/entry-link.ts` and `lib/page-index.ts`, none of which
 * `lib/categories.ts`, `lib/namesakes.ts` or `lib/entry-infobox.ts` have any
 * business loading in order to filter a join. Six modules import this and one
 * of them is a write path inside a transaction; a predicate that dragged the
 * full-text search snippet options in behind it would be paying for the
 * convenience of a shorter import list.
 *
 * It also keeps the tripwire honest in a way a re-export could not. If this
 * lived in `lib/pages.ts`, a module could name `schema.pages` and satisfy the
 * scan by importing something else from the same file; here, the only reason
 * to name `LIVE_PAGES` is to use it.
 *
 * ## Why `is null` rather than a `deleted` boolean
 *
 * `db/schema.ts` argues the column; the consequence for this file is that
 * "live" is the *absence* of a timestamp, so the predicate is `IS NULL` and
 * not a comparison. That matters at one place in particular: Postgres treats
 * `NULL IS NULL` as true, so a `LEFT JOIN` that finds no row at all also
 * satisfies this. `lib/namesakes.ts` puts the predicate in its `ON` clause
 * rather than its `WHERE` for exactly that reason — it wants the namesake with
 * no entry and the namesake with a retired one to arrive the same way, as a
 * name with a null slug, and relying on the null-propagation to do it in a
 * `WHERE` would be the same answer reached by an accident nobody could read.
 *
 * ## What is *not* filtered, and why the list is short
 *
 * Two modules must see retired entries, and both are named with their reasons
 * in `lib/pages.call-sites.test.ts`. The one worth repeating anywhere anybody
 * might read it is `lib/image-references.ts`: a retired entry's body still
 * counts as a reference to the photographs in it, because if it did not, the
 * next `npm run db:images-sweep --delete` would reclaim files the nightly
 * backup does not carry — and the restore months later would bring back a body
 * pointing at pictures that no longer exist.
 */
export const LIVE_PAGES = isNull(schema.pages.deletedAt);

/**
 * The opposite question, asked in exactly one place: is there a *retired*
 * entry at this address?
 *
 * `lib/create-page.ts` needs it for §4 of the ticket — an author re-typing the
 * title of an entry somebody retired is offered it back rather than handed a
 * near-twin at `rose-whitfield-2` that nothing would ever tell them about.
 * That is the only caller, and it would be reasonable to ask why a second
 * export exists for one use.
 *
 * Two reasons, and the second is the one that made it an export rather than a
 * line in that file.
 *
 * **It is derived, not restated.** `not(LIVE_PAGES)` rather than
 * `isNotNull(schema.pages.deletedAt)`, so there is one definition of what
 * "live" means and the two directions cannot drift into disagreeing about it.
 * Written out separately, a later change to what retirement looks like — a
 * third state, a `purged_at` beside it — would have to be made twice, and the
 * half that was missed would be the half that decides whether somebody is
 * offered their entry back.
 *
 * **It keeps `lib/create-page.ts` honest with the tripwire.** That module
 * names `schema.pages` in order to insert into it, so
 * `lib/pages.call-sites.test.ts` requires it to name a predicate from here.
 * With only `LIVE_PAGES` to reach for it would have needed an exemption — and
 * an exemption is a file in which a genuinely missing filter would become
 * invisible. Naming this instead is the true statement about what the module
 * does, so the guard is satisfied by the code being right rather than by the
 * guard being told to look away.
 */
export const RETIRED_PAGES = not(LIVE_PAGES);
