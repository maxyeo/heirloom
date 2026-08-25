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

/**
 * Where the full export is (E7-T4, `YEO-54`).
 *
 * A second route rather than a query parameter on the first, because the two
 * answer with different media types under different names and share nothing
 * but a session guard. `/full` and not `/backup`: see {@link FULL_EXPORT_TITLE}.
 */
export const FULL_EXPORT_ENDPOINT = "/api/export/full";

/**
 * ZIP's registered media type.
 *
 * `application/zip` rather than one of the `x-` spellings that predate the
 * registration — every browser and every archive tool understands it, and it
 * is what makes the response a file rather than something a tab tries to
 * display.
 */
export const FULL_EXPORT_MEDIA_TYPE = "application/zip";

/** What every export of this kind is called, before the date and extension. */
const FILENAME_STEM = "family-tree";

/** The full export's own stem. See {@link gedcomFilename} for the date. */
const FULL_EXPORT_FILENAME_STEM = "family-export";

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

/**
 * What this download is called on the settings page, and why it is not called
 * a backup (E7-T4, `YEO-54`).
 *
 * E7-T3's reviewer raised it and it is the right call. `docs/backups.md`
 * opens by drawing exactly this line:
 *
 * > *"It is the counterpart to the family's own export, and the two are not
 * > substitutes. Export is a feature: the people in the wiki can take their
 * > data with them. This is the thing that means the data is still there
 * > after an accident nobody noticed at the time."*
 *
 * The two differ in every operational way that matters. The nightly Postgres
 * backup runs on a schedule whether anybody remembers it or not, is
 * encrypted, is kept for ninety days, and proves itself by restoring every
 * night. This is a file a person clicks for, once, and then has to look
 * after. Calling both of them "backup" in the one place a non-technical
 * reader meets either would tell them the second is the first — which is the
 * precise misunderstanding E7-T3's caveat exists to prevent, arriving from
 * the other direction.
 *
 * So: **export** on the page, and *backup* left to mean the operator's
 * runbook. The endpoint is spelled to match ({@link FULL_EXPORT_ENDPOINT}),
 * because a URL is read by people too.
 */
export const FULL_EXPORT_TITLE = "Full export";

/**
 * The name the browser saves the archive under, dated.
 *
 * `gedcomFilename`'s reasoning, unchanged and for the same reasons: ISO order
 * so a folder of them sorts by name, UTC because the server is the only clock
 * in the exchange, and nothing in the name that came from a person, so the
 * quoted `Content-Disposition` below needs no RFC 5987 escape.
 */
export function fullExportFilename(now: Date): string {
  return `${FULL_EXPORT_FILENAME_STEM}-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * The response headers the full export carries.
 *
 * The same four as the GEDCOM download and each for the same reason —
 * `attachment` to make it a download, `no-store` to keep a family's names out
 * of a shared machine's disk cache, `nosniff` because nothing downstream
 * should be guessing at the body.
 *
 * What is deliberately absent is `Content-Length`. The archive is generated
 * as it is sent and its size is not known when the headers go out; a length
 * guessed here and disagreed with by the body is a truncated download that
 * looks complete, which is the one failure a backup must not have. Without
 * it the response is chunked and the browser shows a download with no
 * progress bar — the honest trade.
 */
export function fullExportDownloadHeaders(now: Date): Record<string, string> {
  return {
    "Content-Type": FULL_EXPORT_MEDIA_TYPE,
    "Content-Disposition": `attachment; filename="${fullExportFilename(now)}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
