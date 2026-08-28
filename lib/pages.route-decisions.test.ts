import { describe, expect, it } from "vitest";

import { schema } from "@/db";
import { read, routeFiles } from "@/test/route-inventory";

/**
 * `lib/pages.call-sites.test.ts` proves that no *query* against `pages` is
 * silent about `deleted_at`. This proves the same of the layer above it: no
 * *route* that loads one entry is silent about a retired one (`YEO-123`).
 *
 * ## Why the second file
 *
 * `getPageBySlug` is the one read in `lib/pages.ts` that deliberately does not
 * apply `LIVE_PAGES`, and its docblock explains why at length: it answers a
 * question about one address rather than about a set, six routes stand behind
 * it, and each wants something different from a retired row — a tombstone, a
 * redirect, a notice, a refusal. Filtering there would make all six a 404,
 * which §3 of `YEO-122` argues is indistinguishable from data loss. So the row
 * comes back carrying the timestamp and *the decision belongs to the route*.
 *
 * That docblock also named the risk: "The one thing that could go wrong with
 * that is a route forgetting to look." Two routes had already forgotten by the
 * time it was written. `/wiki/[slug]/history/[revisionId]` rendered a retired
 * entry's prose under a banner ending "It may differ significantly from the
 * current version", beside a link offering to show that current version, which
 * was by then a tombstone; `/wiki/[slug]/history/compare` said nothing at all.
 * Neither was a write and neither lost anything — `savePage` and
 * `restoreRevision` refuse regardless — but a reader was told something untrue
 * by a page that looked complete.
 *
 * The docblock's own enumeration had the same hole, from the same cause: it
 * said five. The count and the gap were one mistake, which is the argument for
 * this file rather than for a more careful sentence. A prose list of callers is
 * maintained by whoever remembers it exists, and the person adding the seventh
 * route is the person who does not.
 *
 * ## What this can and cannot see
 *
 * A tripwire, not a proof — the caveat every scanner in this repository
 * states, and here it has two specific shapes.
 *
 * **It reads text, not behaviour.** A route naming `deletedAt` in a comment
 * and branching on nothing passes. That is not the realistic failure; the
 * realistic failure is a route written by somebody who has never heard of
 * retirement, and this catches every one of those.
 *
 * **It only sees the direct call.** A route that loads an entry through some
 * future helper wrapping `getPageBySlug` is invisible here. If that becomes
 * common the subject to scan is the helper's callers rather than this
 * function's, and the shape of the check does not change.
 *
 * What it does see is the thing prose could not hold: the set of routes is
 * read off the route tree, so a route added under `[slug]` tomorrow is in this
 * test the moment its file exists.
 */

/** What a route names when it means "load the entry at this address". */
const READER = "getPageBySlug";

/**
 * The evidence that a route has decided.
 *
 * The same token `lib/pages.call-sites.test.ts` accepts from the two modules
 * that cannot filter, and for the same reason: a route *must not* filter — the
 * row it is handed is the retired one on purpose — so the only decision
 * available to it is to read the column and branch. There is nothing else to
 * look for.
 */
const COLUMN = "deletedAt";

/**
 * The docblock this file holds to its word, extracted rather than duplicated.
 *
 * Bounded by the export it documents, so it cannot drift onto some other
 * comment in the file: the last `/**` before `export async function
 * getPageBySlug` is the one attached to it. Throws rather than returning an
 * empty string when either marker moves — a guard that silently scans nothing
 * is the failure `test/route-inventory.footprint.test.ts` exists about.
 */
function getPageBySlugDocblock(): string {
  const source = read("lib/pages.ts");
  const marker = `export async function ${READER}`;

  const end = source.indexOf(marker);
  if (end === -1) throw new Error(`lib/pages.ts no longer exports ${READER}`);

  const start = source.lastIndexOf("/**", end);
  if (start === -1) throw new Error(`${READER} has no docblock above it`);

  return source.slice(start, end);
}

/**
 * Every route pattern the docblock names, as `/wiki/…` in backticks.
 *
 * The enumeration is written that way so this can read it back. Anything else
 * in the comment — a file path, a module name, a section heading — does not
 * begin with a slash and so is not mistaken for a route.
 */
function routesNamedIn(docblock: string): string[] {
  return [...docblock.matchAll(/`(\/wiki\/[^`\s]*)`/g)].map(
    (match) => match[1],
  );
}

describe("routes that load one entry by slug", () => {
  const callers = routeFiles()
    .map((route) => ({ ...route, source: read(route.file) }))
    .filter(({ source }) => source.includes(READER));

  const docblock = getPageBySlugDocblock();

  it("finds the routes, so the assertions below are not vacuous", () => {
    // Named rather than counted, on `lib/pages.call-sites.test.ts`'s
    // reasoning: a hard total would fail on every route added, teaching the
    // next person that the way past this file is to edit the number. These
    // three are the ends of the shape — the article, the editor, and the
    // deepest page under it — and if any stops calling `getPageBySlug` the
    // route has been rewritten and this file has stopped meaning what it says.
    const found = callers.map(({ route }) => route);

    expect(found).toContain("/wiki/[slug]");
    expect(found).toContain("/wiki/[slug]/edit");
    expect(found).toContain("/wiki/[slug]/history/[revisionId]/restore");
    expect(found.length).toBeGreaterThanOrEqual(6);
  });

  it("leaves no route silent about a retired entry", () => {
    const silent = callers
      .filter(({ source }) => !source.includes(COLUMN))
      .map(({ file }) => file);

    // A route reaching this list has asked for one entry by address and has
    // not said what it does when that entry is retired — so it renders one as
    // though it were live. There is no exemption list here and that is
    // deliberate: `getPageBySlug` hands back the retired row on purpose, and a
    // route with no opinion about it is a route that has not read the
    // docblock. The three answers already in the tree are a tombstone
    // (`/wiki/[slug]`), a notice above content that is still worth showing
    // (the history pages), and a refusal (`restore`).
    expect(silent).toEqual([]);
  });

  it("is enumerated in full by the docblock that sends routes here", () => {
    const named = new Set(routesNamedIn(docblock));
    const missing = callers
      .map(({ route }) => route)
      .filter((route) => !named.has(route));

    // The half of `YEO-123` that was not a rendering bug. The docblock said
    // five routes stood behind `getPageBySlug` and there were six, and the two
    // it omitted were the two that made no decision — so the sentence a reader
    // would have checked their work against was wrong in exactly the place it
    // mattered. Keeping it right is now this assertion's job rather than a
    // reader's memory.
    expect(missing).toEqual([]);
  });

  it("keeps the docblock from naming a route that has stopped calling", () => {
    const routes = new Set(callers.map(({ route }) => route));
    const stale = routesNamedIn(docblock).filter((route) => !routes.has(route));

    // The other direction, and the failure `lib/pages.call-sites.test.ts`
    // makes the same argument about for its exemptions: an entry that matches
    // nothing is not harmless. A route named here that no longer loads an
    // entry is a promise about code that has moved, sitting where the next
    // reader will trust it.
    expect(stale).toEqual([]);
  });

  it("keeps the column spelled the way the schema spells it", () => {
    // Without this, renaming `deleted_at`'s property would leave all six
    // routes passing the guard above by naming a field that no longer exists.
    // Importing `@/db` is safe under `npm test`, which has no `DATABASE_URL`:
    // `db/index.ts` connects lazily behind a Proxy, so naming a column opens
    // no socket.
    expect(Object.keys(schema.pages)).toContain(COLUMN);
  });
});
