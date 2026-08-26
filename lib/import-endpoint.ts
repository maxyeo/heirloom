import type { ImportReport } from "./import-report";
import type { ImportCounts, ImportPreview } from "./import-preview";

/**
 * The contract between the import screen and the import endpoint (E6-T3,
 * `YEO-48`): the URL, the two field names, and the shape of every answer.
 *
 * ## Why a module rather than two ends that happen to agree
 *
 * `lib/search-endpoint.ts` set the rule for this repository's one other
 * network boundary and the argument carries over unchanged: a disagreement
 * between a route handler and the component that calls it "is not a type
 * error, it is a shape that typechecks on both sides and is wrong in the
 * middle". Here the stakes are a notch higher — the field this file names is
 * the one that separates *show me what this would do* from *do it*.
 *
 * Everything here is pure and free of `@/db`, `@/auth` and the DOM, so both
 * ends can import it and `lib/import-endpoint.test.ts` can assert the whole
 * contract against literals in plain Node.
 *
 * ## The two-request shape, and why it is two requests
 *
 * A preview is only worth having if the thing it previews is the thing that
 * gets written, and a serverless function keeps nothing between requests. So
 * the file travels twice: once to be read, and once to be imported, carrying
 * the {@link ImportPreviewResponse.digest} of what was previewed. The
 * endpoint recomputes it. That is what makes "explicit confirm step" a
 * statement about *this file* rather than about a second button press — see
 * `gedcomDigest` in `lib/import-preview.ts`.
 *
 * The rejected alternative was to stash the parsed mapping server-side under
 * a token. It needs somewhere to stash it, which on this deployment is either
 * the database the preview must not touch or the blob store, and it turns a
 * cancelled import into a thing that has to be cleaned up later. Sending the
 * bytes again costs one upload and leaves nothing behind — which is the
 * acceptance criterion, in the plainest possible form.
 */

/**
 * Where the import screen posts. One route handler rather than a server
 * action, for a reason that is not style: an action's request body is capped
 * at 1 MB by default (`node_modules/next/dist/docs/01-app/02-guides/
 * server-actions.md`), which a real family tree exceeds, and raising the cap
 * would raise it for every action in the application rather than for this
 * one. A route handler gets the platform's whole 4.5 MB — see
 * `MAX_GEDCOM_BYTES`.
 */
export const IMPORT_ENDPOINT = "/api/import";

/** The multipart field holding the `.ged`, named as `/api/images` names its own. */
export const IMPORT_FILE_FIELD = "file";

/**
 * The field that turns a preview into an import: the digest of the file the
 * reader approved.
 *
 * Absent means *preview this*, present means *import this*. One endpoint with
 * one switch rather than two endpoints, because the two are the same work up
 * to the last step — parse, map, summarise — and a second route would be a
 * second place for that pipeline to be assembled slightly differently.
 */
export const IMPORT_CONFIRM_FIELD = "confirm";

/**
 * The field that overrides the ledger's refusal: {@link PriorImport.id}, the
 * earlier import whose claim on this file the reader is deliberately giving
 * up (`YEO-95`).
 *
 * Only ever meaningful beside {@link IMPORT_CONFIRM_FIELD}, and carrying a
 * value rather than a flag. **That is the safety property, not a formality.**
 * A `release=1`, or a release naming only the digest, says *let this file
 * through whatever is in the way* — and a request that says that is
 * dangerous precisely because it stays true. Replayed by a retry, sent again
 * from a second tab, or re-posted by a back button, it would release
 * whichever live row it found and write another complete copy of the tree,
 * which is the duplication `YEO-89` exists to prevent, reached through the
 * door built to escape it.
 *
 * Naming the row makes the override **single-use without any bookkeeping**.
 * It authorises releasing one specific ledger entry, that entry is released
 * exactly once, and a second request carrying the same id releases nothing —
 * so the ordinary unique index meets the second attempt with the ordinary
 * refusal, naming the import that has just happened. Nothing has to remember
 * that the override was spent; it is spent because the row it named is no
 * longer live.
 *
 * The id is not on its own a permission to do anything: it is checked against
 * the digest of the bytes in the very same request, so a release can only
 * ever retire a claim on the file being imported — see `lib/gedcom-import.ts`,
 * where both halves are one `where` clause inside the writing transaction.
 *
 * Its **absence is the guard**, and that is what keeps `YEO-89` intact for
 * the case it was written for. The accidental second import — a second tab, a
 * back button on a stale preview, a retried request — sends no such field,
 * because nothing on that path ever set one. It is still refused, with no
 * extra click and no new way to get it wrong.
 *
 * What a release does and does not do is argued in `lib/gedcom-import.ts` and
 * stated to the reader in `components/GedcomImport.tsx`: the earlier import's
 * ledger row is retired rather than deleted, so its provenance survives, and
 * none of the rows it wrote are removed.
 */
export const IMPORT_RELEASE_FIELD = "release";

