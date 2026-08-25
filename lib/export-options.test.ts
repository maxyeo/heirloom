import { describe, expect, it } from "vitest";

import {
  FULL_EXPORT_ENDPOINT,
  FULL_EXPORT_TITLE,
  GEDCOM_EXPORT_ENDPOINT,
} from "@/lib/export-endpoint";
import { type ExportOption, exportOptions } from "@/lib/export-options";

/**
 * What the settings page says (E7-T3, `YEO-53`; E7-T4, `YEO-54`).
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
 *
 * ## What E7-T4 changed here, and why the change had to be made here
 *
 * The pointer used to say the full export was *"not built yet"*, and the
 * assertion below used to pin that phrase. That was deliberate on E7-T3's
 * part: it made the claim unsofteneable — nobody could quietly reword the
 * caveat into implying a backup existed before one did, because this file
 * failed until the feature was real.
 *
 * E7-T4 built it, so the assertion is inverted rather than deleted: the
 * pointer now has to name a download the reader can actually reach. A
 * deleted assertion would have left the sentence unguarded in the other
 * direction, which is the direction that matters now — a caveat that stops
 * saying where the missing things are is a caveat that has quietly become a
 * complaint.
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

describe("the downloads on offer", () => {
  it("points each at the endpoint that answers it", () => {
    expect(option("gedcom").href).toBe(GEDCOM_EXPORT_ENDPOINT);
    expect(option("full-export").href).toBe(FULL_EXPORT_ENDPOINT);
  });

  it("says GEDCOM on the button, so nobody has to guess what lands", () => {
    expect(option("gedcom").action).toBe("Download family tree (GEDCOM)");
  });

  it("says ZIP on the other one, for the same reason", () => {
    expect(option("full-export").action).toContain("ZIP");
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

  it("points at the download that has the rest", () => {
    // By its name on the page, not by a ticket id: a reader who has just been
    // told this file is incomplete needs to know what to click, and "E7-T4"
    // is a thing to click on in a tracker nobody has an account for.
    expect(caveat!.pointer).toContain(FULL_EXPORT_TITLE);
    expect(option("full-export").title).toBe(FULL_EXPORT_TITLE);
  });

  it("no longer says the full export is unbuilt, because it is built", () => {
    /**
     * The assertion E7-T3 wrote, inverted by E7-T4 rather than removed. It
     * was pinned then so nobody could soften the claim before the feature was
     * real; it is pinned now so nobody can leave a reader looking for a
     * download that has been sitting on the page beneath them all along.
     */
    expect(caveat!.pointer.toLowerCase()).not.toContain("not built");
    expect(caveat!.pointer.toLowerCase()).not.toContain("e7-t4");
  });

  it("says outright that this is not the thing to keep instead of the site", () => {
    expect(prose(option("gedcom"))).toContain("do not keep it instead");
  });
});

describe("the second option, which E7-T4 filled in", () => {
  it("is live, and no longer names a ticket", () => {
    expect(option("full-export").href).not.toBeNull();
    expect(option("full-export").pendingTicket).toBeUndefined();
  });

  it("promises exactly what the GEDCOM leaves out", () => {
    const full = prose(option("full-export"));

    expect(full).toContain("entry");
    expect(full).toContain("version");
    expect(full).toContain("photograph");
  });

  it("carries no caveat, because it is the one that leaves nothing out", () => {
    expect(option("full-export").caveat).toBeNull();
  });

  it("is called an export and not a backup", () => {
    /**
     * E7-T3's reviewer raised this and `docs/backups.md` settles it: the
     * operator's nightly Postgres backup and the family's own export are
     * deliberately different things — one is scheduled, encrypted, kept
     * ninety days and restored every night to prove it works; the other is a
     * file somebody clicks for once and then has to look after. Sharing a
     * word for them on the one page a non-technical reader meets either
     * would say the second is the first.
     *
     * Asserted about the *prose*, not about the title alone, because the
     * summary and the button are read at the same moment and one stray
     * "backup" in either undoes it.
     */
    expect(prose(option("full-export"))).not.toContain("backup");
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
