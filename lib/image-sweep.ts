import { compareIds } from "@/lib/compare-ids";
import type { ListedObject } from "@/lib/storage";
import { isStoredImageKey } from "@/lib/storage-key";

/**
 * Deciding which stored images nothing refers to any more (E5-T5, `YEO-45`).
 *
 * Pure, and that is the point rather than a convenience. Everything about
 * this ticket that can be got wrong is a judgement — is this old enough, is
 * this ours, is this too many to be deleting — and every one of those
 * judgements is made here, against plain values, with no store and no
 * database in the room. `db/images-sweep.ts` is left holding the two side
 * effects: read the world, then do what this decided. See docs/testing.md.
 *
 * ## The asymmetry that shapes every rule below
 *
 * Failing to delete an orphan wastes a few kilobytes until the next run.
 * Deleting something that was not an orphan destroys a family photograph, and
 * photographs are the one thing the nightly backup does not carry
 * (docs/backups.md#what-is-not-in-these-backups) — the dump holds the row
 * that points at the file, never the file. There is no undo. So every rule
 * here is written to fail towards keeping, and the buckets exist so that a
 * "no" is always attributed rather than silent.
 *
 * ## Four buckets, not two
 *
 * A listed object is one of:
 *
 * - **referenced** — some body, revision or portrait column names it.
 * - **too new** — nothing names it *yet*. Uploads happen before saves:
 *   `components/EntryEditor.tsx` and `components/PortraitField.tsx` both
 *   upload the moment an author picks a file, so an image is legitimately
 *   unreferenced for as long as the author keeps typing. Without this bucket
 *   a sweep running in that window deletes the photograph out from under a
 *   live editor, and the save that follows writes a body pointing at a file
 *   that is already gone.
 * - **unrecognised** — under the image prefix but not a key this application
 *   could have minted. The sweep's reference model says nothing about such an
 *   object, and "I do not understand this" is not a reason to delete it.
 * - **orphaned** — everything left, and the only bucket `--delete` touches.
 *
 * Two buckets would have collapsed "not referenced" with "safe to delete",
 * which is exactly the collapse this ticket is about.
 */

/** How much of the store a bucket accounts for. */
export interface SweepTotals {
  /** How many objects. */
  count: number;
  /** How many bytes they occupy — the number `--delete` would reclaim. */
  bytes: number;
}

/**
 * How old an object must be before the sweep is willing to call it an orphan.
 *
 * Twenty-four hours, chosen against the thing it has to outlast: an editing
 * session. An author picks a photograph, the browser uploads it immediately,
 * and the entry is saved whenever they finish — which may be after lunch,
 * after the school run, or tomorrow, because this is a family wiki and not a
 * newsroom. A window measured in minutes would be sized against how long an
 * upload takes, which is not the question.
 *
 * It shortens the race rather than closing it. An author who leaves a tab open
 * for two days, with an image uploaded and never saved, can still have it
 * swept — and would then save a body pointing at a deleted key. Closing that
 * properly needs the upload to be recorded somewhere the sweep can see it,
 * which is a schema change and a different ticket; what makes it tolerable
 * meanwhile is that the sweep is a deliberate, occasional, human-run
 * operation rather than a cron, so the window has to coincide with somebody
 * choosing to run it.
 */
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The share of the store the sweep will delete before it demands a second
 * opinion.
 *
 * This exists for one specific, catastrophic mistake. The sweep reads its
 * references from `DATABASE_URL` and deletes from `STORAGE_TOKEN`'s store,
 * and **nothing pairs those two**. An operator with production's storage
 * token in `.env.local` and a local database — the ordinary state of a
 * developer's machine — computes references from the wrong wiki entirely and
 * every real photograph looks unreferenced. There is no backup to undo it
 * with.
 *
 * A wrong pairing does not look like "a few more orphans than usual". It
 * looks like most of the store at once, which is what makes a fraction a good
 * detector of it and a bad detector of anything else. A tenth is well above
 * what accumulates from abandoned uploads and well below what a mismatch
 * produces.
 */
export const DEFAULT_MAX_ORPHAN_FRACTION = 0.1;

/**
 * How many objects the store must hold before the fraction rule is applied.
 *
 * A fraction of a handful is not a signal: one abandoned upload in a store of
 * four is twenty-five per cent and means nothing. Below this the operator is
 * looking at a list short enough to read in full, which is a better check
 * than any ratio.
 */
const FRACTION_APPLIES_ABOVE = 10;

/** Why a sweep declined to delete, in a form the script can print. */
export interface SweepRefusal {
  /**
   * `no-references` — the store holds objects and the database named none of
   * them. `too-many` — deleting would take more of the store than
   * {@link DEFAULT_MAX_ORPHAN_FRACTION} allows.
   */
  reason: "no-references" | "too-many";
  /** What to print, including how to proceed if this really is expected. */
  message: string;
}

