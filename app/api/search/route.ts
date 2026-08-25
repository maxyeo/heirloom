import {
  MIN_SUGGESTION_QUERY,
  SUGGESTION_FETCH_LIMIT,
  emptySuggestions,
  readSearchQuery,
  toSuggestions,
} from "@/lib/search-endpoint";
// `searchEntries` from `@/lib/pages` — the Postgres full-text one E8-T1
// (`YEO-55`) landed. `lib/entry-links.ts` exports a function of the same name
// over an in-memory `TitledEntry[]`, for the editor's link panel; the wrong
// import of the two typechecks against a different shape and fails only at
// runtime, which is why this says which one.
import { searchEntries } from "@/lib/pages";
import { searchPeopleByName } from "@/lib/people";
import { requireSessionOr401 } from "@/lib/session";

/**
 * The one thing in this application the browser fetches (E8-T3, `YEO-57`).
 *
 * ## Why a GET route handler and not a server action
 *
 * Every other write and read in this app is a Server Component or a
 * `"use server"` action, and this is deliberately the exception rather than
 * the start of a habit. Four reasons, in the order that decides it:
 *
 * 1. **Actions are POST, and the router queues them.** The App Router
 *    serialises action calls so each one's revalidation and router-state
 *    payload apply in order. That is exactly right for a save and exactly
 *    wrong for typeahead: eight keystrokes become eight queued round trips
 *    that must each finish before the next starts, and the eighth answer —
 *    the only one anybody wants — arrives last by construction.
 * 2. **A GET can be cancelled.** `AbortController` over `fetch` really
 *    abandons an in-flight request at the transport, which is what makes the
 *    debounce in `components/SearchBox.tsx` cheap. There is no supported way
 *    to abandon an action's transition.
 * 3. **An action's reply is not JSON.** It is an RSC payload carrying
 *    whatever the action revalidated. Paying for a router tree on every
 *    debounce tick to fetch ten rows is the wrong shape of wire.
 * 4. **This seam was already cut.** `requireSessionOr401` has existed in
 *    `lib/session.ts` since E10-T2 (`YEO-66`), is described there as the
 *    "route-handler flavour", is listed in `test/route-inventory.ts`'s
 *    `BOUNDARY_CALLS`, and is named in `app/auth-boundary.test.ts`'s prose —
 *    and until this file, nothing called it. Three files were holding the
 *    door open for a route handler that did not exist.
 *
 * ## Why there is no test for this file
 *
 * There is nothing left in it to test, and that is the design rather than a
 * gap. It cannot be imported by `npm test` in any case — `@/lib/session`
 * reaches `@/auth`, which calls `NextAuth()` at import time and does not load
 * outside the Next runtime — and driving it needs a live database. Mocking
 * both to assert this file's four lines would be mocking behaviour worth
 * driving, which docs/testing.md forbids.
 *
 * So the handler was reduced until the reduction was the answer. The guard is
 * covered statically and for free by `app/auth-boundary.test.ts`, which
 * enumerates this file off the filesystem the moment it exists and requires
 * it to import and call a boundary. Every decision it makes about queries,
 * limits and payload shape is in `lib/search-endpoint.ts`, with a plain-value
 * test and no Postgres in its import graph. What is left here is a guard, two
 * awaits, and a `Response`.
 */

/**
 * A statement of intent, not a fix — worth being explicit about, because it
 * reads like the latter.
 *
 * Route handlers are **not** cached by default in this version (see
 * `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`:
 * caching is something a `GET` opts *into* with `dynamic = "force-static"`),
 * and `next.config.ts` does not enable Cache Components. So this line changes
 * nothing today. It is here for the reason `app/search/page.tsx` gives for
 * its own: every sibling route states this rather than leaving it to be
 * inferred from whichever request-time API the file happens to touch first.
 * Nobody should be able to make this route cacheable by deleting a line they
 * could not find.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  /**
   * First, and before anything reads the query.
   *
   * `app/auth-boundary.test.ts` makes this argument about server actions and
   * it applies identically here: a handler that parsed its input before it
   * guarded would be a handler somebody with no session could probe for what
   * the corpus contains, by watching which malformed queries it rejected
   * differently.
   */
  const { response } = await requireSessionOr401();
  if (response !== null) return response;

  const query = readSearchQuery(new URL(request.url).searchParams);

  /**
   * Too short to be worth asking about — answered, not refused.
   *
   * `components/SearchBox.tsx` will not ask, because `shouldRequest` applies
   * the same floor, so this is only reachable by a hand-typed URL or a
   * repeated `?q=`. The floor is enforced **here as well as there** because
   * the client is not a trust boundary and, more to the point, is not the
   * only caller: this is a GET anybody signed in can issue, and
   * `searchPeopleByName` reads the whole `individuals` table on every call
   * with no debounce in front of it. A rule that exists to bound cost has to
   * live where the cost is paid. See `MIN_SUGGESTION_QUERY` for why one
   * character is not an answer in the first place.
   *
   * 200 with nothing in it rather than a 400: it is the same answer both
   * backends would give, bought without the round trip, and a 400 would turn
   * something harmless into an error state the client needs copy for.
   */
  if (query.length < MIN_SUGGESTION_QUERY) return json(emptySuggestions(query));

  /**
   * Two reads of two tables that have nothing to do with each other, issued
   * together — `app/search/page.tsx` makes the same call for the same reason:
   * awaiting them in sequence would make the answer as slow as the sum of
   * them for no reason.
   *
   * `SUGGESTION_FETCH_LIMIT` from each — one more than is shown — so that
   * `toSuggestions` can tell "exactly five matched" from "five of forty" and
   * say which. Both backends get the same number, because two groups that
   * disagreed about depth would read as a defect in whichever came up
   * shorter (`lib/entry-search.ts`).
   */
  const [people, entries] = await Promise.all([
    searchPeopleByName(query, { limit: SUGGESTION_FETCH_LIMIT }),
    searchEntries(query, { limit: SUGGESTION_FETCH_LIMIT }),
  ]);

  return json(toSuggestions(query, people, entries));
}

/**
 * The payload, with the one header that matters.
 *
 * `private, no-store` is a different question from `dynamic` above: that one
 * is about Next's render cache, this is about the browser's disk cache, the
 * back/forward cache, and anything in between. What comes back is a family's
 * names, lifespans and the prose of their entries, behind an email allowlist
 * — the same class of data `YEO-86` found sitting outside the boundary in
 * image URLs. A `GET /api/search?q=grandmother` left in a shared laptop's
 * cache is the thing this closes, and a GET is exactly the method that would
 * otherwise be eligible.
 */
function json(payload: unknown): Response {
  return Response.json(payload, {
    headers: { "cache-control": "private, no-store" },
  });
}
