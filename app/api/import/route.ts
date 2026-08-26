import type { ImportedCounts, ImportOutcome } from "@/lib/gedcom-import";
import { importGedcom } from "@/lib/gedcom-import";
import {
  IMPORT_CONFIRM_FIELD,
  IMPORT_FILE_FIELD,
  IMPORT_RELEASE_FIELD,
  formatImportedAt,
  type ImportDoneResponse,
  type ImportPreviewResponse,
  type ImportRefusal,
  type PriorImport,
} from "@/lib/import-endpoint";
import { findImportByDigest } from "@/lib/import-ledger";
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
 *
 * ## A second import of the same file is refused (`YEO-89`)
 *
 * `lib/gedcom-import.ts` writes a `gedcom_imports` row inside the same
 * transaction as the three tables, keyed on the file's digest, before any of
 * them — see that module's docblock and `gedcomImports` in `db/schema.ts`
 * for why the table's **unique index** is the guard rather than any check
 * this route could write, and why refusing beat merging or replacing the
 * prior import. What this route owns is only the two ends of that guard
 * being visible to a reader: the preview says, before anything is written,
 * whether this digest is already in the ledger (`alreadyImported` below,
 * read with `findImportByDigest` — a read, so the preview's own promise to
 * write nothing holds; `lib/gedcom.purity.test.ts` constrains
 * `lib/import-preview.ts`'s closure, not this route), and a confirmation
 * that reaches the guard anyway answers `409` naming what the earlier import
 * did.
 *
 * `409 Conflict` rather than `400`, matching the digest-mismatch refusal
 * above: the request is well-formed and nothing about it is malformed or
 * unauthorised, but the state the caller is proposing — write this file — has
 * already happened, and the caller could not have known that from anything
 * short of asking. That is what `409` is for, and it is the same status this
 * route already used for the one other case where a confirmation is correct
 * in form and refused on the facts.
 *
 * ## …and the way back out of that refusal (`YEO-95`)
 *
 * `IMPORT_RELEASE_FIELD` beside the confirmation, naming the prior import the
 * preview showed the reader, says *import this anyway* — that ledger row
 * gives up its claim inside the same transaction that writes the new import,
 * and the refusal above does not fire. Why it names a row rather than merely
 * asserting an intention, and why that is what makes it safe to replay, is
 * argued in the field's own docblock in `lib/import-endpoint.ts` and enforced
 * in `lib/gedcom-import.ts`'s `where` clause.
 *
 * This route deliberately does **not** check the id against anything. It
 * cannot: whether that row exists, still holds its claim, and belongs to
 * these bytes are three questions with one answer, and that answer is only
 * stable inside the transaction that acts on it. A check here would be a
 * second opinion formed a few milliseconds earlier — the `select`-then-write
 * race `YEO-89` removed, reintroduced by the ticket that was meant to make
 * that guard usable. So the id is passed through untrusted, and the `where`
 * clause is the whole of its validation.
 *
 * What is left here is the one refusal that is a fact about the *request*
 * rather than about the database: a release with no confirmation beside it is
 * a `400`. A preview is not something an override can be spent on, and
 * answering `200` to one would be silently ignoring a field the caller meant.
 *
 * The `409` this route writes names the option too, rather than only the
 * refusal — see `alreadyImportedRefusal`. A guard that says no without saying
 * what a legitimate caller is supposed to do next is how a one-way door gets
 * built twice.
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
  const { session, response } = await requireSessionOr401();
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
  const release = form.get(IMPORT_RELEASE_FIELD);

  if (confirm === null) {
    /**
     * An override with nothing to override. Refused rather than ignored: a
     * preview writes nothing, so spending a release on one would either mean
     * nothing at all or — worse, if this route ever grew a release that stood
     * on its own — mean freeing a digest for a request that then wrote
     * nothing with it. The caller has said two things that cannot both be
     * true, and answering the safer one silently is how a reader comes to
     * believe an override worked.
     */
    if (release !== null) {
      return refuse(
        {
          error:
            "An import can only be released as part of importing it. " +
            "Preview the file, then choose to import it again.",
        },
        400,
      );
    }

    /**
     * A read, not a check — nothing here refuses anything, and the preview
     * answers `200` whatever it finds. `findImportByDigest` reaches `@/db`,
     * which the rest of this branch's closure deliberately does not
     * (`lib/gedcom.purity.test.ts`); it is safe to call from here specifically
     * because "cancelling leaves the database untouched" is a claim about
     * writes, and a `select` that finds a ledger row changes nothing about it.
     */
    const alreadyImported = await findImportByDigest(digest);
    const answer: ImportPreviewResponse = {
      stage: "preview",
      digest,
      preview: read.preview,
      alreadyImported,
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
   * The write, and the only thing on this path that can fail — or be refused
   * — after consent.
   *
   * Caught rather than left to propagate, for the reader rather than for the
   * code: an uncaught throw here is a bare platform `500` with no JSON in it,
   * and the screen's fallback sentence for that is "the answer could not be
   * read", which sends somebody looking at their connection when the truth is
   * that their tree is untouched. `lib/gedcom-import.ts` is explicit that an
   * exception *means* nothing was written — the transaction rolled back — so
   * that is the sentence to say.
   *
   * Logged as well as answered. Every refusal is a fact about the request and
   * needs no record; a thrown fault is different, and the only place it can
   * be seen afterwards is the platform's log.
   *
   * `session` is destructured above alongside `response`: by the time
   * execution reaches this line, `requireSessionOr401` has already refused
   * anything without a `session.user.email`, so `?? null` below is a
   * courtesy to a `Session` type that leaves `user` optional rather than a
   * case this route expects to hit.
   */
  let outcome: ImportOutcome;
  try {
    outcome = await importGedcom(
      read.mapping,
      {
        digest,
        fileName: file instanceof File ? file.name : null,
        byteCount: bytes.byteLength,
        importedBy: session?.user?.email ?? null,
      },
      // Passed through unchecked, on purpose: the id is only meaningful
      // against rows, and `lib/gedcom-import.ts` checks it against them
      // inside the transaction that acts on it (`YEO-95`). A `File` in this
      // field is a caller with a broken form rather than a release, and
      // becomes the same `null` as sending nothing.
      { release: typeof release === "string" ? release : null },
    );
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

  if (outcome.status === "already-imported") {
    return refuse(alreadyImportedRefusal(outcome.previous), 409);
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
    report: buildImportReport(read, writtenCounts(outcome.counts)),
  };
  return Response.json(answer);
}

/**
 * The sentence for a confirmation this route refuses because the ledger
 * already holds this digest (`YEO-89`).
 *
 * Names the date and what the earlier import added, rather than only saying
 * "already imported" — a reader who has forgotten uploading this file before
 * needs the fact in front of them to believe the refusal, and a reader who
 * did it on purpose (a second tab, a slow connection retried) needs to know
 * their first attempt actually landed.
 *
 * The date comes from `formatImportedAt` in `lib/import-endpoint.ts` rather
 * than from an `Intl` call here, and deliberately: the screen writes its own
 * statement about the same moment (`components/GedcomImport.tsx`), and a
 * reader who reaches this refusal because they missed that statement must not
 * be shown two different dates for one import.
 */
function alreadyImportedRefusal(previous: PriorImport): ImportRefusal {
  const when = formatImportedAt(previous.importedAt);
  const people = previous.counts.people;

  return {
    error:
      `This file has already been imported — on ${when}, adding ${people} ` +
      `${people === 1 ? "person" : "people"}. Importing it again would add ` +
      "a second copy of everybody in it, so it was refused and nothing was " +
      "written. If that is what you want — because those rows have since " +
      "been deleted, or the first run was a mistake — preview the file " +
      "again and choose “Import it again anyway”, which releases the " +
      "earlier import's claim on this file while keeping its record.",
  };
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
