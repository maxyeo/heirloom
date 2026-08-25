import { fullExportDownloadHeaders } from "@/lib/export-endpoint";
import { fullExportStream } from "@/lib/export-full";
import { requireSessionOr401 } from "@/lib/session";

/**
 * The full export (E7-T4, `YEO-54`) — everything GEDCOM cannot carry.
 *
 * Thin, in the way `app/api/export/gedcom/route.ts` and
 * `app/api/import/route.ts` are thin, and for the same reason: what the
 * archive contains is `lib/export-archive.ts`, how it is read is
 * `lib/export-full.ts`, how the bytes are framed is `lib/zip-stream.ts`, and
 * the filename and headers are `lib/export-endpoint.ts`. Every one of those is
 * a function this repository's own test suite can drive. What is left here is
 * the part that can only exist in a route: the session guard, and turning a
 * stream into a response a browser saves.
 *
 * ## This one streams, and the GEDCOM download does not
 *
 * That is not an inconsistency; it is the same rule applied to two different
 * bodies. The GEDCOM route says so in as many words — `writeGedcom` is a pure
 * function over rows already read, so *"there is nothing to stream from"* and
 * a `ReadableStream` around a finished string would be ceremony. Here there
 * is: the photographs go from the image store to the client through this
 * process without ever being whole in it, and the archive as a whole is never
 * assembled anywhere. The Next.js guide's route-handler pattern is exactly
 * this — a `ReadableStream` handed to `Response`
 * (`node_modules/next/dist/docs/01-app/02-guides/streaming.md`).
 *
 * ## What a failure looks like, and why that is stated
 *
 * The response begins before the archive is finished, so a read that fails
 * halfway cannot become a 500 — the status line is long gone. It becomes a
 * broken connection, and a broken download, which is the correct outcome and
 * a visible one: the browser reports the download as failed and there is no
 * file left behind that looks like a backup. What must not happen is a
 * *complete-looking* short archive, and the ZIP's own structure is what rules
 * that out — the table of contents is the last thing written, so an archive
 * cut short has no end-of-central-directory record and no tool will open it.
 * The one thing an unfinished export can never be is one somebody trusts.
 */

/**
 * Never prerendered. The body is the current contents of the database and of
 * the image store; a `GET` answered from a build-time render would hand
 * somebody the wiki as it stood when the site was last deployed.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  // The only access boundary there is — no RLS underneath, one database role
  // for everyone. See `lib/session.ts`.
  const { response } = await requireSessionOr401();
  if (response) return response;

  /**
   * One moment for the whole export: the filename, the manifest's
   * `generatedAt` and every member's timestamp inside the archive all come
   * from this `Date`. Read once here rather than in each of them, so a file
   * cannot be dated a second later than the manifest inside it.
   */
  const now = new Date();

  return new Response(fullExportStream(now), {
    headers: fullExportDownloadHeaders(now),
  });
}
