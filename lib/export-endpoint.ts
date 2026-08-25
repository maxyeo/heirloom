/**
 * The contract between the settings page's download button and the endpoint
 * that answers it (E7-T3, `YEO-53`): where it points, what comes back, and
 * what the file is called.
 *
 * ## Why a module rather than a header written inline
 *
 * `lib/import-endpoint.ts` and `lib/search-endpoint.ts` set the rule for this
 * repository's network boundaries, and the argument carries over unchanged: a
 * path spelled one way in a page and another way in a route "is not a type
 * error, it is a shape that typechecks on both sides and is wrong in the
 * middle".
 *
 * It buys something extra here. "Filename includes the date" is an acceptance
 * criterion of this ticket, and a filename assembled inside a route handler
 * can only be checked by driving the route. Assembled here it is a function
 * from a `Date` to a string, which `lib/export-endpoint.test.ts` checks
 * against literals with no session, no database and no clock.
 *
 * Everything in this module is pure and free of `@/db`, `@/auth` and the DOM,
 * so both ends can import it.
 */

/**
 * Where the download button points.
 *
 * A `GET` route handler rather than a Server Action, and for a plainer reason
 * than `lib/import-endpoint.ts` had: an action is a `POST` that returns a
 * value to React, and what is wanted here is a *URL* — something an `<a>` can
 * point at, that a browser will save on its own, with no JavaScript involved
 * on the page at all. The Next.js guide's own download example is a route
 * handler returning a `Response` with `Content-Disposition` on it
 * (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`), and that is
 * what this is.
 */
export const GEDCOM_EXPORT_ENDPOINT = "/api/export/gedcom";

/**
 * GEDCOM's registered media type, with the character set the exporter
 * actually writes.
 *
 * `lib/gedcom-export.ts` emits `1 CHAR UTF-8`, so the file says UTF-8 about
 * itself and this says the same thing about the transfer. The two agreeing is
 * not decoration: `lib/gedcom-encoding.ts` exists because files whose
 * declaration disagrees with their bytes are the ordinary case in this
 * format, and there is no reason for a file this application wrote to be one
 * of them.
 */
export const GEDCOM_MEDIA_TYPE = "text/vnd.familysearch.gedcom; charset=utf-8";

/** What every export of this kind is called, before the date and extension. */
const FILENAME_STEM = "family-tree";

/**
 * The name the browser saves the file under, dated.
 *
 * ## Why the date is in it and the serialiser has no clock
 *
 * `lib/gedcom-export.ts` deliberately writes no timestamp — E7-T2 (`YEO-52`)
 * compares two exports byte for byte, and a clock inside the file would make
 * every export of an unchanged tree a different file. The *name* is a
 * different thing: it is not part of what was exported, nobody diffs it, and
 * it is the only place a person looking at a folder of downloads can tell one
 * from another. So the moment is here, passed in rather than read, which
 * keeps this function as testable as the serialiser it names files for.
 *
 * ## `YYYY-MM-DD`, in UTC
 *
 * ISO order so a folder of these sorts chronologically by name, which is the
 * whole reason anyone puts a date in a filename. UTC because the file is
 * written by the server and the server is the only clock in the exchange —
 * the alternative would be to have the browser send its offset, which is a
 * round trip and a query parameter to make a filename off by at most a day.
 * Somebody downloading late in the evening west of Greenwich gets tomorrow's
 * date; that is a smaller surprise than two downloads on the same day sorting
 * out of order because one of them was named by a different timezone.
 */
export function gedcomFilename(now: Date): string {
  return `${FILENAME_STEM}-${now.toISOString().slice(0, 10)}.ged`;
}

/**
 * The response headers a GEDCOM download carries.
 *
 * - `Content-Disposition: attachment` is what makes this a download rather
 *   than a wall of text in a tab. The filename needs no RFC 5987 `filename*`
 *   escape hatch and no quoting worry, because it is not user input: it is
 *   {@link FILENAME_STEM}, a date, and an extension. That is a reason to keep
 *   the site's own configurable name out of it — `NEXT_PUBLIC_SITE_TITLE` is
 *   whatever an install set it to, quotes and non-ASCII included.
 * - `no-store`, for the reason `docs/architecture.md` gives about
 *   `/api/search`: this is the family's names, and a copy of them left in a
 *   shared laptop's disk cache is a copy outside the one boundary there is.
 * - `nosniff`, as the Next.js streaming guide's download example has it. The
 *   body is a text format of somebody else's choosing; nothing downstream
 *   should be guessing at it.
 */
export function gedcomDownloadHeaders(now: Date): Record<string, string> {
  return {
    "Content-Type": GEDCOM_MEDIA_TYPE,
    "Content-Disposition": `attachment; filename="${gedcomFilename(now)}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
