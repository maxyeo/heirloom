import { gedcomDownloadHeaders } from "@/lib/export-endpoint";
import { exportTreeAsGedcom } from "@/lib/export-tree";
import { requireSessionOr401 } from "@/lib/session";

/**
 * The download itself (E7-T3, `YEO-53`).
 *
 * Thin, in the way `app/api/import/route.ts` is thin and for the same reason:
 * every decision an export involves is already somewhere better. The bytes are
 * `lib/gedcom-export.ts`, which is pure and round-tripped by E7-T2
 * (`YEO-52`); the query that feeds it is `lib/export-tree.ts`, which is the
 * only part of the export that knows `@/db` exists and was split out
 * precisely so that this handler and E7-T4's backup call one function rather
 * than each writing the query; the filename and the headers are
 * `lib/export-endpoint.ts`. What is left here is the part that can only exist
 * in a route — the session guard, and turning a string into a response a
 * browser saves.
 *
 * ## Why this is a route handler and not a Server Action
 *
 * `lib/import-endpoint.ts` reached for one to escape the 1 MB action body
 * limit. The reason here is different and simpler: an action returns a value
 * to React, and a download needs a *URL*. A plain `<a href>` on the settings
 * page, a `Content-Disposition` on the way back, and the browser does the
 * rest — no client component, no `fetch`, no object URL to revoke, and it
 * works with JavaScript disabled. That is the shape the Next.js guide's own
 * download example has
 * (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`).
 *
 * ## Why the whole file is built before any of it is sent
 *
 * The same guide shows streaming a response so a large file never sits in
 * memory. It does not apply: `writeGedcom` is a pure function over rows
 * already read, so there is nothing to stream *from* — the string exists in
 * full before the first byte could be written, and a `ReadableStream` around
 * it would be ceremony that buys a family tree nothing. It also lets a failed
 * read fail before the response starts, so an error is a 500 rather than a
 * truncated `.ged` that somebody files away as a backup.
 */

/**
 * Never prerendered. The body is the current contents of the database, and a
 * `GET` handler that Next decided to answer from a build-time render would
 * hand somebody the tree as it stood when the site was last deployed. The
 * database query would stop prerendering on its own; saying so is cheaper
 * than depending on that.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  const { response } = await requireSessionOr401();
  if (response) return response;

  const gedcom = await exportTreeAsGedcom();

  return new Response(gedcom, { headers: gedcomDownloadHeaders(new Date()) });
}
