import type { ImportedCounts } from "./gedcom-import";
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
 * contract against literals in plain Node. The one reference to a module that
 * does reach `@/db` is a type, imported with `import type` and therefore
 * erased — see {@link writtenCounts}, which explains why it is there.
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
 * The answer to a confirmed import that ran: the rows are in the tree.
 *
 * A stage of its own rather than a bare `200`, because the reader has just
 * handed over a file they cannot see the inside of and "it worked" is not an
 * answer to *what did it do*. E6-T5 (`YEO-50`) is the ticket that says so in
 * full, and {@link ImportDoneResponse.written} is the smallest true version:
 * how many rows reached each table.
 */
export type ImportDoneResponse = {
  stage: "imported";
  /**
   * What the import actually wrote, counted off the rows that were inserted.
   *
   * The same shape as {@link ImportPreview.counts}, which is what makes the
   * preview checkable against the outcome: the screen said 148 people and the
   * import says 148 people, in the same three words. `lib/gedcom-import.ts`
   * counts them in its own vocabulary — the *tables'* names, `individuals` /
   * `unions` / `unionChildren` — and {@link writtenCounts} is the one place
   * the two are put side by side.
   */
  written: ImportCounts;
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

/**
 * `lib/gedcom-import.ts`'s counts in the words the screen uses.
 *
 * Two names for three numbers, and both of them are right where they are.
 * `ImportedCounts` is named for the **tables** — `individuals`, `unions`,
 * `unionChildren` — which is what a module whose whole job is three inserts
 * should be counting, and it is the name a reviewer of `db/schema.ts` can
 * check. {@link ImportCounts} is named for the **screen** — people, unions,
 * children — which is what somebody who has just uploaded a family file is
 * looking at.
 *
 * The reconciliation is this function and nothing else. The considered
 * alternative was to make one type an alias of the other and rename the
 * fields at whichever end lost the argument, which trades a translation
 * anybody can read for a vocabulary that is wrong in one of the two places
 * forever. E6-T3 and E6-T4 were built in parallel and each chose the name its
 * own half needed; this is the seam between them, so this is where the
 * translation belongs.
 *
 * The type is imported with `import type` deliberately —
 * `lib/gedcom-import.ts` reaches `@/db`, and this module is imported by
 * `components/GedcomImport.tsx`, which is a client component. `import type`
 * erases entirely, which is the rule `docs/testing.md` states for exactly
 * this hazard.
 */
export function writtenCounts(imported: ImportedCounts): ImportCounts {
  return {
    people: imported.individuals,
    unions: imported.unions,
    children: imported.unionChildren,
  };
}
