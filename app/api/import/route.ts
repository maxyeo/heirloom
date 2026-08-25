import type { ImportedCounts } from "@/lib/gedcom-import";
import { importGedcom } from "@/lib/gedcom-import";
import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_FILE_FIELD,
  type ImportDoneResponse,
  type ImportPreviewResponse,
  type ImportRefusal,
} from "@/lib/import-endpoint";
import {
  checkGedcomUpload,
  gedcomDigest,
  type ImportCounts,
  MAX_REQUEST_BYTES,
  readGedcom,
} from "@/lib/import-preview";
import { buildImportReport } from "@/lib/import-report";
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
 * ## Where the write is
 *
 * `lib/gedcom-import.ts` (E6-T4, `YEO-49`), called on the confirming branch
 * below and nowhere else. It lands the rows as one transaction that rolls
 * back whole, which is why the call is a single `await` with no bookkeeping
 * around it: there is no partial outcome to account for.
 *
 * E6-T3 and E6-T4 were built in parallel, so until E6-T5 (`YEO-50`) this
 * branch answered `501` and named the ticket that would fill it in. The seam
 * really was the one line its note promised — `readGedcom` already returns
 * the `mapping`, with every id minted and every foreign key resolved — and
 * closing it is a prerequisite for E6-T5 rather than a change of its own:
 * there is no *post-import* report until an import can run.
 *
 * ## What a confirmed import answers with
 *
 * The whole report (E6-T5, `YEO-50`), not a status. `lib/import-report.ts`
 * builds it and says why it travels inline: it describes bytes that exist
 * only inside this request, so there is nowhere to go and ask for it
 * afterwards.
 */

/**
 * How long the platform lets a confirmed import run, in seconds.
 *
 * A requirement `lib/gedcom-import.ts` states and deliberately cannot meet on
 * its own: `maxDuration` is a route-segment export
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * 02-route-segment-config/maxDuration.md`), so it belongs to whichever route
 * comes to call the import, and E6-T4 added no route.
 *
 * Sixty rather than the platform's ten-second default because the import is
 * one invocation by design. The alternative the criterion offered — chunks
 * that are individually safe to retry — is not available here: chunks that
 * commit independently *are* the half-imported tree the transaction exists to
 * prevent. So the whole file lands in one function call, and the number has
 * to cover the largest file the upload cap admits (`MAX_GEDCOM_BYTES`, four
 * mebibytes) against a pooled connection.
 *
 * What makes overrunning it safe is the transaction rather than the number. A
 * function killed mid-import never reaches `commit`, so the tree is untouched
 * and the reader can upload the file again. Sixty seconds is the ceiling on
 * Vercel's Hobby plan, which is where this deploys; raising it further is a
 * plan change rather than an edit here.
 */
export const maxDuration = 60;

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
   * request answers with, the `mapping` beside it is what a confirmed one
   * writes, and the report afterwards is built from the same value again.
   * Parsing the file twice would be two chances for the screen somebody
   * approved, the rows that get written, and the account of what happened to
   * describe three slightly different things.
   */
  const read = readGedcom(bytes);

  const confirm = form.get(IMPORT_CONFIRM_FIELD);
  if (confirm === null) {
    const answer: ImportPreviewResponse = {
      stage: "preview",
      digest,
      preview: read.preview,
    };
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

  /**
   * The write, and the only thing on this path that can fail after consent.
   *
   * Caught rather than left to propagate, for the reader rather than for the
   * code: an uncaught throw here is a bare platform `500` with no JSON in it,
   * and the screen's fallback sentence for that is "the answer could not be
   * read", which sends somebody looking at their connection when the truth is
   * that their tree is untouched. `lib/gedcom-import.ts` is explicit that an
   * exception *means* nothing was written — the transaction rolled back — so
   * that is the sentence to say.
   *
   * Logged as well as answered. Every refusal above is a fact about the
   * request and needs no record; this one is a fault, and the only place it
   * can be seen afterwards is the platform's log.
   */
  let imported: ImportedCounts;
  try {
    imported = await importGedcom(read.mapping);
  } catch (error) {
    console.error("GEDCOM import failed:", error);
    return refuse(
      {
        error:
          "The import did not finish, and nothing was written — the tree is " +
          "exactly as it was. Try again.",
      },
      500,
    );
  }

  /**
   * Built *after* the `try` closes, and that placement is the point of it.
   * Assembling the report is pure and cannot fail, but if it ever did inside
   * that block it would answer "nothing was written" about a transaction that
   * had already committed — a lie in the one direction this whole flow exists
   * to make impossible.
   */
  const answer: ImportDoneResponse = {
    stage: "imported",
    report: buildImportReport(read, writtenCounts(imported)),
  };
  return Response.json(answer);
}

/**
 * `lib/gedcom-import.ts`'s counts in the words the rest of the flow uses.
 *
 * Two names for three numbers, and both are right where they are. E6-T4
 * counts in the **tables'** words — `individuals`, `unions`, `unionChildren`
 * — which is what a module whose whole job is three inserts should be
 * counting, and what a reviewer holding `db/schema.ts` can check. E6-T3
 * counts in the **screen's** — people, unions, children — which is what
 * somebody who has just uploaded a family file is reading.
 *
 * The translation lives here because this route is the only place that holds
 * both, and because putting it anywhere further down would drag a type from a
 * module that reaches `drizzle-orm` into the pure half of the pipeline. The
 * specifier scan in `lib/gedcom.purity.test.ts` does not distinguish an
 * `import type` from a real one, so "no module on the read side names the
 * write side" stays a rule that holds rather than one that happens to.
 *
 * The rejected alternative was to alias one type to the other and rename the
 * fields at whichever end lost the argument, which buys a vocabulary that is
 * wrong at one of the two ends forever.
 */
function writtenCounts(imported: ImportedCounts): ImportCounts {
  return {
    people: imported.individuals,
    unions: imported.unions,
    children: imported.unionChildren,
  };
}

/** One shape for every refusal; see {@link ImportRefusal}. */
function refuse(refusal: ImportRefusal, status: number): Response {
  return Response.json(refusal, { status });
}