/**
 * What is known about an earlier import of this exact file (`YEO-89`).
 *
 * Free of `@/db` on purpose, the same way `ImportPreview` is: this travels
 * over the wire to a client component, and `lib/import-ledger.ts` — which
 * does reach the database to find one of these — shapes its row into this
 * type rather than the other way round.
 *
 * Still deliberately **not** the ledger row: the three counts are already the
 * screen's vocabulary — {@link ImportCounts} — rather than the tables', and
 * there is no reason to make a reader learn a second one to be told what a
 * prior import added.
 *
 * `id`, though, is now here, and `YEO-89` said in this spot that it would not
 * be — "nothing on the client needs to name a specific import". That was true
 * for exactly as long as the refusal had no override. `YEO-95` gives it one,
 * and an override that cannot name *which* import it is overriding is not a
 * decision a reader made, it is a decision about whatever happens to be in
 * the ledger when the request lands. That distinction is the whole of the
 * safety argument in {@link IMPORT_RELEASE_FIELD}, so the id crosses the wire
 * — as an opaque handle to a row the caller has already been shown, and never
 * as something to look anything else up by.
 */
export type PriorImport = {
  /**
   * The ledger row this describes, so a release can be pinned to it.
   *
   * Read-only from the client's side and useful for exactly one thing:
   * going back in {@link IMPORT_RELEASE_FIELD} to say *this* import, the one
   * I was shown, is the claim I am giving up.
   */
  id: string;
  /** When the earlier import ran, ISO 8601. */
  importedAt: string;
  /** The name of the file that import was given, or null if none was recorded. */
  fileName: string | null;
  /** What that import wrote. */
  counts: ImportCounts;
};

/**
 * A {@link PriorImport}'s timestamp, in words: `3 March 2026`.
 *
 * Here rather than at either end because both ends say it. The route writes
 * the sentence a `409` carries, and the screen writes the statement that
 * replaces the Import button — two different sentences about the same moment,
 * and a reader who hits the refusal after missing the statement must not be
 * told two different dates. This module is already the one place both ends
 * agree about the wire; the rendering of a value on that wire belongs with
 * it, for the same reason `lib/search-endpoint.ts` gives about a shape that
 * "typechecks on both sides and is wrong in the middle".
 *
 * `en-GB` and UTC are both pinned, matching `formatQualifiedDate` in
 * `lib/format-date.ts` and for its reason: `Intl` otherwise defaults to the
 * *environment's* locale and zone, and the two ends here are a server and a
 * browser that share neither. A date is deliberately all this renders — the
 * clock time an import ran at answers no question a reader is asking, and
 * showing one would invite them to compare it against their own.
 *
 * @param importedAt {@link PriorImport.importedAt}, ISO 8601
 */
export function formatImportedAt(importedAt: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(importedAt));
}

/** The answer to an upload with no {@link IMPORT_CONFIRM_FIELD}: nothing was written. */
export type ImportPreviewResponse = {
  stage: "preview";
  /**
   * SHA-256 of the bytes this preview describes, lowercase hex.
   *
   * Sent back in {@link IMPORT_CONFIRM_FIELD} to import. Not a secret and not
   * a capability — it authorises nothing on its own, and the session guard is
   * still the only thing standing between a caller and this endpoint. What it
   * establishes is only that the file in the confirming request is the file
   * the preview was about.
   */
  digest: string;
  preview: ImportPreview;
  /**
   * The earlier import of this exact file, if the digest above is already in
   * the ledger — or `null` when it is not.
   *
   * Advisory, not the guard. What actually stops a second import landing is
   * the unique index on `gedcom_imports.digest` (`db/schema.ts`), which holds
   * even against a second tab, a retried request, or a back button that a
   * value computed for a preview screen never sees. What this field buys is
   * only that the reader can be told *before* pressing Import rather than
   * finding out from a `409` after — `components/GedcomImport.tsx` is where
   * that sentence is said.
   */
  alreadyImported: PriorImport | null;
};

/**
 * The answer to a confirmed import that ran: the rows are in the tree.
 *
 * A stage of its own rather than a bare `200`, because the reader has just
 * handed over a file they cannot see the inside of and "it worked" is not an
 * answer to *what did it do*. E6-T5 (`YEO-50`) is what that answer is: the
 * whole report travels back with the `200`, because it describes bytes that
 * exist only inside the request that produced it and there is nowhere to go
 * and ask for it afterwards.
 */
export type ImportDoneResponse = {
  stage: "imported";
  /**
   * What the import did, in full: created, skipped, approximated, and the
   * tags this application does not read.
   *
   * Bounded, which matters on this side of the wire — `REPORT_ROWS_SHOWN` in
   * `lib/import-report.ts` is the reason a file of pure noise cannot produce
   * a response the platform refuses to send.
   */
  report: ImportReport;
};

/**
 * The answer to anything this endpoint will not do, at any stage.
 *
 * One shape for every refusal — too large, not a multipart form, a digest
 * that does not match, an import that failed — because the screen does the
 * same thing with all of them: show the sentence. The HTTP status carries the
 * distinction for anything that is not a person reading a screen.
 */
export type ImportRefusal = {
  /** A sentence for the person who picked the file. */
  error: string;
};

export type ImportResponse =
  ImportPreviewResponse | ImportDoneResponse | ImportRefusal;

/** Whether an answer is a preview, for a caller narrowing one. */
export function isImportPreview(
  response: ImportResponse,
): response is ImportPreviewResponse {
  return "stage" in response && response.stage === "preview";
}

/** Whether an answer is a finished import, for a caller narrowing one. */
export function isImportDone(
  response: ImportResponse,
): response is ImportDoneResponse {
  return "stage" in response && response.stage === "imported";
}
