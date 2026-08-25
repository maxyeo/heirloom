import { describe, expect, it } from "vitest";

import { GEDCOM_EXPORT_ENDPOINT } from "@/lib/export-endpoint";
import {
  FULL_BACKUP_TICKET,
  type ExportOption,
  exportOptions,
} from "@/lib/export-options";

/**
 * What the settings page says (E7-T3, `YEO-53`).
 *
 * Three of this ticket's four acceptance criteria are sentences: what the
 * GEDCOM does *not* contain, in plain language, pointing at E7-T4 for the
 * full backup. `lib/site-nav.ts` is the precedent for testing copy this way
 * and gives the reason — "nothing else in the app would notice if a link went
 * to the wrong place", and nothing else here would notice if the caveat went
 * missing. The page renders this list; deleting a warning from it would
 * change no type and break no build.
 *
 * ## The caveat is the reason this file exists
 *
 * From the ticket: *"Someone will treat this file as a backup. GEDCOM has
 * nowhere to put a wiki, so it isn't one."* That is a claim about what a
 * reader is told at the moment they click, so it is asserted about the words,
 * not about the presence of a field.
 */

function option(id: string): ExportOption {
  const found = exportOptions.find((candidate) => candidate.id === id);
  expect(found, `no export option called '${id}'`).toBeDefined();
  return found!;
}

/** Everything a reader is shown about one option, as one lowercase haystack. */
function prose(candidate: ExportOption): string {
  const caveat = candidate.caveat;
  return [
    candidate.title,
    candidate.summary,
    candidate.action,
    caveat?.lead ?? "",
    ...(caveat?.missing ?? []),
    caveat?.pointer ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

describe("the download on offer", () => {
  it("points at the endpoint that answers it", () => {
    expect(option("gedcom").href).toBe(GEDCOM_EXPORT_ENDPOINT);
  });

  it("says GEDCOM on the button, so nobody has to guess what lands", () => {
    expect(option("gedcom").action).toBe("Download family tree (GEDCOM)");
  });
});

describe("the caveat on the GEDCOM", () => {
  const caveat = option("gedcom").caveat;

  it("exists at all — this is the ticket", () => {
    expect(caveat).not.toBeNull();
  });

  it("says what the file is before it says what it is missing", () => {
    expect(caveat!.lead.toLowerCase()).toContain("not a copy of this site");
  });

  it("names each thing that is not in the file, in plain language", () => {
    const missing = caveat!.missing.join(" · ").toLowerCase();

    // The three the acceptance criteria name: entry bodies, revision history,
    // images. Matched on the words a reader would use rather than on ours —
    // "revision" is this codebase's noun, not a family's.
    expect(missing).toContain("wiki entry");
    expect(missing).toContain("history of edits");
    expect(missing).toContain("photographs");
  });

  it("points at E7-T4 for the full backup", () => {
    expect(caveat!.pointer).toContain(FULL_BACKUP_TICKET);
    expect(FULL_BACKUP_TICKET).toBe("E7-T4");
  });

  it("does not claim a full backup already exists", () => {
    /**
     * The half that is easy to get wrong, because it only becomes wrong when
     * somebody reads it: E7-T4 is not built, so a pointer in the present
     * tense sends a reader who has just been told this file is not a backup
     * off to look for one that is not there.
     */
    expect(caveat!.pointer.toLowerCase()).toContain("not built yet");
  });

  it("says outright that this is not the thing to keep instead of the site", () => {
    expect(prose(option("gedcom"))).toContain("do not keep it instead");
  });
});

describe("the second option, which E7-T4 fills in", () => {
  it("is listed, so the page it lands on is already the right shape", () => {
    expect(option("full-backup").pendingTicket).toBe(FULL_BACKUP_TICKET);
  });

  it("is inert rather than a button that 404s", () => {
    // `lib/site-nav.ts`'s rule, and the same reason: something that looks live
    // and is not is worse than something that plainly says "later".
    expect(option("full-backup").href).toBeNull();
  });

  it("promises exactly what the GEDCOM leaves out", () => {
    const backup = prose(option("full-backup"));

    expect(backup).toContain("entry text");
    expect(backup).toContain("revision");
    expect(backup).toContain("images");
  });

  it("carries no caveat, because it is the one that leaves nothing out", () => {
    expect(option("full-backup").caveat).toBeNull();
  });
});

describe("every option", () => {
  it("names a ticket when it has no destination, and only then", () => {
    for (const candidate of exportOptions) {
      expect(Boolean(candidate.pendingTicket)).toBe(candidate.href === null);
    }
  });

  it("has a unique id, since the page keys on it", () => {
    const ids = exportOptions.map((candidate) => candidate.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has something to show for every field the page renders", () => {
    for (const candidate of exportOptions) {
      expect(candidate.title.length).toBeGreaterThan(0);
      expect(candidate.summary.length).toBeGreaterThan(0);
      expect(candidate.action.length).toBeGreaterThan(0);
      for (const thing of candidate.caveat?.missing ?? []) {
        expect(thing.length).toBeGreaterThan(0);
      }
    }
  });
});
