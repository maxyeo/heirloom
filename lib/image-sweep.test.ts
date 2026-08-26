import { describe, expect, it } from "vitest";

import { collectImageReferences } from "@/lib/image-references";
import {
  DEFAULT_MIN_AGE_MS,
  formatBytes,
  formatSweepReport,
  planImageSweep,
  type ImageSweepPlan,
} from "@/lib/image-sweep";
import type { ListedObject } from "@/lib/storage";
import { IMAGE_ROUTE } from "@/lib/storage-key";

/**
 * The decisions `db/images-sweep.ts` makes before it deletes anything, tested
 * where they actually live — as a function of plain values, with no store and
 * no database (docs/testing.md).
 *
 * Every test here is really the same test: **does this rule fail towards
 * keeping the photograph?** An orphan left behind costs a few kilobytes until
 * the next run. A photograph deleted because a rule leaned the other way is
 * gone, because the nightly dump carries the row that points at an image and
 * never the image (docs/backups.md). So the assertions are mostly about what
 * is *not* in `orphans`.
 */

const NOW = new Date("2026-08-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** A key of the shape `newImageKey` mints: `images/<shard>/<uuid>.<ext>`. */
const key = (n: number, ext = "jpg") =>
  `images/a${n}/0e5b6c2f-1234-4a56-89ab-cdef4500000${n}.${ext}`;

/** The `src` an entry body carries for `key` — a site-relative path of ours. */
const imgTag = (storageKey: string) =>
  `<p><img src="${IMAGE_ROUTE}/${storageKey.slice("images/".length)}"></p>`;

function listed(
  storageKey: string,
  overrides: Partial<ListedObject> = {},
): ListedObject {
  return {
    key: storageKey,
    size: 1000,
    // Comfortably past the grace period unless a test says otherwise.
    uploadedAt: new Date(NOW.getTime() - 30 * DAY),
    ...overrides,
  };
}

function plan(
  objects: ListedObject[],
  referenced: Iterable<string> = [],
  overrides: Partial<Parameters<typeof planImageSweep>[0]> = {},
): ImageSweepPlan {
  return planImageSweep({
    listed: objects,
    referenced: new Set(referenced),
    now: NOW,
    ...overrides,
  });
}

const orphanKeys = (result: ImageSweepPlan) =>
  result.orphans.map((object) => object.key);

const reasons = (result: ImageSweepPlan) =>
  result.refusals.map((refusal) => refusal.reason);

const messages = (result: ImageSweepPlan) =>
  result.refusals.map((refusal) => refusal.message).join("\n");

describe("what counts as an orphan", () => {
  it("reports an image nothing refers to", () => {
    // The whole point of the feature: an upload that was never saved into
    // anything is exactly what this reclaims.
    expect(orphanKeys(plan([listed(key(1))]))).toEqual([key(1)]);
  });

  it("spares an image a current entry body uses", () => {
    const referenced = collectImageReferences({ html: [imgTag(key(1))] });

    expect(orphanKeys(plan([listed(key(1))], referenced))).toEqual([]);
  });

  it("spares an image only an old revision still contains", () => {
    // **The trap this ticket exists to prevent.** History is append-only and
    // E1-T7 can restore any revision, so a photograph taken out of the
    // current body last year is still referenced by every version that had
    // it. The current body here does not mention it at all.
    //
    // A sweep "optimised" to read only `pages` passes every other test in
    // this file and fails this one. That is the point of it.
    const currentBody = "<p>She sold the house in 1974.</p>";
    const oldRevision = imgTag(key(1));
    const referenced = collectImageReferences({
      html: [currentBody, oldRevision],
    });

    expect(orphanKeys(plan([listed(key(1))], referenced))).toEqual([]);
  });

  it("spares an image referenced only by a portrait column", () => {
    // E5-T4 put keys on `individuals` directly. A portrait appears in no
    // body anywhere, so a sweep that scanned only HTML would find every
    // portrait in the wiki unreferenced and delete the lot on its first run.
    const referenced = collectImageReferences({ keys: [key(1), key(2)] });

    expect(
      orphanKeys(plan([listed(key(1)), listed(key(2))], referenced)),
    ).toEqual([]);
  });

  it("spares a portrait thumbnail as well as its original", () => {
    // Reaping thumbnails would leave the tree fetching several hundred
    // full-resolution photographs to draw itself — the failure E5-T4 exists
    // to avoid, reintroduced by the cleanup.
    const portrait = key(1);
    const thumb = key(2, "webp");
    const referenced = collectImageReferences({ keys: [portrait, thumb] });

    expect(
      orphanKeys(plan([listed(portrait), listed(thumb)], referenced)),
    ).toEqual([]);
  });
});

describe("the grace period", () => {
  it("holds back an image uploaded moments ago", () => {
    // Uploads happen before saves — `EntryEditor` and `PortraitField` both
    // upload the instant an author picks a file. Without this, a sweep
    // running mid-edit deletes the photograph and the save that follows
    // writes a body pointing at nothing.
    const fresh = listed(key(1), {
      uploadedAt: new Date(NOW.getTime() - 1000),
    });

    const result = plan([fresh]);

    expect(orphanKeys(result)).toEqual([]);
    expect(result.tooNew.count).toBe(1);
  });

  it("holds back an image at exactly the cutoff", () => {
    // The boundary leans towards keeping, which is the direction every
    // ambiguity in this module is resolved in.
    const edge = listed(key(1), {
      uploadedAt: new Date(NOW.getTime() - DEFAULT_MIN_AGE_MS),
    });

    expect(orphanKeys(plan([edge]))).toEqual([]);
  });

  it("reports an image just past the cutoff", () => {
    const past = listed(key(1), {
      uploadedAt: new Date(NOW.getTime() - DEFAULT_MIN_AGE_MS - 1),
    });

    expect(orphanKeys(plan([past]))).toEqual([key(1)]);
  });

  it("holds back an image whose upload time is in the future", () => {
    // Clock skew between this process and the store. Nonsense, but nonsense
    // is not a reason to delete a photograph.
    const skewed = listed(key(1), {
      uploadedAt: new Date(NOW.getTime() + DAY),
    });

    expect(orphanKeys(plan([skewed]))).toEqual([]);
  });

  it("honours a caller's own window", () => {
    const object = listed(key(1), {
      uploadedAt: new Date(NOW.getTime() - 2 * DAY),
    });

    expect(orphanKeys(plan([object], [], { minAgeMs: 7 * DAY }))).toEqual([]);
    expect(orphanKeys(plan([object], [], { minAgeMs: DAY }))).toEqual([key(1)]);
  });
});

describe("objects this application did not mint", () => {
  it("leaves alone a key outside the image namespace", () => {
    // `storage.list` is asked for the `images/` prefix, so this should not
    // arrive — but the prefix filter is the *host's*, and a containment
    // property enforced only by the thing being contained is not one.
    const foreign = listed("dumps/heirloom-2026-08-25.sql.gz");

    const result = plan([foreign]);

    expect(orphanKeys(result)).toEqual([]);
    expect(result.unrecognised.count).toBe(1);
  });

  it("leaves alone a key with a traversal segment in it", () => {
    const nasty = listed("images/../../etc/passwd");

    expect(orphanKeys(plan([nasty]))).toEqual([]);
  });

  it("counts an unrecognised key as unrecognised, not as referenced", () => {
    // Two different reasons to keep something, and conflating them would
    // make the report claim the database refers to a file it has never
    // heard of.
    const result = plan([listed("images/ab/spaces are illegal.jpg")]);

    expect(result.unrecognised.count).toBe(1);
    expect(result.referenced.count).toBe(0);
  });
});

describe("the report", () => {
  it("adds up bytes per bucket so an operator knows what is at stake", () => {
    const referenced = collectImageReferences({ html: [imgTag(key(1))] });
    const result = plan(
      [
        listed(key(1), { size: 500 }),
        listed(key(2), { size: 1500 }),
        listed(key(3), {
          size: 700,
          uploadedAt: new Date(NOW.getTime() - 1000),
        }),
      ],
      referenced,
    );

    expect(result.listed).toEqual({ count: 3, bytes: 2700 });
    expect(result.referenced).toEqual({ count: 1, bytes: 500 });
    expect(result.orphaned).toEqual({ count: 1, bytes: 1500 });
    expect(result.tooNew).toEqual({ count: 1, bytes: 700 });
  });

  it("lists orphans oldest first", () => {
    const result = plan([
      listed(key(1), { uploadedAt: new Date(NOW.getTime() - 10 * DAY) }),
      listed(key(2), { uploadedAt: new Date(NOW.getTime() - 90 * DAY) }),
      listed(key(3), { uploadedAt: new Date(NOW.getTime() - 40 * DAY) }),
    ]);

    expect(orphanKeys(result)).toEqual([key(2), key(3), key(1)]);
  });

  it("breaks ties on age by key, so two runs report the same order", () => {
    const sameMoment = new Date(NOW.getTime() - 10 * DAY);
    const result = plan([
      listed(key(2), { uploadedAt: sameMoment }),
      listed(key(1), { uploadedAt: sameMoment }),
    ]);

    expect(orphanKeys(result)).toEqual([key(1), key(2)]);
  });
});

describe("refusing to delete", () => {
  it("refuses when the store has objects and the database refers to none", () => {
    // What a wrong DATABASE_URL looks like from here, and it is
    // indistinguishable from a wiki that genuinely lost every reference.
    const result = plan([listed(key(1))]);

    expect(reasons(result)).toEqual(["no-references"]);
    expect(messages(result)).toMatch(/--allow-unreferenced-store/);
  });

  it("does not refuse over an empty store", () => {
    // A wiki with no photographs yet is not a misconfiguration.
    expect(plan([]).refusals).toEqual([]);
  });

  it("refuses when it would take more of the store than the limit allows", () => {
    // The guard for the mistake nothing else catches: references read from
    // one deployment, store belonging to another. A mismatch does not look
    // like a few extra orphans, it looks like most of the store at once.
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));
    const referenced = collectImageReferences({ keys: [key(0)] });

    const result = plan(objects, referenced);

    expect(reasons(result)).toEqual(["too-many"]);
    expect(messages(result)).toMatch(/--max-orphan-fraction=/);
  });

  it("allows a sweep that stays under the limit", () => {
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));
    // Everything referenced except one distinct key.
    const referenced = collectImageReferences({
      keys: Array.from({ length: 8 }, (_, i) => key(i)),
    });

    const result = plan(objects, referenced);

    expect(result.refusals).toEqual([]);
    expect(result.orphaned.count).toBeGreaterThan(0);
  });

  it("does not apply the fraction rule to a handful of objects", () => {
    // One abandoned upload in a store of four is 25% and means nothing. The
    // operator is looking at a list short enough to read in full.
    const referenced = collectImageReferences({ keys: [key(1), key(2)] });
    const result = plan(
      [listed(key(1)), listed(key(2)), listed(key(3))],
      referenced,
    );

    expect(result.refusals).toEqual([]);
    expect(orphanKeys(result)).toEqual([key(3)]);
  });

  it("decides the refusal on dry runs too", () => {
    // The report has to say "this would be refused" *before* somebody adds
    // --delete and finds out. Nothing about the plan depends on which mode
    // the script is in.
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));
    const referenced = collectImageReferences({ keys: [key(0)] });

    expect(reasons(plan(objects, referenced))).not.toEqual([]);
  });

  it("raises both refusals when both apply", () => {
    // The regression. These two overlap exactly in the worst case: a store
    // the database refers to *none* of is also a store the sweep wants to
    // empty. An earlier version returned the first refusal it found, so this
    // case reported only `no-references` — and `--allow-unreferenced-store`,
    // which is allowed to lift that one, then lifted the only refusal that
    // had been computed. The fraction cap that is supposed to be unliftable
    // never ran, and one flag could delete a family's whole archive.
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));

    const result = plan(objects, []);

    expect(reasons(result).sort()).toEqual(["no-references", "too-many"]);
  });

  it("still refuses on the fraction after the unreferenced-store reason is lifted", () => {
    // The same property stated the way the script consumes it: lifting the
    // liftable reason must leave the other one standing.
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));

    const standing = plan(objects, []).refusals.filter(
      (refusal) => refusal.reason !== "no-references",
    );

    expect(standing.map((refusal) => refusal.reason)).toEqual(["too-many"]);
  });

  it("honours a caller's own limit", () => {
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));
    const referenced = collectImageReferences({ keys: [key(0)] });

    expect(
      plan(objects, referenced, { maxOrphanFraction: 1 }).refusals,
    ).toEqual([]);
  });
});

