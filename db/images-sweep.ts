import "../lib/load-env";

import { parseArgs } from "node:util";

import { readReferencedImageKeys } from "../lib/image-references";
import {
  formatBytes,
  formatSweepReport,
  planImageSweep,
  type ImageSweepPlan,
} from "../lib/image-sweep";
import * as storage from "../lib/storage";
import { IMAGE_KEY_PREFIX } from "../lib/storage-key";
import { db } from "./index";

/**
 * Reclaim storage from images nothing refers to any more (E5-T5, `YEO-45`).
 *
 * ```
 * npm run db:images-sweep              # report only — the default
 * npm run db:images-sweep -- --delete  # actually remove them
 * ```
 *
 * The runbook, including what to check before the first `--delete` against
 * production, is docs/backups.md#reclaiming-storage-from-orphaned-images.
 *
 * ## Why the default is a report
 *
 * Because the mistake is not recoverable. Photographs are the one thing the
 * nightly backup does not carry (docs/backups.md#what-is-not-in-these-
 * backups) — the dump holds the rows that point at images and never the
 * images — so a wrong delete here is not undone by restoring anything. The
 * asymmetry is total: an orphan left behind costs a few kilobytes until
 * somebody runs this again, and a photograph deleted by mistake is gone from
 * a family's archive.
 *
 * So this prints what it would do and stops. `--delete` is a second, explicit
 * decision made by a person who has read the list.
 *
 * ## Where the danger actually is
 *
 * Not in the orphan rule — that is in `lib/image-sweep.ts`, it is pure, and
 * it is tested. It is in the pairing this script cannot check: **references
 * come from `DATABASE_URL` and deletions go to `STORAGE_TOKEN`'s store, and
 * nothing in the system relates the two.** A developer's machine ordinarily
 * has a local database in `DATABASE_URL`; if `STORAGE_TOKEN` names the
 * deployed store, every real photograph in it is unreferenced as far as this
 * run is concerned, and `--delete` would empty a family's archive with no
 * error anywhere.
 *
 * Two things stand in the way, both in `lib/image-sweep.ts` and both decided
 * before deletion is offered: a store with objects that the database refers
 * to *none* of is refused outright, and a sweep that would take more than a
 * tenth of the store is refused as well. A wrong pairing does not look like
 * a handful of extra orphans; it looks like most of the store at once. The
 * report also names the database it read from, which is the line to check
 * before typing `--delete`.
 *
 * ## Where it lives
 *
 * `db/`, with the other operational scripts, because that is what it is: it
 * loads `lib/load-env`, opens the application's own pool through
 * `db/index.ts`, and runs under `tsx` exactly as `db/backup.ts` and
 * `db/keep-alive.ts` do. The store is the thing it writes to, but the
 * database is the thing it needs to be correct about.
 *
 * The judgement is not in here. This file reads the world, prints, and
 * deletes; every decision about what counts as an orphan is in
 * `lib/image-sweep.ts`, and every decision about what counts as a reference
 * is in `lib/image-references.ts`. Both are pure and both are tested without
 * a database — the split `db/seed-guard.ts` established.
 */

/** `--min-age-hours` in hours, so the flag reads in the unit a person thinks in. */
const HOUR_MS = 60 * 60 * 1000;