export interface SweepInput {
  /** Everything the store holds under the image prefix. */
  listed: readonly ListedObject[];
  /** Every key the database still refers to, however it refers to it. */
  referenced: ReadonlySet<string>;
  /** The moment to measure ages against, passed in so this stays a function. */
  now: Date;
  /** Overrides {@link DEFAULT_MIN_AGE_MS}. */
  minAgeMs?: number;
  /** Overrides {@link DEFAULT_MAX_ORPHAN_FRACTION}. */
  maxOrphanFraction?: number;
}

export interface ImageSweepPlan {
  /**
   * The objects `--delete` would remove, oldest first.
   *
   * Oldest first because that is the order that reads: the top of the list is
   * the most certainly dead, and an operator scanning a report stops reading
   * somewhere, so the least surprising entries should not be the ones at the
   * top.
   */
  orphans: ListedObject[];
  /** Everything the store holds under the prefix. */
  listed: SweepTotals;
  /** Objects something in the database still names. */
  referenced: SweepTotals;
  /** Objects too recently uploaded to be judged. */
  tooNew: SweepTotals;
  /** Objects this application could not have minted. */
  unrecognised: SweepTotals;
  /** The orphans, as totals. */
  orphaned: SweepTotals;
  /**
   * Every reason deleting is refused — empty when it is allowed.
   *
   * A list rather than the first reason found, and that is a correctness
   * property rather than a presentation one. The two refusals overlap
   * precisely in the worst case: a store the database refers to *none* of is
   * also a store the sweep wants to delete all of. Returning only the first
   * meant `--allow-unreferenced-store`, which is allowed to lift that one,
   * lifted the only refusal that had been computed — and the fraction cap
   * that was supposed to be unliftable never ran. One flag could then empty a
   * family's archive, which is the exact wrong-pairing catastrophe the guards
   * exist for.
   *
   * Computed on every run, including dry ones, so that the report says "this
   * would be refused" *before* an operator adds `--delete` and finds out.
   */
  refusals: SweepRefusal[];
}

function totals(objects: readonly ListedObject[]): SweepTotals {
  return {
    count: objects.length,
    bytes: objects.reduce((sum, object) => sum + object.size, 0),
  };
}

/**
 * Sort what the store handed back into the four buckets, and decide whether
 * deleting is allowed.
 *
 * The order of the tests is the order of the safety argument, and it is not
 * interchangeable: an object is spared by the *first* rule that applies, so a
 * referenced object is never examined for its age and an unrecognised one is
 * never examined at all. Reversing any pair would only ever move something
 * into `orphans`.
 */
export function planImageSweep(input: SweepInput): ImageSweepPlan {
  const minAgeMs = input.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const maxOrphanFraction =
    input.maxOrphanFraction ?? DEFAULT_MAX_ORPHAN_FRACTION;
  const cutoff = input.now.getTime() - minAgeMs;

  const referenced: ListedObject[] = [];
  const tooNew: ListedObject[] = [];
  const unrecognised: ListedObject[] = [];
  const orphans: ListedObject[] = [];

  for (const object of input.listed) {
    if (input.referenced.has(object.key)) {
      referenced.push(object);
      continue;
    }

    // Checked here as well as in the `prefix` handed to `storage.list`,
    // because that filter is the host's and this one is ours. The namespace
    // is a containment property (`lib/storage-key.ts`), and a containment
    // property enforced only by the thing being contained is not one — the
    // day this store also holds a database dump, a host that read the prefix
    // loosely would be all that stood between the sweep and it.
    if (!isStoredImageKey(object.key)) {
      unrecognised.push(object);
      continue;
    }

    // `>=` rather than `>`: an object landing exactly on the cutoff is held
    // back, because every ambiguity in this module resolves towards keeping
    // the photograph. A future `uploadedAt` — clock skew between this process
    // and the store — lands here too, for the same reason. Nonsense is not a
    // reason to delete something.
    if (object.uploadedAt.getTime() >= cutoff) {
      tooNew.push(object);
      continue;
    }

    orphans.push(object);
  }

  // Oldest first, so a person clearing the report by hand starts with the
  // objects that have had the longest to prove themselves orphaned. Ties
  // break on the storage key by code unit rather than by `localeCompare`
  // (`YEO-116`): the key is `images/<shard>/<uuid>.<ext>`, nobody reads it as
  // an alphabet, and all a tie needs is to report the same order on every run
  // over the same listing rather than one that drifts with the runtime's ICU
  // data.
  orphans.sort(
    (a, b) =>
      a.uploadedAt.getTime() - b.uploadedAt.getTime() ||
      compareIds(a.key, b.key),
  );

  const plan: ImageSweepPlan = {
    orphans,
    listed: totals(input.listed),
    referenced: totals(referenced),
    tooNew: totals(tooNew),
    unrecognised: totals(unrecognised),
    orphaned: totals(orphans),
    refusals: [],
  };

  return { ...plan, refusals: refusalsFor(plan, input, maxOrphanFraction) };
}

