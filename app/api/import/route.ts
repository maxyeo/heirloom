import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_FILE_FIELD,
  IMPORT_PENDING_MESSAGE,
  IMPORT_PENDING_TICKET,
  type ImportPreviewResponse,
  type ImportRefusal,
} from "@/lib/import-endpoint";
import {
  checkGedcomUpload,
  gedcomDigest,
  MAX_REQUEST_BYTES,
  readGedcom,
} from "@/lib/import-preview";
import { requireSessionOr401 } from "@/lib/session";

/**
 * The import endpoint (E6-T3, `YEO-48`).
 *
 * Thin, in the way `app/api/images/route.ts` is thin and for the same
 * reasons. Every decision an import preview involves — the size cap, what a
 * file that is not GEDCOM produces, the counts, the sample, which warnings
 * exist and in what order, and the digest that pins a confirmation to a file
 * — is in `lib/import-preview.ts`, which is a function from bytes to a value
 * and is tested as one with nothing mocked. What is left here is the part
 * that can only exist in a route: the session guard, the multipart form, and
 * the branch between the two stages.
 *
 * ## Two stages, one handler
 *
 * Without {@link IMPORT_CONFIRM_FIELD} this reads the file and answers with a
 * preview. With it, and only when the digest it carries matches the bytes in
 * the same request, this is a confirmed import.
 *
 * The reader's *Cancel* is not a stage and reaches nothing: it is the absence
 * of the second request. That is the acceptance criterion "cancelling leaves
 * the database untouched" holding for a reason better than care — there is no
 * code on the cancelling path at all, and `lib/gedcom.purity.test.ts` proves
 * separately that the code on the *previewing* path could not write if it
 * tried.
 *
 * ## Why the write is not here
 *
 * See {@link IMPORT_PENDING_TICKET}. E6-T4 (`YEO-49`) owns landing the rows
 * as one transaction that rolls back whole; a loop of inserts added here to
 * finish a button is the half-imported tree that ticket exists to prevent.
 * The seam is one line — `readGedcom` already returns the `mapping`, which
 * that ticket writes with nothing left to resolve (`lib/gedcom-map.ts`).
 */
export async function POST(request: Request) {
  const { response } = await requireSessionOr401();
  if (response) return response;

  /**
   * Refused before the body is read, and only ever refused. `Content-Length`
   * is the client's own claim about a body it has not sent, so it can say no
   * early and can never be allowed to say yes — the real cap is applied to
   * the bytes below. `app/api/images/route.ts` documents the rest, including
   * why a chunked request carries no such header and what bounds that case.
   */
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return refuse({ error: "That file is too large." }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse({ error: "Expected a multipart form upload." }, 400);
  }

  const file = form.get(IMPORT_FILE_FIELD);
  if (!(file instanceof Blob)) {
    return refuse(
      { error: `Expected a file in a field named '${IMPORT_FILE_FIELD}'.` },
      400,
    );
  }

  const checked = checkGedcomUpload(file.size);
  if (!checked.ok) {
    return refuse({ error: checked.message }, checked.status);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await gedcomDigest(bytes);

  /**
   * Read once, whichever stage this is. The preview is what a previewing
   * request answers with; the `mapping` beside it — destructured by E6-T4 —
   * is what a confirmed one writes. Parsing the file twice would be two
   * chances for the screen somebody approved and the rows that get written to
   * describe different things.
   */
  const { preview } = readGedcom(bytes);

  const confirm = form.get(IMPORT_CONFIRM_FIELD);
  if (confirm === null) {
    const answer: ImportPreviewResponse = { stage: "preview", digest, preview };
    return Response.json(answer);
  }

  /**
   * A confirmation for a different file than was previewed. `409 Conflict`
   * rather than `400`: the request is well-formed and the caller is not
   * confused about the protocol — the state on the two ends has diverged,
   * which is what that status is for.
   *
   * The screen cannot normally reach this, since choosing a different file
   * takes the preview down with it. It is here for everything that is not the
   * screen, and for the case the whole ticket is about: what must never
   * happen is that a confirmation approves one tree and imports another.
   */
  if (confirm !== digest) {
    return refuse(
      {
        error:
          "This file is not the one that was previewed. Preview it again " +
          "before importing.",
      },
      409,
    );
  }

  return refuse(
    { error: IMPORT_PENDING_MESSAGE, pendingTicket: IMPORT_PENDING_TICKET },
    501,
  );
}

/** One shape for every refusal; see {@link ImportRefusal}. */
function refuse(refusal: ImportRefusal, status: number): Response {
  return Response.json(refusal, { status });
}