async function main() {
  const { values } = parseArgs({
    options: {
      /**
       * Actually delete. Everything else about this script is the same in
       * both modes — the same reads, the same report, the same refusals —
       * so a dry run is a faithful rehearsal rather than a different code
       * path that happens to agree.
       */
      delete: { type: "boolean", default: false },
      /** Overrides the grace period that protects an in-progress edit. */
      "min-age-hours": { type: "string" },
      /** Raises the share of the store a single run may remove. */
      "max-orphan-fraction": { type: "string" },
      /**
       * Proceed even though the database refers to none of the stored
       * images. Only ever right for a store that really is all abandoned
       * uploads — otherwise this is the flag that silences the warning about
       * being pointed at the wrong database.
       */
      "allow-unreferenced-store": { type: "boolean", default: false },
    },
  });

  const minAgeMs = numeric(values["min-age-hours"], "min-age-hours", HOUR_MS);
  const maxOrphanFraction = numeric(
    values["max-orphan-fraction"],
    "max-orphan-fraction",
    1,
  );

  // The store is enumerated *before* the references are read, and the order
  // is deliberate. Anything uploaded during the run is absent from the
  // listing and so cannot be swept; anything referenced during the run is
  // caught by the read that happens afterwards. Reading the references first
  // would leave a window where a body saved mid-run pointed at an object
  // this run had already decided was unreferenced.
  console.log(`Listing ${IMAGE_KEY_PREFIX}* …`);
  const listed = await storage.list({ prefix: IMAGE_KEY_PREFIX });

  // One transaction, so the three reads describe one instant. A page save
  // writes `pages` and `revisions` together, and a sweep that read them a
  // moment apart could see neither copy of an image that was being moved
  // between them.
  const references = await db.transaction((tx) => readReferencedImageKeys(tx));

  const plan = planImageSweep({
    listed,
    referenced: references.keys,
    now: new Date(),
    minAgeMs,
    maxOrphanFraction,
  });

  for (const line of formatSweepReport(plan, references, describeDatabase())) {
    console.log(line);
  }

  if (!values.delete) {
    console.log(
      plan.orphaned.count === 0
        ? "\nNothing to reclaim. (This was a dry run; nothing is ever deleted " +
            "without --delete.)"
        : `\nNothing was deleted — this is a report. Re-run with --delete to ` +
            `reclaim ${formatBytes(plan.orphaned.bytes)}.`,
    );
    return;
  }

  const refusal = deletionRefusal(plan, values["allow-unreferenced-store"]);
  if (refusal) {
    console.error(`\nRefusing to delete. ${refusal}`);
    process.exitCode = 1;
    return;
  }

  if (plan.orphaned.count === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  console.log(`\nDeleting ${plan.orphaned.count} object(s) …`);
  let deleted = 0;
  let failed = 0;
  // Accumulated from what actually succeeded rather than from the plan.
  // Reporting the planned total after a partial run would overstate the
  // reclaim by exactly the objects that are still sitting there, which is
  // the number somebody would go on to trust.
  let reclaimed = 0;
  for (const object of plan.orphans) {
    try {
      await storage.delete(object.key);
      deleted += 1;
      reclaimed += object.size;
    } catch (error) {
      // One unreachable object must not abandon the rest: the run has
      // already decided these are orphans, and stopping halfway leaves the
      // operator with a partial reclaim and no record of where it stopped.
      failed += 1;
      console.error(`  failed ${object.key}: ${message(error)}`);
    }
  }

  console.log(
    `Deleted ${deleted} object(s), reclaiming about ` +
      `${formatBytes(reclaimed)}.` +
      (failed > 0 ? ` ${failed} could not be deleted; re-run to retry.` : ""),
  );
  if (failed > 0) process.exitCode = 1;
}

/**
 * Why this run may not delete, or `null`.
 *
 * `--allow-unreferenced-store` lifts exactly one of the two refusals. It
 * cannot lift the other, which is what keeps it from becoming the flag people
 * paste in to make the script stop arguing: a sweep that wants most of the
 * store is refused whatever this says, and is answered by
 * `--max-orphan-fraction`, which has to be given a number the operator chose
 * after reading the report.
 */
function deletionRefusal(
  plan: ImageSweepPlan,
  allowUnreferencedStore: boolean,
): string | null {
  if (!plan.refusal) return null;
  if (plan.refusal.reason === "no-references" && allowUnreferencedStore) {
    return null;
  }
  return plan.refusal.message;
}

/**
 * Which database the references came from, without the password in it.
 *
 * `user@host/database`, the same three parts `db/destructive-target.ts`
 * reasons about — on Supabase's shared pooler the *username* is what picks
 * the project, so a host alone would not tell two deployments apart.
 */
function describeDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL (unset)";
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}@` : "";
    return `${user}${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "DATABASE_URL (unparseable)";
  }
}

/**
 * Read a numeric flag, or throw.
 *
 * A flag that cannot be parsed is refused rather than defaulted. Silently
 * falling back would mean `--min-age-hours=fourty` ran with the default
 * window while the operator believed they had widened it, which is the exact
 * shape of mistake this script must not make.
 */
function numeric(
  value: string | undefined,
  flag: string,
  scale: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${flag} must be a non-negative number, got "${value}".`);
  }
  return parsed * scale;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .then(() => {
    // `db/index.ts` holds the pool open by design and exposes no way to close
    // it, so the process would otherwise hang until the job timeout.
    // `db/keep-alive.ts` and `db/seed.ts` end the same way.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error("Image sweep failed:", err);
    process.exit(1);
  });