/**
 * Every reason this run may not delete.
 *
 * Both rules are evaluated, always, and neither is allowed to short-circuit
 * the other. They are at their most alike exactly when things are at their
 * worst — a store nothing refers to is also a store the sweep wants to empty
 * — so an implementation that stopped at the first match would report the
 * liftable reason and silently skip the unliftable one.
 */
function refusalsFor(
  plan: ImageSweepPlan,
  input: SweepInput,
  maxOrphanFraction: number,
): SweepRefusal[] {
  const found: SweepRefusal[] = [];

  // An empty store is not suspicious, it is just empty — and neither is a
  // fresh wiki with nothing in it. What is suspicious is a store with
  // photographs in it that the database has never heard of, which is what a
  // wrong `DATABASE_URL`, a half-applied migration, or a restore in progress
  // all look like from here.
  if (plan.listed.count > 0 && input.referenced.size === 0) {
    found.push({
      reason: "no-references",
      message:
        `The store holds ${plan.listed.count} object(s) and the database ` +
        "refers to none of them. That is what a wrong DATABASE_URL, a " +
        "half-applied migration, or a restore in progress looks like from " +
        "here, and it is indistinguishable from a wiki that genuinely lost " +
        "every reference. Check that DATABASE_URL and STORAGE_TOKEN name the " +
        "same deployment. If the store really is all abandoned uploads, " +
        "pass --allow-unreferenced-store.",
    });
  }

  if (plan.listed.count <= FRACTION_APPLIES_ABOVE) return found;

  const fraction = plan.orphaned.count / plan.listed.count;
  if (fraction > maxOrphanFraction) {
    found.push({
      reason: "too-many",
      message:
        `This would delete ${plan.orphaned.count} of ${plan.listed.count} ` +
        `objects (${percent(fraction)}), more than the ` +
        `${percent(maxOrphanFraction)} a sweep will remove without being ` +
        "told to. The usual cause is that the references were read from one " +
        "deployment and the store belongs to another — DATABASE_URL and " +
        "STORAGE_TOKEN are not checked against each other, and nothing else " +
        "would notice. Read the list above, and if it is right, re-run with " +
        `--max-orphan-fraction=${Math.min(1, Math.ceil(fraction * 100) / 100)}.`,
    });
  }

  return found;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The report, as lines, so that "report before delete" is a tested property
 * rather than a sequence of `console.log` calls nobody asserts on.
 *
 * A pure function of the plan and two labels. `db/images-sweep.ts` prints what
 * this returns and adds nothing of its own, which is what makes the dry run a
 * faithful rehearsal: the same lines are produced in both modes, from the same
 * plan, before anything is deleted.
 *
 * @param databaseLabel which database the references came from, already
 *   stripped of its password by the caller — the one line an operator should
 *   read before typing `--delete`, because it is the half of the
 *   database/store pairing that can be wrong with nothing noticing
 */
export function formatSweepReport(
  plan: ImageSweepPlan,
  census: {
    fromPages: number;
    fromRevisions: number;
    fromPortraits: number;
  },
  databaseLabel: string,
): string[] {
  const lines = [
    `References read from: ${databaseLabel}`,
    `  ${census.fromPages} from entry bodies, ` +
      `${census.fromRevisions} from revisions, ` +
      `${census.fromPortraits} from portrait columns`,
    "",
    `Store: ${plan.listed.count} object(s), ${formatBytes(plan.listed.bytes)}`,
    `  referenced    ${bucket(plan.referenced)}`,
    `  too new       ${bucket(plan.tooNew)}`,
    `  unrecognised  ${bucket(plan.unrecognised)}`,
    `  orphaned      ${bucket(plan.orphaned)}`,
  ];

  if (plan.orphans.length > 0) {
    lines.push("", "Orphans, oldest first:");
    for (const object of plan.orphans) {
      lines.push(
        `  ${object.key}  ${formatBytes(object.size).padStart(9)}  ` +
          `uploaded ${object.uploadedAt.toISOString().slice(0, 10)}`,
      );
    }
  }

  for (const refusal of plan.refusals) {
    lines.push("", `This run would be refused: ${refusal.message}`);
  }

  return lines;
}

function bucket(totals: SweepTotals): string {
  return `${String(totals.count).padStart(6)}  ${formatBytes(totals.bytes).padStart(9)}`;
}

/**
 * Human bytes. Approximate on purpose — this is a report, not an invoice.
 */
export function formatBytes(value: number): string {
  const units = ["B", "kB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`;
}