describe("the printed report", () => {
  const census = { fromPages: 3, fromRevisions: 7, fromPortraits: 2 };
  const render = (result: ImageSweepPlan, label = "user@db.example/heirloom") =>
    formatSweepReport(result, census, label).join("\n");

  it("names the database the references came from", () => {
    // The one line an operator should read before typing --delete: references
    // come from DATABASE_URL and deletions go to STORAGE_TOKEN's store, and
    // nothing in the system relates the two.
    const text = render(plan([listed(key(1))]));

    expect(text).toContain("References read from: user@db.example/heirloom");
  });

  it("attributes references to all three sources", () => {
    // Zero portrait references against a wiki full of photographs is a bug
    // somebody can see. A single total would have hidden it.
    const text = render(plan([listed(key(1))]));

    expect(text).toContain("3 from entry bodies");
    expect(text).toContain("7 from revisions");
    expect(text).toContain("2 from portrait columns");
  });

  it("lists each orphan with its size and upload date", () => {
    const text = render(
      plan([
        listed(key(1), {
          size: 2 * 1024 * 1024,
          uploadedAt: new Date("2026-03-04T05:06:07.000Z"),
        }),
      ]),
    );

    expect(text).toContain(key(1));
    expect(text).toContain("2.0 MB");
    expect(text).toContain("uploaded 2026-03-04");
  });

  it("says a delete would be refused, before anybody tries one", () => {
    // The refusal is decided on dry runs too, so the report warns rather
    // than letting an operator discover it by adding --delete.
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));
    const referenced = collectImageReferences({ keys: [key(0)] });

    expect(render(plan(objects, referenced))).toContain(
      "This run would be refused:",
    );
  });

  it("prints a line per standing refusal, not just the first", () => {
    // The printed half of the blocker fix. An operator who is about to pass
    // --allow-unreferenced-store needs to see the fraction cap in the report
    // as well, or lifting the one they were shown looks like the whole
    // argument.
    const objects = Array.from({ length: 20 }, (_, i) => listed(key(i % 9)));

    const text = render(plan(objects, []));

    expect(text.match(/This run would be refused:/g)).toHaveLength(2);
  });

  it("says nothing about refusals when there are none", () => {
    const referenced = collectImageReferences({ keys: [key(1)] });

    expect(render(plan([listed(key(1))], referenced))).not.toContain(
      "would be refused",
    );
  });

  it("reports an empty store without inventing an orphan list", () => {
    const text = render(plan([]));

    expect(text).toContain("Store: 0 object(s)");
    expect(text).not.toContain("Orphans, oldest first");
  });
});

describe("formatBytes", () => {
  it("scales to the unit a person would use", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 kB");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
