import type { ImportPreview } from "./import-preview";

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
};

/**
 * The answer to anything this endpoint will not do, at any stage.
 *
 * One shape for every refusal — too large, not a multipart form, a digest
 * that does not match — because the screen does the same thing with all of
 * them: show the sentence. The HTTP status carries the distinction for
 * anything that is not a person reading a screen.
 */
export type ImportRefusal = {
  /** A sentence for the person who picked the file. */
  error: string;
  /**
   * The ticket that will make this work, when the refusal is *not yet* rather
   * than *no*.
   *
   * `lib/site-nav.ts` set this convention for the sidebar's unbuilt
   * destination and the reasoning is the same one: something that looks live
   * and is not is worse than something that plainly says "later". A refusal
   * carrying a ticket is not a failure the reader caused and there is nothing
   * for them to fix; saying so is more useful than an apology.
   */
  pendingTicket?: string;
};

export type ImportResponse = ImportPreviewResponse | ImportRefusal;

/** Whether an answer is a preview, for a caller narrowing one. */
export function isImportPreview(
  response: ImportResponse,
): response is ImportPreviewResponse {
  return "stage" in response && response.stage === "preview";
}

/**
 * The ticket that writes the rows.
 *
 * E6-T3 owns everything up to and including the moment of consent: the
 * upload, the parse, the preview, the cancel, and the confirming request that
 * proves it is confirming *this* file. What it deliberately does not own is
 * the write — E6-T4 (`YEO-49`) is "all or nothing, any failure rolls back
 * completely", and a plain sequence of inserts added here to make a button
 * feel finished is the exact half-imported tree that ticket exists to
 * prevent: it looks like data, so nobody re-runs it.
 *
 * So the confirming branch of `app/api/import/route.ts` answers `501` and
 * names this, and every acceptance criterion of *this* ticket is true in the
 * strongest possible sense — nothing anywhere on this path can write.
 */
export const IMPORT_PENDING_TICKET = "E6-T4";

/** What the endpoint says when a confirmed import has nowhere to go yet. */
export const IMPORT_PENDING_MESSAGE =
  "Nothing was written. Reading a file is finished; writing one is E6-T4, " +
  "which lands the import as a single transaction that rolls back whole.";
